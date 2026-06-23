// escape.rs — the single JSON string escaper, shared by the AST serializer
// (json.rs) and the value serializer (json_value.rs) so the two cannot drift.
//
// Matches JSON.stringify: named escapes for \b \f \n \r \t, \uXXXX (lower-case)
// for other controls and lone surrogates, valid surrogate pairs decoded to UTF-8.

pub fn write_json_string(s: &mut String, units: &[u16]) {
    s.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => s.push_str("\\\""),
            0x5C => s.push_str("\\\\"),
            0x08 => s.push_str("\\b"),
            0x0C => s.push_str("\\f"),
            0x0A => s.push_str("\\n"),
            0x0D => s.push_str("\\r"),
            0x09 => s.push_str("\\t"),
            0x00..=0x1F => s.push_str(&format!("\\u{:04x}", u)),
            0xD800..=0xDBFF => {
                // High surrogate: pair with a following low surrogate if present.
                if i + 1 < units.len() && (0xDC00..=0xDFFF).contains(&units[i + 1]) {
                    let hi = u as u32;
                    let lo = units[i + 1] as u32;
                    let c = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                    if let Some(ch) = char::from_u32(c) {
                        s.push(ch);
                    }
                    i += 2;
                    continue;
                }
                s.push_str(&format!("\\u{:04x}", u)); // lone high surrogate
            }
            0xDC00..=0xDFFF => s.push_str(&format!("\\u{:04x}", u)), // lone low surrogate
            _ => {
                if let Some(ch) = char::from_u32(u as u32) {
                    s.push(ch);
                }
            }
        }
        i += 1;
    }
    s.push('"');
}
