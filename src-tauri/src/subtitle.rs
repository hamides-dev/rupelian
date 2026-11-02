use serde::Serialize;
use std::{collections::HashMap, path::Path};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleSpan {
    pub(crate) text: String,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) underline: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) strikeout: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) font_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) opacity: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitlePlacement {
    pub(crate) vertical: String,
    pub(crate) horizontal: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleCue {
    pub(crate) start: f64,
    pub(crate) end: f64,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) spans: Vec<SubtitleSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) placement: Option<SubtitlePlacement>,
}

#[derive(Clone, Debug, Default)]
struct SpanStyle {
    bold: bool,
    italic: bool,
    underline: bool,
    strikeout: bool,
    color: Option<String>,
    background_color: Option<String>,
    font_family: Option<String>,
    font_scale: Option<f64>,
    opacity: Option<f64>,
}

#[derive(Clone, Debug)]
struct AssStyle {
    span: SpanStyle,
    alignment: Option<SubtitlePlacement>,
    font_size: f64,
}

impl Default for AssStyle {
    fn default() -> Self {
        Self {
            span: SpanStyle::default(),
            alignment: Some(alignment_from_an(2)),
            font_size: 36.0,
        }
    }
}

#[derive(Default)]
struct RichCaption {
    spans: Vec<SubtitleSpan>,
    placement: Option<SubtitlePlacement>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn timestamp_to_seconds(value: &str) -> Option<f64> {
    let normalized = value.trim().replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    let seconds = parts.last()?.parse::<f64>().ok()?;
    match parts.len() {
        2 => Some(parts[0].parse::<f64>().ok()? * 60.0 + seconds),
        3 => Some(
            parts[0].parse::<f64>().ok()? * 3600.0 + parts[1].parse::<f64>().ok()? * 60.0 + seconds,
        ),
        _ => None,
    }
}

fn decode_subtitle_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
            .into_owned()
    }
}

fn span_from_text(text: String, style: &SpanStyle) -> SubtitleSpan {
    SubtitleSpan {
        text,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strikeout: style.strikeout,
        color: style.color.clone(),
        background_color: style.background_color.clone(),
        font_family: style.font_family.clone(),
        font_scale: style.font_scale,
        opacity: style.opacity,
    }
}

fn same_span_style(span: &SubtitleSpan, style: &SpanStyle) -> bool {
    span.bold == style.bold
        && span.italic == style.italic
        && span.underline == style.underline
        && span.strikeout == style.strikeout
        && span.color == style.color
        && span.background_color == style.background_color
        && span.font_family == style.font_family
        && span.font_scale == style.font_scale
        && span.opacity == style.opacity
}

fn push_span(spans: &mut Vec<SubtitleSpan>, value: &str, style: &SpanStyle) {
    if value.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut().filter(|last| same_span_style(last, style)) {
        last.text.push_str(value);
    } else {
        spans.push(span_from_text(value.to_owned(), style));
    }
}

