//! Deterministic decode check for the progress-bar `pstatus` aspect: load the real
//! repo `content/` tree (exactly as the gate does) and assert that the bar-bearing
//! cards expose a `pstatus` stock slot the client can resolve. This is the same
//! lookup `Client::progress_window` does (`stock_slot_bits(bundle, def, "pstatus")`)
//! — if it returns `None` here, the live client finds no interval and draws no bar,
//! regardless of gate/browser state. Catches an incomplete rename or a card that
//! forgot `aspect_flags` without needing a running gate.

use std::fs;
use std::path::{Path, PathBuf};

use resonantdust_dsl::bridge::stock_slot_bits;
use resonantdust_dsl::loader::load;

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
fn bar_cards_expose_pstatus_slot() {
  let content = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../../content")
    .canonicalize()
    .expect("locate repo content/ tree");
  let mut sources = read_tree(&content.join("data"), "");
  sources.extend(read_tree(&content.join("visuals"), "visuals/"));
  let bundle = load(&sources).unwrap_or_else(|e| panic!("corpus load failed: {e:?}"));

  // Cards that drive a build bar via start_bar/end_bar (recipes 01/02).
  for card in ["corpus_dim", "blueprint_chord_soul", "despair", "strike"] {
    let bits = stock_slot_bits(&bundle, card, "pstatus");
    assert!(
      bits.is_some(),
      "{card}: no `pstatus` stock slot — client progress_window would return None (no bar). \
       Does its def call $data_func::aspect_flags?"
    );
    // 4-bit presence bitmap (channel 0 = the build bar).
    assert_eq!(bits.unwrap().1, 4, "{card}: pstatus width should be 4 bits");
    // The retired aspect must be gone — a leftover `pstyle` slot means a partial rename.
    assert!(
      stock_slot_bits(&bundle, card, "pstyle").is_none(),
      "{card}: stale `pstyle` slot still present — rename incomplete"
    );
  }
}
