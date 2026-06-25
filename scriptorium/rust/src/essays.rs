// essays.rs — the shared data/essays.json walking helpers for the build bins
// (content-ast + search-index), ported from the identical logic in
// generate-content-ast.js / generate-search-index.js. Pure (no fs), so the lib
// still compiles cleanly to wasm; the bins do their own file IO around these.

use crate::json_value::Json;

pub fn s(text: &str) -> Json {
    Json::Str(text.encode_utf16().collect())
}

pub fn k(key: &str) -> Vec<u16> {
    key.encode_utf16().collect()
}

/// The `essays` array from a parsed essays.json, deep-copied to owned values
/// (json_value::Json is not Clone).
pub fn essays_array(parsed: &Json) -> Vec<Json> {
    match parsed.get("essays").and_then(|v| v.as_array()) {
        Some(list) => list.iter().map(deep_copy).collect(),
        None => Vec::new(),
    }
}

pub fn essay_slug(essay: &Json) -> String {
    essay.get("slug").and_then(|v| v.as_string()).unwrap_or_default()
}

pub fn essay_title(essay: &Json, slug: &str) -> String {
    truthy_string(essay.get("title")).unwrap_or_else(|| slug.to_string())
}

pub fn essay_summary(essay: &Json) -> String {
    truthy_string(essay.get("summary")).unwrap_or_default()
}

/// (title, subtitle) from essay.section_meta[String(n)], with the JS fallbacks:
/// title → "Section {n}" when absent/empty; subtitle → "".
pub fn section_meta(essay: &Json, n: i64) -> (String, String) {
    let meta = essay.get("section_meta").and_then(|m| m.get(&n.to_string()));
    let title = meta
        .and_then(|m| truthy_string(m.get("title")))
        .unwrap_or_else(|| format!("Section {}", n));
    let subtitle = meta.and_then(|m| truthy_string(m.get("subtitle"))).unwrap_or_default();
    (title, subtitle)
}

/// sourceNameFor: (source_dir || "raw") + "/" + n + ".txt".
pub fn source_name_for(essay: &Json, n: i64) -> String {
    let dir = essay
        .get("source_dir")
        .and_then(|v| v.as_string())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "raw".to_string());
    format!("{}/{}.txt", dir, n)
}

/// JS: `value || fallback` where a non-empty string is truthy.
pub fn truthy_string(value: Option<&Json>) -> Option<String> {
    value.and_then(|v| v.as_string()).filter(|s| !s.is_empty())
}

/// uniqueNumbers: parseInt(String(v),10), keep finite > 0, dedup, preserve order.
pub fn unique_numbers(value: Option<&Json>) -> Vec<i64> {
    let list = match value.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut seen: Vec<i64> = Vec::new();
    let mut out: Vec<i64> = Vec::new();
    for item in list {
        if let Some(n) = to_number(item) {
            if !seen.contains(&n) {
                seen.push(n);
                out.push(n);
            }
        }
    }
    out
}

pub fn to_number(value: &Json) -> Option<i64> {
    let n = parse_int_js(&js_string(value))?;
    if n > 0 {
        Some(n)
    } else {
        None
    }
}

pub fn js_string(value: &Json) -> String {
    match value {
        Json::Int(n) => n.to_string(),
        Json::Str(u) => String::from_utf16_lossy(u),
        Json::Bool(b) => b.to_string(),
        Json::Null => "null".to_string(),
        Json::Float(f) => f.to_string(),
        _ => String::new(),
    }
}

// Number.parseInt(s, 10): skip leading whitespace, optional sign, leading digits.
pub fn parse_int_js(s: &str) -> Option<i64> {
    let bytes = s.trim_start().as_bytes();
    let mut i = 0;
    let mut neg = false;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        neg = bytes[i] == b'-';
        i += 1;
    }
    let start = i;
    let mut value: i64 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        value = value.saturating_mul(10).saturating_add((bytes[i] - b'0') as i64);
        i += 1;
    }
    if i == start {
        return None;
    }
    Some(if neg { -value } else { value })
}

pub fn deep_copy(v: &Json) -> Json {
    match v {
        Json::Null => Json::Null,
        Json::Bool(b) => Json::Bool(*b),
        Json::Int(n) => Json::Int(*n),
        Json::Float(f) => Json::Float(*f),
        Json::Str(u) => Json::Str(u.clone()),
        Json::Array(a) => Json::Array(a.iter().map(deep_copy).collect()),
        Json::Object(o) => {
            Json::Object(o.iter().map(|(key, val)| (key.clone(), deep_copy(val))).collect())
        }
    }
}
