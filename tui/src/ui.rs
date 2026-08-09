//! The shared bits of drawing: a bordered block, a badge, and the text fitting
//! every view needs.
//!
//! No domain knowledge — nothing here knows what a suggestion is, which is why
//! all four views can use it without it becoming a layer between them and the
//! data.

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType};

use crate::theme;

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
/// start on the same column as the `scope` and `cluster` labels under it.
pub fn badge(label: &str, colour: Color) -> Span<'static> {
    Span::styled(format!("{label}  "), Style::new().fg(colour))
}

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

