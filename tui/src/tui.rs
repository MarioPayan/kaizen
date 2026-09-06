//! The board, as a terminal UI — the command centre the other tabs orbit.
//!
//! Every HTTP call happens on a worker thread and comes back over a channel. That
//! is not premature: `GET /api/state` rescans the skills tree and takes ~40ms, and
//! `POST /api/apply` runs `git apply` and two more git commands. Doing either on
//! the draw loop makes the board stutter on every file change.
//!
//! Applying is never optimistic. It produces a commit sha and can be refused three
//! ways — dirty tree, read-only target, no patch — so the card only moves once the
//! server says it did, and a refusal is shown in the server's own words.
//!
//! Reading one item whole happens in a window over the board (`enter`), so your
//! place never moves; moving a card on (`a`) or out (`x`) happens where you
//! already are, and what "on" costs is the lane's business — see `advance`.

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Tabs, Wrap};
use ratatui::Frame;
use std::sync::mpsc;
use std::time::Duration;

use crate::api::{ApplyRefusal, Client, Config, State, Suggestion, Target};
use crate::theme::{self, severity_colour, status_colour, tone_colour};
use crate::ui::{fit_parts, short, title_of, titled, truncate, wrapped};
use crate::keys::{self, Action, Tab};
use crate::unblock::{other_targets, ways_out, Needs};
use crate::views::{agent, board, settings, skills};
use crate::lifecycle::{
    actor_of, awaits_pass, decision_status, exit, forward, is_terminal, landed_status, lifecycle,
    next_statuses, status_icon, status_line, status_spec,
};

/// 100ms, which is the spinner's frame rate: a 10-frame braille cycle turns
/// once a second. Ratatui diff-draws, so the extra wakeups cost almost nothing.
const TICK: Duration = Duration::from_millis(100);

/* -------------------------------------------------------------------- work ---- */

enum Req {
    Refresh,
    SetStatus { id: String, status: String },
    Sweep { status: String },
    /// `id` fences the run to one suggestion; `None` takes the backlog.
    Dispatch { id: Option<String> },
    Apply { id: String },
    /// Write what a card waits on, or clear it. Not a status move: the card
    /// stays in its lane and stops asking.
    SetBlock { id: String, text: String },
    /// Land these in order and stop at the first refusal — the reason the first
    /// one refused is the reason the rest would.
    ApplyAll { ids: Vec<String> },
    Diff { id: String },
    Config,
    SaveConfig(serde_json::Value),
    SkillFile { path: String },
    /// One of the ways out of a parked card, as the menu named it, with what
    /// the choice asked for.
    Unblock { id: String, choice: &'static str, text: Option<String>, target: Option<String> },
}

enum Res {
    State(Result<State, String>),
    /// A one-line result of something the user asked for, good or bad.
    Acted(Result<String, String>),
    Diff(String, Result<Option<String>, String>),
    Config(Result<(Config, serde_json::Value), String>),
    SkillFile(String, Result<String, String>),
}

fn spawn_worker(client: Client, rx: mpsc::Receiver<Req>, tx: mpsc::Sender<Res>) {
    std::thread::spawn(move || {
        for req in rx {
            let res = match req {
                Req::Refresh => Res::State(client.state()),
                Req::SetStatus { id, status } => Res::Acted(
                    client.set_status(&id, &status).map(|_| format!("{status}: {}", short(&id))),
                ),
                Req::SetBlock { id, text } => Res::Acted(client.set_block(&id, &text).map(|_| {
                    if text.is_empty() {
                        format!("{} is no longer waiting on you", short(&id))
                    } else {
                        format!("{} now waits on: {text}", short(&id))
                    }
                })),
                Req::Sweep { status } => Res::Acted(
                    client.sweep(&status).map(|(moved, skipped)| {
                        if skipped == 0 {
                            format!("{status} {moved}")
                        } else {
                            format!("{status} {moved} — {skipped} not ready")
                        }
                    }),
                ),
                Req::Dispatch { id } => Res::Acted(client.dispatch(id.as_deref()).map(|(n, at)| {
                    match (&id, at) {
                        (Some(id), 0) => format!("a run is on {} — its row relabels as it lands", short(id)),
                        (None, 0) => format!("a run is on {n} — rows relabel as it lands"),
                        (Some(id), at) => format!("{} is {at} in line — the next seat takes it", short(id)),
                        (None, at) => format!("the backlog is {at} in line — the next seat takes it"),
                    }
                })),
                Req::Apply { id } => Res::Acted(
                    client
                        .apply(&id)
                        .map(|(sha, closed)| {
                            let sha = &sha[..7.min(sha.len())];
                            if closed == 0 {
                                format!("applied {} — {sha}", short(&id))
                            } else {
                                format!("applied {} — {sha} · closed {closed} sibling(s)", short(&id))
                            }
                        })
                        .map_err(|e| match e {
                            // The card now stands with the reason on it; the
                            // menu is one `a` away.
                            ApplyRefusal::Parked(why) => format!("parked {} — {why} (a for the ways out)", short(&id)),
                            ApplyRefusal::Stopped(why) => why,
                        }),
                ),
                Req::ApplyAll { ids } => {
                    // A patch that cannot land parks its card and the walk goes
                    // on; a tree that is not ready stops it, since the reason
                    // the first one refused is the reason the rest would.
                    let mut landed = 0;
                    let mut parked = 0;
                    let mut stopped = None;
                    for id in &ids {
                        match client.apply(id) {
                            Ok(_) => landed += 1,
                            Err(ApplyRefusal::Parked(_)) => parked += 1,
                            Err(ApplyRefusal::Stopped(e)) => {
                                stopped = Some(format!("{}: {e}", short(id)));
                                break;
                            }
                        }
                    }
                    let tally = match parked {
                        0 => format!("applied {landed}"),
                        n => format!("applied {landed}, parked {n} with their reasons"),
                    };
                    Res::Acted(match stopped {
                        None => Ok(format!("{tally} — the lane is walked")),
                        Some(why) if landed == 0 && parked == 0 => Err(why),
                        Some(why) => Err(format!("{tally}, then stopped at {why}")),
                    })
                }
                Req::Unblock { id, choice, text, target } => Res::Acted(
                    client
                        .unblock(&id, choice, text.as_deref(), target.as_deref())
                        .map(|did| format!("{}: {did}", short(&id))),
                ),
                Req::Diff { id } => {
                    let out = client.diff(&id);
                    Res::Diff(id, out)
                }
                Req::Config => Res::Config(client.config()),
                Req::SaveConfig(next) => Res::Acted(
                    client.save_config(&next).map(|_| "config saved".to_string()),
                ),
                Req::SkillFile { path } => {
                    let out = client.skill_file(&path);
                    Res::SkillFile(path, out)
                }
            };
            if tx.send(res).is_err() {
                return;
            }
        }
    });
}

/* ------------------------------------------------------------------- state ---- */

/// Things you consult, drawn on top of whichever tab you are on.
///
/// Help carries both halves rather than being two overlays: the keys and the
/// model are the two questions you have while looking at the board, and making
/// them one overlay with a switch means you never have to remember which key
/// opened which.
///
/// `Detail` holds the id, not an index: a refresh can reorder the lanes under
/// the window, and the id keeps it on the same suggestion regardless.
enum Overlay {
    Help { guide: bool, scroll: u16 },
    Diff { id: String, body: String, scroll: u16 },
    File { path: String, body: String, scroll: u16 },
    Detail { id: String, scroll: u16 },
    /// The ways out of a parked card: the reason in full, the moves as a
    /// list, and — when the move asks for something — the field for it.
    Unblock { id: String, cursor: usize, ask: Ask },
}

/// What the ways-out menu is asking for right now.
#[derive(Debug, Clone, PartialEq)]
enum Ask {
    /// Pick a move.
    Menu,
    /// Type a line for this move; the footer is the field.
    Text { choice: &'static str, text: String },
    /// Pick a target for the move.
    Target { cursor: usize },
}

/// Where you were, precisely enough to put you back.
///
/// Not just the tab: returning to a list with the cursor reset to the top is
/// still losing your place, and the whole complaint about `esc` was that it
/// did not take you back to where you actually were.
#[derive(Clone, PartialEq)]
struct Place {
    tab: Tab,
    board_lane: usize,
    board_sel: usize,
    skill_sel: usize,
    setting_sel: u16,
}

struct Notice {
    text: String,
    error: bool,
}

struct App {
    state: Option<State>,
    error: Option<String>,
    overlay: Option<Overlay>,
    notice: Option<Notice>,
    live: bool,
    busy: bool,
    /// The card an id-targeted request is out for — an advance or discard, so
    /// the board can spin that card, not just the header.
    busy_on: Option<String>,
    /// The runs last seen going — pid and what each was fenced to — so the
    /// state where one is gone can say what became of its card. By pid, not a
    /// flag: with a line behind them the seats are never all empty, and the
    /// next run is already up when this one's ending arrives.
    runs_seen: Vec<(u64, Option<String>)>,
    /// `/` on the board: the text typed so far. While `Some`, keys go here and
    /// the cursor follows the first card whose uid or name matches.
    find: Option<String>,
    /// The card whose block is being written, and the text so far. Prefilled
    /// with what it already says, because most answers are an edit of one.
    block: Option<(String, String)>,
    /// Bumped once per loop iteration; the spinner glyph derives from it, so
    /// `draw` stays a pure function of `&App` and tests can pin a frame.
    spin: usize,
    tab: Tab,
    /// One cursor per list, so switching tabs does not move the other one.
    /// The board has two — which lane, and which card in it.
    board_lane: usize,
    board_sel: usize,
    skill_sel: usize,
    setting_sel: u16,
    /// The config being edited. Edits land here and are POSTed on `s`, so a
    /// half-made change is never saved and the file on disk stays whole.
    config: Option<serde_json::Value>,
    config_saved: Option<serde_json::Value>,
    config_errors: Vec<String>,
    /// Everywhere you have been, most recent last. `esc` pops it.
    history: Vec<Place>,
}

impl App {
    fn new() -> Self {
        Self {
            state: None,
            error: None,
            overlay: None,
            notice: None,
            live: false,
            busy: true,
            busy_on: None,
            runs_seen: Vec::new(),
            find: None,
            block: None,
            spin: 0,
            tab: Tab::Board,
            board_lane: 0,
            board_sel: 0,
            skill_sel: 0,
            setting_sel: 0,
            config: None,
            config_saved: None,
            config_errors: Vec::new(),
            history: Vec::new(),
        }
    }

    /// The card under the board's two cursors, straight from the lanes the view
    /// draws — same source, so the keys act on what the eye is on.
    fn board_selected(&self) -> Option<&Suggestion> {
        let state = self.state.as_ref()?;
        board::lanes(state).get(self.board_lane)?.items.get(self.board_sel).copied()
    }

    fn selected_id(&self) -> Option<String> {
        self.board_selected().map(|s| s.id.clone())
    }

    /// Anything that can shrink the board — a refresh most of all — has to leave
    /// the selection on a card that still exists: a relabelled card moves lanes,
    /// and an emptied lane collapses.
    fn clamp(&mut self) {
        let lanes = self.state.as_ref().map(board::lanes).unwrap_or_default();
        self.board_lane = self.board_lane.min(lanes.len().saturating_sub(1));
        let cards = lanes.get(self.board_lane).map(|l| l.items.len()).unwrap_or(0);
        self.board_sel = self.board_sel.min(cards.saturating_sub(1));
    }

    /// j/k, dispatched to whatever the current tab is actually showing.
    ///
    /// One entry point rather than a match at every call site, so the four
    /// tabs cannot drift apart on what a step means.
    fn move_by(&mut self, delta: isize) {
        let step = |cur: usize, len: usize| -> usize {
            if len == 0 {
                0
            } else {
                (cur as isize + delta).clamp(0, len as isize - 1) as usize
            }
        };
        match self.tab {
            // The agents tab is a short list with nothing to select.
            Tab::Agent => {}
            Tab::Board => {
                let cards = self
                    .state
                    .as_ref()
                    .and_then(|s| board::lanes(s).get(self.board_lane).map(|l| l.items.len()))
                    .unwrap_or(0);
                self.board_sel = step(self.board_sel, cards);
            }
            Tab::Skills => {
                self.skill_sel = step(self.skill_sel, self.skills().len());
            }
            Tab::Settings => {
                let len = self
                    .config
                    .as_ref()
                    .map(|c| settings::editable(&settings::rows(c)).len())
                    .unwrap_or(0);
                self.setting_sel = step(self.setting_sel as usize, len) as u16;
            }
        }
    }

    fn place(&self) -> Place {
        Place {
            tab: self.tab,
            board_lane: self.board_lane,
            board_sel: self.board_sel,
            skill_sel: self.skill_sel,
            setting_sel: self.setting_sel,
        }
    }

    /// Remember where we are, before going somewhere else.
    ///
    /// Capped, and never twice in a row for the same place: holding `2` should
    /// not bury the way back under forty copies of the categories tab.
    fn remember(&mut self) {
        let here = self.place();
        if self.history.last() == Some(&here) {
            return;
        }
        self.history.push(here);
        if self.history.len() > 32 {
            self.history.remove(0);
        }
    }

    fn go_back(&mut self) -> bool {
        let Some(p) = self.history.pop() else { return false };
        self.tab = p.tab;
        self.board_lane = p.board_lane;
        self.board_sel = p.board_sel;
        self.skill_sel = p.skill_sel;
        self.setting_sel = p.setting_sel;
        self.clamp();
        true
    }

    /// Space on the selected settings row: flip, step, or join a list.
    fn edit_setting(&mut self) {
        let Some(cfg) = self.config.as_mut() else { return };
        let all = settings::rows(cfg);
        let Some(&i) = settings::editable(&all).get(self.setting_sel as usize) else { return };
        settings::apply(cfg, &all[i]);
    }

    /// The draft, if it differs from what the server last gave us. Nothing is
    /// pending before the first load, however the two Options happen to sit.
    fn pending_config(&self) -> Option<serde_json::Value> {
        let cfg = self.config.as_ref()?;
        let saved = self.config_saved.as_ref()?;
        (cfg != saved).then(|| cfg.clone())
    }

    fn config_dirty(&self) -> bool {
        self.pending_config().is_some()
    }

    fn skills(&self) -> Vec<&crate::api::Skill> {
        self.state.as_ref().map(|s| skills::ranked(&s.skills)).unwrap_or_default()
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some(Notice { text: text.into(), error });
    }

    /// The status the selected lane holds — what `A` widens over. `None` for
    /// an empty lane; the closed lane answers with whichever terminal is on top,
    /// which has no forward move, so it refuses like any other.
    fn lane_status(&self) -> Option<String> {
        let state = self.state.as_ref()?;
        board::lanes(state).get(self.board_lane)?.items.first().map(|s| s.status.clone())
    }

