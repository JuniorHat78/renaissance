// json_value.rs — a minimal std-only JSON value: parse + serialize, no serde (§7).
//
// Used by the Rust server (R2) to read/write data/essays.json and build API
// responses byte-compatibly with Node's JSON.stringify. Object key order is
// preserved (insertion order, like JSON.parse→stringify). Strings are kept as
// UTF-16 code units so escaping matches JSON.stringify exactly (incl. lone
// surrogates). Numbers: integer-valued JSON in i64 range round-trips exactly
// (which is all data/essays.json uses); other reals fall back to Rust's f64
// formatting (a documented gap — the corpus/fuzz stay integer-only).

pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Vec<u16>),
    Array(Vec<Json>),
    Object(Vec<(Vec<u16>, Json)>),
}

impl Json {
    /// Object field lookup by (ASCII) key.
    pub fn get(&self, key: &str) -> Option<&Json> {
        if let Json::Object(entries) = self {
            for (k, v) in entries {
                if utf16_eq_ascii(k, key) {
                    return Some(v);
                }
            }
        }
        None
    }

    pub fn as_array(&self) -> Option<&Vec<Json>> {
        if let Json::Array(a) = self { Some(a) } else { None }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }

    /// A string value as a Rust String (lossy on lone surrogates — fine for the
    /// ASCII slug/source_dir fields the server reads).
    pub fn as_string(&self) -> Option<String> {
        if let Json::Str(u) = self {
            Some(String::from_utf16_lossy(u))
        } else {
            None
        }
    }
}

fn utf16_eq_ascii(units: &[u16], s: &str) -> bool {
    let b = s.as_bytes();
    if units.len() != b.len() {
        return false;
    }
    for i in 0..units.len() {
        if units[i] != b[i] as u16 {
            return false;
        }
    }
    true
}

// --- parsing ----------------------------------------------------------------

pub struct ParseError(pub String);

pub fn parse(units: &[u16]) -> Result<Json, ParseError> {
    let mut p = Parser { u: units, i: 0 };
    p.skip_ws();
    let v = p.parse_value()?;
    p.skip_ws();
    if p.i != p.u.len() {
        return Err(ParseError("trailing content after JSON value".to_string()));
    }
    Ok(v)
}

struct Parser<'a> {
    u: &'a [u16],
    i: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u16> {
        if self.i < self.u.len() { Some(self.u[self.i]) } else { None }
    }

    fn skip_ws(&mut self) {
        // JSON insignificant whitespace: space, tab, LF, CR.
        while let Some(c) = self.peek() {
            if c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Json, ParseError> {
        match self.peek() {
            None => Err(ParseError("unexpected end of input".to_string())),
            Some(c) => match c {
                0x7B => self.parse_object(),
                0x5B => self.parse_array(),
                0x22 => Ok(Json::Str(self.parse_string()?)),
                0x74 => self.parse_lit(&[0x74, 0x72, 0x75, 0x65], Json::Bool(true)),
                0x66 => self.parse_lit(&[0x66, 0x61, 0x6C, 0x73, 0x65], Json::Bool(false)),
                0x6E => self.parse_lit(&[0x6E, 0x75, 0x6C, 0x6C], Json::Null),
                _ => self.parse_number(),
            },
        }
    }

    fn parse_lit(&mut self, lit: &[u16], value: Json) -> Result<Json, ParseError> {
        if self.i + lit.len() <= self.u.len() && &self.u[self.i..self.i + lit.len()] == lit {
            self.i += lit.len();
            Ok(value)
        } else {
            Err(ParseError("invalid literal".to_string()))
        }
    }

    fn parse_string(&mut self) -> Result<Vec<u16>, ParseError> {
        // assumes current char is the opening quote
        self.i += 1;
        let mut out: Vec<u16> = Vec::new();
        while let Some(c) = self.peek() {
            self.i += 1;
            if c == 0x22 {
                return Ok(out);
            }
            if c == 0x5C {
                let e = self.peek().ok_or_else(|| ParseError("bad escape".to_string()))?;
                self.i += 1;
                match e {
                    0x22 => out.push(0x22),
                    0x5C => out.push(0x5C),
                    0x2F => out.push(0x2F),
                    0x62 => out.push(0x08),
                    0x66 => out.push(0x0C),
                    0x6E => out.push(0x0A),
                    0x72 => out.push(0x0D),
                    0x74 => out.push(0x09),
                    0x75 => {
                        if self.i + 4 > self.u.len() {
                            return Err(ParseError("bad \\u escape".to_string()));
                        }
                        let mut v: u16 = 0;
                        for k in 0..4 {
                            v = v.wrapping_mul(16).wrapping_add(hex_val(self.u[self.i + k])?);
                        }
                        self.i += 4;
                        out.push(v);
                    }
                    _ => return Err(ParseError("unknown escape".to_string())),
                }
            } else {
                out.push(c);
            }
        }
        Err(ParseError("unterminated string".to_string()))
    }

    fn parse_number(&mut self) -> Result<Json, ParseError> {
        let start = self.i;
        let mut is_float = false;
        if self.peek() == Some(0x2D) {
            self.i += 1;
        }
        while let Some(c) = self.peek() {
            if (0x30..=0x39).contains(&c) {
                self.i += 1;
            } else if c == 0x2E || c == 0x65 || c == 0x45 {
                is_float = true;
                self.i += 1;
            } else if c == 0x2B || c == 0x2D {
                self.i += 1;
            } else {
                break;
            }
        }
        if self.i == start {
            return Err(ParseError("invalid number".to_string()));
        }
        let s: String = self.u[start..self.i]
            .iter()
            .map(|&u| char::from_u32(u as u32).unwrap_or('?'))
            .collect();
        if !is_float {
            if let Ok(n) = s.parse::<i64>() {
                return Ok(Json::Int(n));
            }
        }
        s.parse::<f64>()
            .map(Json::Float)
            .map_err(|_| ParseError("invalid number".to_string()))
    }

    fn parse_array(&mut self) -> Result<Json, ParseError> {
        self.i += 1; // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(0x5D) {
            self.i += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(0x2C) => { self.i += 1; }
                Some(0x5D) => { self.i += 1; return Ok(Json::Array(items)); }
                _ => return Err(ParseError("expected , or ] in array".to_string())),
            }
        }
    }

    fn parse_object(&mut self) -> Result<Json, ParseError> {
        self.i += 1; // {
        let mut entries: Vec<(Vec<u16>, Json)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(0x7D) {
            self.i += 1;
            return Ok(Json::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(0x22) {
                return Err(ParseError("expected string key in object".to_string()));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(0x3A) {
                return Err(ParseError("expected : in object".to_string()));
            }
            self.i += 1;
            self.skip_ws();
            let value = self.parse_value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(0x2C) => { self.i += 1; }
                Some(0x7D) => { self.i += 1; return Ok(Json::Object(entries)); }
                _ => return Err(ParseError("expected , or } in object".to_string())),
            }
        }
    }
}

