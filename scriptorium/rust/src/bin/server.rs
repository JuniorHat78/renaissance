// scriptorium-server — the native author server (SCRIPTORIUM-RUST-PARSER.md R2).
//
// A std-only HTTP/1.1 server (no crates) that replicates scriptorium/server.js's
// contract: serve the project root statically and READ/WRITE raw/<slug>/<n>.txt
// and data/essays.json, with atomic writes and path safety. It is the Node-killer
// — the same behaviour with no JavaScript runtime. Held equivalent to server.js
// by the differential oracle (scripts/tests/rust-server-oracle.js) in CI.
//
// Config via env: SCRIPTORIUM_ROOT (project root; default current dir),
// SCRIPTORIUM_PORT (default 4500). JSON read/write reuses the json_value module
// proven byte-identical to JSON.stringify.

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use scriptorium_parser::json_value::{self, Json};

const DEFAULT_PORT: u16 = 4500;
const DEFAULT_ROUTE: &str = "/scriptorium/editor.html";

fn main() {
    let root = env::var("SCRIPTORIUM_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().expect("cwd"));
    let port: u16 = env::var("SCRIPTORIUM_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("Scriptorium server (rust) running.");
    eprintln!("  Project root: {}", root.display());
    eprintln!("  Open the editor: http://localhost:{}{}", port, DEFAULT_ROUTE);

    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            let root = root.clone();
            thread::spawn(move || {
                let _ = handle_connection(stream, &root);
            });
        }
    }
}

// --- HTTP request -----------------------------------------------------------

struct Request {
    method: String,
    target: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    // Read until the end of headers (\r\n\r\n).
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return None,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    header_end = pos;
                    break;
                }
                if buf.len() > 1024 * 1024 {
                    return None; // runaway headers
                }
            }
            Err(_) => return None,
        }
    }

    let header_bytes = &buf[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut content_length = 0usize;
    for line in lines {
        if let Some(idx) = line.find(':') {
            let name = line[..idx].trim().to_ascii_lowercase();
            let value = line[idx + 1..].trim();
            if name == "content-length" {
                content_length = value.parse().unwrap_or(0);
            }
        }
    }

    // Body = whatever followed the header terminator, plus more reads.
    let mut body: Vec<u8> = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    body.truncate(content_length);

    Some(Request { method, target, body })
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for i in 0..=haystack.len() - needle.len() {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

// --- HTTP response ----------------------------------------------------------

fn send(stream: &mut TcpStream, status: u16, reason: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status, reason, content_type, body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json(stream: &mut TcpStream, status: u16, reason: &str, json: &str) {
    send(stream, status, reason, "application/json; charset=utf-8", json.as_bytes());
}

// Headers only (HEAD), with an explicit Content-Length for the would-be body.
fn send_header_only(stream: &mut TcpStream, status: u16, reason: &str, content_type: &str, content_length: usize) {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status, reason, content_type, content_length
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.flush();
}

fn send_error(stream: &mut TcpStream, status: u16, reason: &str, message: &str) {
    let body = Json::Object(vec![
        (str_units("ok"), Json::Bool(false)),
        (str_units("error"), Json::Str(str_units(message))),
    ]);
    send_json(stream, status, reason, &json_value::to_compact(&body));
}

fn str_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

// --- connection dispatch ----------------------------------------------------

fn handle_connection(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let req = match read_request(&mut stream) {
        Some(r) => r,
        None => return Ok(()),
    };

    let (path, query) = split_target(&req.target);

    // ---- API ----
    if path == "/api/essays" {
        match req.method.as_str() {
            "GET" => handle_get_essays(&mut stream, root),
            "PUT" => handle_put_essays(&mut stream, root, &req.body),
            _ => send_error(&mut stream, 405, "Method Not Allowed", "Method not allowed for /api/essays."),
        }
        return Ok(());
    }
    if path == "/api/section" {
        match req.method.as_str() {
            "GET" => handle_get_section(&mut stream, root, &query),
            "PUT" => handle_put_section(&mut stream, root, &req.body),
            _ => send_error(&mut stream, 405, "Method Not Allowed", "Method not allowed for /api/section."),
        }
        return Ok(());
    }
    if path == "/api/doctor" {
        // The doctor is JS (scriptorium/doctor.js); the native server does not
        // re-implement it (out of R2 scope). Report a clear placeholder; the
        // differential oracle does not compare this route.
        if req.method == "GET" {
            send_json(&mut stream, 200, "OK",
                "{\"ok\":true,\"issues\":[],\"note\":\"doctor runs via the node tooling\"}");
        } else {
            send_error(&mut stream, 405, "Method Not Allowed", "Method not allowed for /api/doctor.");
        }
        return Ok(());
    }
    if path == "/api" || path.starts_with("/api/") {
        send_error(&mut stream, 404, "Not Found", &format!("Unknown API route: {}", path));
        return Ok(());
    }

    // ---- static ----
    if req.method != "GET" && req.method != "HEAD" {
        send_error(&mut stream, 405, "Method Not Allowed", "Method not allowed.");
        return Ok(());
    }
    if path == "/" || path.is_empty() {
        let header = format!(
            "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            DEFAULT_ROUTE
        );
        let _ = stream.write_all(header.as_bytes());
        return Ok(());
    }
    serve_static(&mut stream, root, &path, req.method == "HEAD");
    Ok(())
}

fn split_target(target: &str) -> (String, Vec<(String, String)>) {
    let (p, q) = match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    };
    let mut query = Vec::new();
    if !q.is_empty() {
        for pair in q.split('&') {
            let (k, v) = match pair.find('=') {
                Some(i) => (&pair[..i], &pair[i + 1..]),
                None => (pair, ""),
            };
            query.push((percent_decode_lossy(k), percent_decode_lossy(v)));
        }
    }
    (p.to_string(), query)
}

fn query_get<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

// --- API handlers -----------------------------------------------------------

fn handle_get_essays(stream: &mut TcpStream, root: &Path) {
    let path = root.join("data").join("essays.json");
    let raw = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            send_error(stream, 500, "Internal Server Error",
                &format!("Unable to read data/essays.json: {}", e));
            return;
        }
    };
    let units: Vec<u16> = String::from_utf8_lossy(&raw).encode_utf16().collect();
    match json_value::parse(&units) {
        Ok(v) => send_json(stream, 200, "OK", &json_value::to_compact(&v)),
        Err(e) => send_error(stream, 500, "Internal Server Error",
            &format!("data/essays.json is not valid JSON: {}", e.0)),
    }
}

