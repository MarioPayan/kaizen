//! Clusters, because one fix closes all of them.
//!
//! This is the highest-value screen in the tool and the reason the skill used to
//! say "point at the app if the queue is long": approving nine suggestions that
//! share one file is one decision, not nine. The queue can only ever show you
//! the cluster of the row you happen to be on.
//!
//! Read-only apart from `A`. Deciding still happens in the queue, where the
//! plan and the validation plan are visible — approving a cluster from a list of
//! ids alone would be exactly the un-evidenced yes the model exists to prevent.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::api::Cluster;
use crate::theme;
use crate::ui::{titled, truncate};

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

pub fn draw(frame: &mut Frame, area: Rect, clusters: &[Cluster], sel: usize, focused: bool) {
    let rows = actionable(clusters);
    let promoted = rows.iter().filter(|c| c.promoted).count();
    let outer = titled(&format!("Clusters ({} · {promoted} promoted)", rows.len()), area, focused);
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

    // promoted(2) + size(5) + incidents(6) + days(6) are fixed; the id and the
    // scope share the rest, with the scope favoured — the id is a slug built out
    // of the members' words, the scope is the file the one fix lands in.
    const FIXED: u16 = 19;
    const MARKER: u16 = 2;
    let spare = inner.width.saturating_sub(FIXED + MARKER) as usize;
    let id_w = (spare / 2).min(34);
    let scope_w = spare.saturating_sub(id_w + 2);

    let items: Vec<ListItem> = rows
        .iter()
        .map(|c| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    if c.promoted { "▲ " } else { "  " },
                    Style::new().fg(theme::warn()).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("{:>3}  ", c.size), Style::new().fg(theme::dim())),
                Span::styled(format!("{:>4}  ", c.incidents), Style::new().fg(theme::accent())),
                Span::styled(format!("{:>4}d ", c.span_days), Style::new().fg(theme::dim())),
                Span::raw(format!("{:<width$}  ", truncate(&c.id, id_w), width = id_w)),
                Span::styled(
                    truncate(c.scopes.first().map(String::as_str).unwrap_or("—"), scope_w),
                    Style::new().fg(theme::dim()),
                ),
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
