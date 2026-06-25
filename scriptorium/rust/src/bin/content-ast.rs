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

use scriptorium_parser as sp;
use scriptorium_parser::essays::{self, k, s};
use scriptorium_parser::json_value::{self, Json};

const ARTIFACT_VERSION: i64 = 1;
const AST_VERSION: &str = "0.2.0";

fn main() {
    let root = env::var("SCRIPTORIUM_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().expect("cwd"));
    let check = env::args().any(|a| a == "--check");

    let all = load_essays(&root);
    let artifacts: Vec<(String, String, i64)> = all
        .iter()
        .filter(|e| !essays::essay_slug(e).is_empty())
        .map(|e| {
            let slug = essays::essay_slug(e);
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
    let title = essays::essay_title(essay, slug);
    let sections: Vec<Json> = essays::unique_numbers(essay.get("section_order"))
        .into_iter()
        .enumerate()
        .map(|(order, n)| section_record(root, essay, slug, n, order as i64))
        .collect();
    let section_count = sections.len() as i64;

    let artifact = Json::Object(vec![
        (k("version"), Json::Int(ARTIFACT_VERSION)),
        (k("astVersion"), s(AST_VERSION)),
        (k("slug"), s(slug)),
        (k("title"), s(&title)),
        (k("sectionCount"), Json::Int(section_count)),
        (k("sections"), Json::Array(sections)),
    ]);
    (json_value::to_pretty(&artifact, 2) + "\n", section_count)
}

fn section_record(root: &Path, essay: &Json, slug: &str, n: i64, order: i64) -> Json {
    let source_name = essays::source_name_for(essay, n);
    let raw = read_section_source(root, slug, &source_name);
    let units: Vec<u16> = raw.encode_utf16().collect();
    let doc = sp::content_document(&units);

    let (title, subtitle) = essays::section_meta(essay, n);
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
            eprintln!("Missing section file for content compile: {} ({})", source_name, slug);
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
