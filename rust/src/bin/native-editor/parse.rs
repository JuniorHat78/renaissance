//! Off-thread parse (N4; SCRIPTORIUM-NATIVE-CONCURRENCY.md). The parser is lifted off the
//! UI thread onto a single long-lived worker fed an O(1), immutable rope `Snapshot`, so a
//! keystroke never waits on `parse_document` and — as prose grows toward book scale — a full
//! reparse can never drop a frame mid-keystroke.
//!
//! Platform-free on purpose: the one OS touch, waking the UI thread's message pump, is
//! **injected** as a `wake` closure by `win32` (which posts `WM_APP_PARSE_DONE`). So the
//! mailbox, the coalescing, the generation gate, and the service lifecycle compile and are
//! oracle-tested on every platform — the Win32 coupling stays in `win32`. The seam
//! (umbrella §4) holds: `app` owns state, `parse` owns the worker choreography, and neither
//! names the other's world (the worker only ever reads an immutable `Snapshot`).

use crate::buffer::Snapshot;
use crate::styles::{styles_of, StyleSpan};
use scriptorium_parser::{parse_document, InlineSpan};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

/// AST-derived stats shown in the status line — proof the parse loop is closed. Produced on
/// the worker, folded into `App` on the UI thread (`app::App::apply_parse`). Platform-free, so
/// it lives here (with the worker that makes it) rather than in the Windows-gated `app`.
pub struct ParseSignal {
    pub blocks: usize,
    pub words: usize,
    pub parse_micros: u128,
}

/// A finished parse headed back to the UI thread: the generation it reflects, the AST stats, and the
/// block-level **style spans** the renderer source-highlights with (SCRIPTORIUM-NATIVE-STYLING.md). The
/// compact `Vec<StyleSpan>` crosses the thread boundary — never the `Document`. The `gen` is the
/// staleness token the UI side gates on (`apply_parse`, monotonic — §5).
pub struct ParseResult {
    pub gen: u64,
    pub signal: ParseSignal,
    pub styles: Vec<StyleSpan>,
    /// Styled inline spans (strong/emphasis/code/link, source offsets) from the parser's
    /// `Document.inline_spans` (SCRIPTORIUM-NATIVE-STYLING.md §5B), carried back under the same
    /// staleness gate as the block styles and applied within each paragraph by the renderer.
    pub inline_spans: Vec<InlineSpan>,
}

/// A pending job: the generation and the immutable snapshot to parse.
type Job = (u64, Snapshot);

/// The single-slot **coalescing** mailbox (SCRIPTORIUM-NATIVE-CONCURRENCY.md §4). Holds at most
/// one pending job: `push` overwrites the slot, dropping any superseded snapshot (O(1) — it is an
/// `Arc`), so N keystrokes that arrive while the worker is busy collapse to a single parse of the
/// newest generation. `shutdown` tells the worker to exit its loop.
struct Mailbox {
    inner: Mutex<MailboxState>,
    cv: Condvar,
}

struct MailboxState {
    latest: Option<Job>,
    shutdown: bool,
}

impl Mailbox {
    fn new() -> Mailbox {
        Mailbox {
            inner: Mutex::new(MailboxState { latest: None, shutdown: false }),
            cv: Condvar::new(),
        }
    }

    /// Overwrite the one-slot mailbox with the newest job (the previous pending snapshot, if any,
    /// is dropped here — the coalescing). The lock is held only for the swap, never across a parse.
    fn push(&self, job: Job) {
        let mut st = self.inner.lock().unwrap();
        st.latest = Some(job);
    }

    /// Ask the worker to stop and wake it.
    fn shutdown(&self) {
        {
            let mut st = self.inner.lock().unwrap();
            st.shutdown = true;
        }
        self.cv.notify_one();
    }

    /// Block until there is a job or a shutdown. `None` means shutdown (exit the loop). Re-checks
    /// the predicate under the lock on every wake, so a spurious `Condvar` wakeup is harmless.
    fn take_blocking(&self) -> Option<Job> {
        let mut st = self.inner.lock().unwrap();
        loop {
            if st.shutdown {
                return None;
            }
            if let Some(j) = st.latest.take() {
                return Some(j);
            }
            st = self.cv.wait(st).unwrap();
        }
    }
}

/// The off-thread parser: owns the worker, the coalescing mailbox, and the result channel.
/// `win32` holds one in `WindowState`, `submit`s on edits, and `drain_latest`s in the
/// `WM_APP_PARSE_DONE` handler. Dropping it stops and joins the worker (leak-free teardown, §6).
pub struct ParseService {
    mailbox: Arc<Mailbox>,
    results: Receiver<ParseResult>,
    worker: Option<JoinHandle<()>>,
}

impl ParseService {
    /// Spawn the worker. `wake` is called (on the worker thread) after each result is queued, to
    /// nudge the UI thread's pump — on Windows it posts a contentless `WM_APP_PARSE_DONE`.
    pub fn new(wake: Arc<dyn Fn() + Send + Sync>) -> ParseService {
        let mailbox = Arc::new(Mailbox::new());
        let (tx, rx) = mpsc::channel();
        let worker_mb = mailbox.clone();
        let worker = std::thread::Builder::new()
            .name("scriptorium-parse".into())
            .spawn(move || worker_loop(worker_mb, tx, wake))
            .expect("spawn parse worker");
        ParseService { mailbox, results: rx, worker: Some(worker) }
    }

    /// Coalescing submit: overwrite the one-slot mailbox with `(gen, snap)` and wake the worker.
    /// Never blocks on a busy worker — the worker parses with the lock released (§7 edge 1), so a
    /// `submit` during a parse just refills the slot for the worker's next take.
    pub fn submit(&self, gen: u64, snap: Snapshot) {
        self.mailbox.push((gen, snap));
        self.mailbox.cv.notify_one();
    }

