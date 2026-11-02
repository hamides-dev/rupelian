//! Bounded upstream requests avoid CDN throttling of a single open-ended download.
//! The downstream response remains one ordinary seekable HTTP resource. Backpressure
//! and cancellation belong to the response body; no detached download survives a seek.
use std::{collections::HashMap, io, time::Duration};

use axum::{body::Body, http::{header, HeaderMap, Method, Response, StatusCode}};
use futures_util::stream;

// Below YouTube's 10 MB throttling threshold, while amortizing request latency
// for high-bitrate streams. Response bytes are forwarded immediately, not held
// until the entire chunk has downloaded.
const CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const RETRIES: usize = 3;

#[derive(Clone)]
pub(crate) struct RemoteSource {
    pub url: String,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum RequestedRange {
    Full,
    From(u64, Option<u64>),
    Suffix(u64),
}

impl RequestedRange {
    fn parse(value: Option<&str>) -> Result<Self, ()> {
        let Some(value) = value else { return Ok(Self::Full) };
        let (start, end) = value.strip_prefix("bytes=").ok_or(())?.split_once('-').ok_or(())?;
        if start.is_empty() {
            return end.parse::<u64>().ok().filter(|size| *size > 0).map(Self::Suffix).ok_or(());
        }
        let start = start.parse::<u64>().map_err(|_| ())?;
        let end = if end.is_empty() { None } else { Some(end.parse::<u64>().map_err(|_| ())?) };
        if end.is_some_and(|end| end < start) { return Err(()) }
        Ok(Self::From(start, end))
    }

