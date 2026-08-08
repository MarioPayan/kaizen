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

const TICK: Duration = Duration::from_millis(250);

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
    match s {
        "new" => theme::accent(),
        "proposed" => theme::warn(),
        "approved" => theme::ok(),
        "rejected" | "superseded" | "applied" => theme::dim(),
        _ => theme::dim(),
    }
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

/* ------------------------------------------------------------------- state ---- */

enum Overlay {
    Help,
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
        }
    }

    fn queue_len(&self) -> usize {
        self.state.as_ref().map(|s| s.queue().len()).unwrap_or(0)
    }

    fn selected_id(&self) -> Option<String> {
        self.state.as_ref()?.queue().get(self.sel).map(|s| s.id.clone())
    }

    fn selected_cluster(&self) -> Option<String> {
        let state = self.state.as_ref()?;
        let pin = state.queue().get(self.sel)?.cluster_pin.clone();
        (!pin.is_empty()).then_some(pin)
    }

    fn move_by(&mut self, delta: isize) {
        let len = self.queue_len();
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

fn block(title: &str, focused: bool) -> Block<'_> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(if focused { theme::accent() } else { theme::dim() }))
        .title(Span::styled(format!(" {title} "), Style::new().fg(theme::accent())))
}

fn badge(label: &str, colour: Color) -> Span<'static> {
    Span::styled(format!(" {label} "), Style::new().fg(colour))
}

fn draw_queue(frame: &mut Frame, area: Rect, app: &App) {
    let queue = app.state.as_ref().map(|s| s.queue()).unwrap_or_default();
    let title = format!("Queue ({})", queue.len());
    let outer = block(&title, true);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if queue.is_empty() {
        let msg = if app.state.is_none() { "reading skills…" } else { "nothing to decide" };
        frame.render_widget(Paragraph::new(msg).style(Style::new().fg(theme::dim())), inner);
        return;
    }

    // score(5) + severity(7) + status(9) are fixed; skill and slug share what is
    // left, with the slug favoured — it is the column you actually read down. A
    // narrow pane drops the skill entirely rather than shaving both into initials.
    const FIXED: u16 = 21;
    let spare = inner.width.saturating_sub(FIXED) as usize;
    let skill_w = if spare < 28 { 0 } else { (spare / 3).min(18) };
    let slug_w = spare.saturating_sub(skill_w + usize::from(skill_w > 0));

    let items: Vec<ListItem> = queue
        .iter()
        .map(|s| {
            let mut spans = vec![
                Span::styled(format!("{:>4} ", s.score.round() as i64), Style::new().fg(theme::dim())),
                Span::styled(
                    format!("{:<7}", abbreviate(&s.severity)),
                    Style::new().fg(severity_colour(&s.severity)),
                ),
                Span::styled(format!("{:<9}", s.status), Style::new().fg(status_colour(&s.status))),
            ];
            if skill_w > 0 {
                spans.push(Span::styled(
                    format!("{:<width$} ", truncate(&s.skill, skill_w), width = skill_w),
                    Style::new().fg(theme::dim()),
                ));
            }
            // Fall back to the id's tail rather than leaving the row anonymous.
            let name = if s.slug.is_empty() { short(&s.id) } else { s.slug.clone() };
            spans.push(Span::raw(truncate(&name, slug_w)));
            ListItem::new(Line::from(spans))
        })
        .collect();

    let mut list_state = ListState::default().with_selected(Some(app.sel));
    frame.render_stateful_widget(
        List::new(items).highlight_style(Style::new().bg(theme::selection_bg())),
        inner,
        &mut list_state,
    );

    if queue.len() > inner.height as usize {
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight),
            inner,
            &mut ScrollbarState::new(queue.len()).position(app.sel),
        );
    }
}

fn detail_lines(state: &State, s: &Suggestion) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::from(Span::styled(s.id.clone(), Style::new().fg(theme::dim()))),
        Line::from(vec![
            badge(&s.severity, severity_colour(&s.severity)),
            badge(&s.status, status_colour(&s.status)),
            badge(&s.kind, theme::accent()),
            badge(&s.objective, theme::dim()),
            Span::styled(
                format!(
                    " score {} · {} incident{} · rung {}",
                    s.score.round() as i64,
                    s.incidents,
                    if s.incidents == 1 { "" } else { "s" },
                    s.rung.map(|r| r.to_string()).unwrap_or_else(|| "—".into()),
                ),
                Style::new().fg(theme::dim()),
            ),
        ]),
    ];
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
    lines
}

