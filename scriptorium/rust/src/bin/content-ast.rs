// scriptorium-content-ast — the build-time content compiler, in Rust (Pass 1
// step 2). A faithful port of scripts/generate-content-ast.js: read
// data/essays.json, walk each essay's section_order, parse each raw/<n>.txt →
// withoutLeadingHeadings, and emit data/compiled/<slug>.json byte-identical to
// `JSON.stringify(artifact, null, 2) + "\n"`. With this and the search-index bin,
// the build pipeline has zero parse.js consumers (the R3 cutover, step 4).
//
// Modes: default = write artifacts (+ remove orphans); `--check` = fail if any
// committed artifact drifts. Config: SCRIPTORIUM_ROOT (default cwd).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

use scriptorium_parser::json_value::{self, Json};
use scriptorium_parser as sp;

const ARTIFACT_VERSION: i64 = 1;
const AST_VERSION: &str = "0.2.0";

fn main() {
    let root = env::var("SCRIPTORIUM_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().expect("cwd"));
    let check = env::args().any(|a| a == "--check");

    let essays = load_essays(&root);
    let artifacts: Vec<(String, String, i64)> = compilable(&essays)
        .iter()
        .map(|e| {
            let slug = essay_slug(e);
            let (content, section_count) = essay_artifact(&root, e, &slug);
            (slug, content, section_count)
        })
        .collect();

    let out_dir = root.join("data").join("compiled");
    let expected: Vec<String> = artifacts.iter().map(|(s, _, _)| format!("{}.json", s)).collect();
    let orphans: Vec<String> = list_compiled(&out_dir)
        .into_iter()
        .filter(|name| !expected.contains(name))
        .collect();

    if check {
        let mut problems: Vec<String> = Vec::new();
        for (slug, content, _) in &artifacts {
            let file = out_dir.join(format!("{}.json", slug));
            let actual = fs::read_to_string(&file).unwrap_or_default();
            if actual != *content {
                problems.push(format!("out of date: data/compiled/{}.json", slug));
            }
        }
        for orphan in &orphans {
            problems.push(format!("orphaned (essay removed): data/compiled/{}", orphan));
        }
        if !problems.is_empty() {
            eprintln!("Compiled content AST is stale:");
            for p in &problems {
                eprintln!("  - {}", p);
            }
            eprintln!("Run: scriptorium-content-ast");
            exit(1);
        }
        println!("Compiled content AST is up to date ({} essays).", artifacts.len());
        return;
    }

    fs::create_dir_all(&out_dir).expect("mkdir data/compiled");
    for (slug, content, _) in &artifacts {
        fs::write(out_dir.join(format!("{}.json", slug)), content).expect("write artifact");
    }
    for orphan in &orphans {
        let _ = fs::remove_file(out_dir.join(orphan));
    }

    let sections: i64 = artifacts.iter().map(|(_, _, n)| n).sum();
    let mut msg = format!(
        "Wrote {} compiled essay artifact(s) to data/compiled/ ({} sections, ast {})",
        artifacts.len(),
        sections,
        AST_VERSION
    );
    if !orphans.is_empty() {
        msg.push_str(&format!("; removed {} orphan(s)", orphans.len()));
    }
    println!("{}", msg);
}

// --- artifact assembly ------------------------------------------------------

fn essay_artifact(root: &Path, essay: &Json, slug: &str) -> (String, i64) {
    let title = essay_title(essay, slug);
    let sections: Vec<(i64, Json)> = unique_numbers(essay.get("section_order"))
        .into_iter()
        .enumerate()
        .map(|(order, n)| (n, section_record(root, essay, slug, n, order as i64)))
        .collect();
    let section_count = sections.len() as i64;

    let artifact = Json::Object(vec![
        (k("version"), Json::Int(ARTIFACT_VERSION)),
        (k("astVersion"), s(AST_VERSION)),
        (k("slug"), s(slug)),
        (k("title"), s(&title)),
        (k("sectionCount"), Json::Int(section_count)),
        (k("sections"), Json::Array(sections.into_iter().map(|(_, r)| r).collect())),
    ]);
    (json_value::to_pretty(&artifact, 2) + "\n", section_count)
}

fn section_record(root: &Path, essay: &Json, slug: &str, n: i64, order: i64) -> Json {
    let source_name = source_name_for(essay, n);
    let raw = read_section_source(root, slug, &source_name);
    let units: Vec<u16> = raw.encode_utf16().collect();
    let doc = sp::content_document(&units);

    let (title, subtitle) = section_meta(essay, n);
    let name_units: Vec<u16> = source_name.encode_utf16().collect();
    Json::Object(vec![
        (k("sectionNumber"), Json::Int(n)),
        (k("order"), Json::Int(order)),
        (k("title"), s(&title)),
        (k("subtitle"), s(&subtitle)),
        (k("wordCount"), Json::Int(sp::searchable_word_count(&doc) as i64)),
        (k("passageCount"), Json::Int(sp::passage_count(&doc) as i64)),
        (k("ast"), sp::document_to_json(&doc, Some(&name_units))),
    ])
}

// --- essays.json helpers (mirror generate-content-ast.js) -------------------

fn load_essays(root: &Path) -> Vec<Json> {
    let path = root.join("data").join("essays.json");
    let raw = fs::read(&path).unwrap_or_else(|e| {
        eprintln!("Unable to read data/essays.json: {}", e);
        exit(1);
    });
    let units: Vec<u16> = String::from_utf8_lossy(&raw).encode_utf16().collect();
    let parsed = json_value::parse(&units).unwrap_or_else(|e| {
        eprintln!("data/essays.json is not valid JSON: {}", e.0);
        exit(1);
    });
    match parsed.get("essays").and_then(|v| v.as_array()) {
        Some(list) => clone_array(list),
        None => Vec::new(),
    }
}

// essay && essay.slug — compilable (published or draft; gating happens elsewhere).
fn compilable(essays: &[Json]) -> Vec<&Json> {
    essays.iter().filter(|e| !essay_slug(e).is_empty()).collect()
}

fn essay_slug(essay: &Json) -> String {
    essay.get("slug").and_then(|v| v.as_string()).unwrap_or_default()
}

fn essay_title(essay: &Json, slug: &str) -> String {
    truthy_string(essay.get("title")).unwrap_or_else(|| slug.to_string())
}

fn section_meta(essay: &Json, n: i64) -> (String, String) {
    let meta = essay
        .get("section_meta")
        .and_then(|m| m.get(&n.to_string()));
    let title = meta
        .and_then(|m| truthy_string(m.get("title")))
        .unwrap_or_else(|| format!("Section {}", n));
    let subtitle = meta.and_then(|m| truthy_string(m.get("subtitle"))).unwrap_or_default();
    (title, subtitle)
}

fn source_name_for(essay: &Json, n: i64) -> String {
    let dir = essay
        .get("source_dir")
        .and_then(|v| v.as_string())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "raw".to_string());
    format!("{}/{}.txt", dir, n)
}

