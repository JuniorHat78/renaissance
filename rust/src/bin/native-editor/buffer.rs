//! The text buffer — a persistent, augmented, chunked rope (N1;
//! SCRIPTORIUM-NATIVE-BUFFER.md). Pure logic, no Win32/COM/DWrite, so it compiles and
//! is fuzz-tested on every platform.
//!
//! Shape: a balanced binary tree whose leaves are chunks of UTF-16 units and whose
//! `Branch` nodes carry an augmented `Summary` (subtree length + newline count). Nodes
//! are `Arc`-shared and immutable; edits **path-copy** (allocate O(log n) new nodes and
//! share every untouched subtree), so `snapshot()` is an O(1) root clone with structural
//! sharing — the foundation for O(1) undo now and lock-free off-thread reads later (N4).
//!
//! The whole edit algebra is `split` + `concat`; insert/delete are one-liners over them.
//! That tiny surface is what makes a crate-free, hand-rolled rope safe to ship: the
//! model-based oracle at the bottom of this file fuzzes it against a `Vec<u16>` reference.

// Suppress dead-code noise in non-test builds (the off-Windows stub and the Windows app
// each use a subset of the API); under `cargo test` the full API is exercised, so real
// dead code still surfaces there.
#![cfg_attr(not(test), allow(dead_code))]

use std::ops::Range;
use std::sync::Arc;

/// Max UTF-16 units per leaf chunk. Keeps the node count ~ total/MAX_CHUNK (a 55 KB
/// section ≈ 27 leaves) so the tree stays shallow and scans stay cache-friendly.
const MAX_CHUNK: usize = 1024;

type Link = Option<Arc<Node>>;

#[derive(Clone)]
struct Summary {
    len: usize,
    lines: usize,
}

enum Node {
    Leaf(Vec<u16>),
    Branch {
        left: Arc<Node>,
        right: Arc<Node>,
        summary: Summary,
        height: u8,
    },
}

fn count_nl(units: &[u16]) -> usize {
    units.iter().filter(|&&u| u == 0x000A).count()
}

fn len_of(n: &Arc<Node>) -> usize {
    match &**n {
        Node::Leaf(c) => c.len(),
        Node::Branch { summary, .. } => summary.len,
    }
}

fn lines_of(n: &Arc<Node>) -> usize {
    match &**n {
        Node::Leaf(c) => count_nl(c),
        Node::Branch { summary, .. } => summary.lines,
    }
}

fn height_of(n: &Arc<Node>) -> u8 {
    match &**n {
        Node::Leaf(_) => 1,
        Node::Branch { height, .. } => *height,
    }
}

/// Build a `Branch` over two non-empty subtrees, recomputing the augmented summary.
fn mk_branch(left: Arc<Node>, right: Arc<Node>) -> Arc<Node> {
    let summary = Summary {
        len: len_of(&left) + len_of(&right),
        lines: lines_of(&left) + lines_of(&right),
    };
    let height = 1 + height_of(&left).max(height_of(&right));
    Arc::new(Node::Branch { left, right, summary, height })
}

/// Ideal height for a rope of `len` units: ⌊log2(leaves)⌋ + 1.
fn ideal_height(len: usize) -> u8 {
    let leaves = (len / MAX_CHUNK).max(1) as u64;
    (u64::BITS - leaves.leading_zeros()) as u8
}

/// Concatenate two non-empty subtrees (sequence: all of `l`, then `r`).
/// Merges two small adjacent leaves (so typing coalesces into one growing chunk), and
/// rebuilds the subtree balanced if it has become too skewed (correct regardless — only
/// performance depends on balance).
fn concat(l: Arc<Node>, r: Arc<Node>) -> Arc<Node> {
    if let (Node::Leaf(a), Node::Leaf(b)) = (&*l, &*r) {
        if a.len() + b.len() <= MAX_CHUNK {
            let mut v = Vec::with_capacity(a.len() + b.len());
            v.extend_from_slice(a);
            v.extend_from_slice(b);
            return Arc::new(Node::Leaf(v));
        }
    }
    let node = mk_branch(l, r);
    let len = len_of(&node);
    if height_of(&node) as usize > ideal_height(len) as usize * 3 + 4 {
        let mut leaves = Vec::new();
        collect_leaves(&node, &mut leaves);
        rebuild_balanced(&leaves)
    } else {
        node
    }
}