    /// Is the selected lane a place cards wait rather than a stage they hold?
    fn lane_holding(&self) -> bool {
        self.state
            .as_ref()
            .and_then(|s| board::lanes(s).get(self.board_lane).map(|l| l.holding))
            .unwrap_or(false)
    }
}

/// What `a` costs this card: the one move its lane waits for. `Err` is the
/// refusal, in the footer's words — said here, before a 409 or a 422 travels
/// the wire to say the same thing.
///
/// Derived, so a lane cannot be left without its key: wherever a model moves
/// the card a run is sent — opencode to do, claude to check — at the decision
/// you do, right after it the server lands it. A card flagged for a check is
/// the reviewer's whatever its status, so the flag is read before the status.
///
/// Takes the card, not just its status, because the block is a fact about the
/// card. A parked one refuses here rather than on the wire: the request would
/// be accepted as far as the status is concerned and spend a detached model run
/// to conclude what `blocked_on` already says.
fn advance(s: &Suggestion) -> Result<Req, String> {
    let from = s.status.as_str();
    let Some(to) = forward(from) else {
        return Err(format!("{from} is terminal — nothing follows it"));
    };
    if !s.blocked_by.is_empty() {
        // Waiting on another card. Nothing here is your move — the carrier
        // landing is — and advancing anyway writes a status its own patch will
        // contradict.
        Err(format!("waiting on {} — {}", short(&s.blocked_by), s.blocked_on))
    } else if !s.needs_review.is_empty() || awaits_pass(from) {
        if !s.blocked_on.is_empty() {
            // The block is on you, and a pass cannot do what you have to do.
            // The key handler opens the ways out before it gets here; this is
            // the sentence for the one caller that does not.
            return Err(format!("needs you — {} (a for the ways out, b to answer)", s.blocked_on));
        }
        Ok(Req::Dispatch { id: Some(s.id.clone()) })
    } else if to == decision_status() {
        Ok(Req::SetStatus { id: s.id.clone(), status: to.into() })
    } else if Some(to) == landed_status() {
        Ok(Req::Apply { id: s.id.clone() })
    } else {
        let who = actor_of(to).unwrap_or("someone else");
        Err(format!("{from} → {to} is done by {who}, not by a key"))
    }
}

/// What to say when the run in the seat is gone. A fenced run is judged by
/// where its card ended up — the status is the outcome, and the lane it lands
/// in is named when that is off to the right; a backlog run by its exit code,
/// when the state still holds it (a line behind it may already have moved on),
/// and by name, since two runners take turns at the same backlog.
fn run_outcome(state: &State, pid: u64, fenced: Option<&str>) -> (String, bool) {
    if let Some(id) = fenced {
        return match state.suggestions.iter().find(|s| s.id == id) {
            Some(s) => {
                let lane = if is_terminal(&s.status) { " (closed lane)" } else { "" };
                (format!("{} → {}{lane}", short(id), s.status), false)
            }
            None => (format!("{} → gone from disk", short(id)), true),
        };
    }
    let left = state.suggestions.iter().filter(|s| awaits_pass(&s.status)).count();
    let run = state.dispatch.as_ref().and_then(|d| d.runs.iter().find(|r| r.pid == pid));
    let who = run.map(|r| r.runner.as_str()).filter(|r| !r.is_empty()).unwrap_or("the run");
    match run.and_then(|r| r.exit_code) {
        Some(0) => (format!("{who} is done — {left} still to advance"), false),
        Some(code) => (format!("{who} failed (exit {code}) — 2 opens the agent tab"), true),
        // Adopted across a restart, or already aged off the list: no code to
        // read, and nothing to alarm about.
        None => (format!("{who} ended — {left} still to advance"), false),
    }
}

/// The card `/` lands on: the first, in lane order, whose uid starts with the
/// query or whose name contains it, case-blind. Position as (lane, card).
fn find_card(state: &State, query: &str) -> Option<(usize, usize)> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return None;
    }
    board::lanes(state).iter().enumerate().find_map(|(l, lane)| {
        lane.items
            .iter()
            .position(|s| s.uid.to_lowercase().starts_with(&q) || title_of(s).to_lowercase().contains(&q))
            .map(|c| (l, c))
    })
}

/// `x`: the card's way out. Not every status has one — the pipeline owns a
/// failed item, and a terminal is already out.
///
/// Never gated on `blocked_on`: closing a card is exactly the move a parked one
/// still has, and a lane you can enter but not leave is a worse bug than the
/// one the block prevents.
fn discard(s: &Suggestion) -> Result<Req, String> {
    let from = s.status.as_str();
    match exit(from) {
        Some(to) => Ok(Req::SetStatus { id: s.id.clone(), status: to.into() }),
        None if next_statuses(from).is_empty() => {
            Err(format!("{from} is terminal — nothing follows it"))
        }
        None => Err(format!("{from} has no way out — it can only become {}", next_statuses(from).join(", "))),
    }
}

/* -------------------------------------------------------------------- draw ---- */

/// How wide a fact cell has to be before three of them are worth having.
const FACT_W: usize = 26;
/// The label column inside a cell, so values line up down the window.
const LABEL_W: usize = 10;

/// One `label value` line, for the facts too long to share a row.
fn field(label: &str, value: String, ink: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<LABEL_W$}"), Style::new().fg(theme::dim())),
        Span::styled(value, Style::new().fg(ink)),
    ])
}

/// The card's short facts, `label value`, three to a row.
///
/// They used to be a row of bare badges — `AID  high  approved  structural
/// bug` — five words with nothing saying which question each answers. You had
/// to know the vocabulary to read your own card. A label costs one column and
/// buys that back; three to a row keeps it to a few lines rather than a form.
///
/// Empty facts are left out rather than dashed: an untriaged card has no type,
/// objective, rung or effort yet, and five dashes say that worse than the
/// `missing:` line at the bottom already does.
fn fact_rows(s: &Suggestion, width: usize) -> Vec<Line<'static>> {
    let rung = s.rung.map(|r| r.to_string()).unwrap_or_default();
    let facts: Vec<(&str, String, Color)> = [
        ("uid", s.uid.clone(), theme::dim()),
        ("severity", s.severity.clone(), severity_colour(&s.severity)),
        ("status", s.status.clone(), status_colour(&s.status)),
        ("type", s.kind.clone(), theme::accent()),
        ("objective", s.objective.clone(), theme::accent()),
        ("rung", rung, Color::Reset),
        ("effort", s.effort.clone(), Color::Reset),
        ("score", format!("{}", s.score.round() as i64), Color::Reset),
        ("incidents", s.incidents.to_string(), Color::Reset),
    ]
    .into_iter()
    .filter(|(_, v, _)| !v.is_empty())
    .collect();

    // Three where there is room, fewer where there is not — a cell narrower
    // than its label and value is two columns of nothing.
    let cols = (width / FACT_W).clamp(1, 3);
    let cell = width / cols;
    facts
        .chunks(cols)
        .map(|row| {
            let mut spans = Vec::with_capacity(row.len() * 3);
            for (label, value, ink) in row {
                spans.push(Span::styled(
                    format!("{label:<LABEL_W$}"),
                    Style::new().fg(theme::dim()),
                ));
                spans.push(Span::styled(value.clone(), Style::new().fg(*ink)));
                let used = LABEL_W + value.chars().count();
                spans.push(Span::raw(" ".repeat(cell.saturating_sub(used))));
            }
            Line::from(spans)
        })
        .collect()
}

fn detail_lines(s: &Suggestion, width: usize) -> Vec<Line<'static>> {
    // The slug is the block's title, so the body opens on the facts rather than on
    // three wrapped lines of the id — which is kept, dimmed, at the bottom.
    let mut lines = fact_rows(s, width);
    // The long ones get a line each: a path, a stamp and a sha do not fit a
    // third of a window, and truncating the answer to "which commit" is worse
    // than spending the row.
    if !s.scope.is_empty() {
        lines.push(field("scope", s.scope.clone(), Color::Reset));
    }
    if !s.confirmed_at.is_empty() {
        lines.push(field("confirmed", s.confirmed_at.clone(), theme::dim()));
    }
    if !s.applied_sha.is_empty() {
        lines.push(field("applied", s.applied_sha.clone(), theme::dim()));
    }
    if !s.blocked_on.is_empty() {
        // Which of the two waits this is, in the label rather than in the prose
        // underneath: one of them is yours to end and the other is not.
        let (tag, ink) = if s.blocked_by.is_empty() {
            ("⚑ on you ", theme::warn())
        } else {
            ("⚑ waits on ", theme::dim())
        };
        lines.push(Line::from(vec![
            Span::styled(tag, Style::new().fg(ink)),
            Span::styled(s.blocked_on.clone(), Style::new().fg(ink)),
        ]));
    }
    if !s.needs_review.is_empty() {
        // The status above is provisional until this name clears it.
        lines.push(field("check", format!("waiting on {}", s.needs_review), theme::accent()));
    }

    for (heading, body) in [
        ("Context", &s.context),
        ("Suggestion", &s.suggestion),
        ("Rationale", &s.rationale),
        ("Review", &s.review),
        ("Verdict", &s.verdict),
    ] {
        if body.trim().is_empty() {
            continue;
        }
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            heading.to_string(),
            Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
        ));
        for para in body.split('\n') {
            lines.push(Line::raw(para.to_string()));
        }
    }
    if !s.missing.is_empty() {
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            format!("missing: {}", s.missing.join(", ")),
            Style::new().fg(theme::warn()),
        ));
    }
    lines.push(Line::raw(""));
    lines.push(Line::styled(s.id.clone(), Style::new().fg(theme::dim())));
    lines
}

/// The closed set a column can hold, when it has one.
///
/// A sub-list rather than a run-on inside the description: nine statuses in one
/// wrapped sentence is a thing you read twice and still lose your place in.
/// Empty for a column whose values are open — a slug or a filename.
fn column_values(tab: Tab, column: &str) -> Vec<(String, String)> {
    let pairs = |xs: &[(&str, &str)]| {
        xs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>()
    };
    match (tab, column) {
        // Generated, so renaming a status cannot leave a stale legend behind.
        // The three lanes past the stages are the view's own and are named here.
        (Tab::Board, "lane") => lifecycle()
            .statuses
            .iter()
            .map(|s| (format!("{} {}", status_icon(&s.id), s.abbrev), s.id.clone()))
            .chain(pairs(&[("◎ rvw", "review"), ("⚑ blk", "blocked"), ("· cls", "closed")]))
            .collect(),
        (Tab::Board, "card") => pairs(&[("▲", "high"), ("►", "medium"), ("▼", "low")]),
        (Tab::Board, "flag") => pairs(&[
            ("⚑ lit", "waiting on you — b answers it, and the card stays in its lane"),
            ("⚑ dim", "waiting on another card, over in blocked"),
        ]),
        (Tab::Board, "mark") => pairs(&[
            ("⠋", "a run has this card"),
            ("1", "its place in line for the next seat"),
            ("◌", "a backlog run has yet to reach it"),
        ]),
        (Tab::Skills, "health") => pairs(skills::HEALTH),
        _ => Vec::new(),
    }
}

fn columns_for(tab: Tab) -> &'static [(&'static str, &'static str)] {
    match tab {
        Tab::Board => board::COLUMNS,
        Tab::Agent => agent::COLUMNS,
        Tab::Skills => skills::COLUMNS,
        Tab::Settings => settings::COLUMNS,
    }
}

/// The keys for one tab, from the table that also dispatches them.
///
/// Only what works here. The same `tabs` field that stops a key firing on the
/// wrong view is what keeps it off this card, so the two cannot disagree — and
/// a key that means something different per view shows the meaning it has here
/// rather than all three at once.
fn help_keys(tab: Tab) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for (section, bindings) in keys::sections(tab) {
        out.push(Line::styled(
            section.to_string(),
            Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
        ));
        for b in bindings {
            out.push(Line::from(vec![
                Span::styled(format!("  {:<7}", b.hint), Style::new().fg(theme::ok())),
                Span::raw(b.label),
            ]));
        }
        out.push(Line::raw(""));
    }
    // Only where advancing is a thing you can do here. A footnote about git on
    // the settings card is the same clutter as a key you cannot press.
    if keys::resolve(KeyCode::Char('a'), tab) == Some(keys::Action::Advance) {
        for line in [
            "advance does what the lane waits for:",
            "a run, your yes, or the server",
            "landing the patch — which needs a",
            "clean tree and a patch on disk.",
            "on a card parked on you it opens",
            "the ways out: pick one, enter",
        ] {
            out.push(Line::styled(line, Style::new().fg(theme::dim())));
        }
    }
    out
}

/// What the numbers on this view mean.
///
/// Same source as the table header for the views that have one, and the only
/// naming the queue's columns get — it is a composed line, not a table, so
/// `42 H apr` is otherwise unexplained anywhere.
fn help_columns(tab: Tab, width: usize) -> Vec<Line<'static>> {
    let mut out = vec![Line::styled(
        "columns".to_string(),
        Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
    )];
    for (name, meaning) in columns_for(tab) {
        out.push(Line::styled(
            format!("  {name}"),
            Style::new().fg(theme::ok()),
        ));
        for line in wrapped(meaning, "    ", width) {
            out.push(Line::styled(line, Style::new().fg(theme::dim())));
        }
        // Sized to the longest value in this list, not a fixed column: three
        // letters padded to eleven reads as two separate lists.
        let values = column_values(tab, name);
        let pad = values.iter().map(|(v, _)| v.chars().count()).max().unwrap_or(0) + 2;
        for (value, meaning) in values {
            // Wrapped here, with the value's column left blank on continuation
            // rows. Letting the Paragraph wrap it restarts at column zero, which
            // puts the second half of a sentence under the next value.
            let avail = width.saturating_sub(6 + pad).max(16);
            for (n, chunk) in wrapped(&meaning, "", avail).iter().enumerate() {
                out.push(Line::from(vec![
                    Span::styled(
                        format!("      {:<pad$}", if n == 0 { value.as_str() } else { "" }),
                        Style::new().fg(theme::ok()),
                    ),
                    Span::styled(chunk.clone(), Style::new().fg(theme::dim())),
                ]));
            }
        }
    }
    out
}

