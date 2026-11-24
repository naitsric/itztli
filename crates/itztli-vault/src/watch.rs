//! Notices changes made outside the app (another editor, git, a sync
//! client).
//!
//! What the system says happened is only a hint: events come merged, split
//! and reordered, differently on each platform. So this only reports *where*
//! something may have changed; whoever listens looks at the disk.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher as _};

/// Quiet time to wait for, so a burst (a git checkout) is reported once.
const QUIET: Duration = Duration::from_millis(120);
/// And the longest a steady stream of changes can hold a report back.
const MAX_WAIT: Duration = Duration::from_millis(1000);

#[derive(Debug, thiserror::Error)]
#[error("cannot watch the vault for changes: {0}")]
pub struct WatchError(#[from] notify::Error);

/// Watches until dropped.
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
}

impl Watcher {
    /// Calls `on_change` with the places that may have changed. An empty set
    /// means anything may have: the system lost track.
    pub fn start(root: &Path, on_change: impl Fn(BTreeSet<PathBuf>) + Send + 'static) -> Result<Self, WatchError> {
        let (sender, receiver) = mpsc::channel::<notify::Event>();
        let mut inner = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event
                && !event.kind.is_access()
            {
                let _ = sender.send(event);
            }
        })?;
        inner.watch(root, RecursiveMode::Recursive)?;

        // Ends when the watcher (and with it the sender) is dropped.
        std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || {
                while let Ok(first) = receiver.recv() {
                    let started = Instant::now();
                    let mut lost_track = first.need_rescan();
                    let mut places: BTreeSet<PathBuf> = first.paths.into_iter().collect();
                    let disconnected = loop {
                        match receiver.recv_timeout(QUIET) {
                            Ok(event) => {
                                lost_track |= event.need_rescan();
                                places.extend(event.paths);
                                if started.elapsed() > MAX_WAIT {
                                    break false;
                                }
                            }
                            Err(RecvTimeoutError::Timeout) => break false,
                            Err(RecvTimeoutError::Disconnected) => break true,
                        }
                    };
                    if disconnected {
                        return;
                    }
                    if lost_track {
                        places.clear();
                    }
                    on_change(places);
                }
            })
            .map_err(notify::Error::io)?;
        Ok(Self { _inner: inner })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_where_something_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (sender, receiver) = mpsc::channel();
        let _watcher = Watcher::start(&root, move |places| {
            let _ = sender.send(places);
        })
        .unwrap();

        // The system may take a moment to start delivering events.
        let deadline = Instant::now() + Duration::from_secs(10);
        let note = root.join("note.md");
        loop {
            std::fs::write(&note, format!("{:?}", Instant::now())).unwrap();
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(places) if places.contains(&note) => break,
                _ => assert!(Instant::now() < deadline, "no change reported"),
            }
        }
    }
}
