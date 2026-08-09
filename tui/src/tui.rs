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
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Clear, List, ListItem, ListState, Paragraph, Scrollbar, ScrollbarOrientation,
    ScrollbarState, Wrap,
};
use ratatui::Frame;
use std::sync::mpsc;
use std::time::Duration;

use crate::api::{Client, State, Suggestion};
use crate::lifecycle::{
    can_transition, decision_status, is_before_decision, lifecycle, next_statuses, status_abbrev,
    status_spec,
};

const TICK: Duration = Duration::from_millis(250);

/// Under this many columns, a split leaves both panes unreadable, so only the
/// focused one is drawn. 90 is where the list can still hold a skill and a
/// forty-character slug at 45% of the width.
const WIDE: u16 = 90;

/* ------------------------------------------------------------------ theme ---- */

mod theme {
    use ratatui::style::Color;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CURRENT: AtomicUsize = AtomicUsize::new(0);
    pub const NAMES: [&str; 3] = ["dark", "light", "high-contrast"];

    pub fn cycle() {
        let _ = CURRENT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |i| {
            Some((i + 1) % NAMES.len())
        });
    }
    pub fn name() -> &'static str {
        NAMES[i()]
    }
    fn i() -> usize {
        CURRENT.load(Ordering::Relaxed)
    }

    pub fn accent() -> Color {
        [Color::Cyan, Color::Blue, Color::Rgb(0, 255, 255)][i()]
    }
    pub fn dim() -> Color {
        [Color::DarkGray, Color::Gray, Color::Gray][i()]
    }
    pub fn ok() -> Color {
        [Color::Green, Color::Green, Color::Rgb(0, 255, 0)][i()]
    }
    pub fn warn() -> Color {
        [Color::Yellow, Color::Rgb(176, 120, 0), Color::Rgb(255, 255, 0)][i()]
    }
    pub fn err() -> Color {
        [Color::Red, Color::Red, Color::Rgb(255, 80, 80)][i()]
    }
    pub fn selection_bg() -> Color {
        [Color::Rgb(45, 55, 70), Color::Rgb(206, 216, 232), Color::Rgb(70, 70, 70)][i()]
    }
}

fn severity_colour(s: &str) -> Color {
    match s {
        "high" => theme::err(),
        "medium" => theme::warn(),
        "low" => theme::ok(),
        _ => theme::dim(),
    }
}

fn status_colour(s: &str) -> Color {
    status_spec(s).map(|x| tone_colour(&x.tone)).unwrap_or_else(theme::dim)
}

/// One column instead of seven. The word is still spelled out in the detail pane,
/// and the letter survives a terminal with no colour where a bare hue would not.
fn severity_letter(s: &str) -> &'static str {
    match s {
        "high" => "H",
        "medium" => "M",
        "low" => "L",
        _ => "·",
    }
}

/// The spec's tone is semantic so each front end can spend its own palette. A
/// terminal has green and red, so all five land somewhere distinct here.
fn tone_colour(tone: &str) -> Color {
    match tone {
        "accent" => theme::accent(),
        "positive" => theme::ok(),
        "warning" => theme::warn(),
        "negative" => theme::err(),
        _ => theme::dim(),
    }
}

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
}

enum Res {
    State(Result<State, String>),
    /// A one-line result of something the user asked for, good or bad.
    Acted(Result<String, String>),
    Diff(String, Result<Option<String>, String>),
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

enum Overlay {
    Help { scroll: u16 },
    Docs { scroll: u16 },
    Diff { id: String, body: String, scroll: u16 },
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
    query: String,
    searching: bool,
    focus: Focus,
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
            query: String::new(),
            searching: false,
            focus: Focus::Queue,
        }
    }

    /// The queue after the filter and the search. The server's order is kept —
    /// re-ranking here would invent an order the dashboard does not share.
    fn visible(&self) -> Vec<&Suggestion> {
        let Some(state) = self.state.as_ref() else { return Vec::new() };
        let needle = self.query.to_lowercase();
        state
            .queue()
            .into_iter()
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

    fn move_by(&mut self, delta: isize) {
        let len = self.visible().len();
        if len == 0 {
            return;
        }
        let next = (self.sel as isize + delta).clamp(0, len as isize - 1);
        if next as usize != self.sel {
            self.sel = next as usize;
            // A new row is a new document; carrying the old offset lands mid-sentence.
            self.scroll = 0;
        }
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some(Notice { text: text.into(), error });
    }
}

