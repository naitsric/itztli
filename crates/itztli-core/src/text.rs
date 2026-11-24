/// Line and column lookup over a text. Lines are zero-based; columns count
/// UTF-16 units, as the editor does. Line breaks may be `\n` or `\r\n`.
pub struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    pub fn new(text: &'a str) -> Self {
        let starts = std::iter::once(0).chain(memchr::memchr_iter(b'\n', text.as_bytes()).map(|at| at + 1)).collect();
        Self { text, starts }
    }

    /// Line and column of a byte offset.
    pub fn position(&self, offset: usize) -> (u32, u32) {
        let line = self.starts.partition_point(|&start| start <= offset) - 1;
        (line as u32, utf16_len(&self.text[self.starts[line]..offset]))
    }

    /// Byte offset just past the line holding `offset`, line break excluded.
    pub fn end_of_line(&self, offset: usize) -> usize {
        let line = self.starts.partition_point(|&start| start <= offset) - 1;
        let end = self.starts.get(line + 1).map_or(self.text.len(), |next| next - 1);
        if self.text[..end].ends_with('\r') && end > self.starts[line] { end - 1 } else { end }
    }

    /// The text of a line, without its break.
    pub fn line(&self, line: u32) -> Option<&'a str> {
        let start = *self.starts.get(line as usize)?;
        Some(&self.text[start..self.end_of_line(start)])
    }
}

pub fn utf16_len(text: &str) -> u32 {
    if text.is_ascii() { text.len() as u32 } else { text.encode_utf16().count() as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_count_utf16_units() {
        let text = "añ😀b\r\nlast";
        let lines = Lines::new(text);
        assert_eq!(lines.position(text.find('b').unwrap()), (0, 4));
        assert_eq!(lines.position(text.find("last").unwrap()), (1, 0));
        assert_eq!(lines.position(text.len()), (1, 4));
        assert_eq!(lines.line(0), Some("añ😀b"));
        assert_eq!(lines.line(1), Some("last"));
        assert_eq!(lines.line(2), None);
    }
}