fn hex_val(u: u16) -> Result<u16, ParseError> {
    match u {
        0x30..=0x39 => Ok(u - 0x30),
        0x41..=0x46 => Ok(u - 0x41 + 10),
        0x61..=0x66 => Ok(u - 0x61 + 10),
        _ => Err(ParseError("bad hex digit".to_string())),
    }
}

// --- serializing (matches JSON.stringify) -----------------------------------

/// Compact, like `JSON.stringify(value)`.
pub fn to_compact(v: &Json) -> String {
    let mut s = String::new();
    write_value(&mut s, v, None, 0);
    s
}

/// Pretty with `indent` spaces per level, like `JSON.stringify(value, null, n)`.
pub fn to_pretty(v: &Json, indent: usize) -> String {
    let mut s = String::new();
    write_value(&mut s, v, Some(indent), 0);
    s
}

fn write_indent(s: &mut String, indent: usize, depth: usize) {
    s.push('\n');
    for _ in 0..(indent * depth) {
        s.push(' ');
    }
}

fn write_value(s: &mut String, v: &Json, indent: Option<usize>, depth: usize) {
    match v {
        Json::Null => s.push_str("null"),
        Json::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
        Json::Int(n) => s.push_str(&n.to_string()),
        Json::Float(f) => {
            // Integer-valued f64 prints without a decimal (matches JSON.stringify).
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 {
                s.push_str(&(*f as i64).to_string());
            } else {
                s.push_str(&f.to_string());
            }
        }
        Json::Str(units) => write_json_string(s, units),
        Json::Array(items) => {
            if items.is_empty() {
                s.push_str("[]");
                return;
            }
            s.push('[');
            for (k, item) in items.iter().enumerate() {
                if k > 0 {
                    s.push(',');
                }
                if let Some(n) = indent {
                    write_indent(s, n, depth + 1);
                }
                write_value(s, item, indent, depth + 1);
            }
            if let Some(n) = indent {
                write_indent(s, n, depth);
            }
            s.push(']');
        }
        Json::Object(entries) => {
            if entries.is_empty() {
                s.push_str("{}");
                return;
            }
            s.push('{');
            for (k, (key, val)) in entries.iter().enumerate() {
                if k > 0 {
                    s.push(',');
                }
                if let Some(n) = indent {
                    write_indent(s, n, depth + 1);
                }
                write_json_string(s, key);
                s.push(':');
                if indent.is_some() {
                    s.push(' ');
                }
                write_value(s, val, indent, depth + 1);
            }
            if let Some(n) = indent {
                write_indent(s, n, depth);
            }
            s.push('}');
        }
    }
}

// JSON.stringify string escaping (shared shape with json.rs's writer).
fn write_json_string(s: &mut String, units: &[u16]) {
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
                s.push_str(&format!("\\u{:04x}", u));
            }
            0xDC00..=0xDFFF => s.push_str(&format!("\\u{:04x}", u)),
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
