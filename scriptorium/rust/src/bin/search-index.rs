// scriptorium-search-index — the build-time search index, in Rust (Pass 1
// step 3). A faithful port of scripts/generate-search-index.js: per published
// essay/section/passage records + per-term passage-frequency stats (df >= 2,
// keys sorted), emitted to data/search-index.json byte-identical to
// `JSON.stringify(index, null, 2) + "\n"`. Passages reuse the oracle-proven
// consume projection; only tokenization + df tabulation + the wrapper are new.
//
// Modes: default = write; `--check` = fail on drift. Config: SCRIPTORIUM_ROOT.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

use scriptorium_parser as sp;
use scriptorium_parser::essays::{self, k, s};
use scriptorium_parser::json_value::{self, Json};

const INDEX_VERSION: i64 = 1;
const AST_VERSION: &str = "0.2.0";

fn main() {
    let root = env::var("SCRIPTORIUM_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().expect("cwd"));
    let check = env::args().any(|a| a == "--check");

    let all = load_essays(&root);
    let mut texts: Vec<Vec<u16>> = Vec::new();
    let mut essay_records: Vec<Json> = Vec::new();
    let mut total_sections: i64 = 0;
    let mut total_passages: i64 = 0;

    let published: Vec<&Json> = all.iter().filter(|e| is_published(e)).collect();
    for (order, essay) in published.iter().enumerate() {
        let (record, section_count, passage_count) =
            essay_record(&root, essay, order as i64, &mut texts);
        total_sections += section_count;
        total_passages += passage_count;
        essay_records.push(record);
    }

    let (terms, vocabulary, indexed_terms) = build_term_stats(&texts);
    let essays_count = essay_records.len() as i64;

    let index = Json::Object(vec![
        (k("version"), Json::Int(INDEX_VERSION)),
        (k("astVersion"), s(AST_VERSION)),
        (k("essays"), Json::Array(essay_records)),
        (k("terms"), terms),
        (
            k("stats"),
            Json::Object(vec![
                (k("essays"), Json::Int(essays_count)),
                (k("sections"), Json::Int(total_sections)),
                (k("passages"), Json::Int(total_passages)),
                (k("vocabulary"), Json::Int(vocabulary as i64)),
                (k("indexedTerms"), Json::Int(indexed_terms as i64)),
            ]),
        ),
    ]);

    let expected = json_value::to_pretty(&index, 2) + "\n";
    let out_path = root.join("data").join("search-index.json");

    if check {
        let actual = fs::read_to_string(&out_path).unwrap_or_default();
        if actual != expected {
            eprintln!("Out of date: data/search-index.json");
            eprintln!("Run: scriptorium-search-index");
            exit(1);
        }
        println!("Search index is up to date.");
        return;
    }

    fs::create_dir_all(out_path.parent().unwrap()).expect("mkdir data");
    fs::write(&out_path, &expected).expect("write search-index.json");
    println!(
        "Wrote data/search-index.json ({} essays, {} sections, {} passages, ast {})",
        essays_count, total_sections, total_passages, AST_VERSION
    );
}

// --- record assembly --------------------------------------------------------

// publishedEssays: essay.published !== false && slug truthy.
fn is_published(essay: &Json) -> bool {
    !essays::essay_slug(essay).is_empty()
        && !matches!(essay.get("published"), Some(Json::Bool(false)))
}

fn essay_record(
    root: &Path,
    essay: &Json,
    order: i64,
    texts: &mut Vec<Vec<u16>>,
) -> (Json, i64, i64) {
    let slug = essays::essay_slug(essay);
    let title = essays::essay_title(essay, &slug);
    let summary = essays::essay_summary(essay);

    let mut passage_total: i64 = 0;
    let sections: Vec<Json> = essays::unique_numbers(essay.get("section_order"))
        .into_iter()
        .enumerate()
        .map(|(section_order, n)| {
            let (record, passage_count) =
                section_record(root, essay, &slug, n, section_order as i64, texts);
            passage_total += passage_count;
            record
        })
        .collect();
    let section_count = sections.len() as i64;

    let record = Json::Object(vec![
        (k("slug"), s(&slug)),
        (k("title"), s(&title)),
        (k("summary"), s(&summary)),
        (k("order"), Json::Int(order)),
        (k("sectionCount"), Json::Int(section_count)),
        (k("passageCount"), Json::Int(passage_total)),
        (k("sections"), Json::Array(sections)),
    ]);
    (record, section_count, passage_total)
}

fn section_record(
    root: &Path,
    essay: &Json,
    slug: &str,
    n: i64,
    order: i64,
    texts: &mut Vec<Vec<u16>>,
) -> (Json, i64) {
    let source_name = essays::source_name_for(essay, n);
    let raw = read_section_source(root, slug, &source_name);
    let units: Vec<u16> = raw.encode_utf16().collect();
    let doc = sp::content_document(&units);

    let passages = sp::passage_records(&doc);
    let passage_count = passages.len() as i64;
    let mut word_count: i64 = 0;
    for passage in &passages {
        if let Some(Json::Str(text)) = passage.get("text") {
            word_count += sp::word_count_units(text) as i64;
            texts.push(text.clone());
        }
    }

    let (title, subtitle) = essays::section_meta(essay, n);
    let record = Json::Object(vec![
        (k("sectionNumber"), Json::Int(n)),
        (k("order"), Json::Int(order)),
        (k("title"), s(&title)),
        (k("subtitle"), s(&subtitle)),
        (k("wordCount"), Json::Int(word_count)),
        (k("passages"), Json::Array(passages)),
    ]);
    (record, passage_count)
}

// --- term stats -------------------------------------------------------------

// buildTermStats: passage-frequency per term; store terms with df >= 2;
// vocabulary = total distinct terms, indexedTerms = stored count.
//
// Key ORDER must reproduce JS object property ordering exactly: the JS generator
// inserts keys in lexicographic order, but a JS object then emits integer-index
// keys FIRST in ascending numeric order, and the remaining string keys in
// insertion (here: lexicographic) order. So a pure-digit canonical token like
// "5"/"40"/"300" sorts numerically ahead of "000" (non-canonical → string key)
// and "1920s" (has a letter → string key).
fn build_term_stats(texts: &[Vec<u16>]) -> (Json, usize, usize) {
    let mut df: HashMap<String, i64> = HashMap::new();
    for text in texts {
        let mut seen: HashSet<String> = HashSet::new();
        for token in tokenize(text) {
            seen.insert(token);
        }
        for token in seen {
            *df.entry(token).or_insert(0) += 1;
        }
    }
    let vocabulary = df.len();

    // Lexicographic baseline (JS insertion order), then split out integer-index
    // keys to the front in numeric order — matching JS object key ordering.
    let mut keys: Vec<&String> = df.keys().filter(|key| df[*key] >= 2).collect();
    keys.sort();
    let mut index_keys: Vec<(u64, &String)> = Vec::new();
    let mut string_keys: Vec<&String> = Vec::new();
    for key in keys {
        match array_index(key) {
            Some(value) => index_keys.push((value, key)),
            None => string_keys.push(key),
        }
    }
    index_keys.sort_by_key(|(value, _)| *value);

    let mut entries: Vec<(Vec<u16>, Json)> = Vec::new();
    for (_, key) in &index_keys {
        entries.push((k(key), Json::Int(df[*key])));
    }
    for key in &string_keys {
        entries.push((k(key), Json::Int(df[*key])));
    }
    let indexed = entries.len();
    (Json::Object(entries), vocabulary, indexed)
}

// A JS array-index property: ToString(ToUint32(s)) === s && ToUint32(s) != 2^32-1.
// For our [a-z0-9]+ tokens that means a canonical decimal (no leading zero unless
// "0") with value <= 2^32-2; returns the numeric value for ordering.
fn array_index(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None; // leading zero → non-canonical → string key
    }
    let mut value: u64 = 0;
    for &b in bytes {
        value = value * 10 + (b - b'0') as u64;
        if value > 4_294_967_294 {
            return None; // exceeds 2^32-2 → not an array index
        }
    }
    Some(value)
}

// tokenize: String(text).toLowerCase().match(/[a-z0-9]+/g) — maximal ASCII
// alphanumeric runs over the Unicode-lowercased text.
fn tokenize(units: &[u16]) -> Vec<String> {
    let lowered = String::from_utf16_lossy(units).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// --- fs helpers -------------------------------------------------------------

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
    essays::essays_array(&parsed)
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
            eprintln!("Missing section file for search index: {} ({})", source_name, slug);
            exit(1);
        }
    }
}
