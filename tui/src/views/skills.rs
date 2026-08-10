//! Skills, ranked by the ratio the whole tool argues about.
//!
//! `per100` is failures per hundred lines of prose. A skill with scripts and no
//! complaints is the shape this system is trying to produce; heavy prose with a
//! high complaint rate is what it is trying to remove. Both the ratio and the
//! label come from the scanner, so this view derives nothing.

use ratatui::layout::{Constraint, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::widgets::{Cell, Paragraph, Row, Table, TableState, Wrap};
use ratatui::Frame;

use crate::api::Skill;
use crate::theme;
use crate::ui::titled;

/// The columns, and what they mean. The header is built from the first of each
/// pair, so it cannot drift from the explanation.
pub const COLUMNS: &[(&str, &str)] = &[
    ("health", "the shape of this skill, in one word"),
    ("per100", "suggestions per 100 lines of prose: the ratio the tool argues about"),
    ("filed", "suggestions filed against this skill"),
    ("scripts", "scripts it can call instead of re-deriving the same thing"),
    ("lines", "how much prose it carries"),
    ("skill", "name, or the library module's path"),
];

/// What each `health` word means. Its own list rather than a run-on in the
/// column's description, because four values crammed into one sentence is the
/// thing you have to re-read.
pub const HEALTH: &[(&str, &str)] = &[
    ("scripted", "has scripts and nothing filed — the shape to aim for"),
    ("noisy", "two or more suggestions per hundred lines"),
    ("watch", "some, but under that"),
    ("quiet", "nothing filed against it"),
];

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

    let body: Vec<Row> = rows
        .iter()
        .map(|s| {
            Row::new(vec![
                Cell::from(s.health.clone()).style(
                    Style::new().fg(health_colour(&s.health)).add_modifier(
                        if s.health == "noisy" { Modifier::BOLD } else { Modifier::empty() },
                    ),
                ),
                Cell::from(format!("{:.2}", s.per100)).style(Style::new().fg(theme::accent())),
                Cell::from(s.suggestions.to_string()).style(Style::new().fg(theme::dim())),
                Cell::from(s.scripts.to_string()).style(Style::new().fg(theme::ok())),
                Cell::from(s.lines.to_string()).style(Style::new().fg(theme::dim())),
                Cell::from(s.name.clone()),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(8),
        Constraint::Length(6),
        Constraint::Length(5),
        Constraint::Length(7),
        Constraint::Length(5),
        Constraint::Fill(1),
    ];

    let mut state = TableState::default().with_selected(Some(sel));
    frame.render_stateful_widget(
        Table::new(body, widths)
            // `2.36 17 0 721` is unreadable without these; per100 in particular
            // is the number the whole tool argues about and looked like noise.
            .header(
                Row::new(COLUMNS.iter().map(|(name, _)| *name).collect::<Vec<_>>())
                    .style(Style::new().fg(theme::dim()).add_modifier(Modifier::BOLD)),
            )
            .column_spacing(2)
            .highlight_symbol("▸ ")
            .row_highlight_style(Style::new().bg(theme::selection_bg())),
        inner,
        &mut state,
    );
}