fn concat_link(l: Link, r: Link) -> Link {
    match (l, r) {
        (None, x) | (x, None) => x,
        (Some(a), Some(b)) => Some(concat(a, b)),
    }
}

fn collect_leaves(n: &Arc<Node>, out: &mut Vec<Arc<Node>>) {
    match &**n {
        Node::Leaf(_) => out.push(n.clone()),
        Node::Branch { left, right, .. } => {
            collect_leaves(left, out);
            collect_leaves(right, out);
        }
    }
}

/// Build a height-balanced tree from a non-empty in-order slice of leaf nodes.
fn rebuild_balanced(leaves: &[Arc<Node>]) -> Arc<Node> {
    match leaves.len() {
        1 => leaves[0].clone(),
        n => {
            let mid = n / 2;
            mk_branch(rebuild_balanced(&leaves[..mid]), rebuild_balanced(&leaves[mid..]))
        }
    }
}

/// Split a subtree at UTF-16 offset `at` into (left, right); either side may be empty.
fn split(n: &Arc<Node>, at: usize) -> (Link, Link) {
    match &**n {
        Node::Leaf(c) => {
            if at == 0 {
                (None, Some(n.clone()))
            } else if at >= c.len() {
                (Some(n.clone()), None)
            } else {
                let l = Arc::new(Node::Leaf(c[..at].to_vec()));
                let r = Arc::new(Node::Leaf(c[at..].to_vec()));
                (Some(l), Some(r))
            }
        }
        Node::Branch { left, right, .. } => {
            let ll = len_of(left);
            if at < ll {
                let (a, b) = split(left, at);
                (a, concat_link(b, Some(right.clone())))
            } else if at > ll {
                let (a, b) = split(right, at - ll);
                (concat_link(Some(left.clone()), a), b)
            } else {
                (Some(left.clone()), Some(right.clone()))
            }
        }
    }
}

/// Chunk `units` (non-empty) into leaves and build a balanced tree.
fn build_from_units(units: &[u16]) -> Arc<Node> {
    if units.len() <= MAX_CHUNK {
        return Arc::new(Node::Leaf(units.to_vec()));
    }
    let mut leaves = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let end = (i + MAX_CHUNK).min(units.len());
        leaves.push(Arc::new(Node::Leaf(units[i..end].to_vec())));
        i = end;
    }
    rebuild_balanced(&leaves)
}

fn collect_units(n: &Arc<Node>, out: &mut Vec<u16>) {
    match &**n {
        Node::Leaf(c) => out.extend_from_slice(c),
        Node::Branch { left, right, .. } => {
            collect_units(left, out);
            collect_units(right, out);
        }
    }
}

fn line_of_offset_node(n: &Arc<Node>, off: usize) -> usize {
    match &**n {
        Node::Leaf(c) => count_nl(&c[..off.min(c.len())]),
        Node::Branch { left, right, .. } => {
            let ll = len_of(left);
            if off <= ll {
                line_of_offset_node(left, off)
            } else {
                lines_of(left) + line_of_offset_node(right, off - ll)
            }
        }
    }
}

fn offset_of_line_node(n: &Arc<Node>, line: usize) -> usize {
    match &**n {
        Node::Leaf(c) => {
            let mut seen = 0;
            for (i, &u) in c.iter().enumerate() {
                if u == 0x000A {
                    seen += 1;
                    if seen == line {
                        return i + 1;
                    }
                }
            }
            c.len()
        }
        Node::Branch { left, right, .. } => {
            let ll = lines_of(left);
            if line <= ll {
                offset_of_line_node(left, line)
            } else {
                len_of(left) + offset_of_line_node(right, line - ll)
            }
        }
    }
}

/// An editable document of UTF-16 code units, backed by a persistent rope.
pub struct TextBuffer {
    root: Link,
}

/// An immutable, O(1)-cloned view of a buffer at one moment — the unit of undo history
/// and (later) of off-thread reads. Structural sharing keeps it valid and cheap forever.
#[derive(Clone)]
pub struct Snapshot {
    root: Link,
}

impl TextBuffer {
    pub fn new() -> TextBuffer {
        TextBuffer { root: None }
    }

    pub fn from_units(units: &[u16]) -> TextBuffer {
        let root = if units.is_empty() { None } else { Some(build_from_units(units)) };
        TextBuffer { root }
    }

