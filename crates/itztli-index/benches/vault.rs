//! How long the index takes on big vaults. `cargo bench -p itztli-index`

use std::time::Instant;

use itztli_core::Entry;
use itztli_index::{FindScope, Index, TextQuery, grep};
use rayon::prelude::*;

/// A made-up vault: notes of a few paragraphs, with links, tags and headings.
fn vault(notes: usize) -> Vec<(String, String)> {
    const WORDS: [&str; 24] = [
        "obsidian", "note", "review", "project", "canción", "weekly", "design", "idea", "system", "graph", "archive", "reading",
        "plan", "meeting", "database", "keyboard", "plugin", "vault", "editor", "index", "search", "theme", "window", "memory",
    ];
    let mut seed = 7u64;
    let mut random = move |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n
    };
    (0..notes)
        .map(|i| {
            let mut text = format!("---\ntags: [{}]\n---\n# {} {}\n\n", WORDS[random(24)], WORDS[random(24)], i);
            for section in 0..4 {
                text.push_str(&format!("## Section {section} {}\n\n", WORDS[random(24)]));
                for _ in 0..4 {
                    for _ in 0..28 {
                        text.push_str(WORDS[random(24)]);
                        text.push(' ');
                    }
                    text.push_str(&format!("[[Note {}]] #{}\n\n", random(notes), WORDS[random(24)]));
                }
            }
            (format!("folder {}/Note {i}.md", i % 97), text)
        })
        .collect()
}

fn timed<T>(what: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    println!("  {what:<34}{:>9.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    result
}

fn main() {
    for count in [1_000, 10_000, 50_000] {
        let files = vault(count);
        let bytes: usize = files.iter().map(|(_, t)| t.len()).sum();
        println!("\n{count} notes, {:.1} MB", bytes as f64 / 1e6);

        let parsed: Vec<_> = timed("parse (parallel)", || files.par_iter().map(|(_, t)| itztli_core::parse(t)).collect());
        let mut index = timed("build the index", || {
            let mut index = Index::default();
            for ((path, _), meta) in files.iter().zip(parsed) {
                index.put(Entry { path: path.clone(), folder: false, size: 0, modified: 0 }, Some(meta));
            }
            index
        });
        timed("go to file, 3 letters", || index.find_files("n42", FindScope::Notes, 50));
        timed("go to heading", || index.find_headings("sect graph", 50));
        timed("backlinks of a note", || index.backlinks("folder 42/Note 42.md"));
        timed("all problems", || index.problems());
        timed("tags", || index.tags());
        timed("whole graph", || index.graph(None, true));
        let paths: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
        let by_path: std::collections::HashMap<&str, &str> = files.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
        let read = |p: &str| by_path.get(p).map(|t| t.as_bytes().to_vec());
        let query = TextQuery { text: "cancion weekly".into(), limit: 1000, ..Default::default() };
        timed("find in files (in memory)", || grep(&paths, read, &query, || false).unwrap());
        timed("plan a rename", || index.move_entry("folder 42/Note 42.md", "folder 42/Renamed.md"));
    }
}