/// The lifecycle, drawn from the embedded spec.
///
/// Built as ratatui lines rather than by rendering `docs/LIFECYCLE.md`: the
/// markdown is itself generated from this same file, so parsing it here would
/// mean a markdown dependency to read a document we already hold as data.
fn docs_lines(width: usize) -> Vec<Line<'static>> {
    let l = lifecycle();
    let head = |t: &str| {
        Line::styled(format!("  {t}"), Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD))
    };
    let dim = |t: String| Line::styled(t, Style::new().fg(theme::dim()));
    // Prose is wrapped here rather than by the Paragraph: ratatui restarts a
    // continuation line at column zero, which turns every indented summary into
    // a ragged block that is harder to read than the thing it describes.
    let prose = |t: &str, indent: &str| -> Vec<Line<'static>> {
        wrapped(t, indent, width)
            .into_iter()
            .map(|s| Line::styled(s, Style::new().fg(theme::dim())))
            .collect()
    };
    let mut out = vec![
        Line::styled(
            "  The suggestion lifecycle",
            Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
        dim(format!(
            "    {} phases. A suggestion rests in exactly one status between each,",
            l.phases.len()
        )),
        dim("    so \"where is this\" always has one answer.".into()),
        Line::raw(""),
        head("phases"),
    ];

    for (i, p) in l.phases.iter().enumerate() {
        let rests = status_spec(&p.produces);
        out.push(Line::from(vec![
            Span::styled(format!("    {} ", i + 1), Style::new().fg(theme::dim())),
            Span::styled(format!("{:<9}", p.title), Style::new().add_modifier(Modifier::BOLD)),
            Span::styled(format!("{:<32}", p.actor), Style::new().fg(theme::dim())),
            Span::styled("→ ", Style::new().fg(theme::dim())),
            Span::styled(
                p.produces.clone(),
                Style::new().fg(rests.map(|s| tone_colour(&s.tone)).unwrap_or_else(theme::dim)),
            ),
            // The one thing worth spotting at a glance: which phase stops for you.
            Span::styled(
                if p.attended { "   needs you" } else { "" }.to_string(),
                Style::new().fg(theme::warn()),
            ),
            // And the other: whose word is provisional until someone else's.
            Span::styled(
                if p.reviewer.is_empty() { String::new() } else { format!("   checked by {}", p.reviewer) },
                Style::new().fg(theme::accent()),
            ),
        ]));
        out.extend(prose(&p.summary, "      "));
        if !p.requires.is_empty() {
            out.extend(prose(&format!("needs: {}", p.requires.join(", ")), "      "));
        }
        out.push(Line::raw(""));
    }

    out.push(head("statuses"));
    for s in &l.statuses {
        out.push(Line::from(vec![
            Span::styled(format!("    {} ", status_icon(&s.id)), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("{:<4} ", s.abbrev), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("{:<11}", s.id), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("{:<9}", s.phase), Style::new().fg(theme::dim())),
        ]));
        out.extend(prose(&s.help, "      "));
    }
    out.push(Line::raw(""));

    out.push(head("what can follow what"));
    let width = l.statuses.iter().map(|s| s.id.len()).max().unwrap_or(10);
    for s in &l.statuses {
        let to = if s.next.is_empty() { "(terminal)".to_string() } else { s.next.join(" | ") };
        out.push(Line::from(vec![
            Span::styled(format!("    {:<width$} ", s.id, width = width), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("→ {to}"), Style::new().fg(theme::dim())),
        ]));
    }
    out.push(Line::raw(""));

    // The one kaizen surface that is not on this screen. It greets you in a
    // prompt where there is nothing to ask, so the glyphs are explained where
    // you would go looking — here — and from the same spec the CLI paints from.
    let sl = status_line();
    out.push(head("the session line"));
    out.extend(prose(&sl.help, "    "));
    out.push(Line::raw(""));
    out.push(Line::from(vec![
        Span::styled(format!("    {} ", sl.mark), Style::new().fg(theme::accent())),
        Span::styled(
            sl.piles.iter().map(|p| format!("{}n", p.glyph)).collect::<Vec<_>>().join(" "),
            Style::new().fg(theme::dim()),
        ),
    ]));
    out.push(Line::raw(""));
    for pile in &sl.piles {
        out.push(Line::from(vec![
            Span::styled(format!("    {} ", pile.glyph), Style::new().fg(theme::warn())),
            Span::styled(format!("{:<20}", pile.label), Style::new().fg(theme::accent())),
        ]));
        out.extend(prose(&pile.help, "      "));
    }
    out.push(Line::raw(""));

    out.push(head("the item format"));
    for f in &l.fields {
        let phase = l.phases.iter().find(|p| p.id == f.phase).map(|p| p.title.as_str());
        out.push(Line::from(vec![
            Span::styled(format!("    {:<14}", f.id), Style::new().fg(theme::accent())),
            Span::styled(
                format!("{:<9}", phase.unwrap_or(&f.phase)),
                Style::new().fg(theme::dim()),
            ),
        ]));
        out.extend(prose(&f.help, "      "));
    }

    out
}

/// The targets out of the raw config the settings tab holds. Typed here, once,
/// because the ways-out menu is the only other reader and it wants the names.
fn targets_of(config: Option<&serde_json::Value>) -> Vec<Target> {
    config
        .and_then(|c| c.get("targets"))
        .and_then(|t| serde_json::from_value::<Vec<Target>>(t.clone()).ok())
        .unwrap_or_default()
}

/// The ways-out window: the reason in full — the footer truncated it, which
/// is half of why the menu exists — then the moves, the chosen one marked, and
/// what the move is asking for, if anything.
fn unblock_lines(
    s: &Suggestion,
    targets: &[Target],
    cursor: usize,
    ask: &Ask,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = wrapped(&format!("⚑ {}", s.blocked_on), "", width)
        .into_iter()
        .map(|l| Line::styled(l, Style::new().fg(theme::warn())))
        .collect();
    lines.push(Line::raw(""));
    match ask {
        Ask::Target { cursor } => {
            lines.push(Line::styled(
                "move to which target?".to_string(),
                Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
            ));
            for (i, t) in other_targets(s, targets).iter().enumerate() {
                let mark = if i == *cursor { "▸ " } else { "  " };
                lines.push(Line::from(vec![
                    Span::styled(mark.to_string(), Style::new().fg(theme::accent())),
                    Span::styled(t.name.clone(), Style::new().add_modifier(Modifier::BOLD)),
                    Span::styled(format!("   {}", t.skills), Style::new().fg(theme::dim())),
                ]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                "j/k move · enter move it · esc back".to_string(),
                Style::new().fg(theme::dim()),
            ));
        }
        _ => {
            for (i, w) in ways_out(s, targets).iter().enumerate() {
                let picked = i == cursor;
                let mark = if picked { "▸ " } else { "  " };
                lines.push(Line::from(vec![
                    Span::styled(mark.to_string(), Style::new().fg(theme::accent())),
                    Span::styled(
                        w.label.to_string(),
                        if picked {
                            Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD)
                        } else {
                            Style::new().add_modifier(Modifier::BOLD)
                        },
                    ),
                ]));
                lines.extend(
                    wrapped(w.help, "    ", width)
                        .into_iter()
                        .map(|l| Line::styled(l, Style::new().fg(theme::dim()))),
                );
            }
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                match ask {
                    Ask::Text { .. } => "type below · enter sends · esc back to the list".to_string(),
                    _ => "j/k move · enter pick · esc back".to_string(),
                },
                Style::new().fg(theme::dim()),
            ));
        }
    }
    lines
}

fn draw_overlay(
    frame: &mut Frame,
    area: Rect,
    overlay: &Overlay,
    tab: Tab,
    state: Option<&State>,
    targets: &[Target],
) {
    // Size first: the docs and the columns both wrap their own prose and need to
    // know how wide the box will be. `min` after the clamp — on a terminal
    // narrower than the floor the box would be wider than the screen and the
    // centring subtraction underflows.
    let w = area.width.saturating_sub(8).clamp(20, 120).min(area.width);
    let h = area.height.saturating_sub(4).max(6).min(area.height);
    let box_area = Rect::new((area.width - w) / 2, (area.height - h) / 2, w, h);
    let inner_w = w.saturating_sub(2) as usize;

    let (title, scroll) = match overlay {
        Overlay::Help { guide, scroll } => (
            // Both halves named in the title, the current one marked, so the
            // switch is discoverable without being explained. The keys half
            // names its view, because it is showing that view's keys only.
            format!(
                "help — {} keys ({}) {} guide   (tab switches)",
                if *guide { " " } else { "▸" },
                tab.label(),
                if *guide { "▸" } else { " " },
            ),
            *scroll,
        ),
        Overlay::File { path, scroll, .. } => {
            (format!("file — {}", path.rsplit('/').next().unwrap_or(path)), *scroll)
        }
        Overlay::Diff { id, scroll, .. } => (format!("patch — {}", short(id)), *scroll),
        Overlay::Detail { id, scroll } => (format!("detail — {}", short(id)), *scroll),
        Overlay::Unblock { id, .. } => (format!("ways out — {}", short(id)), 0),
    };

    frame.render_widget(Clear, box_area);
    let block = titled(&title, box_area, true);
    let inner = block.inner(box_area);
    frame.render_widget(block, box_area);

    let paragraph = |lines: Vec<Line<'static>>| {
        Paragraph::new(lines).wrap(Wrap { trim: false }).scroll((scroll, 0))
    };

    match overlay {
        // Two columns: what the numbers mean on the left, what the keys do on
        // the right. They answer different questions and reading one should not
        // mean scrolling past the other.
        Overlay::Help { guide: false, .. } if inner.width >= 72 => {
            let [left, right] =
                Layout::horizontal([Constraint::Percentage(58), Constraint::Min(22)]).areas(inner);
            frame.render_widget(paragraph(help_columns(tab, left.width as usize - 1)), left);
            frame.render_widget(paragraph(help_keys(tab)), right);
        }
        // Too narrow to sit side by side: keys first, since that is what `h` was
        // pressed for, then the columns under them.
        Overlay::Help { guide: false, .. } => {
            let mut lines = help_keys(tab);
            lines.push(Line::raw(""));
            lines.extend(help_columns(tab, inner_w));
            frame.render_widget(paragraph(lines), inner);
        }
        Overlay::Help { .. } => frame.render_widget(paragraph(docs_lines(inner_w)), inner),
        Overlay::File { body, .. } => frame.render_widget(
            paragraph(body.lines().map(|l| Line::raw(l.to_string())).collect()),
            inner,
        ),
        Overlay::Diff { body, .. } => {
            let lines = body
                .lines()
                .map(|l| {
                    let colour = match l.chars().next() {
                        Some('+') if !l.starts_with("+++") => theme::ok(),
                        Some('-') if !l.starts_with("---") => theme::err(),
                        Some('@') => theme::accent(),
                        _ => theme::dim(),
                    };
                    Line::styled(l.to_string(), Style::new().fg(colour))
                })
                .collect();
            frame.render_widget(paragraph(lines), inner);
        }
        Overlay::Detail { id, .. } => {
            let lines = match state.and_then(|st| st.suggestions.iter().find(|s| s.id == *id)) {
                Some(s) => detail_lines(s, inner_w),
                // A refresh can close the file under the window; a calm line
                // beats a popup that silently shows someone else's card.
                None => vec![Line::styled(
                    "gone — the state refreshed it away (esc)".to_string(),
                    Style::new().fg(theme::dim()),
                )],
            };
            frame.render_widget(paragraph(lines), inner);
        }
        Overlay::Unblock { id, cursor, ask } => {
            let lines = match state.and_then(|st| st.suggestions.iter().find(|s| s.id == *id)) {
                Some(s) => unblock_lines(s, targets, *cursor, ask, inner_w),
                None => vec![Line::styled(
                    "gone — the state refreshed it away (esc)".to_string(),
                    Style::new().fg(theme::dim()),
                )],
            };
            frame.render_widget(paragraph(lines), inner);
        }
    }
}

fn draw(frame: &mut Frame, app: &App) {
    let [header, body, footer] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0), Constraint::Length(1)])
            .areas(frame.area());

    let m = app.state.as_ref().map(|s| s.metrics.clone()).unwrap_or_default();
    let mut parts = vec![format!("{} open", m.open)];
    if app.busy {
        parts.push(format!("{} working…", crate::ui::spinner(app.spin)));
    }
    parts.push(format!("{} untriaged", m.untriaged));
    if m.on_you > 0 {
        parts.push(format!("⚑ {} on you", m.on_you));
    }
    let agents = app
        .state
        .as_ref()
        .and_then(|s| s.dispatch.as_ref())
        .map(|d| d.runs.iter().filter(|r| r.running).count())
        .unwrap_or(0);
    if agents > 0 {
        let word = if agents == 1 { "agent" } else { "agents" };
        parts.push(format!("{} {agents} {word}", crate::ui::spinner(app.spin)));
    }
    // The tab bar doubles as its own legend: the number beside each name is the
    // key that gets there, so there is nothing to look up. `Tabs` owns the
    // divider and the selected styling, which is three fewer things to align.
    let titles: Vec<String> =
        Tab::ALL.iter().enumerate().map(|(i, t)| format!("{} {}", i + 1, t.label())).collect();
    let bar_w: usize = titles.iter().map(|s| s.chars().count() + 3).sum::<usize>() + 10;
    let [brand, bar, metrics] = Layout::horizontal([
        Constraint::Length(9),
        Constraint::Length(bar_w as u16),
        Constraint::Min(0),
    ])
    .areas(header);

    let live = if app.live { "●" } else { "○" };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" kaizen ", Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD)),
            Span::styled(live, Style::new().fg(if app.live { theme::ok() } else { theme::dim() })),
        ])),
        brand,
    );
    frame.render_widget(
        Tabs::new(titles)
            .select(Tab::ALL.iter().position(|t| *t == app.tab).unwrap_or(0))
            .style(Style::new().fg(theme::dim()))
            .highlight_style(Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD))
            .divider("·"),
        bar,
    );
    frame.render_widget(
        Paragraph::new(fit_parts(&parts, metrics.width as usize))
            .style(Style::new().fg(theme::dim())),
        metrics,
    );

    if let Some(err) = &app.error {
        frame.render_widget(
            Paragraph::new(format!("\n  {err}\n\n  Is the server running?  kaizen serve"))
                .wrap(Wrap { trim: false })
                .style(Style::new().fg(theme::err()))
                .block(titled("cannot read state", body, false)),
            body,
        );
    } else {
        match app.tab {
            Tab::Board => {
                if let Some(state) = app.state.as_ref() {
                    board::draw(
                        frame,
                        body,
                        state,
                        app.board_lane,
                        app.board_sel,
                        crate::ui::spinner(app.spin),
                        app.busy_on.as_deref(),
                    );
                } else {
                    // The board is the front door now, so the first-load message
                    // the queue used to carry lives here.
                    frame.render_widget(
                        Paragraph::new("reading skills…").style(Style::new().fg(theme::dim())),
                        body,
                    );
                }
            }
            Tab::Agent => agent::draw(
                frame,
                body,
                app.state.as_ref().and_then(|s| s.dispatch.as_ref()),
                crate::ui::spinner(app.spin),
            ),
            Tab::Skills => {
                let list = app.state.as_ref().map(|s| s.skills.as_slice()).unwrap_or(&[]);
                skills::draw(frame, body, list, app.skill_sel, true);
            }
            Tab::Settings => settings::draw(
                frame,
                body,
                app.config.as_ref(),
                app.config_dirty(),
                &app.config_errors,
                app.setting_sel as usize,
            ),
        }
    }

    draw_footer(frame, footer, app);

    if let Some(overlay) = &app.overlay {
        draw_overlay(
            frame,
            frame.area(),
            overlay,
            app.tab,
            app.state.as_ref(),
            &targets_of(app.config.as_ref()),
        );
    }
}

fn draw_footer(frame: &mut Frame, footer: Rect, app: &App) {
    // Whole hints or none: a truncated key name reads as a rendering bug. The
    // base URL used to sit on the right; it was never something anyone needed
    // mid-decision, and it was taking the room the keys wanted.
    let width = footer.width as usize;
    let (text, colour) = if let Some((_, b)) = &app.block {
        // The card is still on screen behind this; the footer is the field.
        (format!(" ⚑ {b}▏  enter saves · empty clears · esc back"), theme::warn())
    } else if let Some(Overlay::Unblock { ask: Ask::Text { choice, text }, .. }) = &app.overlay {
        // The menu's move wants a line: same field, in the move's name.
        (format!(" {choice}: {text}▏  enter sends · esc back"), theme::warn())
    } else if let Some(q) = &app.find {
        // The prompt takes the footer while it is open: the cursor is already
        // on the first match, so this line is the query and how to leave it.
        (format!(" /{q}▏  enter keeps · esc back"), theme::accent())
    } else if let Some(n) = &app.notice {
        (
            format!(" {}", truncate(&n.text, width.saturating_sub(1))),
            if n.error { theme::err() } else { theme::ok() },
        )
    } else {
        let parts: Vec<String> =
            keys::hints(app.tab).iter().map(|(k, v)| format!("{k} {v}")).collect();
        (format!(" {}", fit_parts(&parts, width.saturating_sub(1))), theme::dim())
    };
    frame.render_widget(Paragraph::new(text).style(Style::new().fg(colour)), footer);
}

/* -------------------------------------------------------------------- loop ---- */