fn normalized_caption_text(spans: &[SubtitleSpan]) -> String {
    let joined = spans
        .iter()
        .map(|span| span.text.as_str())
        .collect::<String>();
    joined
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn finish_caption(mut caption: RichCaption) -> Option<RichCaption> {
    let text = normalized_caption_text(&caption.spans);
    if text.is_empty() {
        return None;
    }
    caption.spans.retain(|span| !span.text.is_empty());
    Some(caption)
}

fn cue_from_caption(start: f64, end: f64, caption: RichCaption) -> Option<SubtitleCue> {
    if end < start {
        return None;
    }
    let caption = finish_caption(caption)?;
    let text = normalized_caption_text(&caption.spans);
    Some(SubtitleCue {
        start,
        end,
        text,
        spans: caption.spans,
        placement: caption.placement,
    })
}

fn decode_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        rest = &rest[index..];
        let Some(end) = rest.find(';').filter(|end| *end <= 12) else {
            output.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = decoded {
            output.push(character);
        } else {
            output.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
}

fn safe_font_family(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(['\'', '"']);
    (!value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|character| !matches!(character, '{' | '}' | ';' | '<' | '>')))
    .then(|| value.to_owned())
}

fn normalize_css_color(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(['\'', '"']).to_ascii_lowercase();
    let valid_hex = value.strip_prefix('#').is_some_and(|hex| {
        matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
    });
    const NAMES: &[&str] = &[
        "white", "black", "red", "green", "blue", "yellow", "cyan", "aqua", "magenta", "fuchsia",
        "lime", "silver", "gray", "grey", "maroon", "olive", "navy", "purple", "teal", "orange",
    ];
    (valid_hex || NAMES.contains(&value.as_str())).then_some(value)
}

fn tag_attribute(tag: &str, wanted: &str) -> Option<String> {
    let mut rest = tag;
    while !rest.trim_start().is_empty() {
        rest = rest.trim_start();
        let name_end = rest
            .find(|character: char| character.is_whitespace() || character == '=')
            .unwrap_or(rest.len());
        let name = &rest[..name_end];
        rest = &rest[name_end..];
        rest = rest.trim_start();
        if !rest.starts_with('=') {
            if rest.is_empty() {
                break;
            }
            rest = &rest[1..];
            continue;
        }
        rest = rest[1..].trim_start();
        let (value, remaining) =
            if let Some(quote) = rest.chars().next().filter(|c| matches!(c, '\'' | '"')) {
                let tail = &rest[quote.len_utf8()..];
                if let Some(end) = tail.find(quote) {
                    (&tail[..end], &tail[end + quote.len_utf8()..])
                } else {
                    (tail, "")
                }
            } else {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                (&rest[..end], &rest[end..])
            };
        if name.eq_ignore_ascii_case(wanted) {
            return Some(value.to_owned());
        }
        rest = remaining;
    }
    None
}

fn apply_css_declarations(style: &mut SpanStyle, declarations: &str) {
    for declaration in declarations.split(';') {
        let Some((name, value)) = declaration.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "color" => style.color = normalize_css_color(value),
            "background" | "background-color" => {
                style.background_color = normalize_css_color(value)
            }
            "font-family" => style.font_family = safe_font_family(value),
            "font-weight" => {
                style.bold = value.trim().eq_ignore_ascii_case("bold")
                    || value
                        .trim()
                        .parse::<u16>()
                        .is_ok_and(|weight| weight >= 600)
            }
            "font-style" => style.italic = value.trim().eq_ignore_ascii_case("italic"),
            "text-decoration" => {
                let value = value.to_ascii_lowercase();
                style.underline = value.contains("underline");
                style.strikeout = value.contains("line-through");
            }
            "opacity" => {
                style.opacity = value.trim().parse::<f64>().ok().map(|v| v.clamp(0.0, 1.0))
            }
            _ => {}
        }
    }
}

fn parse_vtt_class_styles(content: &str) -> HashMap<String, SpanStyle> {
    let mut styles = HashMap::new();
    let lower = content.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative) = lower[offset..].find("::cue(.") {
        let start = offset + relative + 7;
        let Some(close_relative) = lower[start..].find(')') else {
            break;
        };
        let class_end = start + close_relative;
        let class_name = content[start..class_end].trim();
        let Some(open_relative) = lower[class_end..].find('{') else {
            break;
        };
        let open = class_end + open_relative;
        let Some(end_relative) = lower[open + 1..].find('}') else {
            break;
        };
        let end = open + 1 + end_relative;
        let mut style = SpanStyle::default();
        apply_css_declarations(&mut style, &content[open + 1..end]);
        if !class_name.is_empty() {
            styles.insert(class_name.to_ascii_lowercase(), style);
        }
        offset = end + 1;
    }
    styles
}

fn html_font_size_scale(value: &str) -> Option<f64> {
    let number = value.trim().parse::<i32>().ok()?.clamp(1, 7);
    Some([0.65, 0.78, 0.9, 1.0, 1.18, 1.38, 1.62][(number - 1) as usize])
}