    /// Drain the result channel to the newest result (older ones coalesced away — the UI only
    /// needs the latest AST stats). `None` when nothing has arrived since the last drain.
    pub fn drain_latest(&self) -> Option<ParseResult> {
        let mut latest = None;
        while let Ok(r) = self.results.try_recv() {
            latest = Some(r);
        }
        latest
    }
}

impl Drop for ParseService {
    fn drop(&mut self) {
        // Tell the worker to exit, then join it — blocks at most one in-flight parse (§6). The
        // `results` receiver then drops, freeing any queued result; the wake closure drops too.
        self.mailbox.shutdown();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

/// The worker loop: block for a job, materialize the snapshot + parse it off-thread, queue the
/// result, and wake the UI. The lock is released before parsing (so the UI thread's `submit`
/// never waits on us), and the parse runs on a plain owned `Vec<u16>` — no shared mutable state,
/// nothing the paint path can observe torn (§2).
fn worker_loop(mailbox: Arc<Mailbox>, tx: Sender<ParseResult>, wake: Arc<dyn Fn() + Send + Sync>) {
    while let Some((gen, snap)) = mailbox.take_blocking() {
        let units = snap.to_units();
        let start = Instant::now();
        let doc = parse_document(&units);
        let styles = styles_of(&doc);
        let inline_spans = doc.inline_spans.clone();
        let parse_micros = start.elapsed().as_micros();
        let signal = ParseSignal { blocks: doc.stats_blocks, words: doc.stats_words, parse_micros };
        if tx.send(ParseResult { gen, signal, styles, inline_spans }).is_err() {
            return; // the UI side hung up (service dropped) — nothing to report to.
        }
        (wake)();
    }
}

// --- concurrency oracles (SCRIPTORIUM-NATIVE-CONCURRENCY.md §8) ----------------
// The deterministic half of N4: coalescing, snapshot/parse equivalence, and a bounded real-worker
// round-trip. Pure logic + std threads (no Win32/DWrite), so these run on every CI platform.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::TextBuffer;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn mailbox_coalesces_to_the_latest_job() {
        // Five submits with no worker draining between them must collapse to ONE job — the newest
        // generation — not queue five parses (SCRIPTORIUM-NATIVE-CONCURRENCY.md §4 coalescing).
        let mb = Mailbox::new();
        for gen in 1..=5u64 {
            mb.push((gen, TextBuffer::new().snapshot()));
        }
        let (gen, _) = mb.take_blocking().expect("a job is pending");
        assert_eq!(gen, 5, "N submits collapse to the newest job, not a backlog");
        // After taking the single coalesced job the slot is empty (the next take would block).
        assert!(mb.inner.lock().unwrap().latest.is_none(), "only one job ever holds");
    }

    #[test]
    fn take_blocking_returns_none_on_shutdown() {
        let mb = Mailbox::new();
        mb.shutdown();
        assert!(mb.take_blocking().is_none(), "shutdown wakes the worker with None to exit");
    }

    #[test]
    fn parsing_a_snapshot_matches_parsing_the_live_text() {
        // The worker reads exactly what an inline parse would have: async changes *timing*, never
        // *result* (SCRIPTORIUM-NATIVE-CONCURRENCY.md §8 equivalence).
        let buf = TextBuffer::from_units(&u("# Title\n\nHello world, this is some prose.\n"));
        let live = buf.to_units();
        let snap = buf.snapshot();
        let a = parse_document(&live);
        let b = parse_document(&snap.to_units());
        assert_eq!(a.stats_blocks, b.stats_blocks, "block count is snapshot-invariant");
        assert_eq!(a.stats_words, b.stats_words, "word count is snapshot-invariant");
    }

    #[test]
    fn service_parses_a_submitted_snapshot_off_thread_and_wakes_the_ui() {
        // The real worker: submit a snapshot, and within a bounded wait the result comes back on
        // the channel with the right generation + AST stats, and the injected wake fires.
        let woke = Arc::new(AtomicBool::new(false));
        let w = woke.clone();
        let svc = ParseService::new(Arc::new(move || w.store(true, Ordering::SeqCst)));

        let buf = TextBuffer::from_units(&u("alpha beta gamma delta"));
        svc.submit(7, buf.snapshot());

        let mut got = None;
        for _ in 0..2000 {
            if let Some(r) = svc.drain_latest() {
                got = Some(r);
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let r = got.expect("the worker should produce a result within the bound");
        assert_eq!(r.gen, 7, "the result carries the submitted generation");
        let expect = parse_document(&buf.to_units());
        assert_eq!(r.signal.words, expect.stats_words, "off-thread stats match an inline parse");
        assert!(woke.load(Ordering::SeqCst), "the injected wake closure fired");
    }

    #[test]
    fn later_submit_supersedes_an_undrained_earlier_one() {
        // Two submits before the worker is scheduled: the mailbox holds only the latest, so the
        // worker's first (and only) parse reflects the newer generation.
        let svc = ParseService::new(Arc::new(|| {}));
        let a = TextBuffer::from_units(&u("one two"));
        let b = TextBuffer::from_units(&u("one two three four five"));
        svc.submit(1, a.snapshot());
        svc.submit(2, b.snapshot());

        let mut last = None;
        for _ in 0..2000 {
            if let Some(r) = svc.drain_latest() {
                last = Some(r);
            }
            if matches!(last.as_ref(), Some(r) if r.gen == 2) {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let r = last.expect("at least one result");
        assert_eq!(r.gen, 2, "the newest submit wins; the earlier one may be coalesced away");
    }
}
