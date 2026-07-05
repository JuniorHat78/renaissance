//! Byte ↔ buffer codec (SCRIPTORIUM-NATIVE-IO.md §3): the pure bijection-with-memory between a
//! file's bytes and our **UTF-16, LF-only** buffer. Decoding remembers the file's encoding and
//! newline convention so a later save round-trips it byte-faithfully; new documents default to
//! BOM-less UTF-8 + LF (the coherent default for the buffer and the markdown pipeline).
//!
//! Platform-free and **un-gated** (like `buffer`/`grapheme`/`parse`), so the round-trip oracles
//! run on every CI platform, not just Windows. Only the file *dialogs* + the byte read/write are
//! `win32`'s; the encoding/newline logic lives here where it can be fuzzed anywhere.
//!
//! Decode/encode are **total** — malformed input never errors, it degrades to U+FFFD (a truncated
//! or mojibake file opens rather than refusing), so there is no failure path that can strand the
//! user mid-open.

/// How a file's bytes are encoded. Detected from the leading BOM on decode (else BOM-less UTF-8),
/// remembered on the document, and reapplied verbatim on save.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    /// UTF-8 with no byte-order mark — the default, and the project's markdown convention.
    Utf8,
    /// UTF-8 preceded by the `EF BB BF` BOM.
    Utf8Bom,
    /// UTF-16, little-endian, `FF FE` BOM.
    Utf16Le,
    /// UTF-16, big-endian, `FE FF` BOM.
    Utf16Be,
}

/// A file's newline convention. Detected from the first line ending on decode (else LF),
/// remembered on the document, and reapplied on save — an opened CRLF file stays CRLF.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Newline {
    /// `\n` — the internal buffer convention and the default for new documents.
    Lf,
    /// `\r\n` — the Windows convention; preserved when a file arrives with it.
    Crlf,
    /// `\r` — classic Mac; rare, but detected and preserved rather than silently rewritten.
    Cr,
}

/// The result of decoding file bytes: the LF-internal units plus what the file *was*, so the
/// document can round-trip it on save.
pub struct Decoded {
    pub units: Vec<u16>,
    pub encoding: Encoding,
    pub newline: Newline,
}

const LF: u16 = 0x000A;
const CR: u16 = 0x000D;

/// Decode file bytes into LF-internal UTF-16 units, detecting (and returning) the encoding and
/// newline convention. Total: malformed bytes become U+FFFD, a trailing odd UTF-16 byte is
/// dropped — decode never fails (SCRIPTORIUM-NATIVE-IO.md §3).
pub fn decode(bytes: &[u8]) -> Decoded {
    let (encoding, body) = detect_encoding(bytes);
    let raw = bytes_to_units(body, encoding);
    let newline = detect_newline(&raw);
    let units = normalize_newlines(&raw);
    Decoded { units, encoding, newline }
}

/// Encode LF-internal units into file bytes in the given encoding + newline convention (the
/// inverse of `decode` for consistently-terminated input). Total: unpaired surrogates become
/// U+FFFD. Prepends the BOM for the BOM-bearing encodings.
pub fn encode(units: &[u16], enc: Encoding, nl: Newline) -> Vec<u8> {
    let denorm = apply_newline(units, nl);
    match enc {
        Encoding::Utf8 => String::from_utf16_lossy(&denorm).into_bytes(),
        Encoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend(String::from_utf16_lossy(&denorm).into_bytes());
            out
        }
        Encoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            out.extend(denorm.iter().flat_map(|u| u.to_le_bytes()));
            out
        }
        Encoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            out.extend(denorm.iter().flat_map(|u| u.to_be_bytes()));
            out
        }
    }
}

