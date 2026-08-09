//! Clusters, because one fix closes all of them.
//!
//! This is the highest-value screen in the tool: approving nine suggestions that
//! share one file is one decision, not nine. The queue can only ever show you
//! the cluster of the row you happen to be on.
//!
//! Read-only apart from `A`. Deciding still happens in the queue, where the plan
//! and the validation plan are visible — approving a cluster from a list of ids
//! alone would be the un-evidenced yes the model exists to prevent.

use ratatui::layout::{Constraint, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Cell, Paragraph, Row, Table, TableState, Wrap};
use ratatui::Frame;

use crate::api::Cluster;
use crate::theme;
use crate::ui::titled;

/// Worth acting on: more than one member, promoted first, then by what it cost.
pub fn actionable(clusters: &[Cluster]) -> Vec<&Cluster> {
    let mut out: Vec<&Cluster> = clusters.iter().filter(|c| c.size > 1).collect();
    out.sort_by(|a, b| {
        b.promoted
            .cmp(&a.promoted)
            .then_with(|| b.incidents.cmp(&a.incidents))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    clusters: &[Cluster],
    sel: usize,
    focused: bool,
    // How many members could still be approved. Shown because the server's
    // cluster write is all-or-nothing: a cluster whose members have all been
    // decided refuses the whole call, and reading that off a 409 that names one
    // file is a poor way to find out.
    ready: &dyn Fn(&str) -> usize,
) {
    let rows = actionable(clusters);
    let live = rows.iter().filter(|c| ready(&c.id) > 0).count();
    let outer = titled(&format!("Clusters ({} · {live} actionable)", rows.len()), area, focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if rows.is_empty() {
        frame.render_widget(
            Paragraph::new("nothing has been filed twice — no cluster to decide as one")
                .wrap(Wrap { trim: false })
                .style(Style::new().fg(theme::dim())),
            inner,
        );
        return;
    }

    let body: Vec<Row> = rows
        .iter()
        .map(|c| {
            let open = ready(&c.id);
            // A cluster with nothing left to decide is dimmed whole, so the eye
            // skips it rather than landing there and pressing A.
            let done = open == 0;
            let tone = |c: Color| if done { theme::dim() } else { c };
            Row::new(vec![
                Cell::from(if c.promoted { "▲" } else { "" }).style(Style::new().fg(tone(theme::warn()))),
                Cell::from(format!("{open}/{}", c.size)).style(Style::new().fg(tone(theme::ok()))),
                Cell::from(c.incidents.to_string()).style(Style::new().fg(tone(theme::accent()))),
                Cell::from(format!("{}d", c.span_days)).style(Style::new().fg(theme::dim())),
                Cell::from(c.id.clone()).style(if done { Style::new().fg(theme::dim()) } else { Style::new() }),
                Cell::from(c.scopes.first().cloned().unwrap_or_else(|| "—".into()))
                    .style(Style::new().fg(theme::dim())),
            ])
        })
        .collect();

    // Widths are declared, not computed. The arithmetic this replaces — a FIXED
    // constant, a `spare`, two derived widths — is where every off-by-one
    // truncation lived, and it had to be redone on each column change.
    let widths = [
        Constraint::Length(1),
        Constraint::Length(7),
        Constraint::Length(4),
        Constraint::Length(5),
        Constraint::Fill(4),
        Constraint::Fill(5),
    ];

    let mut state = TableState::default().with_selected(Some(sel));
    frame.render_stateful_widget(
        Table::new(body, widths)
            // Numeric columns are meaningless unlabelled: `9 27 70d` needs a
            // header far more than a slug does.
            .header(
                Row::new(vec!["", "open", "inc", "span", "cluster", "the file one fix lands in"])
                    .style(Style::new().fg(theme::dim()).add_modifier(Modifier::BOLD)),
            )
            .column_spacing(2)
            .highlight_symbol("▸ ")
            .row_highlight_style(Style::new().bg(theme::selection_bg())),
        inner,
        &mut state,
    );
}
