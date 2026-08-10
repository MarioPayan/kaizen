//! The queue, as a terminal UI.
//!
//! Every HTTP call happens on a worker thread and comes back over a channel. That
//! is not premature: `GET /api/state` rescans the skills tree and takes ~40ms, and
//! `POST /api/apply` runs `git apply` and two more git commands. Doing either on
//! the draw loop makes the list stutter on every file change.
//!
//! Applying is never optimistic. It produces a commit sha and can be refused three
//! ways — dirty tree, read-only target, no patch — so the row only changes once the
//! server says it did, and a refusal is shown in the server's own words.
//!
//! The layout has one breakpoint. Below `WIDE` columns a two-pane split gives each
//! pane too little to be read, so only the focused pane is drawn and it gets the
//! whole width; above it, both are drawn and focus only moves the accent border.
//! `tab` means "the detail" either way, which keeps `enter` unambiguously "apply".

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Clear, List, ListItem, ListState, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Tabs,
    Wrap,
};
use ratatui::Frame;
use std::sync::mpsc;
use std::time::Duration;

use crate::api::{Client, Config, State, Suggestion};
use crate::theme::{self, severity_colour, severity_letter, status_colour, tone_colour};
use crate::ui::{badge, fit_parts, titled, truncate, wrapped};
use crate::keys::{self, Action, Tab};
use crate::views::{clusters, settings, skills};
use crate::lifecycle::{
    can_transition, decision_status, is_before_decision, lifecycle, next_statuses, status_abbrev,
    status_spec,
};

const TICK: Duration = Duration::from_millis(250);

/// Under this many columns, a split leaves both panes unreadable, so only the
/// focused one is drawn. 90 is where the list can still hold a skill and a
/// forty-character slug at 45% of the width.
const WIDE: u16 = 90;

/* ------------------------------------------------------------------ filter ---- */

#[derive(Clone, Copy, PartialEq, Debug)]
enum Filter {
    All,
    Undecided,
    Approved,
}

impl Filter {
    fn next(self) -> Self {
        match self {
            Filter::All => Filter::Undecided,
            Filter::Undecided => Filter::Approved,
            Filter::Approved => Filter::All,
        }
    }