    pub fn len(&self) -> usize {
        self.root.as_ref().map_or(0, len_of)
    }

    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    /// Insert `units` at UTF-16 offset `at` (clamped to the document length).
    pub fn insert(&mut self, at: usize, units: &[u16]) {
        if units.is_empty() {
            return;
        }
        let at = at.min(self.len());
        let mid = build_from_units(units);
        let (l, r) = match self.root.take() {
            Some(n) => split(&n, at),
            None => (None, None),
        };
        self.root = concat_link(concat_link(l, Some(mid)), r);
    }

    /// Delete the half-open UTF-16 range (clamped to the document).
    pub fn delete(&mut self, range: Range<usize>) {
        let len = self.len();
        let start = range.start.min(len);
        let end = range.end.min(len);
        if start >= end {
            return;
        }
        let n = match self.root.take() {
            Some(n) => n,
            None => return,
        };
        let (l, rest) = split(&n, start);
        let r = match rest {
            Some(t) => split(&t, end - start).1,
            None => None,
        };
        self.root = concat_link(l, r);
    }

    /// Materialize the whole document into one contiguous `Vec<u16>` — the feed for the
    /// parser (`parse_document(&[u16])`) and the renderer (`IDWriteTextLayout`).
    pub fn to_units(&self) -> Vec<u16> {
        let mut out = Vec::with_capacity(self.len());
        if let Some(n) = &self.root {
            collect_units(n, &mut out);
        }
        out
    }

    /// O(1): an immutable view sharing this buffer's structure.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot { root: self.root.clone() }
    }

    /// O(1): restore from a snapshot (undo/redo).
    pub fn restore(&mut self, snap: &Snapshot) {
        self.root = snap.root.clone();
    }

    /// The number of newlines in `[0, off)` — i.e. the 0-based line index of `off`.
    /// An augmented O(log n) query (reads subtree line summaries).
    pub fn line_of_offset(&self, off: usize) -> usize {
        let off = off.min(self.len());
        self.root.as_ref().map_or(0, |n| line_of_offset_node(n, off))
    }

    /// The UTF-16 offset at which the 0-based `line` starts.
    pub fn offset_of_line(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        let off = self.root.as_ref().map_or(0, |n| offset_of_line_node(n, line));
        off.min(self.len())
    }
}

impl Snapshot {
    pub fn to_units(&self) -> Vec<u16> {
        let mut out = Vec::new();
        if let Some(n) = &self.root {
            collect_units(n, &mut out);
        }
        out
    }
}