fn read_section_source(root: &Path, slug: &str, source_name: &str) -> String {
    let mut path = root.to_path_buf();
    for part in source_name.split('/') {
        if !part.is_empty() {
            path.push(part);
        }
    }
    match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).replace("\r\n", "\n"),
        Err(_) => {
            eprintln!(
                "Missing section file for content compile: {} ({})",
                source_name, slug
            );
            exit(1);
        }
    }
}

fn list_compiled(out_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(out_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json"))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

// --- value helpers ----------------------------------------------------------

fn s(text: &str) -> Json {
    Json::Str(text.encode_utf16().collect())
}

fn k(key: &str) -> Vec<u16> {
    key.encode_utf16().collect()
}

// JS: value || fallback where a non-empty string is truthy. Returns Some only for
// a present, non-empty string value.
fn truthy_string(value: Option<&Json>) -> Option<String> {
    value.and_then(|v| v.as_string()).filter(|s| !s.is_empty())
}

// uniqueNumbers: parseInt(String(v),10), keep finite > 0, dedup, preserve order.
fn unique_numbers(value: Option<&Json>) -> Vec<i64> {
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

fn to_number(value: &Json) -> Option<i64> {
    let n = parse_int_js(&js_string(value))?;
    if n > 0 {
        Some(n)
    } else {
        None
    }
}

fn js_string(value: &Json) -> String {
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
fn parse_int_js(s: &str) -> Option<i64> {
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

// json_value::Json is not Clone; rebuild the array entries we keep by reference
// into owned values via a re-parse-free deep copy.
fn clone_array(list: &[Json]) -> Vec<Json> {
    list.iter().map(deep_copy).collect()
}

fn deep_copy(v: &Json) -> Json {
    match v {
        Json::Null => Json::Null,
        Json::Bool(b) => Json::Bool(*b),
        Json::Int(n) => Json::Int(*n),
        Json::Float(f) => Json::Float(*f),
        Json::Str(u) => Json::Str(u.clone()),
        Json::Array(a) => Json::Array(a.iter().map(deep_copy).collect()),
        Json::Object(o) => Json::Object(o.iter().map(|(key, val)| (key.clone(), deep_copy(val))).collect()),
    }
}