fn handle_put_essays(stream: &mut TcpStream, root: &Path, body: &[u8]) {
    let units: Vec<u16> = String::from_utf8_lossy(body).encode_utf16().collect();
    let parsed = match json_value::parse(&units) {
        Ok(v) => v,
        Err(_) => {
            send_error(stream, 400, "Bad Request", "Request body is not valid JSON.");
            return;
        }
    };
    if !parsed.is_object() {
        send_error(stream, 400, "Bad Request", "Expected a JSON object for essays.json.");
        return;
    }
    let serialized = json_value::to_pretty(&parsed, 2) + "\n";
    let path = root.join("data").join("essays.json");
    match atomic_write(&path, serialized.as_bytes()) {
        Ok(_) => send_json(stream, 200, "OK", "{\"ok\":true}"),
        Err(e) => send_error(stream, 500, "Internal Server Error", &e),
    }
}

fn handle_get_section(stream: &mut TcpStream, root: &Path, query: &[(String, String)]) {
    let slug = query_get(query, "slug").unwrap_or("");
    let n = query_get(query, "n").unwrap_or("");
    let safe = match safe_section_path(root, slug, n) {
        Ok(p) => p,
        Err((code, msg)) => {
            send_error(stream, code, status_reason(code), &msg);
            return;
        }
    };
    let text = match fs::read(&safe) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            send_error(stream, 500, "Internal Server Error", &format!("read failed: {}", e));
            return;
        }
    };
    let nnum: i64 = n.parse().unwrap_or(0);
    let obj = Json::Object(vec![
        (str_units("slug"), Json::Str(str_units(slug))),
        (str_units("n"), Json::Int(nnum)),
        (str_units("text"), Json::Str(text.encode_utf16().collect())),
    ]);
    send_json(stream, 200, "OK", &json_value::to_compact(&obj));
}

fn handle_put_section(stream: &mut TcpStream, root: &Path, body: &[u8]) {
    let units: Vec<u16> = String::from_utf8_lossy(body).encode_utf16().collect();
    let parsed = match json_value::parse(&units) {
        Ok(v) => v,
        Err(_) => {
            send_error(stream, 400, "Bad Request", "Request body is not valid JSON.");
            return;
        }
    };
    if !parsed.is_object() {
        send_error(stream, 400, "Bad Request", "Expected a JSON object { slug, n, text }.");
        return;
    }
    let slug = parsed.get("slug").and_then(|v| v.as_string()).unwrap_or_default();
    let n_str = match parsed.get("n") {
        Some(Json::Int(i)) => i.to_string(),
        Some(Json::Str(u)) => String::from_utf16_lossy(u),
        _ => String::new(),
    };
    let text = match parsed.get("text") {
        Some(Json::Str(u)) => String::from_utf16_lossy(u),
        Some(_) => {
            send_error(stream, 400, "Bad Request", "Field 'text' must be a string.");
            return;
        }
        None => {
            send_error(stream, 400, "Bad Request", "Field 'text' must be a string.");
            return;
        }
    };

    let safe = match safe_section_path(root, &slug, &n_str) {
        Ok(p) => p,
        Err((code, msg)) => {
            send_error(stream, code, status_reason(code), &msg);
            return;
        }
    };
    // Normalize line endings on save (\r\n? -> \n), matching server.js.
    let normalized = normalize_newlines(&text);
    match atomic_write(&safe, normalized.as_bytes()) {
        Ok(_) => send_json(stream, 200, "OK", "{\"ok\":true}"),
        Err(e) => send_error(stream, 500, "Internal Server Error", &e),
    }
}