    fn label(self) -> Option<&'static str> {
        match self {
            Filter::All => None,
            Filter::Undecided => Some("undecided"),
            Filter::Approved => Some("approved"),
        }
    }

    /// Membership comes from the spec, not from a list of names kept here — the
    /// previous one was still matching `new` and `proposed` after the rename and
    /// would have quietly filtered to nothing.
    fn keeps(self, s: &Suggestion) -> bool {
        match self {
            Filter::All => true,
            Filter::Undecided => s.status.is_empty() || is_before_decision(&s.status),
            Filter::Approved => status_spec(&s.status).is_some_and(|x| x.id == decision_status()),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Focus {
    Queue,
    Detail,
}

/* -------------------------------------------------------------------- work ---- */

enum Req {
    Refresh,
    SetStatus { id: String, status: String },
    SetCluster { id: String, status: String },
    Apply { id: String },
    Diff { id: String },
    Config,
    SaveConfig(serde_json::Value),
    SkillFile { path: String },
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
                Req::SetCluster { id, status } => Res::Acted(
                    client
                        .set_cluster_status(&id, &status)
                        .map(|n| format!("{status} {n} in cluster {id}")),
                ),
                Req::Apply { id } => Res::Acted(
                    client
                        .apply(&id)
                        .map(|sha| format!("applied {} — {}", short(&id), &sha[..7.min(sha.len())])),
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

/// `user/kaizen/2026-08-08-a-dead-end.md` -> `a-dead-end`.
fn short(id: &str) -> String {
    id.rsplit('/')
        .next()
        .unwrap_or(id)
        .trim_end_matches(".md")
        .splitn(4, '-')
        .nth(3)
        .unwrap_or(id)
        .to_string()
}

/// What to call a suggestion in one line. Falls back to the id's tail rather than
/// leaving a row anonymous.
fn title_of(s: &Suggestion) -> String {
    if s.slug.is_empty() {
        short(&s.id)
    } else {
        s.slug.clone()
    }
}

/* ------------------------------------------------------------------- state ---- */

/// Things you consult, drawn on top of whichever tab you are on.
///
/// Help carries both halves rather than being two overlays: the keys and the
/// model are the two questions you have while looking at a queue, and making
/// them one overlay with a switch means you never have to remember which key
/// opened which.
enum Overlay {
    Help { guide: bool, scroll: u16 },
    Diff { id: String, body: String, scroll: u16 },
    File { path: String, body: String, scroll: u16 },
}

/// Where you were, precisely enough to put you back.
///
/// Not just the tab: returning to the clusters list with the cursor reset to the
/// top is still losing your place, and the whole complaint about `esc` was that
/// it did not take you back to where you actually were.
#[derive(Clone, PartialEq)]
struct Place {
    tab: Tab,
    focus: Focus,
    cluster_filter: Option<String>,
    query: String,
    filter: Filter,
    sel: usize,
    cluster_sel: usize,
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
    sel: usize,
    scroll: u16,
    overlay: Option<Overlay>,
    notice: Option<Notice>,
    live: bool,
    busy: bool,
    filter: Filter,
    /// Set by opening a cluster. Membership, not text — the cluster id is built
    /// from its members' shared vocabulary and is frequently in none of them.
    cluster_filter: Option<String>,
    query: String,
    searching: bool,
    focus: Focus,
    tab: Tab,
    /// One cursor per list, so switching tabs does not move the other one.
    cluster_sel: usize,
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
            sel: 0,
            scroll: 0,
            overlay: None,
            notice: None,
            live: false,
            busy: true,
            filter: Filter::All,
            cluster_filter: None,
            query: String::new(),
            searching: false,
            focus: Focus::Queue,
            tab: Tab::Queue,
            cluster_sel: 0,
            skill_sel: 0,
            setting_sel: 0,
            config: None,
            config_saved: None,
            config_errors: Vec::new(),
            history: Vec::new(),
        }
    }

    /// The queue after the filter and the search. The server's order is kept —
    /// re-ranking here would invent an order the dashboard does not share.
    fn visible(&self) -> Vec<&Suggestion> {
        let Some(state) = self.state.as_ref() else { return Vec::new() };
        let needle = self.query.to_lowercase();
        let members: Option<std::collections::HashSet<&str>> = self.cluster_filter.as_ref().map(|id| {
            state
                .clusters
                .iter()
                .find(|c| &c.id == id)
                .map(|c| c.members.iter().map(String::as_str).collect())
                .unwrap_or_default()
        });
        state
            .queue()
            .into_iter()
            .filter(|s| members.as_ref().is_none_or(|m| m.contains(s.id.as_str())))
            .filter(|s| self.filter.keeps(s))
            .filter(|s| {
                needle.is_empty()
                    || s.slug.to_lowercase().contains(&needle)
                    || s.skill.to_lowercase().contains(&needle)
                    || s.id.to_lowercase().contains(&needle)
            })
            .collect()
    }

    fn total(&self) -> usize {
        self.state.as_ref().map(|s| s.queue().len()).unwrap_or(0)
    }

    fn selected_id(&self) -> Option<String> {
        self.visible().get(self.sel).map(|s| s.id.clone())
    }

    /// The status of the row the keys act on, canonical-or-raw as the file has it.
    fn selected_status(&self) -> Option<String> {
        self.visible().get(self.sel).map(|s| s.status.clone())
    }

    fn selected_cluster(&self) -> Option<String> {
        let pin = self.visible().get(self.sel)?.cluster_pin.clone();
        (!pin.is_empty()).then_some(pin)
    }

    /// Anything that can shrink the list — a refresh, a filter, a keystroke in the
    /// search — has to leave the selection on a row that still exists.
    fn clamp(&mut self) {
        self.sel = self.sel.min(self.visible().len().saturating_sub(1));
    }

    /// j/k, dispatched to whatever the current tab is actually showing.
    ///
    /// One entry point rather than a match at every call site: the queue has a
    /// focus model and two of the tabs are plain lists, and threading that
    /// distinction through four key handlers is how they drift apart.
    fn move_by(&mut self, delta: isize) {
        let step = |cur: usize, len: usize| -> usize {
            if len == 0 {
                0
            } else {
                (cur as isize + delta).clamp(0, len as isize - 1) as usize
            }
        };
        match self.tab {
            Tab::Queue if self.focus == Focus::Detail => {
                self.scroll = self.scroll.saturating_add_signed(delta as i16)
            }
            Tab::Queue => {
                let next = step(self.sel, self.visible().len());
                if next != self.sel {
                    self.sel = next;
                    // A new row is a new document; the old offset lands mid-sentence.
                    self.scroll = 0;
                }
            }
            Tab::Clusters => {
                self.cluster_sel = step(self.cluster_sel, self.clusters().len());
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

    /// The clusters worth deciding, in the order the view draws them — so the
    /// cursor index means the same thing here and there.
    fn clusters(&self) -> Vec<&crate::api::Cluster> {
        self.state.as_ref().map(|s| clusters::actionable(&s.clusters)).unwrap_or_default()
    }

    fn place(&self) -> Place {
        Place {
            tab: self.tab,
            focus: self.focus,
            cluster_filter: self.cluster_filter.clone(),
            query: self.query.clone(),
            filter: self.filter,
            sel: self.sel,
            cluster_sel: self.cluster_sel,
            skill_sel: self.skill_sel,
            setting_sel: self.setting_sel,
        }
    }

    /// Remember where we are, before going somewhere else.
    ///
    /// Capped, and never twice in a row for the same place: holding `2` should
    /// not bury the way back under forty copies of the clusters tab.
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
        self.focus = p.focus;
        self.cluster_filter = p.cluster_filter;
        self.query = p.query;
        self.filter = p.filter;
        self.sel = p.sel;
        self.cluster_sel = p.cluster_sel;
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

    /// How many of a cluster's members could actually become approved, and how
    /// many there are. The server's cluster write is all-or-nothing, so the pair
    /// is what decides whether asking is worth a round trip.
    fn cluster_readiness(&self, id: &str) -> (usize, usize) {
        let Some(state) = self.state.as_ref() else { return (0, 0) };
        let Some(cluster) = state.clusters.iter().find(|c| c.id == id) else { return (0, 0) };
        let ready = cluster
            .members
            .iter()
            .filter_map(|m| state.suggestions.iter().find(|s| &s.id == m))
            .filter(|s| can_transition(&s.status, "approved"))
            .count();
        (ready, cluster.members.len())
    }

    fn skills(&self) -> Vec<&crate::api::Skill> {
        self.state.as_ref().map(|s| skills::ranked(&s.skills)).unwrap_or_default()
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some(Notice { text: text.into(), error });
    }
}

/* -------------------------------------------------------------------- draw ---- */

fn draw_queue(frame: &mut Frame, area: Rect, app: &App, focused: bool) {
    let visible = app.visible();
    let total = app.total();
    let title = if visible.len() == total && app.query.is_empty() {
        format!("Queue ({total})")
    } else {
        let mut t = format!("Queue ({} of {total}", visible.len());
        if let Some(label) = app.filter.label() {
            t.push_str(" · ");
            t.push_str(label);
        }
        if !app.query.is_empty() {
            t.push_str(" · /");
            t.push_str(&app.query);
        }
        t.push(')');
        t
    };

    let outer = titled(&title, area, focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if visible.is_empty() {
        let msg = match (app.state.is_none(), total) {
            (true, _) => "reading skills…",
            (false, 0) => "nothing to decide",
            // The queue is not empty, the view of it is — say which key undoes that.
            _ => "nothing matches — f cycles the filter, / clears the search",
        };
        frame.render_widget(
            Paragraph::new(msg).wrap(Wrap { trim: false }).style(Style::new().fg(theme::dim())),
            inner,
        );
        return;
    }

    // The scrollbar gets its own column rather than painting over the last one.
    let scrolls = visible.len() > inner.height as usize;
    let (list_area, bar_area) = if scrolls {
        (
            Rect { width: inner.width.saturating_sub(1), ..inner },
            Some(Rect { x: inner.x + inner.width.saturating_sub(1), width: 1, ..inner }),
        )
    } else {
        (inner, None)
    };

    // marker(2) + score(4) + severity(2) + status(5) are fixed; skill and slug
    // share what is left, with the slug favoured — it is the column you actually
    // read down. A narrow pane drops the skill entirely rather than shaving both.
    const MARKER: u16 = 2;
    const FIXED: u16 = 11;
    let spare = list_area.width.saturating_sub(MARKER + FIXED) as usize;
    let skill_w = if spare < 36 { 0 } else { (spare / 3).min(16) };
    let slug_w = spare.saturating_sub(skill_w + 2 * usize::from(skill_w > 0));

    let items: Vec<ListItem> = visible
        .iter()
        .map(|s| {
            let mut spans = vec![
                Span::styled(format!("{:>3} ", s.score.round() as i64), Style::new().fg(theme::dim())),
                Span::styled(
                    format!("{} ", severity_letter(&s.severity)),
                    Style::new().fg(severity_colour(&s.severity)),
                ),
                Span::styled(
                    format!("{:<3}  ", status_abbrev(&s.status)),
                    Style::new().fg(status_colour(&s.status)),
                ),
            ];
            if skill_w > 0 {
                spans.push(Span::styled(
                    format!("{:<width$}  ", truncate(&s.skill, skill_w), width = skill_w),
                    Style::new().fg(theme::dim()),
                ));
            }
            spans.push(Span::raw(truncate(&title_of(s), slug_w)));
            ListItem::new(Line::from(spans))
        })
        .collect();

    let mut list_state = ListState::default().with_selected(Some(app.sel));
    frame.render_stateful_widget(
        List::new(items)
            // A marker as well as a background: a terminal with a weak or absent
            // selection colour still shows which row the keys act on.
            .highlight_symbol("▸ ")
            .highlight_style(Style::new().bg(theme::selection_bg()))
            .scroll_padding(2),
        list_area,
        &mut list_state,
    );

    if let Some(bar) = bar_area {
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight),
            bar,
            &mut ScrollbarState::new(visible.len()).position(app.sel),
        );
    }
}

fn detail_lines(state: &State, s: &Suggestion) -> Vec<Line<'static>> {
    // The slug is the block's title, so the body opens on the facts rather than on
    // three wrapped lines of the id — which is kept, dimmed, at the bottom.
    let mut lines = vec![Line::from(vec![
        badge(&s.severity, severity_colour(&s.severity)),
        badge(&s.status, status_colour(&s.status)),
        badge(&s.kind, theme::accent()),
        badge(&s.objective, theme::dim()),
        Span::styled(
            format!(
                "score {} · {} incident{} · rung {}",
                s.score.round() as i64,
                s.incidents,
                if s.incidents == 1 { "" } else { "s" },
                s.rung.map(|r| r.to_string()).unwrap_or_else(|| "—".into()),
            ),
            Style::new().fg(theme::dim()),
        ),
    ])];
    if !s.scope.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("scope   ", Style::new().fg(theme::dim())),
            Span::raw(s.scope.clone()),
        ]));
    }
    if let Some(cluster) = (!s.cluster_pin.is_empty()).then(|| state.cluster(&s.cluster_pin)).flatten() {
        lines.push(Line::from(vec![
            Span::styled("cluster ", Style::new().fg(theme::dim())),
            Span::styled(cluster.id.clone(), Style::new().fg(theme::accent())),
            Span::styled(
                format!(
                    "  {} members · {} incidents · {} days{}",
                    cluster.size,
                    cluster.incidents,
                    cluster.span_days,
                    if cluster.promoted { " · promoted" } else { "" }
                ),
                Style::new().fg(theme::dim()),
            ),
        ]));
    } else if !s.cluster_pin.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("cluster ", Style::new().fg(theme::dim())),
            Span::raw(s.cluster_pin.clone()),
        ]));
    }

    for (heading, body) in
        [("Context", &s.context), ("Suggestion", &s.suggestion), ("Rationale", &s.rationale)]
    {
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

fn draw_detail(frame: &mut Frame, area: Rect, app: &App, focused: bool) {
    let visible = app.visible();
    let selected = visible.get(app.sel);
    let title = selected.map(|s| title_of(s)).unwrap_or_else(|| "Detail".into());
    let outer = titled(&title, area, focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    let Some(state) = app.state.as_ref() else { return };
    let Some(s) = selected else { return };

    frame.render_widget(
        Paragraph::new(detail_lines(state, s))
            .wrap(Wrap { trim: false })
            .scroll((app.scroll, 0)),
        inner,
    );
}

/// The queue's columns. It is a composed line rather than a table — the slug has
/// to run to the edge — so there is no header row and this is the only place
/// they are ever named.
const QUEUE_COLUMNS: &[(&str, &str)] = &[
    ("score", "impact × (1 + recurrences) ÷ effort; untriaged score 0"),
    ("H M L", "severity: high, medium, low — a letter so it survives no colour"),
    ("status", "three letters, spelled out below"),
    ("skill", "which skill filed it"),
    ("slug", "what it is about"),
];

fn columns_for(tab: Tab) -> &'static [(&'static str, &'static str)] {
    match tab {
        Tab::Queue => QUEUE_COLUMNS,
        Tab::Clusters => clusters::COLUMNS,
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
    // Only where applying is a thing you can do here. A footnote about git on
    // the settings card is the same clutter as a key you cannot press.
    if keys::resolve(KeyCode::Enter, tab) == Some(keys::Action::Apply) {
        out.push(Line::styled(
            "applying needs a clean tree",
            Style::new().fg(theme::dim()),
        ));
        out.push(Line::styled("and a patch on disk", Style::new().fg(theme::dim())));
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
        // Spelled out from the spec, directly under the column it explains, so
        // a renamed status cannot leave a stale legend behind.
        if *name == "status" {
            let legend = lifecycle()
                .statuses
                .iter()
                .map(|s| format!("{} {}", s.abbrev, s.id))
                .collect::<Vec<_>>()
                .join(" · ");
            for line in wrapped(&legend, "    ", width) {
                out.push(Line::styled(line, Style::new().fg(theme::dim())));
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
            Span::styled(format!("    {:<4} ", s.abbrev), Style::new().fg(tone_colour(&s.tone))),
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

fn draw_overlay(frame: &mut Frame, area: Rect, overlay: &Overlay, tab: Tab) {
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
    }
}

fn draw(frame: &mut Frame, app: &App) {
    let [header, body, footer] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0), Constraint::Length(1)])
            .areas(frame.area());
    let wide = frame.area().width >= WIDE;
    // Nothing to focus when nothing is listed — otherwise a narrow terminal shows
    // an empty detail box and no way to learn why.
    let focus = if app.visible().is_empty() { Focus::Queue } else { app.focus };

    let m = app.state.as_ref().map(|s| s.metrics.clone()).unwrap_or_default();
    let mut parts = vec![format!("{} open", m.open)];
    if app.busy {
        parts.push("working…".into());
    }
    parts.push(format!("{} untriaged", m.untriaged));
    parts.push(format!(
        "{} promoted cluster{}",
        m.promoted_clusters,
        if m.promoted_clusters == 1 { "" } else { "s" }
    ));
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
            Tab::Queue if wide => {
                let [list, detail] =
                    Layout::horizontal([Constraint::Percentage(45), Constraint::Min(30)]).areas(body);
                draw_queue(frame, list, app, focus == Focus::Queue);
                draw_detail(frame, detail, app, focus == Focus::Detail);
            }
            Tab::Queue if focus == Focus::Detail => draw_detail(frame, body, app, true),
            Tab::Queue => draw_queue(frame, body, app, true),
            Tab::Clusters => {
                let list = app.state.as_ref().map(|s| s.clusters.as_slice()).unwrap_or(&[]);
                clusters::draw(frame, body, list, app.cluster_sel, true, &|id| {
                    app.cluster_readiness(id).0
                });
            }
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
        draw_overlay(frame, frame.area(), overlay, app.tab);
    }
}

fn draw_footer(frame: &mut Frame, footer: Rect, app: &App) {
    // Whole hints or none: a truncated key name reads as a rendering bug. The
    // base URL used to sit on the right; it was never something anyone needed
    // mid-decision, and it was taking the room the keys wanted.
    let width = footer.width as usize;
    let (text, colour) = if app.searching {
        (format!(" /{}▏", app.query), theme::accent())
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
                "change" => {
                    app.live = true;
                    app.busy = true;
                    let _ = req.send(Req::Refresh);
                }
                _ => app.live = true,
            }
        }
        while let Ok(message) = res.try_recv() {
            app.busy = false;
            match message {
                Res::State(Ok(state)) => {
                    app.error = None;
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

        // The search line owns the keyboard while it is open, or `a` would approve
        // instead of typing an "a".
        if app.searching {
            match key.code {
                KeyCode::Esc => {
                    app.searching = false;
                    app.query.clear();
                    app.clamp();
                }
                KeyCode::Enter => app.searching = false,
                KeyCode::Backspace => {
                    app.query.pop();
                    app.sel = 0;
                }
                KeyCode::Char(c) => {
                    app.query.push(c);
                    app.sel = 0;
                }
                _ => {}
            }
            continue;
        }

        // An overlay captures every key: esc/q closes it, the rest scrolls.
        if let Some(overlay) = app.overlay.as_mut() {
            fn scroll_of(o: &mut Overlay) -> &mut u16 {
                match o {
                    Overlay::Help { scroll, .. }
                    | Overlay::File { scroll, .. }
                    | Overlay::Diff { scroll, .. } => scroll,
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
                    let s = scroll_of(overlay);
                    *s = s.saturating_add(1);
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    let s = scroll_of(overlay);
                    *s = s.saturating_sub(1);
                }
                KeyCode::PageDown => {
                    let s = scroll_of(overlay);
                    *s = s.saturating_add(10);
                }
                KeyCode::PageUp => {
                    let s = scroll_of(overlay);
                    *s = s.saturating_sub(10);
                }
                _ => app.overlay = None,
            }
            continue;
        }

        app.notice = None;
        // Ctrl-C is not a binding — it is the terminal's, and it should work
        // from inside a search box too, which the table below deliberately does
        // not reach.
        let Some(action) = keys::resolve(key.code, app.tab) else { continue };
        match action {
            Action::Quit => return Ok(()),
            Action::Back => {
                // The detail pane is a step within the queue rather than a place
                // of its own, so it closes first and does not consume history.
                if app.focus == Focus::Detail {
                    app.focus = Focus::Queue;
                } else if !app.go_back() {
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
            Action::ScrollDetail(d) => app.scroll = app.scroll.saturating_add_signed(d),
            Action::ToggleFocus => {
                app.focus = if app.focus == Focus::Queue { Focus::Detail } else { Focus::Queue }
            }
            Action::Help => app.overlay = Some(Overlay::Help { guide: false, scroll: 0 }),
            Action::Guide => app.overlay = Some(Overlay::Help { guide: true, scroll: 0 }),
            Action::Theme => theme::cycle(),
            Action::Refresh => {
                app.busy = true;
                let _ = req.send(Req::Refresh);
                if app.tab == Tab::Settings {
                    let _ = req.send(Req::Config);
                }
            }
            Action::CycleFilter => {
                app.filter = app.filter.next();
                app.sel = 0;
                app.scroll = 0;
            }
            Action::Search => app.searching = true,
            Action::Approve | Action::Reject => {
                let status = if action == Action::Approve { "approved" } else { "rejected" };
                match app.selected_status() {
                    Some(from) if !can_transition(&from, status) => {
                        let onward = next_statuses(&from);
                        app.say(
                            if onward.is_empty() {
                                format!("{from} is terminal — nothing follows it")
                            } else {
                                format!("{from} cannot become {status} — only {}", onward.join(", "))
                            },
                            true,
                        );
                    }
                    Some(_) => {
                        if let Some(id) = app.selected_id() {
                            app.busy = true;
                            let _ = req.send(Req::SetStatus { id, status: status.into() });
                        }
                    }
                    None => {}
                }
            }
            Action::ApproveCluster => {
                let id = match app.tab {
                    Tab::Clusters => app.clusters().get(app.cluster_sel).map(|c| c.id.clone()),
                    _ => app.selected_cluster(),
                };
                match id {
                    Some(id) => {
                        // The server checks every member before writing any, so
                        // one finished member refuses the whole call. Saying so
                        // here beats a 409 that names a filename.
                        let (ready, total) = app.cluster_readiness(&id);
                        if ready == 0 {
                            app.say(format!("nothing in {id} can be approved — all {total} are decided"), true);
                        } else if ready < total {
                            app.say(format!("{id}: only {ready} of {total} can move"), true);
                        } else {
                            app.busy = true;
                            let _ = req.send(Req::SetCluster { id, status: "approved".into() });
                        }
                    }
                    None => app.say("this suggestion is not in a cluster", true),
                }
            }
            Action::Apply => {
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::Apply { id });
                }
            }
            Action::Diff => {
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::Diff { id });
                }
            }
            Action::Open => match app.tab {
                Tab::Clusters => {
                    let id = app.clusters().get(app.cluster_sel).map(|c| c.id.clone());
                    if let Some(id) = id {
                        app.remember();
                        app.cluster_filter = Some(id.clone());
                        app.filter = Filter::All;
                        app.query.clear();
                        app.tab = Tab::Queue;
                        app.sel = 0;
                        app.clamp();
                        let n = app.visible().len();
                        app.say(format!("{n} in {id} — esc goes back"), false);
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

    fn state() -> State {
        serde_json::from_str(
            r#"{
              "suggestions": [
                { "id": "user/kaizen/2026-08-08-approval-is-a-dead-end.md", "skill": "kaizen",
                  "slug": "approval-is-a-dead-end",
                  "severity": "high", "status": "approved", "type": "structural",
                  "objective": "bug", "score": 42, "surfaced": true, "incidents": 3,
                  "rung": 1, "scope": "skills/kaizen/SKILL.md",
                  "clusterPin": "origin-local-remote",
                  "context": "First full pass.", "suggestion": "Write the patch.",
                  "rationale": "Because approval without one is a dead end." },
                { "id": "user/other/2026-08-01-a-second-thing.md", "skill": "other",
                  "slug": "a-second-thing",
                  "severity": "low", "status": "recorded", "score": 5, "surfaced": true }
              ],
              "skills": [
                { "name": "ts-pr-review", "kind": "user", "lines": 700, "scripts": 0,
                  "suggestions": 17, "per100": 2.43, "health": "noisy",
                  "path": "/s/ts-pr-review/SKILL.md" },
                { "name": "ts-github-triage", "kind": "user", "lines": 358, "scripts": 4,
                  "suggestions": 0, "per100": 0, "health": "scripted",
                  "path": "/s/ts-github-triage/SKILL.md" }
              ],
              "clusters": [
                { "id": "origin-local-remote", "size": 2, "incidents": 27,
                  "spanDays": 70, "promoted": true, "scopes": ["_lib/pr/local-workspace.md"],
                  "members": ["user/kaizen/2026-08-08-approval-is-a-dead-end.md",
                              "user/other/2026-08-01-a-second-thing.md"] },
                { "id": "quiet-pair", "size": 2, "incidents": 2,
                  "spanDays": 3, "promoted": false, "scopes": ["_lib/pr/github.md"] }
              ],
              "metrics": { "open": 2, "untriaged": 0, "promotedClusters": 1 }
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

    #[test]
    fn short_keeps_the_slug_and_drops_the_date() {
        assert_eq!(short("user/kaizen/2026-08-08-approval-is-a-dead-end.md"), "approval-is-a-dead-end");
        assert_eq!(short("nonsense"), "nonsense");
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

    #[test]
    fn the_queue_and_its_detail_both_render() {
        let text = render(&app_with_state(), 120, 30);
        assert!(text.contains("Queue (2)"), "{text}");
        assert!(text.contains("approval-is-a-dead-end"), "list shows the slug");
        assert!(text.contains("origin-local-remote"), "detail names the cluster");
        // Asserted piecewise: the detail pane wraps, so the cluster summary can be
        // split across rows and a single `contains` on the whole frame would miss it.
        for part in ["2 members", "27 incidents", "70 days", "promoted"] {
            assert!(text.contains(part), "cluster summary missing {part:?}: {text}");
        }
        assert!(text.contains("2 open"), "header carries the metrics");
        assert!(!text.contains("1 promoted clusters"), "singular, not '1 clusters': {text}");
        // The footer is easy to lose to a layout mistake and hard to notice.
        assert!(text.contains("a approve"), "key hints render: {text}");
        // No URL in the footer any more: it was never something anyone needed
        // mid-decision and it was taking the room the keys wanted.
        assert!(!text.contains("http://"), "the footer carries no URL: {text}");
    }

    /// The columns that read the same on every row are one character each, and the
    /// selected row is marked as well as highlighted.
    #[test]
    fn rows_spend_their_width_on_the_slug() {
        let text = render(&app_with_state(), 120, 30);
        assert!(text.contains("▸  42 H apr"), "marker, score, severity, status: {text}");
        assert!(text.contains("   5 L rec"), "the second row draws its status: {text}");
        assert!(!text.contains("medium   approved"), "the spelled-out columns are gone: {text}");
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
        assert_eq!(status_abbrev("recorded"), "rec");
        assert_eq!(status_abbrev("planned"), "pln");
        assert_eq!(status_abbrev("verified"), "ver");
        // One spelling per status: anything else is a typo, not an older name.
        assert_eq!(status_abbrev("new"), "—");
        assert_eq!(status_abbrev("nonsense"), "—");
        assert_eq!(status_abbrev(""), "—");
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
        let card = help_keys(Tab::Queue)
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
    /// `esc` was hardcoded to "go to the queue" rather than "go back".
    #[test]
    fn esc_returns_to_where_you_came_from_not_to_the_queue() {
        let mut app = app_with_state();

        // Queue -> clusters -> skills, then back down the way we came.
        app.remember();
        app.tab = Tab::Clusters;
        app.cluster_sel = 1;
        app.remember();
        app.tab = Tab::Skills;

        assert!(app.go_back());
        assert_eq!(app.tab, Tab::Clusters);
        assert_eq!(app.cluster_sel, 1, "and to the row you were on, not the top");

        assert!(app.go_back());
        assert_eq!(app.tab, Tab::Queue);

        // Nothing left: it says so rather than quitting. `esc` is labelled
        // "back", and a key that sometimes exits is one you stop trusting.
        assert!(!app.go_back());
    }

    /// Opening a cluster jumps to the queue with a filter; going back has to
    /// undo both the jump and the filter, and land on the same cluster row.
    #[test]
    fn esc_undoes_opening_a_cluster_whole() {
        let mut app = app_with_state();
        app.tab = Tab::Clusters;
        app.cluster_sel = 1;

        app.remember();
        app.cluster_filter = Some("origin-local-remote".into());
        app.tab = Tab::Queue;
        app.sel = 0;
        assert_eq!(app.visible().len(), 2);

        assert!(app.go_back());
        assert_eq!(app.tab, Tab::Clusters);
        assert_eq!(app.cluster_sel, 1);
        assert!(app.cluster_filter.is_none(), "the filter went with it");
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
            app.sel = i % 2;
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

        // `enter` is bound three times, once per view. Each card shows its one.
        let queue = card(Tab::Queue);
        assert!(queue.contains("apply"), "{queue}");
        assert!(!queue.contains("show members"), "and not the clusters meaning: {queue}");
        assert!(!queue.contains("open file"), "nor the skills one: {queue}");

        let clusters = card(Tab::Clusters);
        assert!(clusters.contains("show members"), "{clusters}");
        assert!(!clusters.contains("enter   apply"), "{clusters}");
        // The git footnote is queue-only too — it is advice about a key that is
        // not bound here.
        assert!(!clusters.contains("clean tree"), "{clusters}");
        assert!(queue.contains("clean tree"), "{queue}");

        assert!(card(Tab::Skills).contains("open file"));

        // Keys that do not work here are not offered here.
        assert!(!card(Tab::Skills).contains("approve"), "skills cannot approve");
        assert!(card(Tab::Settings).contains("save"), "but settings can save");
        assert!(!card(Tab::Queue).contains("save"), "and the queue cannot");

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

        // Named per view, not shared: `per100` means nothing on the queue.
        assert!(card(Tab::Skills).contains("per100"));
        assert!(!card(Tab::Queue).contains("per100"));
        assert!(card(Tab::Clusters).contains("promoted"));

        // The status legend is generated, so a renamed status cannot leave a
        // stale abbreviation behind in the help.
        let queue = card(Tab::Queue);
        for s in &lifecycle().statuses {
            assert!(queue.contains(&format!("{} {}", s.abbrev, s.id)), "legend has {}", s.id);
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
        for (tab, columns) in [
            (Tab::Clusters, clusters::COLUMNS),
            (Tab::Skills, skills::COLUMNS),
        ] {
            let mut app = app_with_state();
            app.tab = tab;
            let text = render(&app, 120, 20);
            for (name, _) in columns.iter().filter(|(n, _)| !n.is_empty()) {
                assert!(text.contains(name), "{tab:?} header shows {name:?}: {text}");
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

    /// Promoted first, then by what it cost — the list is a work order.
    #[test]
    fn clusters_rank_promoted_first_and_mark_them() {
        let mut app = app_with_state();
        app.tab = Tab::Clusters;
        let text = render(&app, 120, 30);
        assert!(text.contains("Clusters (2 ·"), "{text}");
        assert!(text.contains("▲"), "the promoted one is marked: {text}");
        assert!(text.contains("origin-local-remote"), "{text}");
        assert!(text.contains("_lib/pr/local-workspace.md"), "the scope is the fix's address: {text}");
        // A one-member cluster is not a cluster: nothing to decide as one.
        assert_eq!(app.clusters().len(), 2);
        assert_eq!(app.clusters()[0].id, "origin-local-remote");
    }

    /// The bug this replaced: `enter` set the search box to the cluster id, and
    /// a cluster id is built out of its members' *shared* vocabulary — so it
    /// frequently appears in none of their slugs and the queue came back empty.
    #[test]
    fn opening_a_cluster_filters_by_membership_not_by_text() {
        let mut app = app_with_state();
        // The id matches no member's text, which is exactly the failing case.
        assert!(app.visible().iter().all(|s| !s.slug.contains("origin-local-remote")));

        app.cluster_filter = Some("origin-local-remote".into());
        assert_eq!(app.visible().len(), 2, "both members are found by id");

        app.cluster_filter = Some("nonexistent".into());
        assert!(app.visible().is_empty(), "an unknown cluster hides everything, not nothing");

        app.cluster_filter = None;
        assert_eq!(app.visible().len(), 2);
    }

    /// The other half of the report: `A` on a cluster whose members are all
    /// decided produced a 409 listing filenames. It refuses locally now.
    #[test]
    fn cluster_readiness_counts_what_could_actually_move() {
        let app = app_with_state();
        // approved -> applied is legal, recorded -> approved is not.
        let (ready, total) = app.cluster_readiness("origin-local-remote");
        assert_eq!(total, 2);
        assert_eq!(ready, 0, "neither member can become approved from where it is");
        assert_eq!(app.cluster_readiness("nope"), (0, 0));
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
                    "clusterPromotion":{"members":3,"incidents":5},
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
        assert_eq!(app.sel, 0, "the queue's cursor did not move");
        app.tab = Tab::Clusters;
        app.move_by(1);
        assert_eq!(app.cluster_sel, 1);
        assert_eq!(app.skill_sel, 1, "and the skills cursor stayed put");
        // Neither can walk off the end.
        app.move_by(50);
        assert_eq!(app.cluster_sel, 1);
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

    /// A row with no slug is still identifiable rather than blank.
    #[test]
    fn a_missing_slug_falls_back_to_the_id() {
        let mut app = App::new();
        app.state = Some(
            serde_json::from_str(
                r#"{"suggestions":[{"id":"user/k/2026-08-08-no-slug-here.md","surfaced":true}]}"#,
            )
            .unwrap(),
        );
        assert!(render(&app, 120, 30).contains("no-slug-here"));
    }

    /// Moving down must re-render the other row's detail, and reset the scroll so
    /// the new document starts at its top.
    #[test]
    fn selection_drives_the_detail_pane() {
        let mut app = app_with_state();
        app.scroll = 12;
        app.move_by(1);
        assert_eq!(app.sel, 1);
        assert_eq!(app.scroll, 0, "a new row starts at the top");
        assert!(render(&app, 120, 30).contains("a-second-thing"));
        // And it cannot walk off either end.
        app.move_by(50);
        assert_eq!(app.sel, 1);
        app.move_by(-50);
        assert_eq!(app.sel, 0);
    }

    #[test]
    fn cluster_action_needs_a_cluster() {
        let mut app = app_with_state();
        assert_eq!(app.selected_cluster().as_deref(), Some("origin-local-remote"));
        app.move_by(1);
        assert_eq!(app.selected_cluster(), None, "the second suggestion has no cluster pin");
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
    fn an_unreachable_server_says_so_instead_of_an_empty_queue() {
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
        for overlay in [Overlay::Help { guide: false, scroll: 0 }, Overlay::Diff {
            id: "user/k/2026-08-08-x.md".into(),
            body: "@@ -1 +1 @@\n-a\n+b".into(),
            scroll: 0,
        }] {
            let mut with_overlay = app_with_state();
            with_overlay.overlay = Some(overlay);
            for (w, h) in [(120, 30), (40, 10), (20, 6), (10, 4), (4, 2)] {
                render(&with_overlay, w, h);
            }
        }
    }

    #[test]
    fn an_empty_queue_says_so() {
        let mut app = App::new();
        app.state = Some(serde_json::from_str(r#"{"suggestions":[]}"#).unwrap());
        assert!(render(&app, 120, 30).contains("nothing to decide"));
        // Before the first fetch lands, it is loading rather than empty.
        assert!(render(&App::new(), 120, 30).contains("reading skills…"));
    }

    /* ------------------------------------------------------------- narrow ---- */

    /// Below the breakpoint only one pane is drawn, and it gets the whole width —
    /// which is the whole point: the slug survives where the split would cut it.
    #[test]
    fn a_narrow_terminal_shows_one_pane_at_full_width() {
        let mut app = app_with_state();
        let list = render(&app, 80, 20);
        assert!(list.contains("Queue (2)"), "{list}");
        assert!(list.contains("approval-is-a-dead-end"), "the slug is not cut: {list}");
        assert!(!list.contains("Context"), "the detail is not drawn: {list}");
        assert!(list.contains("tab detail"), "and the footer says how to reach it: {list}");

        app.focus = Focus::Detail;
        let detail = render(&app, 80, 20);
        assert!(detail.contains("approval-is-a-dead-end"), "the slug titles the pane: {detail}");
        assert!(detail.contains("Context"), "{detail}");
        assert!(!detail.contains("Queue ("), "the queue is not drawn: {detail}");
        assert!(
            keys::hints(Tab::Queue).contains(&("esc", "back")),
            "and there is a way out",
        );
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

    /* ------------------------------------------------------- filter, search ---- */

    #[test]
    fn the_filter_cycles_and_narrows_the_queue() {
        let mut app = app_with_state();
        assert_eq!(app.visible().len(), 2);

        app.filter = Filter::Undecided;
        assert_eq!(app.visible().len(), 1);
        assert_eq!(app.visible()[0].status, "recorded");
        let text = render(&app, 120, 30);
        assert!(text.contains("Queue (1 of 2 · undecided)"), "the title says why: {text}");

        app.filter = app.filter.next();
        assert_eq!(app.filter, Filter::Approved);
        assert_eq!(app.visible().len(), 1);
        assert_eq!(app.visible()[0].status, "approved");

        assert_eq!(app.filter.next(), Filter::All);
    }

    #[test]
    fn search_matches_slug_and_skill_and_is_case_insensitive() {
        let mut app = app_with_state();
        app.query = "DEAD".into();
        assert_eq!(app.visible().len(), 1, "matches the slug regardless of case");

        app.query = "other".into();
        assert_eq!(app.visible().len(), 1, "and matches the skill");
        assert_eq!(app.visible()[0].skill, "other");

        app.query = "zzz".into();
        assert!(app.visible().is_empty());
        let text = render(&app, 120, 30);
        assert!(text.contains("nothing matches"), "it says so, and how to undo it: {text}");
    }

    /// A filter that hides the selected row must not leave the selection past the
    /// end of the list — every later lookup indexes into it.
    #[test]
    fn narrowing_the_queue_clamps_the_selection() {
        let mut app = app_with_state();
        app.sel = 1;
        app.filter = Filter::Approved;
        app.clamp();
        assert_eq!(app.sel, 0);
        assert!(app.selected_id().is_some());
        render(&app, 120, 30);
    }

    #[test]
    fn the_search_line_replaces_the_hints_while_it_is_open() {
        let mut app = app_with_state();
        app.searching = true;
        app.query = "dead".into();
        let text = render(&app, 120, 30);
        assert!(text.contains("/dead"), "{text}");
        assert!(!text.contains("a approve"), "the keys step aside: {text}");
    }
}