fn draw_detail(frame: &mut Frame, area: Rect, app: &App) {
    let outer = block("Detail", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    let Some(state) = app.state.as_ref() else { return };
    let queue = state.queue();
    let Some(s) = queue.get(app.sel) else { return };

    frame.render_widget(
        Paragraph::new(detail_lines(state, s))
            .wrap(Wrap { trim: false })
            .scroll((app.scroll, 0)),
        inner,
    );
}

fn draw_overlay(frame: &mut Frame, area: Rect, overlay: &Overlay) {
    let (title, body, scroll) = match overlay {
        Overlay::Help => (
            "help".to_string(),
            vec![
                Line::styled("kaizen", Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD)),
                Line::raw(""),
                Line::raw("  j / k · ↓ ↑   move through the queue"),
                Line::raw("  J / K         scroll the detail pane"),
                Line::raw("  a             approve"),
                Line::raw("  r             reject"),
                Line::raw("  A             approve the whole cluster"),
                Line::raw("  enter         apply the patch and commit"),
                Line::raw("  d             show the patch"),
                Line::raw("  g             refresh now"),
                Line::raw("  t             cycle theme"),
                Line::raw("  q / esc       quit"),
                Line::raw(""),
                Line::styled(
                    "  applying needs a clean tree and a patch on disk",
                    Style::new().fg(theme::dim()),
                ),
            ],
            0,
        ),
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

    let w = area.width.saturating_sub(8).clamp(20, 120);
    let h = area.height.saturating_sub(4).max(6);
    let box_area = Rect::new((area.width - w) / 2, (area.height - h) / 2, w, h);
    frame.render_widget(Clear, box_area);
    frame.render_widget(
        Paragraph::new(body).scroll((scroll, 0)).block(block(&title, true)),
        box_area,
    );
}

fn draw(frame: &mut Frame, app: &App, base: &str) {
    let [header, body, footer] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0), Constraint::Length(1)])
            .areas(frame.area());

    let m = app.state.as_ref().map(|s| s.metrics.clone()).unwrap_or_default();
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" kaizen ", Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD)),
            Span::styled(
                if app.live { "● live " } else { "○ polling " },
                Style::new().fg(if app.live { theme::ok() } else { theme::dim() }),
            ),
            Span::styled(
                format!(
                    "{} open · {} untriaged · {} promoted cluster{}{}",
                    m.open,
                    m.untriaged,
                    m.promoted_clusters,
                    if m.promoted_clusters == 1 { "" } else { "s" },
                    if app.busy { " · working…" } else { "" }
                ),
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
                .block(block("cannot read state", false)),
            body,
        );
    } else {
        let [list, detail] =
            Layout::horizontal([Constraint::Percentage(45), Constraint::Min(30)]).areas(body);
        draw_queue(frame, list, app);
        draw_detail(frame, detail, app);
    }

    let hint = match &app.notice {
        Some(n) => n.text.clone(),
        None => "j/k move · a approve · r reject · A cluster · enter apply · d diff · ? help".into(),
    };
    let colour = match &app.notice {
        Some(n) if n.error => theme::err(),
        Some(_) => theme::ok(),
        None => theme::dim(),
    };
    // Two paragraphs side by side, not one with a bottom-titled block: on a
    // one-row area the block's title row *is* its only row, so the title paints
    // over the hint and the inner area has zero height.
    let meta = format!("{base} [{}] ", theme::name());
    let [hint_area, meta_area] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(meta.chars().count() as u16 + 1)])
            .areas(footer);
    frame.render_widget(
        Paragraph::new(format!(" {hint}")).style(Style::new().fg(colour)),
        hint_area,
    );
    frame.render_widget(
        Paragraph::new(meta).style(Style::new().fg(theme::dim())).right_aligned(),
        meta_area,
    );

    if let Some(overlay) = &app.overlay {
        draw_overlay(frame, frame.area(), overlay);
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

/// The severity column is seven wide; `medium` fits and `high`/`low` want padding
/// more than they want shortening.
fn abbreviate(severity: &str) -> &str {
    if severity.is_empty() {
        "—"
    } else {
        severity
    }
}

/* -------------------------------------------------------------------- loop ---- */

pub fn main(base: Option<String>) -> std::io::Result<()> {
    let client = Client::new(base);
    let base = client.base().to_string();

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

    let mut terminal = ratatui::init();
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
                    app.sel = app.sel.min(state.queue().len().saturating_sub(1));
                    app.state = Some(state);
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

        // An overlay captures every key: esc/q closes it, the rest scrolls.
        if let Some(overlay) = app.overlay.as_mut() {
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => app.overlay = None,
                KeyCode::Char('j') | KeyCode::Down => {
                    if let Overlay::Diff { scroll, .. } = overlay {
                        *scroll = scroll.saturating_add(1);
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if let Overlay::Diff { scroll, .. } = overlay {
                        *scroll = scroll.saturating_sub(1);
                    }
                }
                _ => app.overlay = None,
            }
            continue;
        }

        app.notice = None;
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(()),
            KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
            KeyCode::Char('j') | KeyCode::Down => app.move_by(1),
            KeyCode::Char('k') | KeyCode::Up => app.move_by(-1),
            KeyCode::PageDown => app.move_by(10),
            KeyCode::PageUp => app.move_by(-10),
            KeyCode::Char('J') => app.scroll = app.scroll.saturating_add(3),
            KeyCode::Char('K') => app.scroll = app.scroll.saturating_sub(3),
            KeyCode::Char('t') => theme::cycle(),
            KeyCode::Char('?') => app.overlay = Some(Overlay::Help),
            KeyCode::Char('g') => {
                app.busy = true;
                let _ = req.send(Req::Refresh);
            }
            KeyCode::Char('a') | KeyCode::Char('r') => {
                let status = if key.code == KeyCode::Char('a') { "approved" } else { "rejected" };
                if let Some(id) = app.selected_id() {
                    app.busy = true;
                    let _ = req.send(Req::SetStatus { id, status: status.into() });
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
        assert!(text.contains("approval-is-a-dead-end"), "the slug is not squeezed out: {text}");
        // The footer is easy to lose to a layout mistake and hard to notice.
        assert!(text.contains("a approve"), "key hints render: {text}");
        assert!(text.contains("http://127.0.0.1:7777"), "and the base URL still fits");
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

    #[test]
    fn draws_at_awkward_sizes_without_panicking() {
        let app = app_with_state();
        for (w, h) in [(200, 60), (120, 30), (80, 24), (40, 10), (20, 6)] {
            render(&app, w, h);
        }
        let mut with_help = app_with_state();
        with_help.overlay = Some(Overlay::Help);
        for (w, h) in [(120, 30), (40, 10), (20, 6)] {
            render(&with_help, w, h);
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
}