    fn bounds(self, total: u64) -> Option<(u64, u64)> {
        if total == 0 { return None }
        let (start, end) = match self {
            Self::Full => (0, total - 1),
            Self::From(start, end) => (start, end.unwrap_or(total - 1).min(total - 1)),
            Self::Suffix(size) => (total.saturating_sub(size), total - 1),
        };
        (start <= end).then_some((start, end))
    }
}

fn content_range(headers: &HeaderMap) -> Option<(u64, u64, u64)> {
    let value = headers.get(header::CONTENT_RANGE)?.to_str().ok()?.strip_prefix("bytes ")?;
    let (span, total) = value.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

fn upstream_request(client: &reqwest::Client, source: &RemoteSource, method: Method) -> reqwest::RequestBuilder {
    let mut request = client.request(method, &source.url);
    for (name, value) in &source.headers {
        if !matches!(name.to_ascii_lowercase().as_str(), "host" | "content-length" | "range" | "accept-encoding" | "connection") {
            request = request.header(name, value);
        }
    }
    request.header(header::ACCEPT_ENCODING, "identity")
}

async fn get_range(client: &reqwest::Client, source: &RemoteSource, start: u64, end: u64, if_range: Option<&str>) -> io::Result<reqwest::Response> {
    for attempt in 0..RETRIES {
        let mut request = upstream_request(client, source, Method::GET)
            .header(header::RANGE, format!("bytes={start}-{end}"));
        if let Some(value) = if_range { request = request.header(header::IF_RANGE, value); }
        match request.send().await {
            Ok(response) if !response.status().is_server_error() || attempt + 1 == RETRIES => return Ok(response),
            Err(error) if attempt + 1 == RETRIES => return Err(io::Error::other(error)),
            _ => tokio::time::sleep(Duration::from_millis(150 * (attempt + 1) as u64)).await,
        }
    }
    unreachable!()
}

fn copy_headers(response: &reqwest::Response) -> axum::http::response::Builder {
    let mut builder = Response::builder().status(response.status());
    for name in [header::ACCEPT_RANGES, header::CONTENT_LENGTH, header::CONTENT_RANGE,
        header::CONTENT_TYPE, header::ETAG, header::LAST_MODIFIED] {
        if let Some(value) = response.headers().get(&name) { builder = builder.header(name, value); }
    }
    builder
}

pub(crate) fn cors(builder: axum::http::response::Builder, body: Body) -> Response<Body> {
    builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, If-Range")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Length, Content-Range, Content-Type")
        // Signed URLs can be refreshed behind a new token. Never store partial error bodies.
        .header(header::CACHE_CONTROL, "no-store")
        .body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}

pub(crate) async fn serve(client: reqwest::Client, source: RemoteSource, method: Method, headers: &HeaderMap) -> Response<Body> {
    if method == Method::OPTIONS { return cors(Response::builder().status(204), Body::empty()) }
    if method != Method::GET && method != Method::HEAD {
        return cors(Response::builder().status(405).header(header::ALLOW, "GET, HEAD, OPTIONS"), Body::empty())
    }
    if method == Method::HEAD {
        return match upstream_request(&client, &source, Method::HEAD).send().await {
            Ok(response) => cors(copy_headers(&response), Body::empty()),
            Err(_) => cors(Response::builder().status(502), Body::from("Stream metadata unavailable")),
        }
    }
    let range = match RequestedRange::parse(headers.get(header::RANGE).and_then(|value| value.to_str().ok())) {
        Ok(range) => range,
        Err(_) => return cors(Response::builder().status(416), Body::empty()),
    };
    let if_range = headers.get(header::IF_RANGE).and_then(|value| value.to_str().ok());
    // Suffix requests first need the size. A one-byte probe stays bounded as well.
    let (first_start, first_end) = match range {
        RequestedRange::From(start, end) => (start, end.unwrap_or(u64::MAX).min(start.saturating_add(CHUNK_BYTES - 1))),
        RequestedRange::Full => (0, CHUNK_BYTES - 1),
        RequestedRange::Suffix(_) => (0, 0),
    };
    let mut response = match get_range(&client, &source, first_start, first_end, if_range).await {
        Ok(response) => response,
        Err(_) => return cors(Response::builder().status(502), Body::from("YouTube stream temporarily unavailable")),
    };
    if response.status() != StatusCode::PARTIAL_CONTENT {
        // A server ignoring Range (including an If-Range mismatch) must stay a 200.
        return cors(copy_headers(&response), Body::from_stream(response.bytes_stream()))
    }
    let Some((actual_start, actual_end, total)) = content_range(response.headers()) else {
        return cors(Response::builder().status(502), Body::from("Invalid upstream byte range"))
    };
    if actual_start != first_start || actual_end > first_end {
        return cors(Response::builder().status(502), Body::from("Unexpected upstream byte range"))
    }
    let Some((start, end)) = range.bounds(total) else {
        return cors(Response::builder().status(416).header(header::CONTENT_RANGE, format!("bytes */{total}")), Body::empty())
    };
    let mut chunk_end = actual_end;
    if matches!(range, RequestedRange::Suffix(_)) {
        drop(response);
        response = match get_range(&client, &source, start, end.min(start.saturating_add(CHUNK_BYTES - 1)), if_range).await {
            Ok(response) => response,
            Err(_) => return cors(Response::builder().status(502), Body::empty()),
        };
        let Some((received_start, received_end, received_total)) = content_range(response.headers()) else {
            return cors(Response::builder().status(502), Body::empty())
        };
        if response.status() != StatusCode::PARTIAL_CONTENT || received_start != start || received_total != total || received_end > end.min(start.saturating_add(CHUNK_BYTES - 1)) {
            return cors(Response::builder().status(502), Body::empty())
        }
        chunk_end = received_end;
    }
    let mut builder = Response::builder()
        .status(if range == RequestedRange::Full { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, end - start + 1);
    if range != RequestedRange::Full { builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}")); }
    for name in [header::CONTENT_TYPE, header::ETAG, header::LAST_MODIFIED] {
        if let Some(value) = response.headers().get(&name) { builder = builder.header(name, value); }
    }
    let validator = response.headers().get(header::ETAG).or_else(|| response.headers().get(header::LAST_MODIFIED))
        .and_then(|value| value.to_str().ok()).map(str::to_owned);
    struct Download {
        client: reqwest::Client, source: RemoteSource, response: Option<reqwest::Response>,
        position: u64, end: u64, chunk_end: u64, total: u64, failures: usize, validator: Option<String>,
    }
    let download = Download { client, source, response: Some(response), position: start, end, chunk_end, total, failures: 0, validator };
    let body = stream::try_unfold(download, |mut download| async move {
        loop {
            if download.position > download.end { return Ok::<_, io::Error>(None) }
            if let Some(response) = download.response.as_mut() {
                match response.chunk().await {
                    Ok(Some(bytes)) if !bytes.is_empty() => {
                        if bytes.len() as u64 > download.chunk_end - download.position + 1 {
                            return Err(io::Error::other("Upstream exceeded its declared range"))
                        }
                        download.position += bytes.len() as u64;
                        download.failures = 0;
                        if download.position > download.chunk_end { download.response = None; }
                        return Ok(Some((bytes, download)))
                    }
                    Ok(Some(_)) => continue,
                    _ => {
                        download.response = None;
                        download.failures += 1;
                        if download.failures >= RETRIES { return Err(io::Error::other("Stream stopped making progress")) }
                    }
                }
            }
            let chunk_end = download.end.min(download.position.saturating_add(CHUNK_BYTES - 1));
            let response = get_range(&download.client, &download.source, download.position, chunk_end, download.validator.as_deref()).await?;
            let received = content_range(response.headers());
            if response.status() != StatusCode::PARTIAL_CONTENT || !received.is_some_and(|(start, end, total)| {
                start == download.position && end <= chunk_end && total == download.total
            }) {
                return Err(io::Error::other("Upstream changed during a ranged download"))
            }
            download.chunk_end = received.unwrap().1;
            download.response = Some(response);
        }
    });
    cors(builder, Body::from_stream(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::{Path, State}, routing::any, Router};
    use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

    #[derive(Clone)]
    struct Fixture {
        bytes: Arc<Vec<u8>>,
        ranges: Arc<Mutex<Vec<(u64, u64)>>>,
        failed: Arc<AtomicBool>,
    }

    async fn origin(State(fixture): State<Fixture>, Path(mode): Path<String>, method: Method, headers: HeaderMap) -> Response<Body> {
        let total = fixture.bytes.len() as u64;
        if method == Method::HEAD {
            return Response::builder().header(header::CONTENT_LENGTH, total).body(Body::empty()).unwrap()
        }
        if mode == "forbidden" { return Response::builder().status(403).body(Body::empty()).unwrap() }
        if mode == "busy" && !fixture.failed.swap(true, Ordering::SeqCst) {
            return Response::builder().status(503).body(Body::empty()).unwrap()
        }
        if mode == "ignore" {
            return Response::builder().header(header::CONTENT_LENGTH, total).body(Body::from(fixture.bytes.as_ref().clone())).unwrap()
        }
        let range = RequestedRange::parse(headers.get(header::RANGE).and_then(|value| value.to_str().ok())).unwrap();
        let Some((start, end)) = range.bounds(total) else {
            return Response::builder().status(416).header(header::CONTENT_RANGE, format!("bytes */{total}")).body(Body::empty()).unwrap()
        };
        fixture.ranges.lock().unwrap().push((start, end));
        let wrong_start = if mode == "wrong" { start + 1 } else { start };
        let builder = Response::builder().status(206)
            .header(header::CONTENT_RANGE, format!("bytes {wrong_start}-{end}/{total}"))
            .header(header::CONTENT_LENGTH, end - start + 1)
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::ETAG, "\"stable\"");
        if matches!(mode.as_str(), "truncate" | "stall") && !fixture.failed.swap(true, Ordering::SeqCst) {
            let bytes = axum::body::Bytes::copy_from_slice(&fixture.bytes[start as usize..(start + 4096).min(end + 1) as usize]);
            let delay = if mode == "stall" { 3000 } else { 30 };
            let body = stream::unfold(0, move |step| {
                let bytes = bytes.clone();
                async move {
                    match step {
                        0 => Some((Ok::<_, io::Error>(bytes), 1)),
                        1 => {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                            Some((Err(io::Error::other("injected mid-body disconnect")), 2))
                        }
                        _ => None,
                    }
                }
            });
            return builder.body(Body::from_stream(body)).unwrap()
        }
        if mode == "slow" {
            let bytes = fixture.bytes.clone();
            let body = stream::unfold(start, move |position| {
                let bytes = bytes.clone();
                async move {
                    if position > end { return None }
                    tokio::time::sleep(Duration::from_millis(15)).await;
                    let next = (position + 65536).min(end + 1);
                    Some((Ok::<_, io::Error>(axum::body::Bytes::copy_from_slice(&bytes[position as usize..next as usize])), next))
                }
            });
            return builder.body(Body::from_stream(body)).unwrap()
        }
        builder.body(Body::from(fixture.bytes[start as usize..=end as usize].to_vec())).unwrap()
    }

    async fn setup(mode: &str) -> (reqwest::Client, String, Fixture, tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let fixture = Fixture {
            bytes: Arc::new((0..CHUNK_BYTES * 3 + 137).map(|index| (index % 251) as u8).collect()),
            ranges: Arc::default(), failed: Arc::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = format!("http://{}/{mode}", listener.local_addr().unwrap());
        let app = Router::new().route("/{mode}", any(origin)).with_state(fixture.clone());
        let origin_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().read_timeout(Duration::from_secs(2)).build().unwrap();
        let proxy_client = client.clone();
        let source = RemoteSource { url: upstream, headers: HashMap::new() };
        let app = Router::new().route("/video", any(move |method: Method, headers: HeaderMap| {
            let client = proxy_client.clone(); let source = source.clone();
            async move { serve(client, source, method, &headers).await }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/video", listener.local_addr().unwrap());
        let proxy_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // The consumer deadline must outlast the proxy's per-read retry window.
        let consumer = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap();
        (consumer, url, fixture, origin_task, proxy_task)
    }

    #[test]
    fn bounded_ranges_preserve_bytes_and_http_semantics() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (client, url, fixture, origin, proxy) = setup("normal").await;
            for (range, start, end) in [
                (None, 0, fixture.bytes.len() - 1),
                (Some("bytes=100-1123"), 100, 1123),
                (Some("bytes=1234567-"), 1234567, fixture.bytes.len() - 1),
                (Some("bytes=-4111"), fixture.bytes.len() - 4111, fixture.bytes.len() - 1),
                (Some("bytes=0-99999999"), 0, fixture.bytes.len() - 1),
            ] {
                let mut request = client.get(&url);
                if let Some(range) = range { request = request.header(header::RANGE, range); }
                let response = request.send().await.unwrap();
                assert_eq!(response.status().as_u16(), if range.is_some() { 206 } else { 200 });
                assert_eq!(response.content_length(), Some((end - start + 1) as u64));
                if range.is_some() {
                    assert_eq!(response.headers()[header::CONTENT_RANGE], format!("bytes {start}-{end}/{}", fixture.bytes.len()));
                }
                assert_eq!(response.bytes().await.unwrap().as_ref(), &fixture.bytes[start..=end]);
            }
            for range in ["bytes=99999999-", "bytes=4-2", "bytes=0-1,4-5", "bytes=-0"] {
                assert_eq!(client.get(&url).header(header::RANGE, range).send().await.unwrap().status(), StatusCode::RANGE_NOT_SATISFIABLE);
            }
            let head = client.head(&url).send().await.unwrap();
            assert_eq!(head.headers()[header::CONTENT_LENGTH], fixture.bytes.len().to_string());
            assert!(head.bytes().await.unwrap().is_empty());
            assert_eq!(client.post(&url).send().await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);
            assert_eq!(client.request(Method::OPTIONS, &url).send().await.unwrap().status(), StatusCode::NO_CONTENT);
            assert!(fixture.ranges.lock().unwrap().iter().all(|(start, end)| end - start < CHUNK_BYTES));
            origin.abort(); proxy.abort();
        });
    }

    #[test]
    fn transient_failures_resume_without_duplicate_or_missing_bytes() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for mode in ["truncate", "stall", "busy"] {
                let (client, url, fixture, origin, proxy) = setup(mode).await;
                let response = client.get(&url).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.bytes().await.unwrap().as_ref(), fixture.bytes.as_slice());
                assert!(fixture.failed.load(Ordering::SeqCst));
                if mode != "busy" { assert_eq!(fixture.ranges.lock().unwrap()[1].0, 4096); }
                origin.abort(); proxy.abort();
            }
        });
    }

    #[test]
    fn does_not_fabricate_partial_content_or_retry_forbidden_streams() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for (mode, status) in [("ignore", 200), ("wrong", 502), ("forbidden", 403)] {
                let (client, url, fixture, origin, proxy) = setup(mode).await;
                let response = client.get(&url).header(header::RANGE, "bytes=5-100").send().await.unwrap();
                assert_eq!(response.status().as_u16(), status);
                if mode == "ignore" { assert_eq!(response.bytes().await.unwrap().as_ref(), fixture.bytes.as_slice()); }
                origin.abort(); proxy.abort();
            }
        });
    }

    #[test]
    fn cancelled_consumers_stop_downloading_and_concurrent_seeks_are_independent() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (client, url, fixture, origin, proxy) = setup("slow").await;
            let mut response = client.get(&url).send().await.unwrap();
            assert!(response.chunk().await.unwrap().is_some());
            drop(response);
            tokio::time::sleep(Duration::from_millis(1400)).await;
            assert_eq!(fixture.ranges.lock().unwrap().len(), 1, "A cancelled seek must not keep requesting chunks");
            let left = client.get(&url).header(header::RANGE, "bytes=7000000-7000999").send();
            let right = client.get(&url).header(header::RANGE, "bytes=1234-2345").send();
            let (left, right) = tokio::join!(left, right);
            assert_eq!(left.unwrap().bytes().await.unwrap().as_ref(), &fixture.bytes[7000000..=7000999]);
            assert_eq!(right.unwrap().bytes().await.unwrap().as_ref(), &fixture.bytes[1234..=2345]);
            origin.abort(); proxy.abort();
        });
    }
}
