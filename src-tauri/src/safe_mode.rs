//! Starting without plugins, for when one keeps the app from working.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

fn marker(data: &Path) -> PathBuf {
    data.join("safe-mode-once")
}

/// Asked for on the command line (`--safe-mode`), or by the last run for
/// this one only.
pub fn requested(data: &Path) -> bool {
    let once = std::fs::remove_file(marker(data)).is_ok();
    once || std::env::args().any(|arg| arg == "--safe-mode")
}

#[tauri::command]
pub fn app_restart(app: AppHandle, safe_mode: bool) {
    if safe_mode && let Ok(data) = app.path().app_data_dir() {
        let _ = std::fs::write(marker(&data), "");
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_for_one_run() {
        let data = std::env::temp_dir().join(format!("itztli-safe-mode-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(marker(&data), "").unwrap();
        assert!(requested(&data));
        assert!(!requested(&data));
        std::fs::remove_dir_all(&data).unwrap();
    }
}
