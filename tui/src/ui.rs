//! The shared bits of drawing: a bordered block, a badge, and the text fitting
//! every view needs.
//!
//! Almost no domain knowledge — the one exception is the naming rule
//! (`short`, `title_of`), which lives here because every surface that says a
//! suggestion's name must say the same one: the slug read as a sentence. The
//! slug itself stays internal — the id line at the foot of the detail window
//! is the one place it is shown as written.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType};

use crate::api::Suggestion;
use crate::theme;

/// Braille dots circling a square — the terminal's "something is moving".
const SPIN: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub fn spinner(frame: usize) -> char {
    SPIN[frame % SPIN.len()]
}

/// A slug read aloud: `a-dead-end` -> `A dead end`. Only the dashes go — an
/// underscore or a dot inside a slug is part of a filename it names, and
/// rewriting those would make the title lie about the file.
pub fn humanize(slug: &str) -> String {
    let mut out = slug.replace('-', " ");
    if let Some(first) = out.get(..1).and_then(|c| c.chars().next()) {
        out.replace_range(..1, &first.to_uppercase().to_string());
    }
    out
}

/// `user/kaizen/2026-08-08-a-dead-end.md` -> `A dead end`. Where all the worker
/// has is an id — a footer notice, an overlay title — this is its name.
pub fn short(id: &str) -> String {
    let slug = id
        .rsplit('/')
        .next()
        .unwrap_or(id)
        .trim_end_matches(".md")
        .splitn(4, '-')
        .nth(3)
        .unwrap_or(id);
    humanize(slug)
}

/// What to call a suggestion in one line. Falls back to the id's tail rather than
/// leaving a row anonymous.
pub fn title_of(s: &Suggestion) -> String {
    if s.slug.is_empty() {
        short(&s.id)
    } else {
        humanize(&s.slug)
    }
}

/// A block title longer than its border is drawn over the corner, so it is cut to
/// fit the area before the block is built rather than after.
pub fn titled(title: &str, area: Rect, focused: bool) -> Block<'static> {
    let colour = if focused { theme::accent() } else { theme::dim() };
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(colour))
        .title(Span::styled(
            format!(" {} ", truncate(title, area.width.saturating_sub(4) as usize)),
            Style::new().fg(colour),
        ))
}

/// No leading space: the badge row is the detail pane's first line and has to
/// start on the same column as the `scope` and `skill` labels under it.
pub fn truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

/// As many whole parts as fit, dropping from the end. A truncated key hint or a
/// half-written metric reads as a rendering bug; a shorter list does not.
pub fn fit_parts(parts: &[String], max: usize) -> String {
    let mut n = parts.len();
    while n > 1 {
        let joined = parts[..n].join(" · ");
        if joined.chars().count() <= max {
            return joined;
        }
        n -= 1;
    }
    truncate(parts.first().map(String::as_str).unwrap_or(""), max)
}

/// Greedy word wrap with a hanging indent, in characters rather than bytes.
pub fn wrapped(text: &str, indent: &str, width: usize) -> Vec<String> {
    let avail = width.saturating_sub(indent.chars().count()).max(24);
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > avail {
            lines.push(format!("{indent}{cur}"));
            cur.clear();
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        lines.push(format!("{indent}{cur}"));
    }
    lines
}

