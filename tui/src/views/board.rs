//! The board: every suggestion, laid out by where it stands — the command
//! centre.
//!
//! A lane per status makes an empty plan column or a bulging recorded column
//! visible at a glance. It shows the whole corpus, terminals and muted types
//! included, because a state overview that hides state is a lie.
//!
//! Everything happens here: `a` moves the selected card one lane on and `x`
//! takes it out — the same two keys in every lane, and what "on" costs is what
//! the lane's subtitle says — `d` shows its patch, and `enter` opens it whole
//! in a window over the board, so your place never moves.
//!
//! A card is drawn where it stands, and a run does not move it: a card being
//! worked on stays in its lane wearing the mark that says so — the spinner, its
//! place in line, `◌` — because a column that fills and empties with every run
//! is a board that rearranges itself under you. Three lanes sit past the
//! stages for the waits a status cannot express: `review`, where a status the
//! runner wrote sits until the reviewer clears it; `blocked`, for a card parked
//! on another card; and `closed`, for the terminals.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::api::{State, Suggestion};
use crate::lifecycle::{
    is_terminal, lifecycle, next_phase, pending_pass, reviewers, status_icon,
};
use crate::theme::{self, severity_colour, severity_icon, tone_colour};
use crate::ui::{title_of, titled, truncate};

/// The columns, for the help card. A lane is a column of cards, so the pair
/// reads (what you see, what it means) like every other view's legend.
pub const COLUMNS: &[(&str, &str)] = &[
    ("lane", "where a card stands: a pipeline stage, or one of the three it waits in"),
    ("card", "one suggestion — severity mark, uid, name; newest first, ruled by age"),
    ("flag", "a card waiting on something before it can move"),
    ("mark", "what is happening to this card right now"),
];

/// A lane the draw loop and the key handlers agree on: `title` is what the
/// border says, `subtitle` what the lane waits for, `tone` picks its colour,
/// `items` are its cards in draw order.
pub struct Lane<'a> {
    pub title: String,
    pub subtitle: String,
    pub tone: &'static str,
    pub items: Vec<&'a Suggestion>,
    /// Not a pipeline stage: a place a card waits rather than a status it holds.
    /// `A` widens a stage's move over its lane, and there is no such move here.
    pub holding: bool,
}

/// The three lanes that are not pipeline stages, in the order a card is tested
/// against them — each a wait a status cannot express.
///
/// `review` holds a status the runner wrote provisionally: opencode planned
/// the card and flagged it, and until claude clears the flag it is not in the
/// planned lane, because the planned lane is what `A` approves. The card wears
/// the spinner here while the check runs, and comes back to its stage when it
/// passes — or goes back a stage, parked on you, when it does not.
///
/// `blocked` draws the ⚑: a card whose frontmatter names another card it is
/// waiting on. No key moves it forward — that is the whole meaning of the
/// field — so it is honest to stop offering it a stage.
///
/// The terminals share one lane: three thin columns of finished work would
/// crowd out the live ones, and "done or dismissed" is one glance either way.
const REVIEW: &str = "◎ review";
const BLOCKED: &str = "⚑ blocked";
const CLOSED: &str = "closed";

/// What a status waits for and whose move it is — the line that answers "why
/// can't I approve this here". Derived, never written per status: the next
/// phase is the one producing what this status becomes, and its runner is the
/// spec's own word for who.
fn waits_for(status: &str) -> String {
    match next_phase(status) {
        Some(next) => format!("→ {} ({})", next.title.to_lowercase(), next.runner),
        None => String::new(),
    }
}