/* -------------------------------------------------------------------- draw ---- */

/// A block title longer than its border is drawn over the corner, so it is cut to
/// fit the area before the block is built rather than after.
fn titled(title: &str, area: Rect, focused: bool) -> Block<'static> {
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
fn badge(label: &str, colour: Color) -> Span<'static> {
    Span::styled(format!("{label}  "), Style::new().fg(colour))
}

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

fn help_lines() -> Vec<Line<'static>> {
    let head = |t: &str| {
        Line::styled(format!("  {t}"), Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD))
    };
    let dim = |t: &str| Line::styled(format!("  {t}"), Style::new().fg(theme::dim()));
    vec![
        head("navigate"),
        Line::raw("    j / k · ↓ ↑    move the queue, or scroll the detail"),
        Line::raw("    J / K          scroll the detail from the queue"),
        Line::raw("    tab            go to the detail, and back"),
        Line::raw("    esc            back to the queue"),
        Line::raw("    pgup / pgdn    jump ten rows"),
        Line::raw(""),
        head("find"),
        Line::raw("    f              filter: all / undecided / approved"),
        Line::raw("    /              search slug and skill · esc clears"),
        Line::raw(""),
        head("decide"),
        Line::raw("    a              approve"),
        Line::raw("    r              reject"),
        Line::raw("    A              approve the whole cluster"),
        Line::raw("    d              show the patch"),
        Line::raw("    enter          apply the patch and commit"),
        Line::raw(""),
        head("other"),
        Line::raw("    D              the lifecycle: phases, statuses, item format"),
        Line::raw("    g  refresh     t  theme     ?  help     q  quit"),
        Line::raw(""),
        head("columns"),
        dim("    score · severity · status · skill · slug"),
        dim("    H high  M medium  L low"),
        // Built from the spec so the legend cannot outlive the vocabulary.
        dim(&format!(
            "    {}",
            lifecycle()
                .statuses
                .iter()
                .map(|s| format!("{} {}", s.abbrev, s.id))
                .collect::<Vec<_>>()
                .join(" · ")
        )),
        Line::raw(""),
        dim("  applying needs a clean tree and a patch on disk"),
    ]
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
        let alias =
            if s.aliases.is_empty() { String::new() } else { format!("  (was {})", s.aliases.join(", ")) };
        out.push(Line::from(vec![
            Span::styled(format!("    {:<4} ", s.abbrev), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("{:<11}", s.id), Style::new().fg(tone_colour(&s.tone))),
            Span::styled(format!("{:<9}", s.phase), Style::new().fg(theme::dim())),
            Span::styled(alias, Style::new().fg(theme::dim())),
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

/// Greedy word wrap with a hanging indent, in characters rather than bytes.
fn wrapped(text: &str, indent: &str, width: usize) -> Vec<String> {
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

fn draw_overlay(frame: &mut Frame, area: Rect, overlay: &Overlay) {
    // Size first: the docs wrap their own prose and need to know how wide the box
    // will be. `min` after the clamp — on a terminal narrower than the floor the
    // box would otherwise be wider than the screen and the centring underflows.
    let w = area.width.saturating_sub(8).clamp(20, 120).min(area.width);
    let h = area.height.saturating_sub(4).max(6).min(area.height);
    let box_area = Rect::new((area.width - w) / 2, (area.height - h) / 2, w, h);
    let inner_w = w.saturating_sub(2) as usize;

    let (title, body, scroll) = match overlay {
        Overlay::Help { scroll } => ("kaizen — keys".to_string(), help_lines(), *scroll),
        Overlay::Docs { scroll } => {
            ("kaizen — lifecycle".to_string(), docs_lines(inner_w), *scroll)
        }
        Overlay::Diff { id, body, scroll } => (
            format!("patch — {}", short(id)),
            body.lines()
                .map(|l| {
                    let colour = match l.chars().next() {
                        Some('+') if !l.starts_with("+++") => theme::ok(),
                        Some('-') if !l.starts_with("---") => theme::err(),
                        Some('@') => theme::accent(),
                        _ => theme::dim(),
                    };
                    Line::styled(l.to_string(), Style::new().fg(colour))
                })
                .collect(),
            *scroll,
        ),
    };

    frame.render_widget(Clear, box_area);
    frame.render_widget(
        Paragraph::new(body).wrap(Wrap { trim: false }).scroll((scroll, 0)).block(titled(
            &title, box_area, true,
        )),
        box_area,
    );
}

fn draw(frame: &mut Frame, app: &App, base: &str) {
    let [header, body, footer] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0), Constraint::Length(1)])
            .areas(frame.area());
    let width = frame.area().width as usize;
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
    let live = if app.live { "● live " } else { "○ polling " };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" kaizen ", Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD)),
            Span::styled(live, Style::new().fg(if app.live { theme::ok() } else { theme::dim() })),
            Span::styled(
                fit_parts(&parts, width.saturating_sub(8 + live.len() + 1)),
                Style::new().fg(theme::dim()),
            ),
        ])),
        header,
    );

    if let Some(err) = &app.error {
        frame.render_widget(
            Paragraph::new(format!("\n  {err}\n\n  Is the server running?  kaizen serve"))
                .wrap(Wrap { trim: false })
                .style(Style::new().fg(theme::err()))
                .block(titled("cannot read state", body, false)),
            body,
        );
    } else if wide {
        let [list, detail] =
            Layout::horizontal([Constraint::Percentage(45), Constraint::Min(30)]).areas(body);
        draw_queue(frame, list, app, focus == Focus::Queue);
        draw_detail(frame, detail, app, focus == Focus::Detail);
    } else if focus == Focus::Detail {
        draw_detail(frame, body, app, true);
    } else {
        draw_queue(frame, body, app, true);
    }

    draw_footer(frame, footer, app, base, wide, focus);

    if let Some(overlay) = &app.overlay {
        draw_overlay(frame, frame.area(), overlay);
    }
}