fn apply_inline_ass_block(
    block: &str,
    style: &mut SpanStyle,
    base: &SpanStyle,
    placement: &mut Option<SubtitlePlacement>,
    drawing_mode: &mut bool,
    base_font_size: f64,
    play_res: (f64, f64),
) {
    for raw_command in block.split('\\').skip(1) {
        let command = raw_command.trim();
        let lower = command.to_ascii_lowercase();
        if lower.is_empty() {
            continue;
        }
        if let Some(value) = lower
            .strip_prefix("an")
            .and_then(|value| value.parse::<u8>().ok())
        {
            if (1..=9).contains(&value) {
                *placement = Some(alignment_from_an(value));
            }
        } else if lower.starts_with('a') && !lower.starts_with("alpha") {
            if let Ok(value) = lower[1..].parse::<u8>() {
                *placement = alignment_from_legacy_a(value);
            }
        } else if lower.starts_with("pos(") || lower.starts_with("move(") {
            if let Some(inner) = command
                .split_once('(')
                .and_then(|(_, tail)| tail.split_once(')'))
                .map(|v| v.0)
            {
                let values = inner
                    .split(',')
                    .filter_map(|value| value.trim().parse::<f64>().ok())
                    .collect::<Vec<_>>();
                if values.len() >= 2 {
                    *placement = Some(placement_from_position(values[0], values[1], play_res));
                }
            }
        } else if lower.starts_with("1c") || lower.starts_with('c') {
            let raw = if lower.starts_with("1c") {
                &command[2..]
            } else {
                &command[1..]
            };
            if raw.trim().is_empty() {
                style.color = base.color.clone();
            } else if let Some((color, opacity)) = ass_color(raw) {
                style.color = Some(color);
                if opacity.is_some() {
                    style.opacity = opacity;
                }
            }
        } else if lower.starts_with("1a") || lower.starts_with("alpha") {
            let raw = if lower.starts_with("1a") {
                &command[2..]
            } else {
                &command[5..]
            };
            style.opacity = ass_alpha(raw).or(base.opacity);
        } else if let Some(value) = lower.strip_prefix('b') {
            style.bold = ass_toggle(value, base.bold);
        } else if let Some(value) = lower.strip_prefix('i') {
            style.italic = ass_toggle(value, base.italic);
        } else if let Some(value) = lower.strip_prefix('u') {
            style.underline = ass_toggle(value, base.underline);
        } else if let Some(value) = lower.strip_prefix('s') {
            style.strikeout = ass_toggle(value, base.strikeout);
        } else if let Some(value) = command
            .strip_prefix("fn")
            .or_else(|| command.strip_prefix("FN"))
        {
            style.font_family = safe_font_family(value).or_else(|| base.font_family.clone());
        } else if let Some(value) = lower.strip_prefix("fs") {
            style.font_scale = value
                .parse::<f64>()
                .ok()
                .filter(|size| *size > 0.0)
                .map(|size| (size / base_font_size.max(1.0)).clamp(0.5, 2.5));
        } else if let Some(value) = lower
            .strip_prefix('p')
            .and_then(|value| value.parse::<i32>().ok())
        {
            *drawing_mode = value > 0;
        } else if lower.starts_with('r') {
            *style = base.clone();
            *drawing_mode = false;
        }
    }
}

