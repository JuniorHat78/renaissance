# Git hooks (shared, opt-in per clone)

Thin local gates for the Rust code. Enable them once per clone:

```sh
git config core.hooksPath .githooks
```

(They're checked in so everyone gets the same ones, but `core.hooksPath` is a
per-clone setting, so each clone runs the command above once.)

## What runs where — the cost/frequency split

- **`pre-commit`** (fast, seconds): `clippy` over the native editor, but **only when
  `rust/` is touched** (docs-only commits are instant). Catches a compile error or a new
  lint before it's history. The `-A` list matches CI plus the two known pre-existing N3
  debts, so it passes on a clean tree and only reddens on something new.
- **`pre-push`** (heavier): `cargo test --release` for the native editor — the in-process
  oracle suite — so a red CI run is caught before you wait on Actions. Near-instant when
  nothing recompiled.

## What deliberately stays in CI (not in the hooks)

The full matrix: **ASan**, the **windowed smoke** (`--features smoke`), the **wasm / render
/ parser golden oracles**, **Miri**, and the **cross-platform stub builds**. Those are slow
and/or platform-specific — running them on every commit/push would make the tools something
you route around. CI is the backstop; the hooks are just fast local feedback.

Bypassing (`--no-verify`) is discouraged — if a hook is red, fix the cause.
