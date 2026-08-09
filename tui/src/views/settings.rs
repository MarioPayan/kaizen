//! The config, read-only, plus the guards as they actually are.
//!
//! Read-only on purpose. Config is a JSON file and `$EDITOR` is already better
//! at JSON than any form built out of text inputs and multi-selects would be —
//! `e` hands the file to it and the server validates what comes back.
//!
//! The part worth rendering is the guard block. Those are facts about this
//! machine right now, not documentation: a guard someone switched off still
//! reads as "on" in every prose description of the tool, and that is exactly the
//! gap between what a tool claims and what it does.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Wrap};
use ratatui::Frame;

use crate::api::Config;
use crate::theme;
use crate::ui::titled;

fn head(t: &str) -> Line<'static> {
    Line::styled(format!("  {t}"), Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD))
}

fn dim(t: String) -> Line<'static> {
    Line::styled(t, Style::new().fg(theme::dim()))
}

/// A guard and whether it is on, coloured by the answer rather than by the name.
fn guard(name: &str, on: bool, when_on: &str, when_off: &str) -> Vec<Line<'static>> {
    vec![
        Line::from(vec![
            Span::raw(format!("    {name:<26}")),
            Span::styled(
                if on { "on" } else { "OFF" }.to_string(),
                Style::new().fg(if on { theme::ok() } else { theme::err() }).add_modifier(
                    if on { Modifier::empty() } else { Modifier::BOLD },
                ),
            ),
        ]),
        dim(format!("      {}", if on { when_on } else { when_off })),
    ]
}

pub fn lines(config: &Config, errors: &[String]) -> Vec<Line<'static>> {
    let mut out = vec![head("targets")];
    if config.targets.is_empty() {
        out.push(dim("    none configured — run `kaizen init`".into()));
    }
    for t in &config.targets {
        out.push(Line::from(vec![
            Span::styled(format!("    {:<8}", t.name), Style::new().add_modifier(Modifier::BOLD)),
            Span::raw(t.skills.clone()),
            Span::styled(
                if t.writable { "   writable" } else { "   read-only" }.to_string(),
                Style::new().fg(if t.writable { theme::warn() } else { theme::dim() }),
            ),
        ]));
        out.push(dim(format!("    {:<8}{}", "", t.feedback)));
    }
    out.push(Line::raw(""));

    out.push(head("guards"));
    out.push(dim("    what stands between an approval and `git apply`".into()));
    out.extend(guard(
        "clean tree required",
        config.apply_guards.require_clean_tree,
        "applying over uncommitted work is refused, and the refusal names the files",
        "a fix can land on top of uncommitted work, which makes reverting it messy",
    ));
    out.extend(guard(
        "patch must apply",
        config.apply_guards.require_diff_applies,
        "git apply --check runs first, so a stale patch fails whole rather than half",
        "a patch written against an older file may apply badly",
    ));
    // Not configurable, and worth saying so beside the ones that are.
    out.extend(guard(
        "applied cannot be faked",
        true,
        "only the server writes it, and only after git returned a sha",
        "",
    ));
    out.extend(guard("loopback only", true, "the socket refuses anything but 127.0.0.1", ""));
    out.push(Line::raw(""));

    out.push(head("what you asked to see"));
    out.push(dim(format!(
        "    {} types · {} objectives · at least {}",
        config.surface.types.len(),
        config.surface.objectives.len(),
        if config.surface.min_severity.is_empty() { "low" } else { &config.surface.min_severity },
    )));
    out.push(dim(format!("    types       {}", config.surface.types.join(", "))));
    out.push(dim(format!("    objectives  {}", config.surface.objectives.join(", "))));
    out.push(Line::raw(""));

    out.push(head("promotion"));
    out.push(dim(format!(
        "    a cluster is promoted at {} members or {} incidents",
        config.cluster_promotion.members, config.cluster_promotion.incidents,
    )));
    out.push(dim("    a promoted cluster must be fixed at rung 0 or 1 — prose already failed there".into()));
    out.push(Line::raw(""));

    out.push(head("scan"));
    out.push(if config.scan.enabled {
        dim(format!(
            "    {} root(s), depth {}, read-only: {}",
            config.scan.roots.len(),
            config.scan.depth,
            config.scan.roots.join(", "),
        ))
    } else {
        dim("    off — only the configured targets are watched".into())
    });
    out.push(Line::raw(""));

    out.push(head("other"));
    out.push(dim(format!(
        "    weekly pass   {}",
        if config.cadence.weekly.is_empty() { "off" } else { &config.cadence.weekly }
    )));
    out.push(dim(format!(
        "    session line  {}",
        if config.cadence.session_hook { "on" } else { "off" }
    )));
    out.push(dim(format!("    api           {}:{}", config.server.host, config.server.port)));

    if !errors.is_empty() {
        out.push(Line::raw(""));
        out.push(Line::styled(
            "  the server rejects this config".to_string(),
            Style::new().fg(theme::err()).add_modifier(Modifier::BOLD),
        ));
        for e in errors {
            out.push(Line::styled(format!("    {e}"), Style::new().fg(theme::err())));
        }
    }

    out
}

pub fn draw(frame: &mut Frame, area: Rect, config: Option<&Config>, errors: &[String], scroll: u16) {
    let outer = titled("Settings", area, true);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    let body = match config {
        Some(c) => lines(c, errors),
        None => vec![Line::styled("reading config…", Style::new().fg(theme::dim()))],
    };
    frame.render_widget(
        Paragraph::new(body).wrap(Wrap { trim: false }).scroll((scroll, 0)),
        inner,
    );
}
