//! Skills, ranked by the ratio the whole tool argues about.
//!
//! `per100` is failures per hundred lines of prose. A skill with scripts and no
//! complaints is the shape this system is trying to produce; heavy prose with a
//! high complaint rate is what it is trying to remove. Both the ratio and the
//! label come from the scanner, so this view derives nothing.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::api::Skill;
use crate::theme;
use crate::ui::{titled, truncate};

/// Worst ratio first — the list is a work order, not a directory.
pub fn ranked(skills: &[Skill]) -> Vec<&Skill> {
    let mut out: Vec<&Skill> = skills.iter().collect();
    out.sort_by(|a, b| {
        b.per100
            .partial_cmp(&a.per100)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.suggestions.cmp(&a.suggestions))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

fn health_colour(health: &str) -> ratatui::style::Color {
    match health {
        "scripted" => theme::ok(),
        "noisy" => theme::err(),
        "watch" => theme::warn(),
        _ => theme::dim(),
    }
}

pub fn draw(frame: &mut Frame, area: Rect, skills: &[Skill], sel: usize, focused: bool) {
    let rows = ranked(skills);
    let scripted = rows.iter().filter(|s| s.health == "scripted").count();
    let outer = titled(&format!("Skills ({} · {scripted} scripted)", rows.len()), area, focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if rows.is_empty() {
        frame.render_widget(
            Paragraph::new("no skills found — check the targets in settings")
                .wrap(Wrap { trim: false })
                .style(Style::new().fg(theme::dim())),
            inner,
        );
        return;
    }

    // health(9) + per100(7) + filed(6) + scripts(4) + lines(6) are fixed; the
    // name takes the rest. The name is what you read down, same as the queue.
    const FIXED: u16 = 32;
    const MARKER: u16 = 2;
    let name_w = inner.width.saturating_sub(FIXED + MARKER) as usize;

    let items: Vec<ListItem> = rows
        .iter()
        .map(|s| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{:<9}", s.health),
                    Style::new().fg(health_colour(&s.health)).add_modifier(
                        if s.health == "noisy" { Modifier::BOLD } else { Modifier::empty() },
                    ),
                ),
                Span::styled(format!("{:>6.2} ", s.per100), Style::new().fg(theme::accent())),
                Span::styled(format!("{:>4}  ", s.suggestions), Style::new().fg(theme::dim())),
                Span::styled(format!("{:>2}  ", s.scripts), Style::new().fg(theme::ok())),
                Span::styled(format!("{:>5} ", s.lines), Style::new().fg(theme::dim())),
                Span::raw(truncate(&s.name, name_w)),
            ]))
        })
        .collect();

    let mut state = ListState::default().with_selected(Some(sel));
    frame.render_stateful_widget(
        List::new(items)
            .highlight_symbol("▸ ")
            .highlight_style(Style::new().bg(theme::selection_bg()))
            .scroll_padding(2),
        inner,
        &mut state,
    );
}
