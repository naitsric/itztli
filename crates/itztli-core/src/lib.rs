//! Notes as data: what a note's text says about links, tags, headings and
//! tasks, and how vault paths work. Nothing here touches the file system.

mod entry;
pub mod link;
pub mod note;
pub mod path;
pub mod section;
mod text;

pub use entry::Entry;
pub use link::{Link, LinkKind};
pub use note::{Heading, NoteMeta, TagRef, Task, parse};
pub use text::Lines;
