# YouTube playback validation — 2026-10-10

Tested in the actual Windows x64 Tauri desktop app with bundled libmpv,
yt-dlp and Deno, through WebView2 CDP on port 9223. This records observations
from this machine and connection, not a guarantee for every video or network.

## Changes verified

- Native YouTube video and external audio share libmpv's clock and buffering.
- Quality/audio changes preserve position and user Play/Pause intent, including
  clicks while the replacement stream is opening. Volume and speed survive reloads.
- The loopback proxy streams bounded 4 MiB upstream ranges and resumes interrupted
  bodies at the exact next byte. Cancelled consumers stop downloading.
- Timeline preview downloads stop after capture, pointer exit, or a main seek.
- The HTML fallback remains operational. A replaced buffering gate no longer stays
  locked by the pending `play()` promise from the previous gate.

## Real YouTube results

| Video | Actual quality | Metadata lookup | Play to startup | Sustained sample | Rebuffer samples | Maximum reported A/V drift |
| --- | --- | --- | --- | --- | --- | --- |
| [User-provided Friends video](https://www.youtube.com/watch?v=NHQH5Y_zW_E) | 720p (highest resolved) | 8.44 s | 4.45 s | 120.08 s progress / 120 s | 0 | 0.43 ms |
| [Big Buck Bunny](https://www.youtube.com/watch?v=aqz-KE-bpKQ) | 1080p60 | 6.81 s | 2.21 s | 19.87 s progress / 20 s | 0 | 34.02 ms |

Drift is libmpv's sampled `avsync` clock measurement, not a physical measurement
of display/speaker latency. Neither sustained sample had a backward clock jump.
Seek completion ranged from 0.42–4.11 s for Friends and 4.03–8.07 s for the
1080p sample. Metadata lookup and startup are separate timings.

Both videos passed repeated long-distance seeks, a 12-command rapid-seek burst,
paused quality switching, refreshed signed URLs, exact byte-range reads, and
replay after EOF. Friends loaded two caption tracks. The final 1080p run also
verified mute, speed, volume preservation and release of the preview decoder.

An earlier 1080p run failed its progress threshold while measured delivery was
below the selected stream's bitrate. The user reported a VPN interruption.
The short 1080p recheck above passed after the connection was restored; it does
not replace a long-duration 1080p soak test.

## Regression checks

- `cdp-youtube-network-smoke.mjs`: passed. Delayed audio with available video
  stops the shared clock; Pause survives buffer completion; alternate audio is
  actually loaded and survives quality changes; Play/Pause during opening is
  honored; returning to local playback restores per-file network options.
- `cdp-youtube-smoke.mjs`: passed with HTML fallback forced on the default
  `jNQXAC9IVRw` video. Repeated seeks, both Range responses, four caption tracks,
  quality switching and injected network recovery passed. No steady backward
  jumps, silent-audio samples or hard resynchronizations; maximum post-seek drift
  was 54 ms.
- `cdp-native-local-smoke.mjs`: passed on a 360 s H.264/AAC fixture. Startup
  542 ms, individual seeks 54–183 ms, rapid burst settled 102 ms after the last
  command; thumbnails worked and the local buffering loader stayed hidden.
  The first attempt used a 90 s fixture, shorter than this existing test's
  absolute seek targets; it was rerun with the appropriate longer fixture.
- `cdp-controls-resume-smoke.mjs`: passed keyboard/wheel volume, OSD, subtitle
  appearance, and both Continue/Start over branches with the longer fixture.
- `cdp-window-smoke.mjs`: passed fullscreen, double-click, drag-request routing,
  auto-hide and shading checks. Its sampling delays now allow the existing
  460 ms transition to finish. CDP confirmed the native drag request, not actual
  OS pointer-driven window movement.
- Rust library tests: 14 passed, including exact proxy bytes, open/bounded/suffix
  ranges, truncated/stalled bodies, transient server errors, rejected bad ranges,
  cancellation, concurrent seeks and the existing resolver tests.
- Final `npm run build` and `cargo check --manifest-path src-tauri/Cargo.toml`:
  passed.

## Reproduction

Start `npm run tauri dev` with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, then:

```powershell
$env:LINGO_YOUTUBE_QUALITY = '1080'
$env:LINGO_STEADY_SECONDS = '120'
node scripts/cdp-youtube-native-smoke.mjs https://www.youtube.com/watch?v=NHQH5Y_zW_E
node scripts/cdp-youtube-network-smoke.mjs
node scripts/cdp-youtube-smoke.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

The modified desktop development build was exercised; macOS/Linux and prolonged
background/sleep/network-switch scenarios remain unverified. Portable outputs
were subsequently removed at the user's request; packaging is only performed
when explicitly requested and is not pending work for this change.