fn draw_footer(frame: &mut Frame, footer: Rect, app: &App, base: &str, wide: bool, focus: Focus) {
    // Two paragraphs side by side, not one with a bottom-titled block: on a
    // one-row area the block's title row *is* its only row, so the title paints
    // over the hint and the inner area has zero height.
    let meta = format!("{base} [{}] ", theme::name());
    let meta_w = meta.chars().count() + 1;
    // The keys are the point of the footer and the base URL is not, so the URL
    // only gets its corner once the keys have a workable row — and never while a
    // refusal or the search line is using it.
    let show_meta = app.notice.is_none()
        && !app.searching
        && footer.width as usize >= meta_w + 60;
    let hint_w = footer.width as usize - if show_meta { meta_w } else { 0 };

    let (text, colour) = if app.searching {
        (format!(" /{}▏", app.query), theme::accent())
    } else if let Some(n) = &app.notice {
        (format!(" {}", truncate(&n.text, hint_w.saturating_sub(1))), if n.error {
            theme::err()
        } else {
            theme::ok()
        })
    } else {
        let keys: &[(&str, &str)] = match (focus, wide) {
            (Focus::Detail, false) => &[
                ("j/k", "scroll"),
                ("esc", "back"),
                ("a", "approve"),
                ("r", "reject"),
                ("enter", "apply"),
                ("d", "diff"),
                ("?", "help"),
            ],
            (Focus::Detail, true) => &[
                ("j/k", "scroll"),
                ("tab", "queue"),
                ("a", "approve"),
                ("r", "reject"),
                ("enter", "apply"),
                ("d", "diff"),
                ("?", "help"),
            ],
            (Focus::Queue, _) => &[
                ("j/k", "move"),
                ("tab", "detail"),
                ("a", "approve"),
                ("r", "reject"),
                ("A", "cluster"),
                ("enter", "apply"),
                ("d", "diff"),
                ("f", "filter"),
                ("/", "search"),
                ("?", "help"),
            ],
        };
        let parts: Vec<String> = keys.iter().map(|(k, v)| format!("{k} {v}")).collect();
        (format!(" {}", fit_parts(&parts, hint_w.saturating_sub(1))), theme::dim())
    };

    let [hint_area, meta_area] = Layout::horizontal([
        Constraint::Min(0),
        Constraint::Length(if show_meta { meta_w as u16 } else { 0 }),
    ])
    .areas(footer);
    frame.render_widget(Paragraph::new(text).style(Style::new().fg(colour)), hint_area);
    if show_meta {
        frame.render_widget(
            Paragraph::new(meta).style(Style::new().fg(theme::dim())).right_aligned(),
            meta_area,
        );
    }
}

