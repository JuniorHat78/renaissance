// ast.rs — node types mirroring scripts/ast/parse.js output EXACTLY.
//
// String values (text/code value, link href) are stored as Vec<u16> — UTF-16
// code units — because the parser operates in UTF-16 to match JS offset and
// string semantics (SCRIPTORIUM-RUST-PARSER.md §4.2). The JSON serializer
// re-encodes those slices, escaping lone surrogates the way JSON.stringify does.
//
// Only blocks carry a position; inline nodes carry none (§5.5).

pub struct Position {
    pub line: u32,
    pub start: usize, // UTF-16 code-unit offset into the full normalized buffer
    pub end: usize,
}

pub enum Inline {
    Text(Vec<u16>),
    Emphasis(Vec<Inline>),
    Strong(Vec<Inline>),
    Code(Vec<u16>),
    Link { href: Vec<u16>, children: Vec<Inline> },
    HardBreak,
}

pub enum Block {
    Heading { level: u8, children: Vec<Inline>, position: Position },
    Paragraph { children: Vec<Inline>, position: Position },
    PullQuote { children: Vec<Inline>, position: Position },
    BlockQuote { children: Vec<Block>, position: Position },
    List { ordered: bool, children: Vec<Block>, position: Position },
    ListItem { children: Vec<Inline>, position: Position },
    Divider { position: Position },
}

pub enum DetailValue {
    Num(i64),
    Str(Vec<u16>),
}

pub struct Diagnostic {
    pub code: &'static str,
    pub severity: &'static str, // always "info" for parser diagnostics
    pub message: String,        // ASCII messages — String is fine
    pub offset: usize,
    pub details: Vec<(&'static str, DetailValue)>,
    // Derived at the end of the parse from the offset (positionAtOffset):
    pub line: u32,
    pub column: usize,
}

pub struct Document {
    pub children: Vec<Block>,
    pub diagnostics: Vec<Diagnostic>,
    // version "0.2.0" and sourceName null are constant — emitted by the serializer.
    // stats is DEFERRED (SCRIPTORIUM-RUST-PARSER.md §11 decision 6 / §12): the
    // harness strips it from the JS side until parity is added.
}
