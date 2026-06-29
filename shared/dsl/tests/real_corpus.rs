//! Corpus acceptance: feed the real repo `content/` tree through
//! [`resonantdust_dsl::loader::load`] exactly as the gate does — data tree first,
//! then the sibling `visuals/` tree, each in sorted (append-stable) order, mirror-
//! ing `gateway::content::load_content`. `load` parses every file, builds one
//! cross-file symbol table, then validates + resolves each; it returns `Err` with
//! every diagnostic if anything is wrong.
//!
//! This is the load-bearing cross-file lint — it catches renames, missing art,
//! and duplicate/dangling `$` refs that per-crate unit tests can't see. It used to
//! be a standalone `corpus` bin in the `resonantdust-data` crate; that crate is
//! gone, so the check lives here and runs as part of `bin/shared test`.

use std::fs;
use std::path::{Path, PathBuf};

use resonantdust_dsl::loader::load;

/// Recursively collect every `.rd` under `dir` into `out`.
fn collect_rd(dir: &Path, out: &mut Vec<PathBuf>) {
  let Ok(entries) = fs::read_dir(dir) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      collect_rd(&path, out);
    } else if path.extension().is_some_and(|x| x == "rd") {
      out.push(path);
    }
  }
}

/// One content tree → `(name, text)` sources, sorted, names relative to `dir` and
/// prefixed by `prefix` — the exact shape `gateway::content::read_tree` produces.
fn read_tree(dir: &Path, prefix: &str) -> Vec<(String, String)> {
  let mut files = Vec::new();
  collect_rd(dir, &mut files);
  files.sort();
  files
    .iter()
    .map(|f| {
      let text = fs::read_to_string(f).unwrap_or_else(|e| panic!("read {}: {e}", f.display()));
      let rel = f.strip_prefix(dir).unwrap_or(f).display().to_string();
      (format!("{prefix}{rel}"), text)
    })
    .collect()
}

#[test]
fn real_corpus_loads_clean() {
  // CARGO_MANIFEST_DIR is .../shared/dsl; the repo corpus sits at ../../content.
  let content = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../../content")
    .canonicalize()
    .expect("locate repo content/ tree");

  // Data FIRST so a card's def-id derives from its `:data` file; visuals fold onto
  // the existing def afterward (see loader::index_defs / gateway::content).
  let mut sources = read_tree(&content.join("data"), "");
  sources.extend(read_tree(&content.join("visuals"), "visuals/"));
  assert!(
    !sources.is_empty(),
    "no .rd sources found under {} — is the content tree present?",
    content.display()
  );

  if let Err(errors) = load(&sources) {
    let mut report = format!("corpus acceptance failed — {} problem(s):\n", errors.len());
    for e in &errors {
      report.push_str(&format!("  {}: {}\n", e.file, e.message));
    }
    panic!("{report}");
  }
}
