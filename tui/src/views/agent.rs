//! The agents: every run the server has going — codex doing, claude
//! checking — and who waits for a seat.
//!
//! One row per run — spinner, what it is on, pid, age — live ones first, then
//! the last few that ended with how they ended. Under them, the line, in order.
//! Progress mid-run arrives through the file watcher like every other edit;
//! `~/.claude/kaizen/dispatch.log` is where a run explains itself.

use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::api::{Dispatch, Run};
use crate::theme;
use crate::ui::{short, titled};

/// The columns, and what they mean. Same contract as the sibling views: the
/// help card explains the screen from this list alone.
pub const COLUMNS: &[(&str, &str)] = &[
    ("agent", "one run — who has the seat, spinner while it goes, what it is on, its pid and age; ended runs stay a while with their exit code"),
    ("line", "who waits for a seat, in order; dispatch.maxAgents in settings is how many run at once, and a backlog run always runs alone"),
];

/// "3s", "4m", "2h 10m" — the resolution a glance needs, not a stopwatch.
fn age(started_ms: u64) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(started_ms);
    let s = now_ms.saturating_sub(started_ms) / 1000;
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else {
        format!("{}h {}m", s / 3600, (s % 3600) / 60)
    }
}

fn target(id: Option<&str>) -> String {
    match id {
        Some(id) => short(id),
        None => "the backlog".to_string(),
    }
}

/// "codex · " in front of what the run is on — or nothing, for a run adopted
/// across a restart from a record that never said who.
fn who(r: &Run) -> String {
    if r.runner.is_empty() {
        String::new()
    } else {
        format!("{} · ", r.runner)
    }
}

fn run_line(r: &Run, spin: char) -> Line<'static> {
    if r.running {
        let mut spans = vec![
            Span::styled(format!("{spin} "), Style::new().fg(theme::accent())),
            Span::styled(who(r), Style::new().fg(theme::accent())),
            Span::raw(format!("{} · pid {}", target(r.id.as_deref()), r.pid)),
        ];
        if let Some(at) = r.started_at {
            spans.push(Span::styled(format!(" · up {}", age(at)), Style::new().fg(theme::dim())));
        }
        return Line::from(spans);
    }
    // `None` is a run adopted across a restart, whose code nobody saw.
    let (word, colour) = match r.exit_code {
        Some(0) => ("done".to_string(), theme::ok()),
        Some(code) => (format!("exit {code}"), theme::err()),
        None => ("ended".to_string(), theme::dim()),
    };
    Line::from(vec![
        Span::styled("  ", Style::new()),
        Span::styled(who(r), Style::new().fg(theme::dim())),
        Span::styled(target(r.id.as_deref()), Style::new().fg(theme::dim())),
        Span::styled(format!(" · {word}"), Style::new().fg(colour)),
        Span::styled(format!(" · pid {}", r.pid), Style::new().fg(theme::dim())),
    ])
}

pub fn draw(frame: &mut Frame, area: Rect, dispatch: Option<&Dispatch>, spin: char) {
    let (runs, queue): (Vec<&Run>, &[Option<String>]) = match dispatch {
        Some(d) => (d.runs.iter().collect(), &d.queue),
        None => (Vec::new(), &[]),
    };
    let live = runs.iter().filter(|r| r.running).count();
    let [top, bottom] = Layout::vertical([Constraint::Min(3), Constraint::Length(3 + queue.len().min(8) as u16)])
        .areas(area);

    // Live first, newest of those first; then the ended ones, newest first.
    let mut lines: Vec<Line> = runs
        .iter()
        .rev()
        .filter(|r| r.running)
        .chain(runs.iter().rev().filter(|r| !r.running))
        .map(|r| run_line(r, spin))
        .collect();
    if lines.is_empty() {
        lines.push(Line::styled(
            "idle — a on a board card sends a run at it, A at the backlog",
            Style::new().fg(theme::dim()),
        ));
    }
    let title = match live {
        0 => "agents — none running".to_string(),
        1 => "agents — 1 running".to_string(),
        n => format!("agents — {n} running"),
    };
    frame.render_widget(Paragraph::new(lines).block(titled(&title, top, true)), top);

    let line: Vec<Line> = if queue.is_empty() {
        vec![Line::styled("nobody waiting", Style::new().fg(theme::dim()))]
    } else {
        queue
            .iter()
            .enumerate()
            .map(|(i, id)| Line::raw(format!("{:>2}  {}", i + 1, target(id.as_deref()))))
            .collect()
    };
    frame.render_widget(
        Paragraph::new(line).block(titled(&format!("in line ({})", queue.len()), bottom, false)),
        bottom,
    );
}