fn normalize_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '\r' {
            out.push('\n');
            if i + 1 < bytes.len() && bytes[i + 1] == '\n' {
                i += 2;
            } else {
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

// --- path safety + source_dir resolution ------------------------------------

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn safe_section_path(root: &Path, slug: &str, n: &str) -> Result<PathBuf, (u16, String)> {
    if !is_valid_slug(slug) {
        return Err((400, "Invalid slug (expected [a-z0-9-]+).".to_string()));
    }
    let num: u64 = match n.parse() {
        Ok(v) if v > 0 => v,
        _ => return Err((400, "Invalid section number (expected a positive integer).".to_string())),
    };
    let source_dir = resolve_source_dir(root, slug)?;
    let mut candidate = root.to_path_buf();
    for part in source_dir.split(['/', '\\']) {
        if !part.is_empty() {
            candidate.push(part);
        }
    }
    candidate.push(format!("{}.txt", num));
    if !is_inside(root, &candidate) {
        return Err((400, "Refusing path outside the project root.".to_string()));
    }
    Ok(candidate)
}

fn resolve_source_dir(root: &Path, slug: &str) -> Result<String, (u16, String)> {
    let essays_path = root.join("data").join("essays.json");
    let raw = match fs::read(&essays_path) {
        Ok(b) => b,
        Err(_) => return Ok(format!("raw/{}", slug)), // tolerate; default
    };
    let units: Vec<u16> = String::from_utf8_lossy(&raw).encode_utf16().collect();
    let parsed = match json_value::parse(&units) {
        Ok(v) => v,
        Err(_) => return Ok(format!("raw/{}", slug)),
    };
    let essays = parsed.get("essays").and_then(|v| v.as_array());
    let mut matches: Vec<String> = Vec::new();
    if let Some(list) = essays {
        for essay in list {
            if let Some(s) = essay.get("slug").and_then(|v| v.as_string()) {
                if s.trim() == slug {
                    let declared = essay
                        .get("source_dir")
                        .and_then(|v| v.as_string())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    matches.push(declared);
                }
            }
        }
    }
    if matches.len() > 1 {
        return Err((400, format!(
            "Ambiguous slug \"{}\": {} essays in data/essays.json share it. Slugs must be unique.",
            slug, matches.len()
        )));
    }
    if matches.len() == 1 && !matches[0].is_empty() {
        return Ok(matches.remove(0));
    }
    Ok(format!("raw/{}", slug))
}

// Lexically resolve a relative request path under root, rejecting escapes.
fn safe_static_path(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    if decoded.contains('\0') {
        return None;
    }
    let trimmed = decoded.trim_start_matches('/');
    let mut candidate = root.to_path_buf();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(p) => candidate.push(p),
            Component::CurDir => {}
            Component::ParentDir => {
                if !candidate.pop() || !candidate.starts_with(root) {
                    return None;
                }
            }
            _ => return None,
        }
    }
    if is_inside(root, &candidate) {
        Some(candidate)
    } else {
        None
    }
}

fn is_inside(root: &Path, child: &Path) -> bool {
    child.starts_with(root)
}

// --- static serving ---------------------------------------------------------

fn serve_static(stream: &mut TcpStream, root: &Path, path: &str, head_only: bool) {
    let file = match safe_static_path(root, path) {
        Some(p) => p,
        None => {
            send_error(stream, 400, "Bad Request", "Refusing path outside the project root.");
            return;
        }
    };
    let meta = match fs::metadata(&file) {
        Ok(m) => m,
        Err(_) => {
            send_error(stream, 404, "Not Found", "Not found.");
            return;
        }
    };
    if meta.is_dir() {
        send_error(stream, 404, "Not Found", "Not found.");
        return;
    }
    let ctype = content_type_for(&file);
    if head_only {
        // HEAD: headers only, but report the real entity length (like server.js
        // and per HTTP semantics) — not 0.
        send_header_only(stream, 200, "OK", ctype, meta.len() as usize);
        return;
    }
    match fs::read(&file) {
        Ok(bytes) => send(stream, 200, "OK", ctype, &bytes),
        Err(_) => send_error(stream, 500, "Internal Server Error", "read failed"),
    }
}

fn content_type_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// --- atomic write -----------------------------------------------------------

// Per-write counter so two concurrent writes never pick the same temp name
// (process id + nanos guard against collisions across processes; the counter
// guards within this process — matching the uniqueness server.js got from
// crypto.randomBytes).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn atomic_write(dest: &Path, data: &[u8]) -> Result<(), String> {
    let dir = dest.parent().ok_or_else(|| "no parent dir".to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(
        ".{}.{}.{}.{}.tmp",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("out"),
        std::process::id(),
        nanos,
        seq
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

// --- percent decoding -------------------------------------------------------

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex(bytes[i + 1])?;
            let lo = hex(bytes[i + 2])?;
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_decode_lossy(s: &str) -> String {
    percent_decode(s).unwrap_or_else(|| s.to_string())
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn status_reason(code: u16) -> &'static str {
    match code {
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    }
}