fn parse_mixed_caption(
    value: &str,
    initial: SpanStyle,
    class_styles: &HashMap<String, SpanStyle>,
    initial_placement: Option<SubtitlePlacement>,
) -> RichCaption {
    let base = initial.clone();
    let mut style = initial;
    let mut stack = Vec::<(String, SpanStyle)>::new();
    let mut caption = RichCaption {
        placement: initial_placement,
        ..RichCaption::default()
    };
    let mut index = 0;
    let mut drawing_mode = false;
    while index < value.len() {
        let tail = &value[index..];
        if tail.starts_with('{') {
            if let Some(close) = tail.find('}') {
                apply_inline_ass_block(
                    &tail[1..close],
                    &mut style,
                    &base,
                    &mut caption.placement,
                    &mut drawing_mode,
                    36.0,
                    (384.0, 288.0),
                );
                index += close + 1;
                continue;
            }
        }
        if tail.starts_with('<') {
            if let Some(close) = tail.find('>') {
                let raw_tag = tail[1..close].trim();
                let closing = raw_tag.starts_with('/');
                let tag = raw_tag.trim_start_matches('/').trim();
                let name_end = tag
                    .find(|character: char| character.is_whitespace() || character == '.')
                    .unwrap_or(tag.len());
                let name = tag[..name_end].to_ascii_lowercase();
                if name == "br" {
                    push_span(&mut caption.spans, "\n", &style);
                } else if closing {
                    if let Some(position) =
                        stack.iter().rposition(|(tag_name, _)| tag_name == &name)
                    {
                        style = stack[position].1.clone();
                        stack.truncate(position);
                    }
                } else if matches!(
                    name.as_str(),
                    "b" | "strong" | "i" | "em" | "u" | "s" | "strike" | "font" | "c"
                ) {
                    stack.push((name.clone(), style.clone()));
                    match name.as_str() {
                        "b" | "strong" => style.bold = true,
                        "i" | "em" => style.italic = true,
                        "u" => style.underline = true,
                        "s" | "strike" => style.strikeout = true,
                        "font" => {
                            let attributes = &tag[name_end..];
                            if let Some(color) = tag_attribute(attributes, "color")
                                .and_then(|value| normalize_css_color(&value))
                            {
                                style.color = Some(color);
                            }
                            if let Some(face) = tag_attribute(attributes, "face")
                                .and_then(|value| safe_font_family(&value))
                            {
                                style.font_family = Some(face);
                            }
                            if let Some(scale) = tag_attribute(attributes, "size")
                                .and_then(|value| html_font_size_scale(&value))
                            {
                                style.font_scale = Some(scale);
                            }
                        }
                        "c" => {
                            for class_name in tag.split('.').skip(1) {
                                if let Some(class_style) =
                                    class_styles.get(&class_name.to_ascii_lowercase())
                                {
                                    merge_style(&mut style, class_style);
                                } else if let Some(color) = normalize_css_color(class_name) {
                                    style.color = Some(color);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                index += close + 1;
                continue;
            }
        }
        if tail.starts_with("\\N") || tail.starts_with("\\n") {
            if !drawing_mode {
                push_span(&mut caption.spans, "\n", &style);
            }
            index += 2;
            continue;
        }
        if tail.starts_with("\\h") {
            if !drawing_mode {
                push_span(&mut caption.spans, " ", &style);
            }
            index += 2;
            continue;
        }
        let next = tail
            .char_indices()
            .skip(1)
            .find(|(_, character)| matches!(character, '<' | '{' | '\\' | '&'))
            .map(|(position, _)| position)
            .unwrap_or(tail.len());
        let chunk = &tail[..next];
        if !drawing_mode {
            push_span(&mut caption.spans, &decode_entities(chunk), &style);
        }
        index += next.max(1);
    }
    caption
}

fn merge_style(target: &mut SpanStyle, source: &SpanStyle) {
    target.bold |= source.bold;
    target.italic |= source.italic;
    target.underline |= source.underline;
    target.strikeout |= source.strikeout;
    if source.color.is_some() {
        target.color = source.color.clone();
    }
    if source.background_color.is_some() {
        target.background_color = source.background_color.clone();
    }
    if source.font_family.is_some() {
        target.font_family = source.font_family.clone();
    }
    if source.font_scale.is_some() {
        target.font_scale = source.font_scale;
    }
    if source.opacity.is_some() {
        target.opacity = source.opacity;
    }
}

fn placement_from_vtt_settings(settings: &str) -> Option<SubtitlePlacement> {
    let mut vertical = "bottom";
    let mut horizontal = "center";
    let mut found = false;
    for setting in settings.split_whitespace() {
        let Some((name, value)) = setting.split_once(':') else {
            continue;
        };
        match name.to_ascii_lowercase().as_str() {
            "align" => {
                horizontal = match value
                    .split(',')
                    .next()
                    .unwrap_or(value)
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "start" | "left" => "left",
                    "end" | "right" => "right",
                    _ => "center",
                };
                found = true;
            }
            "position" => {
                if let Ok(percent) = value
                    .trim_end_matches('%')
                    .split(',')
                    .next()
                    .unwrap_or(value)
                    .parse::<f64>()
                {
                    horizontal = if percent < 34.0 {
                        "left"
                    } else if percent > 66.0 {
                        "right"
                    } else {
                        "center"
                    };
                    found = true;
                }
            }
            "line" => {
                let raw = value.split(',').next().unwrap_or(value);
                if let Ok(percent) = raw.trim_end_matches('%').parse::<f64>() {
                    vertical = if percent < 34.0 {
                        "top"
                    } else if percent > 66.0 {
                        "bottom"
                    } else {
                        "middle"
                    };
                    found = true;
                } else if let Ok(line) = raw.parse::<i32>() {
                    vertical = if line >= 0 && line <= 3 {
                        "top"
                    } else {
                        "bottom"
                    };
                    found = true;
                }
            }
            _ => {}
        }
    }
    found.then(|| SubtitlePlacement {
        vertical: vertical.to_owned(),
        horizontal: horizontal.to_owned(),
    })
}

pub(crate) fn parse_subtitle_bytes(bytes: &[u8]) -> Result<Vec<SubtitleCue>, String> {
    let content = decode_subtitle_bytes(bytes).replace('\r', "");
    let class_styles = parse_vtt_class_styles(&content);
    let mut cues = Vec::new();
    for block in content.trim().split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(time_index) = lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let Some((start_raw, end_raw)) = lines[time_index].split_once("-->") else {
            continue;
        };
        let Some(start) = timestamp_to_seconds(start_raw) else {
            continue;
        };
        let mut end_parts = end_raw.split_whitespace();
        let Some(end) = end_parts.next().and_then(timestamp_to_seconds) else {
            continue;
        };
        let settings = end_parts.collect::<Vec<_>>().join(" ");
        let caption = parse_mixed_caption(
            &lines[time_index + 1..].join("\n"),
            SpanStyle::default(),
            &class_styles,
            placement_from_vtt_settings(&settings),
        );
        if let Some(cue) = cue_from_caption(start, end, caption) {
            cues.push(cue);
        }
    }
    if cues.is_empty() {
        return Err("No valid SRT or WebVTT cues were found.".into());
    }
    cues.sort_by(|left, right| left.start.total_cmp(&right.start));
    Ok(cues)
}

fn ass_toggle(value: &str, fallback: bool) -> bool {
    value
        .trim()
        .parse::<i32>()
        .map_or(fallback, |value| value != 0)
}

fn ass_alpha(value: &str) -> Option<f64> {
    let hex = value
        .trim()
        .trim_matches('&')
        .trim_start_matches(['H', 'h']);
    let alpha = u8::from_str_radix(hex.get(hex.len().saturating_sub(2)..)?, 16).ok()?;
    Some(1.0 - f64::from(alpha) / 255.0)
}

fn ass_color(value: &str) -> Option<(String, Option<f64>)> {
    let hex = value
        .trim()
        .trim_matches('&')
        .trim_start_matches(['H', 'h']);
    if hex.len() < 6 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return None;
    }
    let color = &hex[hex.len() - 6..];
    let blue = &color[0..2];
    let green = &color[2..4];
    let red = &color[4..6];
    let opacity = (hex.len() >= 8)
        .then(|| ass_alpha(&hex[..hex.len() - 6]))
        .flatten();
    Some((format!("#{red}{green}{blue}").to_ascii_lowercase(), opacity))
}

fn alignment_from_an(value: u8) -> SubtitlePlacement {
    SubtitlePlacement {
        vertical: match value {
            7..=9 => "top",
            4..=6 => "middle",
            _ => "bottom",
        }
        .to_owned(),
        horizontal: match value {
            1 | 4 | 7 => "left",
            3 | 6 | 9 => "right",
            _ => "center",
        }
        .to_owned(),
    }
}

fn alignment_from_legacy_a(value: u8) -> Option<SubtitlePlacement> {
    let an = match value {
        1 => 1,
        2 => 2,
        3 => 3,
        5 => 7,
        6 => 8,
        7 => 9,
        9 => 4,
        10 => 5,
        11 => 6,
        _ => return None,
    };
    Some(alignment_from_an(an))
}

fn placement_from_position(x: f64, y: f64, play_res: (f64, f64)) -> SubtitlePlacement {
    let (width, height) = play_res;
    SubtitlePlacement {
        vertical: if y < height / 3.0 {
            "top"
        } else if y > height * 2.0 / 3.0 {
            "bottom"
        } else {
            "middle"
        }
        .to_owned(),
        horizontal: if x < width / 3.0 {
            "left"
        } else if x > width * 2.0 / 3.0 {
            "right"
        } else {
            "center"
        }
        .to_owned(),
    }
}

fn parse_ass_bool(value: &str) -> bool {
    value.trim().parse::<i32>().is_ok_and(|value| value != 0)
}

fn field_index(format: &[String], name: &str) -> Option<usize> {
    format
        .iter()
        .position(|field| field.eq_ignore_ascii_case(name))
}

fn parse_ass_style(
    format: &[String],
    value: &str,
    legacy_alignment: bool,
) -> Option<(String, AssStyle)> {
    let fields = value
        .splitn(format.len(), ',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if fields.len() != format.len() {
        return None;
    }
    let name = fields[format.iter().position(|field| field == "name")?].to_ascii_lowercase();
    let mut style = AssStyle::default();
    if let Some(index) = field_index(format, "fontname") {
        style.span.font_family = safe_font_family(fields[index]);
    }
    if let Some(index) = field_index(format, "fontsize") {
        style.font_size = fields[index].parse::<f64>().unwrap_or(36.0).max(1.0);
    }
    if let Some(index) = field_index(format, "primarycolour") {
        if let Some((color, opacity)) = ass_color(fields[index]) {
            style.span.color = Some(color);
            style.span.opacity = opacity;
        }
    }
    if let Some(index) = field_index(format, "bold") {
        style.span.bold = parse_ass_bool(fields[index]);
    }
    if let Some(index) = field_index(format, "italic") {
        style.span.italic = parse_ass_bool(fields[index]);
    }
    if let Some(index) = field_index(format, "underline") {
        style.span.underline = parse_ass_bool(fields[index]);
    }
    if let Some(index) = field_index(format, "strikeout") {
        style.span.strikeout = parse_ass_bool(fields[index]);
    }
    if let Some(index) = field_index(format, "alignment") {
        style.alignment = fields[index].parse::<u8>().ok().and_then(|value| {
            if legacy_alignment {
                alignment_from_legacy_a(value)
            } else {
                (1..=9).contains(&value).then(|| alignment_from_an(value))
            }
        });
    }
    Some((name, style))
}

fn parse_ass_caption(value: &str, base: &AssStyle, play_res: (f64, f64)) -> RichCaption {
    let mut style = base.span.clone();
    let reset_style = base.span.clone();
    let mut caption = RichCaption {
        placement: base.alignment.clone(),
        ..RichCaption::default()
    };
    let mut drawing_mode = false;
    let mut index = 0;
    while index < value.len() {
        let tail = &value[index..];
        if tail.starts_with('{') {
            if let Some(close) = tail.find('}') {
                apply_inline_ass_block(
                    &tail[1..close],
                    &mut style,
                    &reset_style,
                    &mut caption.placement,
                    &mut drawing_mode,
                    base.font_size,
                    play_res,
                );
                index += close + 1;
                continue;
            }
        }
        if tail.starts_with("\\N") || tail.starts_with("\\n") {
            if !drawing_mode {
                push_span(&mut caption.spans, "\n", &style);
            }
            index += 2;
            continue;
        }
        if tail.starts_with("\\h") {
            if !drawing_mode {
                push_span(&mut caption.spans, " ", &style);
            }
            index += 2;
            continue;
        }
        let next = tail
            .char_indices()
            .skip(1)
            .find(|(_, character)| matches!(character, '{' | '\\'))
            .map(|(position, _)| position)
            .unwrap_or(tail.len());
        if !drawing_mode {
            push_span(&mut caption.spans, &decode_entities(&tail[..next]), &style);
        }
        index += next.max(1);
    }
    caption
}

pub(crate) fn parse_ass_subtitle_bytes(bytes: &[u8]) -> Result<Vec<SubtitleCue>, String> {
    let content = decode_subtitle_bytes(bytes).replace('\r', "");
    let mut section = String::new();
    let mut style_format = Vec::<String>::new();
    let mut event_format = Vec::<String>::new();
    let mut styles = HashMap::<String, AssStyle>::new();
    let mut dialogue_lines = Vec::<String>::new();
    let mut play_res = (384.0, 288.0);
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line.to_ascii_lowercase();
            continue;
        }
        let Some((kind, value)) = line.split_once(':') else {
            continue;
        };
        let kind = kind.trim();
        let value = value.trim();
        if section == "[script info]" {
            if kind.eq_ignore_ascii_case("playresx") {
                play_res.0 = value.parse::<f64>().unwrap_or(play_res.0).max(1.0);
            } else if kind.eq_ignore_ascii_case("playresy") {
                play_res.1 = value.parse::<f64>().unwrap_or(play_res.1).max(1.0);
            }
        } else if section == "[v4+ styles]" || section == "[v4 styles]" {
            if kind.eq_ignore_ascii_case("format") {
                style_format = value
                    .split(',')
                    .map(|field| field.trim().to_ascii_lowercase())
                    .collect();
            } else if kind.eq_ignore_ascii_case("style") && !style_format.is_empty() {
                if let Some((name, style)) =
                    parse_ass_style(&style_format, value, section == "[v4 styles]")
                {
                    styles.insert(name, style);
                }
            }
        } else if section == "[events]" {
            if kind.eq_ignore_ascii_case("format") {
                event_format = value
                    .split(',')
                    .map(|field| field.trim().to_ascii_lowercase())
                    .collect();
            } else if kind.eq_ignore_ascii_case("dialogue") {
                dialogue_lines.push(value.to_owned());
            }
        }
    }
    let mut cues = Vec::new();
    for value in dialogue_lines {
        if event_format.is_empty() {
            continue;
        }
        let fields = value
            .splitn(event_format.len(), ',')
            .map(str::trim)
            .collect::<Vec<_>>();
        if fields.len() != event_format.len() {
            continue;
        }
        let Some(start_index) = field_index(&event_format, "start") else {
            continue;
        };
        let Some(end_index) = field_index(&event_format, "end") else {
            continue;
        };
        let Some(text_index) = field_index(&event_format, "text") else {
            continue;
        };
        let (Some(start), Some(end)) = (
            timestamp_to_seconds(fields[start_index]),
            timestamp_to_seconds(fields[end_index]),
        ) else {
            continue;
        };
        let style_name = field_index(&event_format, "style")
            .map(|index| fields[index].to_ascii_lowercase())
            .unwrap_or_else(|| "default".into());
        let base = styles
            .get(&style_name)
            .or_else(|| styles.get("default"))
            .cloned()
            .unwrap_or_default();
        if let Some(cue) = cue_from_caption(
            start,
            end,
            parse_ass_caption(fields[text_index], &base, play_res),
        ) {
            cues.push(cue);
        }
    }
    if cues.is_empty() {
        return Err("No valid ASS or SSA cues were found.".into());
    }
    cues.sort_by(|left, right| left.start.total_cmp(&right.start));
    Ok(cues)
}