/// Lanes in spec order, then the three a card waits in. Generated from the
/// spec, so a renamed status cannot strand a lane. The pipeline stages — each
/// some phase's `produces` — stay visible even when empty, so the shape of the
/// loop is on screen and "what comes between triaged and approved" is never a
/// surprise; loop-back statuses collapse when empty, `review` always stands,
/// and `blocked` and `closed` appear only when occupied.
///
/// A card is drawn in exactly one lane, and not always the one its status
/// names: `home` decides, and it reads only facts already on the wire —
/// `needs_review`, `blocked_by`, and the spec's own terminals.
pub fn lanes(state: &State) -> Vec<Lane<'_>> {
    let mut sorted: Vec<&Suggestion> = state.suggestions.iter().collect();
    // Newest first: what came in since you last looked is at the top of every
    // lane, and the age rules fall out of the order for free. Score breaks
    // ties within a day, so a bad day still leads with its worst.
    sorted.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.id.cmp(&b.id))
    });

    // Where a card is drawn, which is not always its status. Order is the
    // precedence: a finished card is finished whatever else is stamped on it,
    // and a card waiting on another card is parked whether or not a check is
    // owed on it. A run in progress moves nothing — the card keeps its lane
    // and wears the mark.
    let home = |s: &Suggestion| -> Option<&'static str> {
        if is_terminal(&s.status) {
            Some(CLOSED)
        } else if !s.blocked_by.is_empty() {
            Some(BLOCKED)
        } else if !s.needs_review.is_empty() {
            Some(REVIEW)
        } else {
            None
        }
    };

    let spec = lifecycle();
    let mut out: Vec<Lane<'_>> = spec
        .statuses
        .iter()
        .filter(|s| !s.terminal)
        .map(|s| {
            (
                spec.phases.iter().any(|p| p.produces == s.id),
                Lane {
                    title: format!("{} {}", status_icon(&s.id), s.id),
                    subtitle: waits_for(&s.id),
                    tone: s.tone.as_str(),
                    items: sorted
                        .iter()
                        .filter(|x| x.status == s.id && home(x).is_none())
                        .copied()
                        .collect(),
                    holding: false,
                },
            )
        })
        .filter(|(stage, lane)| *stage || !lane.items.is_empty())
        .map(|(_, lane)| lane)
        .collect();

    // Appended in precedence order. `review` is drawn even when empty: it fills
    // and empties with every run, and a column that appears under you shifts
    // every lane to its right — you lose the card you were reading to a layout
    // change you did not ask for. The other two are steady enough to collapse.
    let check = format!("→ check ({})", reviewers().join("/"));
    for (title, subtitle, tone, always) in [
        (REVIEW, check.as_str(), "accent", true),
        (BLOCKED, "waiting on another card", "warning", false),
        (CLOSED, "done or dismissed · past week", "muted", false),
    ] {
        let items: Vec<&Suggestion> = sorted
            .iter()
            .filter(|s| home(s) == Some(title))
            // Closed work older than a week is history, and history that greets
            // you every session is noise — one pass left 194 finished cards
            // burying the three you had just watched land. Hidden on a positive
            // old stamp only, never on a missing one: a state that stops
            // carrying `age` should show too much, not silently show nothing.
            // Hiding is not removing — `kaizen prune` is what deletes.
            .filter(|s| title != CLOSED || !matches!(s.age.as_str(), "this month" | "older"))
            .copied()
            .collect();
        if always || !items.is_empty() {
            out.push(Lane {
                title: title.into(),
                subtitle: subtitle.into(),
                tone,
                items,
                holding: true,
            });
        }
    }
    out
}

