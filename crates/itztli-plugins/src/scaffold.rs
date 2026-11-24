//! What New Plugin creates: a plugin that runs, small enough to read whole,
//! with the API's types next to it so editors can complete it.

use std::fs;
use std::io;
use std::path::Path;

const MAIN: &str = include_str!("../template/main.js");
const README: &str = include_str!("../template/README.md");
const STYLES: &str = include_str!("../template/styles.css");
/// The same types the app's own plugin host is checked against.
const TYPES: &str = include_str!("../../../packages/plugin-api/index.d.ts");

pub fn write(folder: &Path, id: &str, name: &str) -> io::Result<()> {
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "version": "0.1.0",
        "api": crate::API_VERSION,
        "description": "What this plugin does, in one line.",
        "author": "",
        "main": "main.js",
        "styles": "styles.css",
        "settings": [
            {
                "key": "greeting",
                "title": "Greeting",
                "description": "What the example command says.",
                "type": "string",
                "default": "Hello"
            }
        ]
    });
    fs::create_dir_all(folder)?;
    fs::write(folder.join("plugin.json"), serde_json::to_string_pretty(&manifest)? + "\n")?;
    for (file, text) in [("main.js", MAIN), ("README.md", README), ("styles.css", STYLES)] {
        fs::write(folder.join(file), text.replace("{{id}}", id).replace("{{name}}", name))?;
    }
    fs::write(folder.join("itztli.d.ts"), TYPES)
}
