// scriptorium-parser binary — the batch oracle endpoint.
//
// Speaks a tiny length-prefixed framing on stdin/stdout so the Node harness can
// parse a whole corpus + fuzz set in ONE spawn (don't hammer the machine, and
// avoid needing a JSON parser in Rust). Framing:
//
//   stdin  : repeated [u32 LE byte-length N][N bytes of UTF-16LE source]
//   stdout : repeated [u32 LE byte-length M][M bytes of UTF-8 canonical JSON]
//
// UTF-16LE on the input is deliberate: it is the parser's native unit and it
// round-trips lone surrogates exactly (UTF-8 stdin would mangle them).

use std::io::{self, Read, Write};

fn main() {
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        std::process::exit(1);
    }

    let mut out: Vec<u8> = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= input.len() {
        let len = u32::from_le_bytes([input[pos], input[pos + 1], input[pos + 2], input[pos + 3]]) as usize;
        pos += 4;
        if pos + len > input.len() {
            break; // truncated frame — stop
        }
        let payload = &input[pos..pos + len];
        pos += len;

        let units: Vec<u16> = payload
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();

        let json = scriptorium_parser::parse_to_json(&units);
        let bytes = json.into_bytes();
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&bytes);
    }

    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(&out);
    let _ = handle.flush();
}
