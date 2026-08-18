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
//! `a` is a promise that the card leaves the lane. Three of the moves it makes
//! are not a new status: a pre-decision advance spawns a run that takes minutes,
//! a card can be parked on something outside the pipeline, and a finished card
//! is finished. So there are three lanes past the stages — `working`, `blocked`
//! and `closed` — and every press lands the card in a stage or in one of them.
//! A key that leaves the card visibly where it was is a key you stop trusting.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::api::{State, Suggestion};
use crate::lifecycle::{
    awaits_pass, is_terminal, lifecycle, next_statuses, pending_pass, status_icon,
};
use crate::theme::{self, severity_colour, severity_icon, tone_colour};
use crate::ui::{title_of, titled, truncate};

/// The columns, for the help card. A lane is a column of cards, so the pair
/// reads (what you see, what it means) like every other view's legend.
pub const COLUMNS: &[(&str, &str)] = &[
    ("lane", "one pipeline stage per column, in spec order and always on screen so the path to done is visible; under each title, what the lane waits for and whose move it is — which is what `a` does to a card there; after the stages come the three lanes a card waits in rather than holds — working while a run has it, blocked while its frontmatter names something only you can clear, closed for the terminals — and each appears only when occupied; lanes wrap onto a second band rather than scrolling off the right, so the whole board is one glance"),
    ("card", "one suggestion — severity mark, its three-letter uid, then its name — newest first within the lane, under a rule for today, this week, this month and older; the uid is three letters of the name, unique across the board, and stays the same wherever the card lands; ⚑ marks a card parked on a decision only you can make (enter says which); while work is in flight, the spinner marks the card being worked, a number the card's place in line for the next run, and ◌ the ones a backlog run still owes"),
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
/// against them. They exist so `a` keeps its promise: press it and the card
/// leaves the lane, always — to the next stage, or to one of these.
///
/// `working` is the answer to the wait a status cannot express. Advancing out
/// of a pre-decision lane spawns a fable run that takes minutes and one seat,
/// so the card is neither where it was nor where it is going; it used to sit in
/// its old lane wearing a spinner, which reads as "the key did nothing".
///
/// `blocked` draws the ⚑: a card whose frontmatter names something outside the
/// pipeline it is waiting on. No key moves it forward — that is the whole
/// meaning of the field — so it is honest to stop offering it a stage.
///
/// The terminals share one lane: three thin columns of finished work would
/// crowd out the live ones, and "done or dismissed" is one glance either way.
const WORKING: &str = "⟳ working";
const BLOCKED: &str = "⚑ blocked";
const CLOSED: &str = "closed";

/// What a status waits for and whose move it is — the line that answers "why
/// can't I approve this here". Derived, never written per status: the next
/// phase is the one producing something this status can become, and who runs
/// it falls out of `attended` and the pass gate.
fn waits_for(status: &str) -> String {
    let Some(next) =
        lifecycle().phases.iter().find(|p| next_statuses(status).contains(&p.produces))
    else {
        return String::new();
    };
    let who = if next.attended {
        "you"
    } else if awaits_pass(status) {
        "fable"
    } else {
        "auto"
    };
    format!("→ {} ({who})", next.title.to_lowercase())
}

/// Lanes in spec order, then the three a card waits in. Generated from the
/// spec, so a renamed status cannot strand a lane. The pipeline stages — each
/// some phase's `produces` — stay visible even when empty, so the shape of the
/// loop is on screen and "what comes between triaged and approved" is never a
/// surprise; loop-back statuses collapse when empty, and `working`, `blocked`
/// and `closed` appear only when occupied.
///
/// A card is drawn in exactly one lane, and not always the one its status
/// names: `home` decides, and it reads only facts already on the wire — the
/// dispatch seat and line, `blocked_on`, and the spec's own terminals.
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

    // The cards a run is holding: one fenced to the card, or a place in the
    // queue for the next seat. A backlog run is fenced to nothing, so the cards
    // it will eventually reach keep their lane and wear `◌` instead — being
    // next in a sweep is not the same as being worked.
    let held: Vec<&str> = state
        .dispatch
        .as_ref()
        .map(|d| {
            d.runs
                .iter()
                .filter(|r| r.running)
                .filter_map(|r| r.id.as_deref())
                .chain(d.queue.iter().filter_map(|q| q.as_deref()))
                .collect()
        })
        .unwrap_or_default();

    // Where a card is drawn, which is not always its status. Order is the
    // precedence: a run in progress outranks the block it may be about to
    // write, and a finished card is finished whatever else is stamped on it.
    let home = |s: &Suggestion| -> Option<&'static str> {
        if held.contains(&s.id.as_str()) {
            Some(WORKING)
        } else if is_terminal(&s.status) {
            Some(CLOSED)
        } else if !s.blocked_on.is_empty() {
            Some(BLOCKED)
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

    // Appended in precedence order, and only when occupied: an empty stage is
    // the shape of the pipeline, but an empty holding pen is just a column.
    for (title, subtitle, tone) in [
        (WORKING, "a run has it", "accent"),
        (BLOCKED, "parked on you — enter says why", "warning"),
        (CLOSED, "done or dismissed", "muted"),
    ] {
        let items: Vec<&Suggestion> =
            sorted.iter().filter(|s| home(s) == Some(title)).copied().collect();
        if !items.is_empty() {
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
                    // The spinner is the card being worked: an id-fenced fable
                    // run, or a decide/apply key waiting on the server. A number
                    // is the card's place in line for the seat. ◌ is a card the
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
                    } else if backlog_live && pending_pass(&s.status, &s.blocked_on) {
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
                // Parked on you: the flag is the one thing on a card that says
                // "no key here moves this — you do". Only on those cards, so
                // it reads as a signal and not a column.
                if !s.blocked_on.is_empty() {
                    spans.push(ratatui::text::Span::styled("⚑ ", Style::new().fg(theme::warn())));
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