/* --------------------------------------------------------------- utilities ---- */

fn truncate(s: &str, max: usize) -> String {
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
fn fit_parts(parts: &[String], max: usize) -> String {
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
    let result = run(&mut terminal, &mut app, &base, &req_tx, &res_rx, &ev_rx);
    ratatui::restore();
    result
}

fn run(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
    base: &str,
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
            }
        }

        terminal.draw(|frame| draw(frame, app, base))?;

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
                    Overlay::Help { scroll }
                    | Overlay::Docs { scroll }
                    | Overlay::Diff { scroll, .. } => scroll,
                }
            }
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => app.overlay = None,
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
        match key.code {
            KeyCode::Char('q') => return Ok(()),
            // Esc is "back" while the detail has focus and "quit" only from the
            // queue, so the narrow layout has a way out that is not also an exit.
            KeyCode::Esc => match app.focus {
                Focus::Detail => app.focus = Focus::Queue,
                Focus::Queue => return Ok(()),
            },
            KeyCode::Tab | KeyCode::BackTab => {
                app.focus = match app.focus {
                    Focus::Queue => Focus::Detail,
                    Focus::Detail => Focus::Queue,
                }
            }
            KeyCode::Char('j') | KeyCode::Down => match app.focus {
                Focus::Queue => app.move_by(1),
                Focus::Detail => app.scroll = app.scroll.saturating_add(1),
            },
            KeyCode::Char('k') | KeyCode::Up => match app.focus {
                Focus::Queue => app.move_by(-1),
                Focus::Detail => app.scroll = app.scroll.saturating_sub(1),
            },
            KeyCode::PageDown => match app.focus {
                Focus::Queue => app.move_by(10),
                Focus::Detail => app.scroll = app.scroll.saturating_add(10),
            },
            KeyCode::PageUp => match app.focus {
                Focus::Queue => app.move_by(-10),
                Focus::Detail => app.scroll = app.scroll.saturating_sub(10),
            },
            KeyCode::Char('J') => app.scroll = app.scroll.saturating_add(3),
            KeyCode::Char('K') => app.scroll = app.scroll.saturating_sub(3),
            KeyCode::Char('f') => {
                app.filter = app.filter.next();
                app.focus = Focus::Queue;
                app.sel = 0;
                app.scroll = 0;
            }
            KeyCode::Char('/') => {
                app.searching = true;
                app.focus = Focus::Queue;
            }
            KeyCode::Char('t') => theme::cycle(),
            KeyCode::Char('?') => app.overlay = Some(Overlay::Help { scroll: 0 }),
            // `d` is the patch; `D` is the model the patch is moving through.
            KeyCode::Char('D') => app.overlay = Some(Overlay::Docs { scroll: 0 }),
            KeyCode::Char('g') => {
                app.busy = true;
                let _ = req.send(Req::Refresh);
            }
            KeyCode::Char('a') | KeyCode::Char('r') => {
                let status = if key.code == KeyCode::Char('a') { "approved" } else { "rejected" };
                // Checked here as well as on the server. The round trip would
                // refuse it anyway, but a key that silently does nothing until a
                // 409 comes back reads as a broken TUI rather than as a
                // suggestion that still needs a plan behind it.
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
            KeyCode::Char('A') => match app.selected_cluster() {
                Some(id) => {
                    app.busy = true;
                    let _ = req.send(Req::SetCluster { id, status: "approved".into() });
                }
                None => app.say("this suggestion is not in a cluster", true),
            },
            KeyCode::Char('d') => {
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::Diff { id });
                }
            }
            KeyCode::Enter => {
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::Apply { id });
                }
            }
            _ => {}
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
                  "severity": "low", "status": "new", "score": 5, "surfaced": true }
              ],
              "clusters": [
                { "id": "origin-local-remote", "size": 9, "incidents": 27,
                  "spanDays": 70, "promoted": true }
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
        terminal.draw(|frame| draw(frame, app, "http://127.0.0.1:7777")).unwrap();
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
        for part in ["9 members", "27 incidents", "70 days", "promoted"] {
            assert!(text.contains(part), "cluster summary missing {part:?}: {text}");
        }
        assert!(text.contains("2 open"), "header carries the metrics");
        assert!(!text.contains("1 promoted clusters"), "singular, not '1 clusters': {text}");
        // The footer is easy to lose to a layout mistake and hard to notice.
        assert!(text.contains("a approve"), "key hints render: {text}");
        assert!(text.contains("http://127.0.0.1:7777"), "and the base URL still fits");
    }

    /// The columns that read the same on every row are one character each, and the
    /// selected row is marked as well as highlighted.
    #[test]
    fn rows_spend_their_width_on_the_slug() {
        let text = render(&app_with_state(), 120, 30);
        assert!(text.contains("▸  42 H apr"), "marker, score, severity, status: {text}");
        // The second row's file says `new`, which the spec lists as an alias of
        // `recorded` — so it draws as `rec`. A row shows the status the model
        // has, not the word that happened to be written before the rename.
        assert!(text.contains("   5 L rec"), "a legacy status renders canonically: {text}");
        assert!(!text.contains("medium   approved"), "the spelled-out columns are gone: {text}");
    }

    /// The key has to refuse locally rather than fire and wait for a 409. Both
    /// rows in the fixture are pre-decision, so neither can be approved directly.
    #[test]
    fn approving_is_only_offered_where_the_model_allows_it() {
        assert!(!can_transition("recorded", "approved"), "a bare capture is not approvable");
        assert!(!can_transition("new", "approved"), "nor is it under its old name");
        assert!(can_transition("planned", "approved"), "a plan can be approved");
        assert!(can_transition("proposed", "approved"), "including under its old name");
        assert!(can_transition("recorded", "rejected"), "but anything can be rejected early");
        assert!(!can_transition("verified", "planned"), "and nothing follows a terminal");

        // The message names where it can actually go, which is the whole point.
        assert_eq!(next_statuses("recorded"), ["triaged", "rejected", "superseded"]);
        assert!(next_statuses("verified").is_empty());
    }

    /// Every abbreviation and colour in the list comes from `lifecycle.json`, so
    /// a status the spec does not know must degrade rather than render blank.
    #[test]
    fn statuses_resolve_through_the_spec_including_aliases() {
        assert_eq!(status_abbrev("recorded"), "rec");
        assert_eq!(status_abbrev("new"), "rec", "the old name maps to the new status");
        assert_eq!(status_abbrev("proposed"), "pln");
        assert_eq!(status_abbrev("verified"), "ver");
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

    #[test]
    fn the_docs_overlay_opens_on_the_phases() {
        let mut app = app_with_state();
        app.overlay = Some(Overlay::Docs { scroll: 0 });
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
        app.overlay = Some(Overlay::Help { scroll: 0 });
        assert!(render(&app, 100, 16).contains("navigate"));
        app.overlay = Some(Overlay::Help { scroll: 20 });
        let text = render(&app, 100, 16);
        assert!(text.contains("columns"), "the legend is reachable: {text}");
        assert!(!text.contains("navigate"), "the top scrolled away: {text}");
    }

    #[test]
    fn draws_at_awkward_sizes_without_panicking() {
        let app = app_with_state();
        for (w, h) in [(200, 60), (120, 30), (89, 24), (80, 24), (40, 10), (20, 6), (10, 4), (4, 2)] {
            render(&app, w, h);
        }
        for overlay in [Overlay::Help { scroll: 0 }, Overlay::Diff {
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
        assert!(detail.contains("esc back"), "and there is a way out: {detail}");
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
        assert_eq!(app.visible()[0].status, "new");
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