pub fn main(base: Option<String>) -> std::io::Result<()> {
    let client = Client::new(base);
    let base = client.base().to_string();

    // Before the terminal is taken over, so anything said here stays readable.
    // A failure is reported and then ignored: the TUI already has an honest
    // "cannot reach the server" screen, and that beats refusing to open.
    match crate::api::ensure_server(&base) {
        Ok(crate::api::Started::AlreadyUp) => {}
        Ok(crate::api::Started::Spawned) => eprintln!("kaizen: started the server at {base}"),
        Err(e) => eprintln!("kaizen: {e}"),
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        ratatui::restore();
        default_hook(info);
    }));

    let (req_tx, req_rx) = mpsc::channel::<Req>();
    let (res_tx, res_rx) = mpsc::channel::<Res>();
    spawn_worker(Client::new(Some(base.clone())), req_rx, res_tx);
    let (ev_tx, ev_rx) = mpsc::channel::<String>();
    crate::api::spawn_stream(base.clone(), ev_tx);

    let mut app = App::new();
    let _ = req_tx.send(Req::Refresh);

    // `try_init` rather than `init`: the latter panics when there is no terminal
    // to take over — piped output, a cron run — and a ratatui backtrace is a poor
    // way to say "this needs a TTY".
    let mut terminal = ratatui::try_init().map_err(|e| {
        std::io::Error::new(e.kind(), format!("{e} — this needs a terminal (is output piped?)"))
    })?;
    let result = run(&mut terminal, &mut app, &req_tx, &res_rx, &ev_rx);
    ratatui::restore();
    result
}