// --- the buffer oracle (SCRIPTORIUM-NATIVE-BUFFER.md §8) ---------------------
// Model-based differential fuzz: a trivially-correct Vec<u16> reference run in lockstep
// with the rope under a seeded random stream of insert/delete/undo/redo, asserting equal
// contents after every op, plus augmented-query and persistence (structural-sharing)
// checks. Pure logic — runs on every platform in CI.
#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny deterministic xorshift64 PRNG (std has no RNG, and we stay crate-free).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: usize) -> usize {
            if n == 0 {
                0
            } else {
                (self.next() % n as u64) as usize
            }
        }
    }

    #[cfg(test)]
    impl TextBuffer {
        fn leaf_count(&self) -> usize {
            fn go(n: &Arc<Node>) -> usize {
                match &**n {
                    Node::Leaf(_) => 1,
                    Node::Branch { left, right, .. } => go(left) + go(right),
                }
            }
            self.root.as_ref().map_or(0, go)
        }
    }

    #[test]
    fn empty_and_basic() {
        let mut b = TextBuffer::new();
        assert_eq!(b.to_units(), Vec::<u16>::new());
        assert_eq!(b.len(), 0);
        let hi: Vec<u16> = "hello".encode_utf16().collect();
        b.insert(0, &hi);
        assert_eq!(b.to_units(), hi);
        b.delete(1..3); // "hlo"
        assert_eq!(b.to_units(), "hlo".encode_utf16().collect::<Vec<u16>>());
        b.insert(1, &"EY".encode_utf16().collect::<Vec<u16>>());
        assert_eq!(b.to_units(), "hEYlo".encode_utf16().collect::<Vec<u16>>());
    }

    #[test]
    fn typing_coalesces_leaves() {
        let mut b = TextBuffer::new();
        for i in 0..500u16 {
            let at = b.len();
            b.insert(at, &[0x41 + (i % 26)]);
        }
        assert_eq!(b.len(), 500);
        assert!(b.leaf_count() <= 2, "expected coalesced leaves, got {}", b.leaf_count());
    }

    #[test]
    fn line_queries() {
        let s: Vec<u16> = "ab\ncd\nef".encode_utf16().collect();
        let b = TextBuffer::from_units(&s);
        assert_eq!(b.line_of_offset(0), 0);
        assert_eq!(b.line_of_offset(2), 0);
        assert_eq!(b.line_of_offset(3), 1);
        assert_eq!(b.line_of_offset(6), 2);
        assert_eq!(b.offset_of_line(0), 0);
        assert_eq!(b.offset_of_line(1), 3);
        assert_eq!(b.offset_of_line(2), 6);
    }

    #[test]
    fn snapshot_is_persistent() {
        let mut b = TextBuffer::from_units(&"original".encode_utf16().collect::<Vec<u16>>());
        let snap = b.snapshot();
        let before = snap.to_units();
        // Mutate heavily; the snapshot must be untouched (structural sharing / immutability).
        for _ in 0..200 {
            let at = b.len() / 2;
            b.insert(at, &"XYZ".encode_utf16().collect::<Vec<u16>>());
        }
        b.delete(0..b.len());
        assert_eq!(snap.to_units(), before, "snapshot mutated — persistence broken");
        assert_eq!(b.to_units(), Vec::<u16>::new());
    }

    #[test]
    fn fuzz_against_model() {
        let iters: usize = std::env::var("SCRIPTORIUM_FUZZ")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4000);

        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut buf = TextBuffer::new();
        let mut model: Vec<u16> = Vec::new();

        // Undo/redo mirrors: the buffer keeps O(1) Snapshots; the model keeps full clones.
        let mut undo_buf: Vec<Snapshot> = Vec::new();
        let mut undo_model: Vec<Vec<u16>> = Vec::new();
        let mut redo_buf: Vec<Snapshot> = Vec::new();
        let mut redo_model: Vec<Vec<u16>> = Vec::new();

        // Stashed old snapshots to verify persistence at the end.
        let mut stash: Vec<(Snapshot, Vec<u16>)> = Vec::new();

        for it in 0..iters {
            match rng.below(100) {
                0..=44 => {
                    // insert
                    let at = rng.below(model.len() + 1);
                    let n = 1 + rng.below(6);
                    let mut units = Vec::new();
                    for _ in 0..n {
                        match rng.below(10) {
                            0 => units.push(0x000A),                 // newline
                            1 => {
                                units.push(0xD83D);                  // astral pair (emoji)
                                units.push(0xDE00);
                            }
                            _ => units.push(0x41 + rng.below(26) as u16),
                        }
                    }
                    undo_buf.push(buf.snapshot());
                    undo_model.push(model.clone());
                    redo_buf.clear();
                    redo_model.clear();
                    buf.insert(at, &units);
                    model.splice(at..at, units.iter().cloned());
                }
                45..=69 => {
                    // delete
                    if !model.is_empty() {
                        let a = rng.below(model.len());
                        let b = a + 1 + rng.below(model.len() - a);
                        undo_buf.push(buf.snapshot());
                        undo_model.push(model.clone());
                        redo_buf.clear();
                        redo_model.clear();
                        buf.delete(a..b);
                        model.drain(a..b);
                    }
                }
                70..=84 => {
                    // undo
                    if let (Some(s), Some(m)) = (undo_buf.pop(), undo_model.pop()) {
                        redo_buf.push(buf.snapshot());
                        redo_model.push(model.clone());
                        buf.restore(&s);
                        model = m;
                    }
                }
                _ => {
                    // redo
                    if let (Some(s), Some(m)) = (redo_buf.pop(), redo_model.pop()) {
                        undo_buf.push(buf.snapshot());
                        undo_model.push(model.clone());
                        buf.restore(&s);
                        model = m;
                    }
                }
            }

            if it % 17 == 0 {
                stash.push((buf.snapshot(), model.clone()));
            }

            assert_eq!(buf.to_units(), model, "content mismatch at iter {it}");
            assert_eq!(buf.len(), model.len(), "len mismatch at iter {it}");
            assert_eq!(buf.is_empty(), model.is_empty(), "is_empty mismatch at iter {it}");

            let k = rng.below(model.len() + 1);
            let model_lines = model[..k].iter().filter(|&&u| u == 0x000A).count();
            assert_eq!(buf.line_of_offset(k), model_lines, "line_of_offset mismatch at iter {it}");
        }

        for (s, m) in &stash {
            assert_eq!(s.to_units(), *m, "stale snapshot corrupted — persistence broken");
        }
    }
}