/// Detect the encoding from a leading BOM and return it with the body after the BOM. BOM-less is
/// UTF-8 (the common case). `FF FE 00 00` UTF-32LE is read as UTF-16LE — unsupported, noted (§3).
fn detect_encoding(bytes: &[u8]) -> (Encoding, &[u8]) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (Encoding::Utf8Bom, &bytes[3..])
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (Encoding::Utf16Le, &bytes[2..])
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (Encoding::Utf16Be, &bytes[2..])
    } else {
        (Encoding::Utf8, bytes)
    }
}

/// Body bytes → UTF-16 units in the detected encoding. UTF-8 is decoded lossily (malformed →
/// U+FFFD); UTF-16 pairs bytes in the right endianness, dropping a trailing odd byte.
fn bytes_to_units(body: &[u8], enc: Encoding) -> Vec<u16> {
    match enc {
        Encoding::Utf8 | Encoding::Utf8Bom => String::from_utf8_lossy(body).encode_utf16().collect(),
        Encoding::Utf16Le => body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect(),
        Encoding::Utf16Be => body
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect(),
    }
}

/// The file's dominant newline convention: the first line ending wins (`\r\n`→Crlf, lone
/// `\r`→Cr, lone `\n`→Lf); a file with none defaults to Lf.
fn detect_newline(units: &[u16]) -> Newline {
    let mut i = 0;
    while i < units.len() {
        match units[i] {
            CR => {
                return if i + 1 < units.len() && units[i + 1] == LF {
                    Newline::Crlf
                } else {
                    Newline::Cr
                }
            }
            LF => return Newline::Lf,
            _ => {}
        }
        i += 1;
    }
    Newline::Lf
}

/// Normalize every CRLF and lone CR to LF for the internal buffer. A mixed-ending file collapses
/// to LF-only here and will re-encode to a single convention on save (§3, ledgered).
fn normalize_newlines(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        if units[i] == CR {
            out.push(LF);
            if i + 1 < units.len() && units[i + 1] == LF {
                i += 1; // consume the LF of a CRLF pair
            }
        } else {
            out.push(units[i]);
        }
        i += 1;
    }
    out
}

/// Map each internal LF to the target newline convention (the inverse of `normalize_newlines`).
fn apply_newline(units: &[u16], nl: Newline) -> Vec<u16> {
    match nl {
        Newline::Lf => units.to_vec(),
        Newline::Crlf => {
            let mut out = Vec::with_capacity(units.len());
            for &u in units {
                if u == LF {
                    out.push(CR);
                    out.push(LF);
                } else {
                    out.push(u);
                }
            }
            out
        }
        Newline::Cr => units.iter().map(|&u| if u == LF { CR } else { u }).collect(),
    }
}