fn run(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
    req: &mpsc::Sender<Req>,
    res: &mpsc::Receiver<Res>,
    events: &mpsc::Receiver<String>,
) -> std::io::Result<()> {
    loop {
        // The server pushes when the files it watches change; `hello` carries the
        // watched set, and an empty one means it connected but watches nothing.
        while let Ok(event) = events.try_recv() {
            match event.as_str() {
                "__disconnected" => app.live = false,
                // `dispatch` fires when the run starts or dies — the one ending
                // a crash would otherwise never show, since it writes no files.
                "change" | "dispatch" => {
                    app.live = true;
                    app.busy = true;
                    let _ = req.send(Req::Refresh);
                }
                _ => app.live = true,
            }
        }
        while let Ok(message) = res.try_recv() {
            app.busy = false;
            // Whatever was out has answered; a still-running fenced dispatch
            // keeps its card spinning through `state.dispatch` instead.
            app.busy_on = None;
            match message {
                Res::State(Ok(state)) => {
                    app.error = None;
                    let now: Vec<(u64, Option<String>)> = state
                        .dispatch
                        .as_ref()
                        .map(|d| d.runs.iter().filter(|r| r.running).map(|r| (r.pid, r.id.clone())).collect())
                        .unwrap_or_default();
                    // Every run seen going that is not going now has an ending
                    // to report; several at once share the one footer line.
                    let ended: Vec<(String, bool)> = std::mem::take(&mut app.runs_seen)
                        .into_iter()
                        .filter(|(pid, _)| !now.iter().any(|(p, _)| p == pid))
                        .map(|(pid, fenced)| run_outcome(&state, pid, fenced.as_deref()))
                        .collect();
                    if !ended.is_empty() {
                        let error = ended.iter().any(|(_, e)| *e);
                        let text = ended.into_iter().map(|(t, _)| t).collect::<Vec<_>>().join(" · ");
                        app.say(text, error);
                    }
                    app.runs_seen = now;
                    app.state = Some(state);
                    app.clamp();
                }
                Res::State(Err(e)) => app.error = Some(e),
                Res::Acted(Ok(msg)) => {
                    app.say(msg, false);
                    app.busy = true;
                    let _ = req.send(Req::Refresh);
                }
                Res::Acted(Err(e)) => app.say(e, true),
                Res::Diff(id, Ok(Some(body))) => {
                    app.overlay = Some(Overlay::Diff { id, body, scroll: 0 })
                }
                Res::Diff(_, Ok(None)) => app.say("no patch for this suggestion yet", true),
                Res::Diff(_, Err(e)) => app.say(e, true),
                Res::Config(Ok((_, raw))) => {
                    app.config_errors = Vec::new();
                    // A reload discards a draft on purpose: the server is the
                    // authority, and silently merging would hide which won.
                    app.config = Some(raw.clone());
                    app.config_saved = Some(raw);
                }
                Res::Config(Err(e)) => app.say(e, true),
                Res::SkillFile(path, Ok(body)) => {
                    app.overlay = Some(Overlay::File { path, body, scroll: 0 })
                }
                Res::SkillFile(_, Err(e)) => app.say(e, true),
            }
        }

        // One bump per iteration: `poll` below times out every TICK, so this is
        // the spinner's clock, and a field rather than an Instant keeps `draw` a
        // pure function of `&App` that tests can pin.
        app.spin = app.spin.wrapping_add(1);
        terminal.draw(|frame| draw(frame, app))?;

        if !event::poll(TICK)? {
            continue;
        }
        let Event::Key(key) = event::read()? else { continue };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Ok(());
        }

        // The block prompt captures every key: what you type is what the card
        // will say it waits on, empty saves as "nothing — it is free again".
        if let Some((id, text)) = app.block.as_mut() {
            match key.code {
                KeyCode::Esc => app.block = None,
                KeyCode::Enter => {
                    let (id, text) = (id.clone(), text.clone());
                    app.busy = true;
                    app.busy_on = Some(id.clone());
                    let _ = req.send(Req::SetBlock { id, text });
                    app.block = None;
                }
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Char(c) => text.push(c),
                _ => {}
            }
            continue;
        }

        // The find prompt captures every key: text edits the query and moves
        // the cursor to the first match; enter keeps the place, esc goes back
        // to where `/` was pressed.
        if let Some(q) = app.find.as_mut() {
            match key.code {
                KeyCode::Esc => {
                    app.find = None;
                    app.go_back();
                }
                KeyCode::Enter => app.find = None,
                KeyCode::Backspace => {
                    q.pop();
                }
                KeyCode::Char(c) => q.push(c),
                _ => {}
            }
            if let (Some(q), Some(state)) = (app.find.as_deref(), app.state.as_ref()) {
                if let Some((lane, card)) = find_card(state, q) {
                    app.board_lane = lane;
                    app.board_sel = card;
                }
            }
            continue;
        }

        // The ways-out menu captures every key: the list moves, enter picks,
        // a move that wants a line takes the keys as text, esc steps back one
        // level. The card and the targets are read before the overlay is
        // borrowed, and the request is sent after it is released.
        if matches!(app.overlay, Some(Overlay::Unblock { .. })) {
            let card = app
                .state
                .as_ref()
                .zip(match &app.overlay {
                    Some(Overlay::Unblock { id, .. }) => Some(id.clone()),
                    _ => None,
                })
                .and_then(|(st, id)| st.suggestions.iter().find(|s| s.id == id).cloned());
            let targets = targets_of(app.config.as_ref());
            let mut send: Option<Req> = None;
            let mut close = false;
            if let (Some(card), Some(Overlay::Unblock { cursor, ask, .. })) = (card, app.overlay.as_mut()) {
                let ways = ways_out(&card, &targets);
                match ask {
                    Ask::Menu => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') => close = true,
                        KeyCode::Char('j') | KeyCode::Down => {
                            *cursor = (*cursor + 1).min(ways.len().saturating_sub(1));
                        }
                        KeyCode::Char('k') | KeyCode::Up => *cursor = cursor.saturating_sub(1),
                        KeyCode::Enter => {
                            if let Some(w) = ways.get(*cursor) {
                                match w.needs {
                                    Needs::Nothing => {
                                        send = Some(Req::Unblock {
                                            id: card.id.clone(),
                                            choice: w.choice,
                                            text: None,
                                            target: None,
                                        });
                                    }
                                    Needs::Text => *ask = Ask::Text { choice: w.choice, text: String::new() },
                                    Needs::Target => *ask = Ask::Target { cursor: 0 },
                                }
                            }
                        }
                        _ => {}
                    },
                    Ask::Text { choice, text } => match key.code {
                        KeyCode::Esc => *ask = Ask::Menu,
                        KeyCode::Enter if !text.trim().is_empty() => {
                            send = Some(Req::Unblock {
                                id: card.id.clone(),
                                choice,
                                text: Some(text.trim().to_string()),
                                target: None,
                            });
                        }
                        KeyCode::Backspace => {
                            text.pop();
                        }
                        KeyCode::Char(c) => text.push(c),
                        _ => {}
                    },
                    Ask::Target { cursor: at } => {
                        let others = other_targets(&card, &targets);
                        match key.code {
                            KeyCode::Esc => *ask = Ask::Menu,
                            KeyCode::Char('j') | KeyCode::Down => {
                                *at = (*at + 1).min(others.len().saturating_sub(1));
                            }
                            KeyCode::Char('k') | KeyCode::Up => *at = at.saturating_sub(1),
                            KeyCode::Enter => {
                                if let Some(t) = others.get(*at) {
                                    send = Some(Req::Unblock {
                                        id: card.id.clone(),
                                        choice: "retarget",
                                        text: None,
                                        target: Some(t.name.clone()),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
            } else {
                // The card left the state under the menu: nothing to act on.
                close = true;
            }
            if let Some(request) = send {
                if let Req::Unblock { id, .. } = &request {
                    app.busy_on = Some(id.clone());
                }
                app.busy = true;
                let _ = req.send(request);
                close = true;
            }
            if close {
                app.overlay = None;
            }
            continue;
        }

        // Every other overlay captures every key: esc/q closes it, the rest
        // scrolls.
        if let Some(overlay) = app.overlay.as_mut() {
            fn scroll_of(o: &mut Overlay) -> Option<&mut u16> {
                match o {
                    Overlay::Help { scroll, .. }
                    | Overlay::File { scroll, .. }
                    | Overlay::Diff { scroll, .. }
                    | Overlay::Detail { scroll, .. } => Some(scroll),
                    Overlay::Unblock { .. } => None,
                }
            }
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => app.overlay = None,
                // The two halves of help are one tab apart, so you can arrive by
                // either key and still reach the other.
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    if let Overlay::Help { guide, scroll } = overlay {
                        *guide = !*guide;
                        *scroll = 0;
                    }
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    if let Some(s) = scroll_of(overlay) {
                        *s = s.saturating_add(1);
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if let Some(s) = scroll_of(overlay) {
                        *s = s.saturating_sub(1);
                    }
                }
                KeyCode::PageDown => {
                    if let Some(s) = scroll_of(overlay) {
                        *s = s.saturating_add(10);
                    }
                }
                KeyCode::PageUp => {
                    if let Some(s) = scroll_of(overlay) {
                        *s = s.saturating_sub(10);
                    }
                }
                _ => app.overlay = None,
            }
            continue;
        }

        app.notice = None;
        // Ctrl-C is not a binding — it is the terminal's, and the table below
        // deliberately does not reach it.
        let Some(action) = keys::resolve(key.code, app.tab) else { continue };
        match action {
            Action::Quit => return Ok(()),
            Action::Back => {
                if !app.go_back() {
                    // Never an exit. `esc` is labelled "back", and a key that
                    // sometimes quits instead is one you stop trusting.
                    app.say("nothing to go back to — q quits", false);
                }
            }
            Action::Go(tab) => {
                if tab != app.tab {
                    app.remember();
                }
                app.tab = tab;
                if tab == Tab::Settings && app.config.is_none() {
                    app.busy = true;
                    let _ = req.send(Req::Config);
                }
            }
            Action::Move(d) => app.move_by(d),
            Action::Lane(d) => {
                let lanes = app.state.as_ref().map(|s| board::lanes(s).len()).unwrap_or(0);
                if lanes > 0 {
                    let next = (app.board_lane as isize + d).clamp(0, lanes as isize - 1) as usize;
                    if next != app.board_lane {
                        app.board_lane = next;
                        // A new lane is a new list; carrying the old row index
                        // over would land on an arbitrary card.
                        app.board_sel = 0;
                    }
                }
            }
            Action::Help => app.overlay = Some(Overlay::Help { guide: false, scroll: 0 }),
            Action::Guide => app.overlay = Some(Overlay::Help { guide: true, scroll: 0 }),
            Action::Refresh => {
                app.busy = true;
                let _ = req.send(Req::Refresh);
                if app.tab == Tab::Settings {
                    let _ = req.send(Req::Config);
                }
            }
            // `a` on a card parked on you opens its ways out. On a card carried
            // by another card it still refuses — nothing there is your move.
            Action::Advance
                if app
                    .board_selected()
                    .map(|c| !c.blocked_on.is_empty() && c.blocked_by.is_empty())
                    .unwrap_or(false) =>
            {
                let id = app.board_selected().map(|c| c.id.clone()).unwrap_or_default();
                // The move-to-another-target option needs the targets; fetch
                // them once, and the menu grows the option when they land.
                if app.config.is_none() {
                    let _ = req.send(Req::Config);
                }
                app.overlay = Some(Overlay::Unblock { id, cursor: 0, ask: Ask::Menu });
            }
            Action::Advance | Action::Discard => {
                // Cloned rather than borrowed: the card is read out of the state
                // the notice below writes into.
                let Some(card) = app.board_selected().cloned() else { continue };
                let step: fn(&Suggestion) -> Result<Req, String> =
                    if action == Action::Advance { advance } else { discard };
                match step(&card) {
                    Ok(request) => {
                        app.busy = true;
                        app.busy_on = Some(card.id);
                        let _ = req.send(request);
                    }
                    Err(why) => app.say(why, true),
                }
            }
            // A holding lane is not a stage, so there is no one move to widen:
            // its cards arrived from several statuses and each leaves by its own.
            Action::AdvanceAll if app.lane_holding() => {
                app.say("not a stage — a and x act on one card here", true)
            }
            Action::AdvanceAll => match app.lane_status() {
                // The pass takes the whole backlog, not one lane — the server
                // has no fence narrower than an id — which is what `A` on a
                // pre-decision lane means anyway. At the decision it sweeps;
                // at the landing it walks the lane.
                Some(from) if awaits_pass(&from) => {
                    app.busy = true;
                    let _ = req.send(Req::Dispatch { id: None });
                }
                Some(from) if forward(&from) == Some(decision_status()) => {
                    app.busy = true;
                    let _ = req.send(Req::Sweep { status: decision_status().into() });
                }
                // Landing has no bulk route on the server — each apply is a
                // commit — so the worker walks the lane in order and stops at
                // the first refusal, which is the drain you would otherwise
                // run from the CLI.
                Some(from) if forward(&from) == landed_status() => {
                    let ids: Vec<String> = app
                        .state
                        .as_ref()
                        .and_then(|s| board::lanes(s).get(app.board_lane).map(|l| l.items.iter().map(|x| x.id.clone()).collect()))
                        .unwrap_or_default();
                    app.busy = true;
                    let _ = req.send(Req::ApplyAll { ids });
                }
                Some(from) => app.say(format!("{from} moves one card at a time — a on each"), true),
                None => app.say("nothing in this lane to advance", true),
            },
            Action::Block => match app.board_selected() {
                Some(card) => app.block = Some((card.id.clone(), card.blocked_on.clone())),
                None => app.say("no card here to answer for", true),
            },
            Action::Find => {
                // Where you were is worth keeping: esc from the prompt returns.
                app.remember();
                app.find = Some(String::new());
            }
            Action::Diff => {
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::Diff { id });
                }
            }
            Action::Open => match app.tab {
                // A window over the board, not a jump: your place never moves,
                // and a closed card opens like any other — history is readable
                // where it lives. No `remember()`: an overlay is not a place.
                Tab::Board => {
                    if let Some(id) = app.selected_id() {
                        app.overlay = Some(Overlay::Detail { id, scroll: 0 });
                    }
                }
                Tab::Skills => {
                    let path = app.skills().get(app.skill_sel).map(|s| s.path.clone());
                    if let Some(path) = path {
                        app.busy = true;
                        let _ = req.send(Req::SkillFile { path });
                    }
                }
                _ => {}
            },
            Action::Edit => app.edit_setting(),
            Action::Save => match app.pending_config() {
                Some(next) => {
                    app.busy = true;
                    let _ = req.send(Req::SaveConfig(next));
                }
                None => app.say("nothing changed", false),
            },
        }
    }
}

/* ------------------------------------------------------------------ tests ---- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::can_transition;

    fn state() -> State {
        serde_json::from_str(
            r#"{
              "suggestions": [
                { "id": "user/kaizen/2026-08-08-approval-is-a-dead-end.md", "skill": "kaizen",
                  "uid": "AID", "slug": "approval-is-a-dead-end",
                  "severity": "high", "status": "approved", "type": "structural",
                  "objective": "bug", "score": 42, "surfaced": true, "incidents": 3,
                  "rung": 1, "scope": "skills/kaizen/SKILL.md",
                  "context": "First full pass.", "suggestion": "Write the patch.",
                  "rationale": "Because approval without one is a dead end." },
                { "id": "user/other/2026-08-01-a-second-thing.md", "skill": "other",
                  "uid": "AST", "slug": "a-second-thing",
                  "severity": "low", "status": "recorded", "score": 5, "surfaced": true,
                  "blockedOn": "carried by a-third-thing — supersede once that lands",
                  "blockedBy": "user/other/2026-08-01-a-third-thing.md" },
                { "id": "user/other/2026-08-01-a-third-thing.md", "skill": "other",
                  "uid": "ATT", "slug": "a-third-thing",
                  "severity": "low", "status": "recorded", "score": 4, "surfaced": true }
              ],
              "skills": [
                { "name": "ts-pr-review", "kind": "user", "lines": 700, "scripts": 0,
                  "suggestions": 17, "per100": 2.43, "health": "noisy",
                  "path": "/s/ts-pr-review/SKILL.md" },
                { "name": "ts-github-triage", "kind": "user", "lines": 358, "scripts": 4,
                  "suggestions": 0, "per100": 0, "health": "scripted",
                  "path": "/s/ts-github-triage/SKILL.md" }
              ],
              "metrics": { "open": 2, "untriaged": 0, "onYou": 1 }
            }"#,
        )
        .unwrap()
    }

    fn app_with_state() -> App {
        let mut app = App::new();
        app.state = Some(state());
        app.busy = false;
        app
    }

    /// A card with only the two fields the decide keys read.
    fn card(status: &str, blocked_on: &str) -> Suggestion {
        Suggestion {
            id: "user/x/2026-08-08-thing.md".into(),
            status: status.into(),
            blocked_on: blocked_on.into(),
            ..Default::default()
        }
    }

    /// One run for a fixture's dispatch: live when `exit` is None.
    fn run(pid: u64, id: Option<&str>, exit: Option<i64>) -> crate::api::Run {
        crate::api::Run {
            pid,
            id: id.map(String::from),
            running: exit.is_none(),
            exit_code: exit,
            ..Default::default()
        }
    }

    fn dispatch(runs: Vec<crate::api::Run>, queue: Vec<Option<&str>>) -> crate::api::Dispatch {
        crate::api::Dispatch { runs, queue: queue.into_iter().map(|q| q.map(String::from)).collect() }
    }

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| (0..w).map(|x| buf[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The name is the slug read as a sentence — dashes become spaces, the
    /// first letter goes up, and nothing else moves: an underscore or a dot is
    /// part of a filename the slug names.
    #[test]
    fn short_reads_the_slug_aloud_and_drops_the_date() {
        assert_eq!(short("user/kaizen/2026-08-08-approval-is-a-dead-end.md"), "Approval is a dead end");
        assert_eq!(short("nonsense"), "Nonsense");
        assert_eq!(crate::ui::humanize("scope-_lib-pr.md-has-siblings"), "Scope _lib pr.md has siblings");
        assert_eq!(crate::ui::humanize(""), "");
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        assert_eq!(truncate("abcdef", 10), "abcdef");
        assert_eq!(truncate("abcdef", 3), "ab…");
        assert_eq!(truncate("héllo-wörld", 6), "héllo…");
        assert_eq!(truncate("abc", 0), "");
    }

    /// The footer and the header both drop whole items rather than half a word.
    #[test]
    fn fit_parts_drops_whole_items() {
        let parts: Vec<String> = ["j/k move", "a approve", "r reject"].map(String::from).to_vec();
        assert_eq!(fit_parts(&parts, 80), "j/k move · a approve · r reject");
        assert_eq!(fit_parts(&parts, 22), "j/k move · a approve");
        assert_eq!(fit_parts(&parts, 9), "j/k move");
        // One part that still does not fit is the only case that may be cut.
        assert_eq!(fit_parts(&parts, 5), "j/k …");
    }

    /// The TUI opens on the board: lanes, cards, metrics and the decide keys,
    /// with no queue to fall back to.
    #[test]
    fn the_board_is_the_front_door_and_the_footer_offers_its_keys() {
        let text = render(&app_with_state(), 200, 30);
        assert!(text.contains("recorded (1)"), "lanes render: {text}");
        // The name is the slug read aloud, with the uid in front as the handle;
        // the slug itself is internal and never drawn on a card.
        assert!(text.contains("AID Approval is a dead end"), "cards show uid and name: {text}");
        assert!(!text.contains("approval-is-a-dead-end"), "the slug stays internal: {text}");
        assert!(text.contains("2 open"), "header carries the metrics");
        // The footer is easy to lose to a layout mistake and hard to notice.
        assert!(text.contains("a advance"), "key hints render: {text}");
        // No URL in the footer any more: it was never something anyone needed
        // mid-decision and it was taking the room the keys wanted.
        assert!(!text.contains("http://"), "the footer carries no URL: {text}");
    }

    /// The chip is the only sign a detached run exists — the process is not a
    /// child of the TUI, so nothing else in the terminal says it is alive.
    #[test]
    fn a_live_dispatch_shows_in_the_header_and_an_ended_one_does_not() {
        let mut app = app_with_state();
        // The tab bar says "2 agents" too, so count: the chip is the second.
        app.state.as_mut().unwrap().dispatch = Some(dispatch(vec![run(4242, None, None)], vec![]));
        assert!(render(&app, 120, 30).contains("1 agent"), "the chip is up");
        app.state.as_mut().unwrap().dispatch =
            Some(dispatch(vec![run(4242, None, None), run(4243, Some("x"), None)], vec![]));
        assert_eq!(render(&app, 120, 30).matches("2 agents").count(), 2, "and counts");

        app.state.as_mut().unwrap().dispatch = Some(dispatch(vec![run(4242, None, Some(0))], vec![]));
        let text = render(&app, 120, 30);
        assert!(!text.contains("1 agent") && text.matches("agents").count() == 1, "down when it ends: {text}");
    }

    /// The braille frame advances with `spin` while anything is in flight, and
    /// no frame at all is drawn when the TUI is at rest.
    #[test]
    fn the_spinner_turns_while_something_is_moving_and_rests_when_nothing_is() {
        let mut app = app_with_state();
        app.busy = true;
        assert!(render(&app, 120, 30).contains('⠋'), "frame 0 while busy");
        app.spin = 1;
        assert!(render(&app, 120, 30).contains('⠙'), "and it advances");

        app.busy = false;
        app.spin = 0;
        let idle = render(&app, 120, 30);
        assert!(
            !idle.chars().any(|c| ('\u{2800}'..='\u{28FF}').contains(&c)),
            "no braille at rest: {idle}"
        );
    }

    /// Lanes wrap onto a second band rather than scrolling off the right, so
    /// the whole board is one glance. Nine lanes are 5 and 4 — balanced, and
    /// never a third band, which is a wall rather than a glance.
    #[test]
    fn lanes_wrap_onto_a_second_band_instead_of_scrolling_off_the_side() {
        let mut app = app_with_state();
        // Enough cards to fill every stage plus the review and blocked lanes.
        let all = app.state.as_mut().unwrap();
        for (i, status) in ["triaged", "planned", "applied", "failed", "reviewed"].iter().enumerate() {
            let mut s = all.suggestions[0].clone();
            s.id = format!("user/x/2026-08-0{i}-filler.md");
            s.uid = format!("F{i}X");
            s.slug = format!("filler-{i}");
            s.status = (*status).into();
            s.blocked_on = String::new();
            all.suggestions.push(s);
        }
        all.dispatch = Some(dispatch(vec![run(1, Some("user/x/2026-08-00-filler.md"), None)], vec![]));
        assert_eq!(board::lanes(all).len(), 9, "seven statuses plus review and blocked");

        // Wide enough for all nine side by side at the minimum width, and
        // still two bands: a lane you can see but not read is not visible.
        let wide = render(&app, 200, 34);
        let bands = wide.lines().filter(|l| l.starts_with('╭')).count();
        assert_eq!(bands, 2, "two bands: {wide}");
        for lane in ["recorded", "triaged", "planned", "approved", "applied", "reviewed", "failed"] {
            assert!(wide.contains(&format!("{lane} (")), "every lane on screen: {wide}");
        }
        assert!(wide.contains("review (") && wide.contains("blocked ("), "{wide}");
        // Five on top, four underneath — the top band ends after the fifth.
        let top = wide.lines().find(|l| l.starts_with('╭')).unwrap();
        assert_eq!(top.matches('╭').count(), 5, "five lanes per band: {top}");

        // A board short enough that a second band would be unreadable keeps one.
        let short = render(&app, 200, 14);
        assert_eq!(short.lines().filter(|l| l.starts_with('╭')).count(), 1, "{short}");
    }

    /// The confusion this prevents: a card sitting in `triaged` looked one
    /// step from `approved` because the empty `planned` lane between them was
    /// collapsed away. The stages stay; only loop-back statuses collapse.
    #[test]
    fn the_pipeline_stays_on_screen_even_where_it_is_empty() {
        let text = render(&app_with_state(), 120, 30);
        assert!(text.contains("recorded (1)"), "{text}");
        assert!(text.contains("triaged (0)"), "an empty stage still shows: {text}");
        assert!(text.contains("planned (0)"), "the step before approval is visible: {text}");
        assert!(text.contains("approved (1)"), "{text}");
        assert!(!text.contains("failed ("), "a loop-back lane collapses when empty: {text}");
        assert!(!text.contains("closed ("), "and closed only exists once something is: {text}");
    }

    /// Each lane names its next phase and whose move it is, derived from the
    /// spec — the answer to "why can't I approve this here", on the lane.
    #[test]
    fn every_lane_says_what_it_waits_for_and_whose_move_it_is() {
        let text = render(&app_with_state(), 130, 30);
        for caption in [
            "→ triage (opencode)",
            "→ plan (opencode)",
            "→ decide (you)",
            "→ apply (server)",
            "→ review (opencode)",
            "→ verify (claude)",
            "→ check (claude)",
        ] {
            assert!(text.contains(caption), "missing {caption:?}: {text}");
        }
    }

    /// A card parked on you opens its ways out on `a`: the reason in full
    /// (the footer truncated it), then the moves, best first, and the field
    /// when a move wants a line. The carried card next to it still refuses.
    #[test]
    fn a_parked_card_opens_its_ways_out_with_the_reason_in_full() {
        let mut app = app_with_state();
        {
            let st = app.state.as_mut().unwrap();
            // A landing that could not happen: parked by the server, on you.
            st.suggestions[0].status = "approved".into();
            st.suggestions[0].blocked_on =
                "apply: error: plugins/ts-dev-tools/skills/pr-review/scripts/fetch-pr.sh: No such file or directory".into();
        }
        let id = "user/kaizen/2026-08-08-approval-is-a-dead-end.md".to_string();
        app.overlay = Some(Overlay::Unblock { id: id.clone(), cursor: 0, ask: Ask::Menu });
        let text = render(&app, 100, 30);
        assert!(text.contains("ways out — Approval is a dead end"), "{text}");
        assert!(text.contains("▸ send back for a new plan"), "an apply: reason leads with a new plan: {text}");
        // The window wraps the reason rather than cutting it: read its lines
        // squashed, since a path this long spans two of them on purpose.
        let card = app.state.as_ref().unwrap().suggestions[0].clone();
        let squashed = unblock_lines(&card, &[], 0, &Ask::Menu, 60)
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(squashed.contains("scripts/fetch-pr.sh: No such file or directory"), "the whole reason: {squashed}");
        assert!(squashed.contains("supersede") && !squashed.contains("reject"), "a yes given can only be overtaken: {squashed}");

        // A move that wants a line takes the footer as its field.
        app.overlay = Some(Overlay::Unblock {
            id: id.clone(),
            cursor: 0,
            ask: Ask::Text { choice: "supersede", text: "landed by hand".into() },
        });
        let text = render(&app, 100, 30);
        assert!(text.contains("supersede: landed by hand▏"), "{text}");

        // Carried by another card: `a` is not yours, whatever the menu offers.
        let carried = app.state.as_ref().unwrap().suggestions[1].clone();
        assert!(!carried.blocked_by.is_empty());
        match advance(&carried) {
            Err(why) => assert!(why.contains("waiting on"), "{why}"),
            Ok(_) => panic!("a carried card is not yours to advance"),
        }
    }

    /// Terminals share one closed lane rather than three sliver columns.
    #[test]
    fn terminals_gather_in_one_closed_lane() {
        let state: crate::api::State = serde_json::from_str(
            r#"{"suggestions":[
                {"id":"a.md","slug":"one","status":"recorded","score":1},
                {"id":"b.md","slug":"two","status":"verified","score":2},
                {"id":"c.md","slug":"three","status":"rejected","score":3}
            ]}"#,
        )
        .unwrap();
        let lanes = board::lanes(&state);
        assert_eq!(lanes.len(), 8, "six stages, the standing review lane, one closed");
        assert!(lanes[0].title.contains("recorded"));
        let closed = lanes.last().unwrap();
        assert_eq!(closed.title, "closed");
        assert_eq!(closed.items.len(), 2);
    }

    /// The closed lane keeps the past week and drops the rest: finished work is
    /// history, and 194 of it buries the landing you just watched. Only a
    /// positive old stamp hides a card — a state that stops carrying `age`
    /// shows everything rather than quietly showing nothing.
    #[test]
    fn the_closed_lane_keeps_the_past_week_and_hides_older_history() {
        let state: crate::api::State = serde_json::from_str(
            r#"{"suggestions":[
                {"id":"now.md","slug":"one","status":"verified","closedAge":"today","score":1},
                {"id":"week.md","slug":"two","status":"superseded","closedAge":"this week","score":2},
                {"id":"month.md","slug":"three","status":"verified","closedAge":"this month","score":3},
                {"id":"old.md","slug":"four","status":"rejected","closedAge":"older","score":4},
                {"id":"july.md","slug":"five","date":"2026-07-01","age":"older",
                 "status":"verified","closedAge":"today","score":5},
                {"id":"unstamped.md","slug":"six","status":"verified","score":6}
            ]}"#,
        )
        .unwrap();
        let closed = board::lanes(&state)
            .into_iter()
            .find(|l| l.title == "closed")
            .expect("a closed lane while anything recent is closed");
        let ids: Vec<&str> = closed.items.iter().map(|s| s.id.as_str()).collect();
        // Newest filing first, as every lane sorts. `month.md` and `old.md` are
        // gone; `july.md` stays because it closed today, which is the whole
        // point of measuring a finished card by when it finished.
        assert_eq!(ids, ["july.md", "unstamped.md", "week.md", "now.md"]);
        assert!(closed.subtitle.contains("past week"), "the lane says it is filtered");

        // Nothing recent closed: the lane collapses rather than standing empty.
        let stale: crate::api::State = serde_json::from_str(
            r#"{"suggestions":[
                {"id":"old.md","slug":"one","status":"verified","closedAge":"older","score":1}
            ]}"#,
        )
        .unwrap();
        assert!(
            !board::lanes(&stale).iter().any(|l| l.title == "closed"),
            "an all-history corpus draws no closed lane at all"
        );
    }

    /// Where a card is drawn is a fact already on the wire, never a status
    /// invented for the view: a check owed puts it in `review`, a carrier puts
    /// it in `blocked`, a terminal in `closed`. A run moves nothing — the card
    /// keeps its lane and wears the mark — because a column that fills and
    /// empties with every run rearranges the board under you.
    #[test]
    fn a_card_waits_in_review_or_blocked_and_a_run_leaves_it_where_it_stands() {
        let mut state: crate::api::State = serde_json::from_str(
            r#"{"suggestions":[
                {"id":"a.md","slug":"one","status":"triaged","score":1},
                {"id":"b.md","slug":"two","status":"triaged","score":2},
                {"id":"c.md","slug":"three","status":"triaged","score":3,
                 "blockedOn":"carried by the scope patch","blockedBy":"b.md"},
                {"id":"d.md","slug":"four","status":"superseded","score":4,
                 "blockedOn":"stale, and finished anyway","blockedBy":"b.md"}
            ]}"#,
        )
        .unwrap();
        let lane = |st: &crate::api::State, title: &str| -> Vec<String> {
            board::lanes(st)
                .into_iter()
                .find(|l| l.title.contains(title))
                .map(|l| l.items.iter().map(|s| s.id.clone()).collect())
                .unwrap_or_default()
        };

        // Idle: only the block moves a card off its stage.
        assert_eq!(lane(&state, "triaged"), ["b.md", "a.md"]);
        assert_eq!(lane(&state, "blocked"), ["c.md"]);
        assert_eq!(lane(&state, "closed"), ["d.md"], "finished outranks parked");
        // Standing, and empty: it fills and empties with every run, and a column
        // that appears under you shifts every lane to its right.
        // By glyph, because the `reviewed` stage answers to "review" too.
        let standing = |st: &crate::api::State| {
            board::lanes(st).iter().any(|l| l.title.contains("◎ review"))
        };
        assert!(standing(&state) && lane(&state, "◎ review").is_empty(), "nothing flagged, no cards in it");

        // One card fenced to a run, one waiting for the seat: both stay where
        // they stand — the mark says a run has them, the lane says what they are.
        state.dispatch = Some(dispatch(vec![run(4242, Some("a.md"), None)], vec![Some("b.md")]));
        assert_eq!(lane(&state, "triaged"), ["b.md", "a.md"]);
        assert!(lane(&state, "◎ review").is_empty(), "a run is not a check owed");

        // The run wrote a status and flagged it: the card is claude's now, and
        // it sits in review until claude says so — not in planned, which `A`
        // would approve.
        state.suggestions[0].status = "planned".into();
        state.suggestions[0].needs_review = "claude".into();
        state.dispatch = Some(dispatch(vec![run(4242, Some("a.md"), Some(0))], vec![]));
        assert_eq!(lane(&state, "◎ review"), ["a.md"]);
        assert!(lane(&state, "planned").is_empty(), "an unchecked plan is not yours yet");
        assert_eq!(lane(&state, "triaged"), ["b.md"]);

        // The check clears and the card is where its status says.
        state.suggestions[0].needs_review = String::new();
        assert_eq!(lane(&state, "planned"), ["a.md"]);
        assert!(standing(&state) && lane(&state, "◎ review").is_empty());
    }

    /// `A` widens a stage's one move over its lane. A holding lane has no such
    /// move — its cards came from several statuses — so it says so instead of
    /// picking the first card's status and acting on that.
    #[test]
    fn the_wide_advance_refuses_a_lane_that_is_not_a_stage() {
        let app = app_with_state();
        let holding: Vec<bool> = board::lanes(app.state.as_ref().unwrap())
            .iter()
            .map(|l| l.holding)
            .collect();
        assert_eq!(
            holding,
            [false, false, false, false, false, false, true, true],
            "six stages, then review and blocked"
        );
    }

    /// One card's cell of a rendered frame: the lanes sit side by side, so a
    /// whole terminal row holds several cards and would smear the assertion.
    fn card_cell<'a>(text: &'a str, slug: &str) -> &'a str {
        let name = crate::ui::humanize(slug);
        text.lines().flat_map(|l| l.split('│')).find(|seg| seg.contains(&name)).unwrap()
    }

    /// The header says fable is out; the card says on what. A fenced run spins
    /// exactly its card and queues nothing else.
    #[test]
    fn the_card_a_fenced_run_is_on_carries_the_spinner() {
        let mut app = app_with_state();
        app.state.as_mut().unwrap().dispatch = Some(dispatch(
            vec![run(4242, Some("user/kaizen/2026-08-08-approval-is-a-dead-end.md"), None)],
            vec![],
        ));
        let text = render(&app, 260, 30);
        let worked = card_cell(&text, "approval-is-a-dead-end");
        assert!(worked.contains('⠋'), "the worked card spins: {worked}");
        let other = card_cell(&text, "a-second-thing");
        assert!(!other.contains('⠋') && !other.contains('◌'), "the rest stay plain: {other}");
    }

    /// A backlog run owes every card a pass can still move; ◌ marks them and
    /// drains as the run relabels each one. Cards past the pass stay plain.
    #[test]
    fn a_backlog_run_marks_the_cards_still_waiting_for_it() {
        let mut app = app_with_state();
        app.state.as_mut().unwrap().dispatch = Some(dispatch(vec![run(4242, None, None)], vec![]));
        let text = render(&app, 260, 30);
        let waiting = card_cell(&text, "a-third-thing");
        assert!(waiting.contains('◌'), "recorded awaits the pass: {waiting}");
        let done = card_cell(&text, "approval-is-a-dead-end");
        assert!(!done.contains('◌') && !done.contains('⠋'), "approved owes it nothing: {done}");
        // Same gate the server gained: a parked card is not work the run owes,
        // so marking it as owed would promise a pass that will be refused.
        let parked = card_cell(&text, "a-second-thing");
        assert!(!parked.contains('◌'), "a backlog run owes a parked card nothing: {parked}");
    }

    /// A card parked on you wears ⚑, and the header counts them: twelve
    /// identical triaged rows once hid that nine were waiting on three calls
    /// of the user's, and no key in the TUI moves those.
    #[test]
    fn a_parked_card_wears_a_flag_and_the_header_counts_them() {
        let text = render(&app_with_state(), 200, 30);
        assert!(card_cell(&text, "a-second-thing").contains('⚑'), "parked: {text}");
        assert!(!card_cell(&text, "approval-is-a-dead-end").contains('⚑'), "not parked");
        assert!(text.contains("⚑ 1 on you"), "header counts: {text}");
    }

    /// When the run in the seat is gone, the notice says what became of its
    /// card — by where the card ended up, not by an exit code, and naming the
    /// closed lane when that is where it went, since that lane sits off to the
    /// right. A backlog run is judged by its exit code while the state still
    /// holds it, and calmly when it does not.
    #[test]
    fn a_finished_run_says_where_its_card_went() {
        let mut state = state();
        state.suggestions[0].status = "superseded".into();
        let (text, error) =
            run_outcome(&state, 1, Some("user/kaizen/2026-08-08-approval-is-a-dead-end.md"));
        assert_eq!(text, "Approval is a dead end → superseded (closed lane)");
        assert!(!error);
        let (text, _) = run_outcome(&state, 1, Some("user/other/2026-08-01-a-second-thing.md"));
        assert_eq!(text, "A second thing → recorded", "a run that moved nothing says so plainly");
        let (text, error) = run_outcome(&state, 1, Some("user/x/2026-01-01-vanished.md"));
        assert!(text.contains("gone from disk") && error);

        state.dispatch = Some(dispatch(vec![run(7, None, Some(2))], vec![]));
        let (text, error) = run_outcome(&state, 7, None);
        assert!(text.contains("failed (exit 2)") && error, "{text}");
        let (text, error) = run_outcome(&state, 6, None);
        assert!(text.contains("ended") && !error, "aged off the list: {text}");
    }

    /// `/` lands on the first card whose uid starts with the query or whose
    /// name contains it, whichever lane — a uid is only worth having if the
    /// board can go to it.
    #[test]
    fn find_lands_on_uid_or_name_across_lanes() {
        let st = state();
        // AST is parked, so it is drawn in the blocked lane rather than in
        // recorded — which is exactly what "whichever lane" has to mean.
        assert_eq!(find_card(&st, "as"), Some((7, 0)), "uid prefix, blocked lane");
        assert_eq!(find_card(&st, "att"), Some((0, 0)), "uid prefix, recorded lane");
        assert_eq!(find_card(&st, "aid"), Some((3, 0)), "case-blind uid, approved lane");
        assert_eq!(find_card(&st, "dead end"), Some((3, 0)), "a bit of the name");
        assert_eq!(find_card(&st, "nothing like this"), None);
        assert_eq!(find_card(&st, ""), None, "an empty query moves nothing");
    }

    /// Newest first, under a rule per age — so what came in since you last
    /// looked is at the top of every lane, and "this week" is a line you can
    /// see rather than a date you have to read. Score only breaks ties within
    /// a day. The rules are rows, but the cursor lands on cards.
    #[test]
    fn lanes_run_newest_first_under_age_rules() {
        let mut app = App::new();
        app.state = Some(
            serde_json::from_str(
                r#"{"suggestions":[
                  {"id":"u/k/2026-07-01-old-but-hot.md","slug":"old-but-hot","uid":"OBH",
                   "date":"2026-07-01","age":"older","status":"recorded","score":90,"surfaced":true},
                  {"id":"u/k/2026-08-15-fresh.md","slug":"fresh","uid":"FRE",
                   "date":"2026-08-15","age":"today","status":"recorded","score":1,"surfaced":true},
                  {"id":"u/k/2026-08-14-yesterday.md","slug":"yesterday","uid":"YES",
                   "date":"2026-08-14","age":"this week","status":"recorded","score":5,"surfaced":true}
                ],"skills":[],"metrics":{"open":3,"untriaged":3}}"#,
            )
            .unwrap(),
        );
        app.busy = false;
        let text = render(&app, 60, 20);
        let at = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle} missing: {text}"));
        assert!(at("─ today") < at("Fresh"), "{text}");
        assert!(at("Fresh") < at("─ this week"), "{text}");
        assert!(at("─ this week") < at("Yesterday"), "{text}");
        assert!(at("Yesterday") < at("─ older"), "{text}");
        assert!(at("─ older") < at("Old but hot"), "score does not outrank recency: {text}");
        // A rule wears its own colour, so it reads as furniture and never as a card.
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 20)).unwrap();
        terminal.draw(|frame| draw(frame, &app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        let rule_row = text.lines().position(|l| l.contains("─ today")).unwrap() as u16;
        let x = text.lines().nth(rule_row as usize).unwrap().find('─').unwrap() as u16;
        assert_eq!(buf[(x, rule_row)].style().fg, Some(theme::rule()));
        // The first card is selected, not the rule above it: `board_selected`
        // and the highlight agree on the card, and the rule is never a target.
        assert_eq!(app.board_selected().map(|s| s.slug.as_str()), Some("fresh"));
    }

    /// A card in line for the seat wears its place, in the marker column, so
    /// five presses of `a` read as 1 2 3 4 behind the spinner and not as four
    /// errors. The number wins over ◌: being in line is more specific than
    /// being owed.
    #[test]
    fn a_queued_card_wears_its_place_in_line() {
        let mut app = app_with_state();
        app.state.as_mut().unwrap().dispatch = Some(dispatch(
            vec![run(4242, Some("user/kaizen/2026-08-08-approval-is-a-dead-end.md"), None)],
            vec![None, Some("user/other/2026-08-01-a-second-thing.md")],
        ));
        let text = render(&app, 200, 30);
        assert!(card_cell(&text, "approval-is-a-dead-end").contains('⠋'), "the seat spins");
        let queued = card_cell(&text, "a-second-thing");
        assert!(queued.contains('2') && !queued.contains('◌'), "second in line: {queued}");
    }

    /// a/x mark their card while the request is out, and an idle board
    /// carries no marker column at all.
    #[test]
    fn deciding_on_a_card_spins_it_until_the_server_answers() {
        let mut app = app_with_state();
        app.busy_on = Some("user/kaizen/2026-08-08-approval-is-a-dead-end.md".into());
        let text = render(&app, 200, 30);
        assert!(card_cell(&text, "approval-is-a-dead-end").contains('⠋'));

        app.busy_on = None;
        let idle = render(&app, 200, 30);
        let row = card_cell(&idle, "approval-is-a-dead-end");
        assert!(!row.contains('⠋') && !row.contains('◌'), "idle cards are plain: {row}");
    }

    /// One key per direction, whatever the lane: what `a` sends is the move
    /// the lane waits for and `x` is its exit — both read off the spec, so a
    /// lane cannot be left without its key or given the wrong one.
    #[test]
    fn a_advances_by_whatever_the_lane_waits_for_and_x_takes_the_way_out() {
        let refusal = |r: Result<Req, String>| match r {
            Err(why) => why,
            Ok(_) => panic!("expected a refusal"),
        };
        assert!(matches!(advance(&card("recorded", "")), Ok(Req::Dispatch { id: Some(_) })), "opencode triages");
        assert!(matches!(advance(&card("triaged", "")), Ok(Req::Dispatch { id: Some(_) })), "opencode plans");
        assert!(
            matches!(advance(&card("planned", "")), Ok(Req::SetStatus { status, .. }) if status == "approved"),
            "you decide"
        );
        assert!(matches!(advance(&card("approved", "")), Ok(Req::Apply { .. })), "the server lands");
        assert!(matches!(advance(&card("failed", "")), Ok(Req::Dispatch { id: Some(_) })), "back to opencode");
        assert!(matches!(advance(&card("applied", "")), Ok(Req::Dispatch { id: Some(_) })), "opencode reviews");
        assert!(matches!(advance(&card("reviewed", "")), Ok(Req::Dispatch { id: Some(_) })), "claude verifies");
        assert!(refusal(advance(&card("verified", ""))).contains("terminal"));
        // A plan nobody has checked is claude's, not yours: `a` sends the check,
        // never the approval.
        let mut unchecked = card("planned", "");
        unchecked.needs_review = "claude".into();
        assert!(matches!(advance(&unchecked), Ok(Req::Dispatch { id: Some(_) })), "claude checks");

        assert!(
            matches!(discard(&card("recorded", "")), Ok(Req::SetStatus { status, .. }) if status == "rejected"),
            "you can still say no"
        );
        assert!(
            matches!(discard(&card("approved", "")), Ok(Req::SetStatus { status, .. }) if status == "superseded"),
            "a yes given can only be overtaken"
        );
        assert!(refusal(discard(&card("failed", ""))).contains("planned"), "the pipeline owns a failed item");
        assert!(refusal(discard(&card("rejected", ""))).contains("terminal"));
    }

    /// Which of the two waits a card is in decides whether `a` is yours to
    /// press. Waiting on another card, it never is. Waiting on you, it is
    /// exactly the button you came for — but only where the next move is yours:
    /// no pass can do what you have to do, and dispatching one buys a re-stamp.
    #[test]
    fn a_is_yours_to_press_when_the_block_is_yours_to_end() {
        let why = "the target is read-only — apply by hand or make it writable";
        let refusal = |r: Result<Req, String>| match r {
            Err(said) => said,
            Ok(_) => panic!("expected a refusal"),
        };

        // Waiting on you, and the next move is yours: the key works.
        assert!(
            matches!(advance(&card("planned", why)), Ok(Req::SetStatus { status, .. }) if status == "approved"),
            "the button you came for"
        );
        assert!(matches!(advance(&card("approved", why)), Ok(Req::Apply { .. })));

        // Waiting on you, but the next move is a pass: it cannot end your block.
        for status in ["recorded", "triaged", "failed"] {
            let said = refusal(advance(&card(status, why)));
            assert!(said.contains(why), "{status}: the refusal has to name the block");
            assert!(said.contains("b to"), "{status}: and point at the key that answers it");
        }

        // Waiting on another card: never yours, in any lane.
        for status in ["recorded", "triaged", "failed", "planned", "approved"] {
            let mut c = card(status, why);
            c.blocked_by = "user/x/2026-08-01-carrier.md".into();
            assert!(
                refusal(advance(&c)).contains("waiting on"),
                "{status}: a carried card is not yours to advance"
            );
        }

        // The way out is never blocked: a lane you cannot leave is the worse bug.
        assert!(
            matches!(discard(&card("triaged", why)), Ok(Req::SetStatus { status, .. }) if status == "rejected"),
            "x closes a parked card"
        );
    }

    /// Enter reads, `x` discards, `a` advances: the verbs the board offers on
    /// one card, and the footer advertises each once. The old per-status keys
    /// resolve to nothing, so muscle memory fails loudly rather than sideways.
    #[test]
    fn the_board_offers_one_key_per_direction_and_the_old_ones_do_nothing() {
        use ratatui::crossterm::event::KeyCode;
        assert_eq!(keys::resolve(KeyCode::Enter, Tab::Board), Some(Action::Open));
        assert_eq!(keys::resolve(KeyCode::Char('a'), Tab::Board), Some(Action::Advance));
        assert_eq!(keys::resolve(KeyCode::Char('x'), Tab::Board), Some(Action::Discard));
        for old in ['r', 't', 'T', 'p'] {
            assert_eq!(keys::resolve(KeyCode::Char(old), Tab::Board), None, "{old} is gone");
        }
        let hints = keys::hints(Tab::Board);
        assert!(hints.contains(&("enter", "detail")), "{hints:?}");
        assert!(hints.contains(&("x", "discard")), "{hints:?}");
    }

    /// One footer entry carries both spellings — `a advance (A lane)` —
    /// so the shifted key works without costing a second slot of width.
    #[test]
    fn shifted_variants_fold_into_one_footer_entry() {
        let hints = keys::hints(Tab::Board);
        assert!(hints.iter().any(|(h, l)| *h == "a" && *l == "advance (A lane)"));
        assert!(!hints.iter().any(|(h, _)| *h == "A"), "no second entry: {hints:?}");
        // And the shifted key still resolves where it is folded.
        use ratatui::crossterm::event::KeyCode;
        assert_eq!(keys::resolve(KeyCode::Char('A'), Tab::Board), Some(Action::AdvanceAll));
    }

    /// The decide keys act on the card under the board's cursors — and an
    /// empty stage lane holds no card, so they refuse quietly there.
    #[test]
    fn board_keys_act_on_the_selected_card() {
        let mut app = app_with_state();
        app.tab = Tab::Board;
        let status = |a: &App| a.board_selected().map(|s| s.status.clone());
        assert_eq!(status(&app).as_deref(), Some("recorded"), "first lane in spec order");
        app.board_lane = 1;
        assert_eq!(status(&app), None, "the triaged stage is empty");
        app.board_lane = 3;
        assert_eq!(status(&app).as_deref(), Some("approved"));
    }

    /// Twelve identical triaged rows once hid that nine were waiting on three
    /// calls of the user's. The window is where a card explains itself.
    #[test]
    fn the_detail_window_says_when_a_card_is_parked_on_you() {
        let mut app = app_with_state();
        app.overlay =
            Some(Overlay::Detail { id: "user/other/2026-08-01-a-second-thing.md".into(), scroll: 0 });
        let text = render(&app, 120, 30);
        assert!(text.contains("waits on"), "the window labels which wait it is: {text}");
        assert!(text.contains("carried by a-third-thing"), "and says why: {text}");
    }

    /// The facts wear their names. A row of bare badges — `AID  high  approved
    /// structural  bug` — needed the vocabulary in your head before you could
    /// read your own card; three labelled columns cost a few lines and no
    /// guessing. The long values take a line each rather than a truncated third.
    #[test]
    fn the_detail_window_names_the_facts_it_shows() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Detail {
            id: "user/kaizen/2026-08-08-approval-is-a-dead-end.md".into(),
            scroll: 0,
        });
        let text = render(&app, 120, 30);
        for pair in ["uid       AID", "severity  high", "status    approved"] {
            assert!(text.contains(pair), "{pair:?} is not labelled: {text}");
        }
        assert!(text.contains("scope     skills/kaizen/SKILL.md"), "{text}");
        // Three to a row, so nine facts are three lines and not nine.
        let row = text.lines().find(|l| l.contains("uid       AID")).unwrap();
        assert!(row.contains("severity") && row.contains("status"), "three to a row: {row}");

        // An untriaged card has no type, objective, rung or effort. Leaving the
        // cells out beats four dashes saying the same thing worse.
        app.overlay =
            Some(Overlay::Detail { id: "user/other/2026-08-01-a-third-thing.md".into(), scroll: 0 });
        let bare = render(&app, 120, 30);
        assert!(bare.contains("uid       ATT") && !bare.contains("objective"), "{bare}");
    }

    #[test]
    fn the_detail_window_shows_the_card_whole() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Detail {
            id: "user/kaizen/2026-08-08-approval-is-a-dead-end.md".into(),
            scroll: 0,
        });
        let text = render(&app, 120, 30);
        assert!(text.contains("detail — Approval is a dead end"), "titled by name: {text}");
        assert!(text.contains("AID"), "and wears its uid: {text}");
        assert!(text.contains("Context"), "{text}");
        assert!(text.contains("First full pass."), "{text}");
        assert!(text.contains("skills/kaizen/SKILL.md"), "names the scope: {text}");
    }

    /// The window holds the id, not an index — a refresh that reorders the
    /// lanes must not swap the card under the reader.
    #[test]
    fn the_detail_window_survives_a_refresh_because_it_holds_the_id() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Detail {
            id: "user/kaizen/2026-08-08-approval-is-a-dead-end.md".into(),
            scroll: 0,
        });
        app.state.as_mut().unwrap().suggestions.reverse();
        let text = render(&app, 120, 30);
        assert!(text.contains("First full pass."), "still the same card: {text}");
    }

    #[test]
    fn a_card_deleted_underneath_its_window_leaves_a_calm_message() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Detail { id: "user/k/2026-01-01-gone.md".into(), scroll: 0 });
        let text = render(&app, 120, 30);
        assert!(text.contains("gone — the state refreshed it away"), "{text}");
    }

    /// The key has to refuse locally rather than fire and wait for a 409. Both
    /// rows in the fixture are pre-decision, so neither can be approved directly.
    #[test]
    fn approving_is_only_offered_where_the_model_allows_it() {
        assert!(!can_transition("recorded", "approved"), "a bare capture is not approvable");
        assert!(can_transition("planned", "approved"), "a plan can be approved");
        assert!(can_transition("recorded", "rejected"), "but anything can be rejected early");
        assert!(!can_transition("verified", "planned"), "and nothing follows a terminal");

        // The message names where it can actually go, which is the whole point.
        assert_eq!(next_statuses("recorded"), ["triaged", "rejected", "superseded"]);
        assert!(next_statuses("verified").is_empty());
    }

    /// Every abbreviation and colour in the list comes from `lifecycle.json`, so
    /// a status the spec does not know must degrade rather than render blank.
    #[test]
    fn statuses_resolve_through_the_spec() {
        assert_ne!(status_icon("recorded"), "—");
        assert_ne!(status_icon("planned"), "—");
        assert_ne!(status_icon("verified"), "—");
        // One spelling per status: anything else is a typo, not an older name.
        assert_eq!(status_icon("new"), "—");
        assert_eq!(status_icon("nonsense"), "—");
        assert_eq!(status_icon(""), "—");
    }

    /// The embedded spec has to parse, and has to be the same document the rest
    /// of the repo generates from — a `cargo build` that succeeds on a broken
    /// lifecycle.json would ship a TUI that panics on first draw.
    #[test]
    fn the_embedded_spec_parses_and_is_coherent() {
        let l = lifecycle();
        assert!(!l.phases.is_empty() && !l.statuses.is_empty() && !l.fields.is_empty());
        for p in &l.phases {
            assert!(
                l.statuses.iter().any(|s| s.id == p.produces),
                "phase {} produces unknown status {}",
                p.id,
                p.produces
            );
        }
        for s in &l.statuses {
            assert_eq!(s.abbrev.chars().count(), 3, "{} abbrev must be 3 wide", s.id);
            for n in &s.next {
                assert!(l.statuses.iter().any(|x| &x.id == n), "{} → unknown {n}", s.id);
            }
        }
    }

    /* --------------------------------------------------------------- tabs ---- */

    /// `h`, not `?`. The footer and the help card are the only places the key is
    /// advertised, so they are the only places it can be advertised wrongly.
    #[test]
    fn help_is_on_h_everywhere_it_is_offered() {
        let card = help_keys(Tab::Board)
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(card.contains("help"), "the card offers help: {card}");
        assert!(!card.contains("?"), "and never mentions ?: {card}");

        // Asserted on the table, not a rendered row: the footer drops whole
        // hints from the end when the width is tight.
        for tab in Tab::ALL {
            let hints = keys::hints(tab);
            assert!(hints.contains(&("h", "help")), "{tab:?} offers h: {hints:?}");
            assert!(!hints.iter().any(|(k, _)| *k == "?"), "{tab:?} drops ?: {hints:?}");
        }
    }

    /// The report: "hit enter and try to get back, it takes me to the init page".
    /// `esc` was hardcoded to one tab rather than "go back".
    #[test]
    fn esc_returns_to_where_you_came_from_not_to_the_first_tab() {
        let mut app = app_with_state();

        // Board -> skills -> settings, then back down the way we came.
        app.board_lane = 1;
        app.remember();
        app.tab = Tab::Skills;
        app.remember();
        app.tab = Tab::Settings;

        assert!(app.go_back());
        assert_eq!(app.tab, Tab::Skills);

        assert!(app.go_back());
        assert_eq!(app.tab, Tab::Board);
        assert_eq!(app.board_lane, 1, "and to the lane you were on, not the first");

        // Nothing left: it says so rather than quitting. `esc` is labelled
        // "back", and a key that sometimes exits is one you stop trusting.
        assert!(!app.go_back());
    }

    /// Enter is a window over the board, not a jump: closing it must find the
    /// cursors untouched, and no history spent getting back.
    #[test]
    fn enter_opens_a_window_and_esc_finds_the_board_exactly_where_it_was() {
        let mut app = app_with_state();
        app.board_lane = 1;
        app.overlay = Some(Overlay::Detail {
            id: "user/kaizen/2026-08-08-approval-is-a-dead-end.md".into(),
            scroll: 0,
        });
        render(&app, 120, 30);

        app.overlay = None;
        assert_eq!(app.tab, Tab::Board);
        assert_eq!(app.board_lane, 1);
        assert!(app.history.is_empty(), "an overlay is not a place");
    }

    #[test]
    fn history_does_not_pile_up_on_a_held_key() {
        let mut app = app_with_state();
        for _ in 0..10 {
            app.remember();
        }
        assert_eq!(app.history.len(), 1, "the same place is not remembered twice");

        // And it cannot grow without bound.
        for i in 0..60 {
            app.skill_sel = i % 2;
            app.remember();
        }
        assert!(app.history.len() <= 32);
    }

    /// The card is the current view's keys, not a catalogue with a "where"
    /// column. That is what lets one key mean different things per view without
    /// the card contradicting itself.
    #[test]
    fn the_help_card_shows_only_this_view_and_its_meaning_of_a_key() {
        // Both halves, as the overlay shows them together, whitespace-normalised
        // because the column meanings wrap inside their pane.
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let card = |tab| {
            squash(
                &help_keys(tab)
                    .into_iter()
                    .chain(help_columns(tab, 60))
                    .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        };

        // `enter` is bound per view. Each card shows its own meaning.
        let board = card(Tab::Board);
        assert!(board.contains("detail"), "{board}");
        assert!(board.contains("advance"), "{board}");
        assert!(!board.contains("open file"), "and not the skills meaning: {board}");

        // The git footnote rides with `a` — advice about a key lives where the
        // key is bound.
        assert!(board.contains("clean tree"), "{board}");
        assert!(!card(Tab::Skills).contains("clean tree"), "and nowhere else");

        assert!(card(Tab::Skills).contains("open file"));

        // Keys that do not work here are not offered here.
        assert!(!card(Tab::Skills).contains("advance"), "skills cannot advance a card");
        assert!(card(Tab::Settings).contains("save"), "but settings can save");
        assert!(!board.contains("save"), "and the board cannot");

        // No "where" column left to disagree with the filtering.
        for tab in Tab::ALL {
            assert!(!card(tab).contains("everywhere"), "{tab:?} card names no scope");
        }
    }

    /// Every view explains its own numbers, and the tables' headers come from
    /// the same list — so a column cannot be labelled one way and described
    /// another. The queue has no header row at all, which is why it needs this
    /// most: `42 H apr` says nothing on its own.
    #[test]
    fn every_view_explains_its_columns() {
        // Both halves, as the overlay shows them together, whitespace-normalised
        // because the column meanings wrap inside their pane.
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let card = |tab| {
            squash(
                &help_keys(tab)
                    .into_iter()
                    .chain(help_columns(tab, 60))
                    .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        };
        for tab in Tab::ALL {
            let text = card(tab);
            assert!(text.contains("columns"), "{tab:?} has a columns section");
            for (name, meaning) in columns_for(tab) {
                assert!(text.contains(&squash(meaning)), "{tab:?} explains {name:?}");
            }
        }

        // Named per view, not shared: `per100` means nothing on the board.
        assert!(card(Tab::Skills).contains("per100"));
        assert!(!card(Tab::Board).contains("per100"));

        // The status legend is generated, so a renamed status cannot leave a
        // stale abbreviation behind in the help.
        let board = card(Tab::Board);
        for s in &lifecycle().statuses {
            assert!(board.contains(&format!("{} {}", s.abbrev, s.id)), "legend has {}", s.id);
        }
        // Side by side, not stacked, once there is room for both.
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Help { guide: false, scroll: 0 });
        let wide = render(&app, 120, 30);
        for line in wide.lines() {
            if line.contains("columns") {
                assert!(line.contains("navigate"), "columns and keys share a row: {line}");
            }
        }
    }

    /// The tables build their header from the same list the help reads.
    #[test]
    fn a_table_header_cannot_drift_from_its_explanation() {
        for (tab, columns) in [(Tab::Skills, skills::COLUMNS)] {
            let mut app = app_with_state();
            app.tab = tab;
            let text = render(&app, 120, 20);
            for (name, _) in columns.iter().filter(|(n, _)| !n.is_empty()) {
                assert!(text.contains(name), "{tab:?} header shows {name:?}: {text}");
            }
        }
    }

    /// A closed set reads as a list, not as a sentence with nine items in it.
    #[test]
    fn a_column_with_a_closed_set_lists_its_values() {
        let lines = |tab| {
            help_columns(tab, 60)
                .iter()
                .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
                .collect::<Vec<_>>()
        };

        let board = lines(Tab::Board);
        // Every status on its own line — icon then abbrev — generated from the spec.
        for s in &lifecycle().statuses {
            assert!(
                board.iter().any(|l| {
                    let l = l.trim_start();
                    l.starts_with(status_icon(&s.id)) && l.contains(&s.abbrev) && l.contains(&s.id)
                }),
                "{} is its own row",
                s.id,
            );
        }
        // And not crammed into one, which is what it used to be.
        assert!(!board.iter().any(|l| l.contains("rec recorded · tri")), "no run-on legend");

        // The severity marks a card carries are their own list too.
        for (mark, word) in [("▲", "high"), ("►", "medium"), ("▼", "low")] {
            assert!(
                board.iter().any(|l| l.contains(mark) && l.contains(word)),
                "{mark} {word} is listed"
            );
        }

        for (value, _) in skills::HEALTH {
            assert!(lines(Tab::Skills).iter().any(|l| l.contains(value)), "{value} is listed");
        }

        // A column whose values are open gets no sub-list invented for it.
        assert!(column_values(Tab::Skills, "skill").is_empty());
    }

    /// The complaint, as a check. `DarkGray` on a black terminal is the grey
    /// text this palette exists to be rid of, and a named ANSI grey is at the
    /// mercy of whatever the terminal maps it to.
    #[test]
    fn nothing_is_drawn_in_grey() {
        use ratatui::style::Color;
        for tab in Tab::ALL {
            let mut app = app_with_state();
            app.tab = tab;
            app.config = Some(serde_json::json!({ "targets": [], "surface": {} }));
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
            terminal.draw(|frame| draw(frame, &app)).unwrap();
            let buf = terminal.backend().buffer().clone();
            for y in 0..40 {
                for x in 0..120 {
                    let fg = buf[(x, y)].style().fg;
                    assert!(
                        !matches!(fg, Some(Color::DarkGray) | Some(Color::Gray)),
                        "{tab:?} draws grey at {x},{y}",
                    );
                }
            }
        }
    }

    #[test]
    fn esc_is_offered_on_every_tab() {
        for tab in Tab::ALL {
            assert!(
                keys::hints(tab).contains(&("esc", "back")),
                "{tab:?} offers esc",
            );
        }
    }

    #[test]
    fn the_tab_bar_names_the_key_that_reaches_each_tab() {
        let text = render(&app_with_state(), 120, 30);
        for (i, tab) in Tab::ALL.iter().enumerate() {
            assert!(text.contains(&format!("{} {}", i + 1, tab.label())), "tab {i} missing: {text}");
        }
    }

    /// `A` widens `a` over the lane under the cursor, so it reads that lane's
    /// status — and an empty stage lane has none to widen over.
    #[test]
    fn the_wide_advance_reads_the_lane_under_the_cursor() {
        let mut app = app_with_state();
        assert_eq!(app.lane_status().as_deref(), Some("recorded"));
        app.board_lane = 1;
        assert_eq!(app.lane_status(), None, "the triaged stage is empty");
    }

    #[test]
    fn skills_rank_by_the_ratio_the_tool_argues_about() {
        let mut app = app_with_state();
        app.tab = Tab::Skills;
        let text = render(&app, 120, 30);
        assert!(text.contains("Skills (2 · 1 scripted)"), "{text}");
        assert!(text.contains("noisy"), "{text}");
        assert!(text.contains("scripted"), "{text}");
        // Worst per100 first, and the label comes from the scanner not from here.
        assert_eq!(app.skills()[0].name, "ts-pr-review");
    }

    #[test]
    fn settings_shows_the_guards_as_they_actually_are() {
        let mut app = app_with_state();
        app.tab = Tab::Settings;
        // Nothing fetched yet: say so rather than drawing an empty box.
        assert!(render(&app, 120, 30).contains("reading config…"));

        app.config = Some(
            serde_json::from_str(
                r#"{"targets":[{"name":"user","skills":"/s","feedback":"/f","writable":true}],
                    "applyGuards":{"requireCleanTree":false,"requireDiffApplies":true},
                    "surface":{"types":["a"],"objectives":["b"],"minSeverity":"low"},
                    "categoryPromotion":{"members":3,"incidents":5},
                    "server":{"host":"127.0.0.1","port":7777}}"#,
            )
            .unwrap(),
        );
        let text = render(&app, 120, 40);
        assert!(text.contains("writable"), "a writable target is worth seeing: {text}");
        // The whole point of the view: a guard someone turned off says OFF here
        // while every prose description of the tool still says it is on.
        assert!(text.contains("OFF"), "a disabled guard is loud: {text}");
        // And it is changed here rather than somewhere else.
        assert!(text.contains("space change"), "the footer says how: {text}");
    }

    #[test]
    fn moving_keeps_a_cursor_per_tab() {
        let mut app = app_with_state();
        app.tab = Tab::Skills;
        app.move_by(1);
        assert_eq!(app.skill_sel, 1);
        app.tab = Tab::Board;
        app.move_by(1);
        assert_eq!(app.skill_sel, 1, "the skills cursor stayed put");
        // Neither can walk off the end.
        app.move_by(50);
        assert_eq!(app.skill_sel, 1);
    }

    #[test]
    fn the_docs_overlay_opens_on_the_phases() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Help { guide: true, scroll: 0 });
        let text = render(&app, 110, 30);
        assert!(text.contains("lifecycle"), "{text}");
        assert!(text.contains("Capture"), "the phases are listed: {text}");
    }

    /// Asserted against the lines rather than a rendered frame: which row a
    /// section lands on depends on how the summaries wrap, and a test that
    /// encodes that breaks on every wording change without finding a bug.
    #[test]
    fn the_docs_cover_every_phase_status_and_field() {
        // Whitespace-normalised: prose is wrapped across lines now, so a raw
        // `contains` on a multi-word sentence would miss at every wrap point.
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let text = squash(
            &docs_lines(96)
                .iter()
                .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
                .collect::<Vec<_>>()
                .join(" "),
        );
        let l = lifecycle();
        for p in &l.phases {
            assert!(text.contains(&p.title), "phase {} missing", p.id);
        }
        for s in &l.statuses {
            assert!(text.contains(&s.id), "status {} missing", s.id);
            assert!(text.contains(&squash(&s.help)), "status {} help missing", s.id);
        }
        for f in &l.fields {
            assert!(text.contains(&f.id), "field {} missing", f.id);
        }
        assert!(text.contains("(terminal)"), "terminal statuses are marked");
        // The one phase that stops for you is the one worth spotting.
        assert!(text.contains("needs you"), "the attended phase is marked");
        assert_eq!(
            l.phases.iter().filter(|p| p.attended).count(),
            1,
            "exactly one phase should be attended — more than that is a workflow, not a pipeline",
        );
    }

    /// The status line is the one kaizen surface that is not on screen, so the
    /// guide is where you go when a glyph in your prompt stops making sense.
    /// It is only that if every glyph is actually there.
    #[test]
    fn the_guide_explains_every_glyph_the_status_line_paints() {
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let text = squash(
            &docs_lines(96)
                .iter()
                .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
                .collect::<Vec<_>>()
                .join(" "),
        );
        let sl = status_line();
        assert!(text.contains(&sl.mark), "the mark is not explained");
        for p in &sl.piles {
            assert!(text.contains(&p.glyph), "pile {} has no glyph on the card", p.label);
            assert!(text.contains(&p.label), "pile {} is not named", p.label);
            assert!(text.contains(&squash(&p.help)), "pile {} has no meaning", p.label);
        }
    }

    /// A card with no slug is still identifiable rather than blank.
    #[test]
    fn a_missing_slug_falls_back_to_the_id() {
        let mut app = App::new();
        app.state = Some(
            serde_json::from_str(
                r#"{"suggestions":[{"id":"user/k/2026-08-08-no-slug-here.md","status":"recorded","surfaced":true}]}"#,
            )
            .unwrap(),
        );
        assert!(render(&app, 120, 30).contains("No slug here"));
    }


    /// A refusal is the interesting case, and it is shown as the server wrote it.
    #[test]
    fn a_refusal_is_shown_verbatim_and_in_red() {
        let mut app = app_with_state();
        app.say("working tree is not clean — commit or stash first: SKILL.md", true);
        let text = render(&app, 120, 30);
        assert!(text.contains("working tree is not clean"), "{text}");
        assert!(text.contains("SKILL.md"), "it names the file");
    }

    #[test]
    fn an_unreachable_server_says_so_instead_of_an_empty_board() {
        let mut app = App::new();
        app.error = Some("cannot reach the kaizen server at http://127.0.0.1:7777 — is it running?".into());
        let text = render(&app, 120, 30);
        assert!(text.contains("cannot read state"), "{text}");
        assert!(text.contains("kaizen serve"), "it names the fix");
    }

    #[test]
    fn the_diff_overlay_colours_and_scrolls() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Diff {
            id: "user/kaizen/2026-08-08-approval-is-a-dead-end.md".into(),
            body: (0..80).map(|i| format!("+line {i}")).collect::<Vec<_>>().join("\n"),
            scroll: 0,
        });
        assert!(render(&app, 120, 30).contains("line 0"));
        if let Some(Overlay::Diff { scroll, .. }) = app.overlay.as_mut() {
            *scroll = 40;
        }
        let text = render(&app, 120, 30);
        assert!(text.contains("line 40"), "scrolled: {text}");
        assert!(!text.contains("line 0 "), "top scrolled away");
    }

    /// Help outgrew a small terminal, so it scrolls like the patch does.
    #[test]
    fn the_help_overlay_scrolls() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Help { guide: false, scroll: 0 });
        assert!(render(&app, 100, 16).contains("navigate"));
        // Asserted on a section heading, which only the card has — the footer
        // behind the overlay also says "j/k".
        app.overlay = Some(Overlay::Help { guide: false, scroll: 8 });
        let text = render(&app, 100, 16);
        assert!(!text.contains("navigate"), "the top scrolled away: {text}");
    }

    #[test]
    fn draws_at_awkward_sizes_without_panicking() {
        let app = app_with_state();
        for (w, h) in [(200, 60), (120, 30), (89, 24), (80, 24), (40, 10), (20, 6), (10, 4), (4, 2)] {
            render(&app, w, h);
        }
        for overlay in [
            Overlay::Help { guide: false, scroll: 0 },
            Overlay::Diff {
                id: "user/k/2026-08-08-x.md".into(),
                body: "@@ -1 +1 @@\n-a\n+b".into(),
                scroll: 0,
            },
            Overlay::Detail { id: "user/k/2026-08-08-x.md".into(), scroll: 0 },
        ] {
            let mut with_overlay = app_with_state();
            with_overlay.overlay = Some(overlay);
            for (w, h) in [(120, 30), (40, 10), (20, 6), (10, 4), (4, 2)] {
                render(&with_overlay, w, h);
            }
        }
        for d in [
            None,
            Some(dispatch(vec![], vec![])),
            Some(dispatch(vec![run(1, None, None), run(2, Some("u/k/2026-08-08-x.md"), Some(0))], vec![None; 12])),
        ] {
            let mut on_agent = app_with_state();
            on_agent.tab = Tab::Agent;
            on_agent.state.as_mut().unwrap().dispatch = d;
            for (w, h) in [(120, 30), (40, 10), (20, 6), (10, 4), (4, 2)] {
                render(&on_agent, w, h);
            }
        }
    }

    #[test]
    fn an_empty_board_says_so_and_a_cold_start_says_loading() {
        let mut app = App::new();
        app.state = Some(serde_json::from_str(r#"{"suggestions":[]}"#).unwrap());
        assert!(render(&app, 120, 30).contains("nothing filed yet"));
        // Before the first fetch lands, it is loading rather than empty.
        assert!(render(&App::new(), 120, 30).contains("reading skills…"));
    }

    /// The URL is the first thing to go when the keys and it cannot both fit.
    #[test]
    fn the_footer_drops_the_url_before_it_cuts_a_key() {
        let text = render(&app_with_state(), 60, 18);
        assert!(!text.contains("http://127.0.0.1:7777"), "the URL is gone: {text}");
        let footer = text.lines().last().unwrap();
        assert!(footer.contains("j/k move"), "the first keys survive whole: {footer}");
        assert!(!footer.contains("appro "), "no half-written hint: {footer}");
    }

    /// A refresh that empties lanes must not leave the cursors past the end —
    /// every later lookup indexes into them. The clamped lane may be an empty
    /// stage, which is a place to stand but nothing to act on.
    #[test]
    fn shrinking_the_board_clamps_both_cursors() {
        let mut app = app_with_state();
        app.board_lane = 99;
        app.board_sel = 99;
        app.clamp();
        assert!(app.board_lane < board::lanes(app.state.as_ref().unwrap()).len());
        render(&app, 120, 30);

        // On a lane with cards, the clamped selection lands on one.
        app.board_lane = 0;
        app.board_sel = 99;
        app.clamp();
        assert!(app.selected_id().is_some());
    }

    /* -------------------------------------------------------------- agent ---- */

    #[test]
    fn the_agents_tab_says_idle_until_a_run_exists() {
        let mut app = app_with_state();
        app.tab = Tab::Agent;
        let text = render(&app, 120, 30);
        assert!(text.contains("none running") && text.contains("idle"), "{text}");
        assert!(text.contains("A at the backlog"), "and points at the keys: {text}");
        assert!(text.contains("nobody waiting"), "and the line is empty: {text}");
    }

    /// Every run the server has going is a row — what it is on, its pid, its
    /// age — live ones first, and the ones that ended stay with how they
    /// ended. Under them, the line, numbered, so "why is my card at 3" has a
    /// place to be answered.
    #[test]
    fn the_agents_tab_lists_every_run_and_the_line() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut app = app_with_state();
        app.tab = Tab::Agent;
        let mut live = run(4242, Some("user/kaizen/2026-08-08-approval-is-a-dead-end.md"), None);
        live.started_at = Some(now_ms);
        app.state.as_mut().unwrap().dispatch = Some(dispatch(
            vec![run(4000, None, Some(1)), run(4001, Some("user/x/2026-01-01-earlier.md"), Some(0)), live, run(4243, None, None)],
            vec![Some("user/other/2026-08-01-a-second-thing.md"), None],
        ));
        let text = render(&app, 120, 30);
        assert!(text.contains("2 running"), "{text}");
        assert!(text.contains("Approval is a dead end · pid 4242"), "names its fence: {text}");
        // Never the exact duration — that is the wall clock's business.
        assert!(text.contains("up "), "{text}");
        assert!(text.contains("the backlog · pid 4243"), "{text}");
        assert!(text.contains("Earlier · done"), "an ended run keeps its verdict: {text}");
        assert!(text.contains("the backlog · exit 1"), "{text}");
        assert!(text.contains("in line (2)"), "{text}");
        assert!(text.contains(" 1  A second thing") && text.contains(" 2  the backlog"), "{text}");
        // Live rows come before ended ones, whatever order the server sent.
        assert!(text.find("pid 4242").unwrap() < text.find("Earlier").unwrap(), "{text}");
    }
}
