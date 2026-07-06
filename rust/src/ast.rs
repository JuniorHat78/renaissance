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

/// The kind of a styled inline span (SCRIPTORIUM-NATIVE-STYLING.md §5B). The four inline nodes that
/// carry a visual: strong, emphasis, inline code, and a link.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InlineKind {
    Emphasis,
    Strong,
    Code,
    Link,
}

/// A styled inline span: the **full source range** `[start, end)` (UTF-16 offsets into the normalized
/// buffer, markers included) of an inline node, with its kind. Emitted by `parse_document` on the side
/// (`Document.inline_spans`) so a consumer that reads the AST in-process — the native editor — can
/// source-highlight inline nodes WITHOUT the AST nodes carrying positions (which would change the
/// serialized shape). Spans nest: `*a **b** c*` yields an Emphasis span over the outer range and a
/// Strong span over the inner, so the overlap (`b`) is styled by both. Never serialized (§5B.1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct InlineSpan {
    pub start: usize,
    pub end: usize,
    pub kind: InlineKind,
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
    /// Styled inline spans (strong/emphasis/code/link) with full source ranges, for in-process
    /// source-highlighting (§5B). NOT serialized — `json.rs`/`docjson.rs` never read it, so the JSON
    /// stays byte-identical and the frozen-golden parity oracle is unaffected.
    pub inline_spans: Vec<InlineSpan>,
    // version "0.2.0" and sourceName null are constant — emitted by the serializer.
    // stats { blocks, words } is replicated (parity, not deferred): blocks is the
    // top-level child count, words is wordCount(toSearchableText(ast)).
    pub stats_blocks: usize,
    pub stats_words: usize,
}