/// A lane needs room for a mark, a uid, a word of name and its border to say
/// anything.
const MIN_LANE_W: u16 = 24;
/// And a band needs room for its borders, its subtitle and a few cards, or
/// wrapping has bought a lane you can see and not read.
const MIN_LANE_H: u16 = 10;
/// What a lane wants rather than needs: the uid and enough of the name to tell
/// two cards apart without opening either. Lanes wrap onto a second band to
/// reach this before they settle for `MIN_LANE_W`.
const WANT_LANE_W: u16 = 38;

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    state: &State,
    lane_sel: usize,
    card_sel: usize,
    spin: char,
    busy_on: Option<&str>,
) {
    let lanes = lanes(state);
    // The marker column exists only while something is actually moving — an
    // idle board spends its width on the slugs. When it exists, every card
    // gets it, so the lanes stay aligned.
    let live: Vec<&crate::api::Run> = state
        .dispatch
        .as_ref()
        .map(|d| d.runs.iter().filter(|r| r.running).collect())
        .unwrap_or_default();
    let queue: &[Option<String>] = state.dispatch.as_ref().map(|d| d.queue.as_slice()).unwrap_or(&[]);
    let backlog_live = live.iter().any(|r| r.id.is_none());
    let markers = !live.is_empty() || !queue.is_empty() || busy_on.is_some();
    // The pipeline lanes exist even with nothing filed, but an all-empty board
    // explains itself instead of drawing five hollow columns.
    if state.suggestions.is_empty() {
        frame.render_widget(
            Paragraph::new("\n  nothing filed yet — the board draws what the scanner finds"),
            area,
        );
        return;
    }

    // Lanes that do not fit across the width wrap onto a second band rather
    // than scrolling off the side. Seeing the whole board at once is what the
    // board is for: a lane you have to walk sideways to reach is a lane you
    // forget is there, and the pile in it is the pile you stop counting.
    //
    // The split is balanced, so eight lanes are 4 and 4 rather than 5 and 3,
    // and no band is taller than it is useful. When even the grid cannot hold
    // them — a narrow or short terminal — it pages to the selected lane, which
    // is the old behaviour and the only case that still hides anything.
    let fit = (area.width / MIN_LANE_W).clamp(1, lanes.len() as u16) as usize;
    let want = (area.width / WANT_LANE_W).clamp(1, lanes.len() as u16) as usize;
    let bands = (area.height / MIN_LANE_H).max(1) as usize;
    // Two bands at most. A third is a wall, not a glance, and by then the lanes
    // are short enough that the pile in each is guesswork again.
    let rows = lanes.len().div_ceil(want).min(bands).min(2);
    let cols = lanes.len().div_ceil(rows).min(fit);
    let page = rows * cols;
    let start = lane_sel / page * page;
    let shown = &lanes[start..(start + page).min(lanes.len())];

    let cells: Vec<Rect> = Layout::vertical(vec![Constraint::Ratio(1, rows as u32); rows])
        .split(area)
        .iter()
        .flat_map(|band| {
            Layout::horizontal(vec![Constraint::Ratio(1, cols as u32); cols]).split(*band).to_vec()
        })
        .collect();
    for (i, (lane, cell)) in shown.iter().zip(cells.iter()).enumerate() {
        let selected = start + i == lane_sel;
        let title = format!("{} ({})", lane.title, lane.items.len());
        let block = titled(&title, *cell, selected)
            .title_style(Style::new().fg(tone_colour(lane.tone)).add_modifier(Modifier::BOLD));
        let inner_w = cell.width.saturating_sub(2) as usize;

        // Rows are cards plus a rule wherever the age changes — `today`, then
        // `this week`, and so on down. The rules are rows in the list so they
        // scroll with the cards, but the cursor only ever lands on a card:
        // `row_of` maps the selected card to its row.
        let mut rows: Vec<ListItem> = Vec::with_capacity(lane.items.len() + 4);
        let mut row_of: Vec<usize> = Vec::with_capacity(lane.items.len());
        let mut age = "";
        for s in &lane.items {
            if s.age != age {
                age = &s.age;
                let head = format!("─ {age} ");
                let rule = head.clone() + &"─".repeat(inner_w.saturating_sub(head.chars().count()));
                rows.push(ListItem::new(Line::styled(
                    truncate(&rule, inner_w),
                    Style::new().fg(theme::rule()),
                )));
            }
            row_of.push(rows.len());
            rows.push({
                let mut spans = Vec::with_capacity(4);
                if markers {
                    // The spinner is the card being worked: an id-fenced run,
                    // or a decide/apply key waiting on the server. A number is
                    // the card's place in line for the seat. ◌ is a card the
                    // backlog run has yet to reach — it drains live as the run
                    // relabels them.
                    let in_line = queue.iter().position(|q| q.as_deref() == Some(s.id.as_str()));
                    if busy_on == Some(s.id.as_str())
                        || live.iter().any(|r| r.id.as_deref() == Some(s.id.as_str()))
                    {
                        spans.push(ratatui::text::Span::styled(
                            format!("{spin} "),
                            Style::new().fg(theme::accent()),
                        ));
                    } else if let Some(at) = in_line {
                        // ponytail: two cells, so the column holds to 99 in line.
                        spans.push(ratatui::text::Span::styled(
                            format!("{:<2}", at + 1),
                            Style::new().fg(theme::accent()),
                        ));
                    } else if backlog_live && pending_pass(&s.status, &s.needs_review, &s.blocked_on) {
                        spans.push(ratatui::text::Span::styled(
                            "◌ ".to_string(),
                            Style::new().fg(theme::dim()),
                        ));
                    } else {
                        spans.push(ratatui::text::Span::raw("  "));
                    }
                }
                spans.push(ratatui::text::Span::styled(
                    format!("{} ", severity_icon(&s.severity)),
                    Style::new().fg(severity_colour(&s.severity)),
                ));
                // The uid rides in front, dim: a handle, not the name. Ahead of
                // the title so it never truncates away on a narrow lane, and
                // so it forms a column the eye can walk to find one card.
                spans.push(ratatui::text::Span::styled(
                    format!("{} ", s.uid),
                    Style::new().fg(theme::dim()),
                ));
                let mut used = if markers { 4 } else { 2 } + s.uid.chars().count() + 1;
                // The flag says "this one needs you before it moves". It burns
                // where that is actionable — a card standing in its own lane,
                // waiting on something only you can do — and goes quiet in the
                // blocked lane, where the lane title already says it and every
                // row would otherwise wear the same mark.
                // Never on a finished card: a superseded one keeps whatever its
                // block last said, and a flag in the closed lane asks for
                // something nobody owes any more.
                if !s.blocked_on.is_empty() && !is_terminal(&s.status) {
                    let ink =
                        if s.blocked_by.is_empty() { theme::warn() } else { theme::dim() };
                    spans.push(ratatui::text::Span::styled("⚑ ", Style::new().fg(ink)));
                    used += 2;
                }
                spans.push(ratatui::text::Span::raw(truncate(&title_of(s), inner_w.saturating_sub(used))));
                ListItem::new(Line::from(spans))
            });
        }

        // The block renders alone so the subtitle can take the first inner row
        // and the cards the rest.
        let inner = block.inner(*cell);
        frame.render_widget(block, *cell);
        let [caption, body] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);
        frame.render_widget(
            Paragraph::new(truncate(&lane.subtitle, inner_w)).style(Style::new().fg(theme::dim())),
            caption,
        );

        let list =
            List::new(rows).highlight_style(Style::new().add_modifier(Modifier::REVERSED));
        // Only the selected lane has a cursor; the others still scroll to top.
        // `checked_sub` because an empty pipeline lane has no card to select.
        let mut cursor = ListState::default().with_selected(
            lane.items
                .len()
                .checked_sub(1)
                .filter(|_| selected)
                .map(|max| row_of[card_sel.min(max)]),
        );
        frame.render_stateful_widget(list, body, &mut cursor);
    }
}