pub(crate) fn parse_named_subtitle_bytes(
    name: &str,
    bytes: &[u8],
) -> Result<Vec<SubtitleCue>, String> {
    match Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some(extension)
            if extension.eq_ignore_ascii_case("ass") || extension.eq_ignore_ascii_case("ssa") =>
        {
            parse_ass_subtitle_bytes(bytes)
        }
        _ => parse_subtitle_bytes(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ass_position_and_font_markup_embedded_in_srt() {
        let cues = parse_subtitle_bytes(
            br##"1
00:00:01,000 --> 00:00:03,000
{\an8}<font color="#FFD84D"><b>Medical section</b></font>
"##,
        )
        .expect("styled SRT should parse");
        assert_eq!(cues[0].text, "Medical section");
        assert_eq!(cues[0].placement.as_ref().unwrap().vertical, "top");
        assert_eq!(cues[0].placement.as_ref().unwrap().horizontal, "center");
        assert_eq!(cues[0].spans[0].color.as_deref(), Some("#ffd84d"));
        assert!(cues[0].spans[0].bold);
    }

    #[test]
    fn parses_ass_style_color_alignment_and_inline_formatting() {
        let cues = parse_ass_subtitle_bytes(
            br#"[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Underline, StrikeOut, Alignment
Style: Signs,Arial,48,&H00112233,-1,0,0,0,7

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.25,0:00:03.50,Signs,,0,0,0,,{\i1\c&HFF0000&}Hello{\i0}\Nworld
"#,
        )
        .expect("ASS should parse");
        assert_eq!(cues[0].text, "Hello\nworld");
        assert_eq!(cues[0].placement.as_ref().unwrap().vertical, "top");
        assert_eq!(cues[0].placement.as_ref().unwrap().horizontal, "left");
        assert_eq!(cues[0].spans[0].color.as_deref(), Some("#0000ff"));
        assert!(cues[0].spans[0].italic);
        assert!(cues[0].spans.iter().all(|span| span.bold));
    }

    #[test]
    fn parses_webvtt_class_style_and_cue_settings() {
        let cues = parse_subtitle_bytes(
            br#"WEBVTT

STYLE
::cue(.warning) { color: yellow; background-color: black; font-weight: bold; }

00:00:01.000 --> 00:00:02.500 line:10% position:85% align:end
<c.warning>Watch out</c>
"#,
        )
        .expect("WebVTT should parse");
        assert_eq!(cues[0].text, "Watch out");
        assert_eq!(cues[0].placement.as_ref().unwrap().vertical, "top");
        assert_eq!(cues[0].placement.as_ref().unwrap().horizontal, "right");
        assert_eq!(cues[0].spans[0].color.as_deref(), Some("yellow"));
        assert_eq!(cues[0].spans[0].background_color.as_deref(), Some("black"));
        assert!(cues[0].spans[0].bold);
    }
}
