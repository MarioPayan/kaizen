//! The board: every suggestion, laid out by where it stands.
//!
//! The queue answers "what should I look at next" — one ranked list, filtered.
//! This view answers "where is everything", which the queue structurally
//! cannot: a lane per status makes an empty plan column or a bulging recorded
//! column visible at a glance. It shows the whole corpus, terminals and muted
//! types included, because a state overview that hides state is a lie.
//!
//! Read-mostly on purpose: `a`/`r`/`d`/`t` work on the selected card, but
//! reading one item deeply and applying it happen in the queue, where the plan
//! and validation are on screen. `enter` takes you there.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::api::{State, Suggestion};
use crate::lifecycle::{is_terminal, lifecycle, status_icon};
use crate::theme::{severity_colour, severity_icon, tone_colour};
use crate::ui::{titled, truncate};

/// The columns, for the help card. A lane is a column of cards, so the pair
/// reads (what you see, what it means) like every other view's legend.
pub const COLUMNS: &[(&str, &str)] = &[
    ("lane", "one column per status that holds anything, in spec order; closed gathers the terminals"),
    ("card", "one suggestion — severity mark, then its slug — score-ordered within the lane"),
];

/// A lane the draw loop and the key handlers agree on: `title` is what the
/// border says, `tone` picks its colour, `items` are its cards in draw order.
pub struct Lane<'a> {
    pub title: String,
    pub tone: &'static str,
    pub items: Vec<&'a Suggestion>,
}

/// The terminals share one lane: three thin columns of finished work would
/// crowd out the live ones, and "done or dismissed" is one glance either way.
const CLOSED: &str = "closed";

/// Non-empty lanes in spec order, closed last. Generated from the spec, so a
/// renamed status cannot strand a lane — and empty lanes collapse, which is
/// what keeps cards readable instead of nine sliver columns.
pub fn lanes(state: &State) -> Vec<Lane<'_>> {
    let mut sorted: Vec<&Suggestion> = state.suggestions.iter().collect();
    sorted.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.id.cmp(&b.id))
    });

    let mut out: Vec<Lane<'_>> = lifecycle()
        .statuses
        .iter()
        .filter(|spec| !spec.terminal)
        .map(|spec| Lane {
            title: format!("{} {}", status_icon(&spec.id), spec.id),
            tone: spec.tone.as_str(),
            items: sorted.iter().filter(|s| s.status == spec.id).copied().collect(),
        })
        .filter(|lane| !lane.items.is_empty())
        .collect();

    let closed: Vec<&Suggestion> = sorted.iter().filter(|s| is_terminal(&s.status)).copied().collect();
    if !closed.is_empty() {
        out.push(Lane { title: CLOSED.into(), tone: "muted", items: closed });
    }
    out
}

/// A lane needs room for a mark, a word of slug and its border to say anything.
const MIN_LANE_W: u16 = 22;

pub fn draw(frame: &mut Frame, area: Rect, state: &State, lane_sel: usize, card_sel: usize) {
    let lanes = lanes(state);
    if lanes.is_empty() {
        frame.render_widget(
            Paragraph::new("\n  nothing filed yet — the board draws what the scanner finds"),
            area,
        );
        return;
    }

    // Show as many lanes as fit and scroll the window to the selected one,
    // rather than squeezing every lane into unreadable slivers.
    let fit = (area.width / MIN_LANE_W).clamp(1, lanes.len() as u16) as usize;
    let start = lane_sel.saturating_sub(fit - 1).min(lanes.len() - fit);
    let shown = &lanes[start..start + fit];

    let cells = Layout::horizontal(vec![Constraint::Ratio(1, fit as u32); fit]).split(area);
    for (i, (lane, cell)) in shown.iter().zip(cells.iter()).enumerate() {
        let selected = start + i == lane_sel;
        let title = format!("{} ({})", lane.title, lane.items.len());
        let block = titled(&title, *cell, selected)
            .title_style(Style::new().fg(tone_colour(lane.tone)).add_modifier(Modifier::BOLD));
        let inner_w = cell.width.saturating_sub(2) as usize;

        let cards: Vec<ListItem> = lane
            .items
            .iter()
            .map(|s| {
                ListItem::new(Line::from(vec![
                    ratatui::text::Span::styled(
                        format!("{} ", severity_icon(&s.severity)),
                        Style::new().fg(severity_colour(&s.severity)),
                    ),
                    ratatui::text::Span::raw(truncate(&s.slug, inner_w.saturating_sub(2))),
                ]))
            })
            .collect();

        let list =
            List::new(cards).block(block).highlight_style(Style::new().add_modifier(Modifier::REVERSED));
        // Only the selected lane has a cursor; the others still scroll to top.
        let mut cursor =
            ListState::default().with_selected(selected.then_some(card_sel.min(lane.items.len() - 1)));
        frame.render_stateful_widget(list, *cell, &mut cursor);
    }
}