// --- codec oracles (SCRIPTORIUM-NATIVE-IO.md §9) ------------------------------
// Pure — no Win32, no fs — so the byte round-trip is pinned on every CI platform. The headline
// property is the byte-faithful bijection for well-formed, consistently-terminated input, plus
// the units-survive-the-trip inverse and the deliberate mixed-ending normalization.
#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// Sample text spanning ASCII, an accent, CJK, and an emoji (a surrogate pair) — the
    /// interesting UTF-16 / UTF-8 boundaries, with LF-internal line breaks.
    fn sample() -> Vec<u16> {
        u("Hello, world\ncafé — 文字\n😀 end")
    }

    #[test]
    fn bom_detection_picks_the_encoding_and_strips_the_mark() {
        assert_eq!(detect_encoding(&[0xEF, 0xBB, 0xBF, b'a']).0, Encoding::Utf8Bom);
        assert_eq!(detect_encoding(&[0xEF, 0xBB, 0xBF, b'a']).1, b"a");
        assert_eq!(detect_encoding(&[0xFF, 0xFE, 0x61, 0x00]).0, Encoding::Utf16Le);
        assert_eq!(detect_encoding(&[0xFE, 0xFF, 0x00, 0x61]).0, Encoding::Utf16Be);
        assert_eq!(detect_encoding(b"plain").0, Encoding::Utf8);
        assert_eq!(detect_encoding(b"plain").1, b"plain");
    }

    #[test]
    fn newline_detection_takes_the_first_ending() {
        assert_eq!(detect_newline(&u("a\r\nb")), Newline::Crlf);
        assert_eq!(detect_newline(&u("a\rb")), Newline::Cr);
        assert_eq!(detect_newline(&u("a\nb")), Newline::Lf);
        assert_eq!(detect_newline(&u("no ending here")), Newline::Lf);
        // A CRLF earlier than a lone LF still reads Crlf (first wins).
        assert_eq!(detect_newline(&u("a\r\nb\nc")), Newline::Crlf);
    }

    #[test]
    fn bytes_round_trip_for_every_encoding_and_newline() {
        // encode(decode(bytes)) == bytes for well-formed, consistently-terminated input.
        for &enc in &[Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le, Encoding::Utf16Be] {
            for &nl in &[Newline::Lf, Newline::Crlf, Newline::Cr] {
                let bytes = encode(&sample(), enc, nl);
                let d = decode(&bytes);
                assert_eq!(d.encoding, enc, "encoding survives the trip ({enc:?}/{nl:?})");
                assert_eq!(d.newline, nl, "newline survives the trip ({enc:?}/{nl:?})");
                let reencoded = encode(&d.units, d.encoding, d.newline);
                assert_eq!(reencoded, bytes, "bytes are byte-faithful ({enc:?}/{nl:?})");
            }
        }
    }

    #[test]
    fn units_survive_the_trip() {
        // decode(encode(u,e,n)).units == u for any LF-internal u.
        for &enc in &[Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le, Encoding::Utf16Be] {
            for &nl in &[Newline::Lf, Newline::Crlf, Newline::Cr] {
                let d = decode(&encode(&sample(), enc, nl));
                assert_eq!(d.units, sample(), "LF-internal units preserved ({enc:?}/{nl:?})");
            }
        }
    }

    #[test]
    fn mixed_endings_normalize_to_lf_then_a_single_convention() {
        // A file with both CRLF and lone LF decodes to LF-only units...
        let d = decode(b"a\r\nb\nc\r\nd");
        assert!(!d.units.contains(&CR), "no CR survives into the buffer");
        assert_eq!(String::from_utf16(&d.units).unwrap(), "a\nb\nc\nd");
        // ...and the first ending (CRLF) is what a save reapplies — consistently.
        assert_eq!(d.newline, Newline::Crlf);
        let out = encode(&d.units, d.encoding, d.newline);
        assert_eq!(out, b"a\r\nb\r\nc\r\nd", "re-encode is single-convention CRLF");
    }

    #[test]
    fn malformed_input_is_lossy_not_a_panic() {
        // A stray continuation byte (invalid UTF-8) → U+FFFD, decode still succeeds.
        let d = decode(&[0x61, 0xFF, 0x62]);
        assert_eq!(d.encoding, Encoding::Utf8);
        assert_eq!(d.units, u("a\u{FFFD}b"));
        // An odd-length UTF-16LE body drops the trailing byte rather than panicking.
        let d = decode(&[0xFF, 0xFE, 0x61, 0x00, 0x62]);
        assert_eq!(d.units, u("a"));
    }

    #[test]
    fn empty_and_no_newline_inputs_are_clean() {
        let d = decode(b"");
        assert!(d.units.is_empty());
        assert_eq!(d.encoding, Encoding::Utf8);
        assert_eq!(d.newline, Newline::Lf);
        // A BOM with an empty body still remembers its encoding so a re-save keeps the BOM.
        let d = decode(&[0xEF, 0xBB, 0xBF]);
        assert!(d.units.is_empty());
        assert_eq!(d.encoding, Encoding::Utf8Bom);
        assert_eq!(encode(&d.units, d.encoding, d.newline), vec![0xEF, 0xBB, 0xBF]);
    }
}
