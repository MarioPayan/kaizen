//! The config, editable, plus the guards as they actually are.
//!
//! The rows are derived from the JSON rather than hand-listed, so a key the
//! config grows shows up here without anyone remembering to add it — and one it
//! loses stops being offered. Editing writes back into the same JSON, which is
//! what gets POSTed, so nothing this view does not understand is dropped on save.
//!
//! The guard block is read-only and is the reason the tab is worth opening even
//! when you are not changing anything: those are facts about this machine right
//! now, and a guard someone switched off still reads as "on" in every prose
//! description of the tool.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;
use serde_json::Value;

use crate::theme;
use crate::ui::titled;

/// Not columns so much as the marks a value can take. Same idea: nobody guesses
/// what `×` against a word means.
pub const COLUMNS: &[(&str, &str)] = &[
    ("on / OFF", "a switch — OFF is loud because a guard someone turned off matters"),
    ("× / ·", "in or out of the list on the left"),
    ("always", "not configurable; shown so the guard list is the whole list"),
    ("● unsaved", "edits are held here until s sends them"),
];

/// What a row does when you press space.
#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    /// Flips.
    Toggle(bool),
    /// Steps to the next of a closed set.
    Choice(&'static [&'static str], String),
    /// Steps by one, clamped — every number in this config is small and bounded.
    Number(i64, i64, i64),
    /// In or out of a list.
    Member(bool),
    /// Read-only: a fact, not a setting.
    Fact(String),
}

#[derive(Debug, Clone)]
pub struct Row {
    /// Dotted path into the config JSON. `""` for a heading or a fact.
    pub path: String,
    pub label: String,
    pub kind: Kind,
    pub heading: bool,
    pub help: &'static str,
}

const TYPES: &[&str] = &["determinism", "structural", "behavioral", "content", "tooling", "hygiene"];
const OBJECTIVES: &[&str] = &["bug", "guardrail", "feature", "performance", "clarity", "debt"];
const SEVERITIES: &[&str] = &["low", "medium", "high"];

/// A sub-label inside a section: not landable, not a value, just a divider with
/// a name. Cheaper than a second heading level nobody would style differently.
fn heading(label: &str) -> Row {
    Row { path: String::new(), label: label.into(), kind: Kind::Fact(String::new()), heading: true, help: "" }
}

fn fact(label: &str, value: String, help: &'static str) -> Row {
    Row { path: String::new(), label: label.into(), kind: Kind::Fact(value), heading: false, help }
}

fn get<'a>(cfg: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(cfg, |v, k| v.get(k))
}

/// Write a value at a dotted path, creating objects on the way down.
pub fn set(cfg: &mut Value, path: &str, next: Value) {
    let keys: Vec<&str> = path.split('.').collect();
    let mut cur = cfg;
    for k in &keys[..keys.len() - 1] {
        if !cur.get(*k).map(Value::is_object).unwrap_or(false) {
            cur[*k] = Value::Object(Default::default());
        }
        cur = cur.get_mut(*k).unwrap();
    }
    cur[keys[keys.len() - 1]] = next;
}

/// Every row the tab shows, in order, derived from the config itself.
pub fn rows(cfg: &Value) -> Vec<Row> {
    let b = |p: &str| get(cfg, p).and_then(Value::as_bool).unwrap_or(false);
    let n = |p: &str| get(cfg, p).and_then(Value::as_i64).unwrap_or(0);
    let s = |p: &str| get(cfg, p).and_then(Value::as_str).unwrap_or("").to_string();
    let has = |p: &str, v: &str| {
        get(cfg, p)
            .and_then(Value::as_array)
            .map(|a| a.iter().any(|x| x.as_str() == Some(v)))
            .unwrap_or(false)
    };

    let mut out = vec![heading("targets")];
    if let Some(targets) = get(cfg, "targets").and_then(Value::as_array) {
        for (i, t) in targets.iter().enumerate() {
            let name = t.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
            out.push(fact(&name, t.get("skills").and_then(Value::as_str).unwrap_or("").into(), ""));
            out.push(fact("", t.get("feedback").and_then(Value::as_str).unwrap_or("").into(), ""));
            out.push(Row {
                path: format!("targets.{i}.writable"),
                label: "  writable".into(),
                kind: Kind::Toggle(t.get("writable").and_then(Value::as_bool).unwrap_or(false)),
                heading: false,
                help: "read-only targets refuse every apply, before git runs",
            });
        }
    }

    out.push(heading("guards"));
    out.push(Row {
        path: "applyGuards.requireCleanTree".into(),
        label: "clean tree required".into(),
        kind: Kind::Toggle(b("applyGuards.requireCleanTree")),
        heading: false,
        help: "on means a patch refuses when its own files carry uncommitted work; off lets a fix land on top of it, and revert stops being one command",
    });
    out.push(Row {
        path: "applyGuards.requireDiffApplies".into(),
        label: "patch must apply".into(),
        kind: Kind::Toggle(b("applyGuards.requireDiffApplies")),
        heading: false,
        help: "off means a stale patch can half-land instead of failing whole",
    });
    out.push(fact("applied cannot be faked", "always".into(), "only the server writes it, after git returned a sha"));
    out.push(fact("loopback only", "always".into(), "the socket refuses anything but 127.0.0.1"));

    out.push(heading("what you want to see"));
    out.push(fact("  change types", String::new(), ""));
    for ty in TYPES {
        out.push(Row {
            path: format!("surface.types.{ty}"),
            label: format!("  {ty}"),
            kind: Kind::Member(has("surface.types", ty)),
            heading: false,
            help: "",
        });
    }
    out.push(fact("  objectives", String::new(), ""));
    for ob in OBJECTIVES {
        out.push(Row {
            path: format!("surface.objectives.{ob}"),
            label: format!("  {ob}"),
            kind: Kind::Member(has("surface.objectives", ob)),
            heading: false,
            help: "",
        });
    }
    out.push(Row {
        path: "surface.minSeverity".into(),
        label: "at least".into(),
        kind: Kind::Choice(SEVERITIES, s("surface.minSeverity")),
        heading: false,
        help: "untriaged suggestions are never hidden, whatever this says",
    });

    out.push(heading("dispatch"));
    out.push(Row {
        path: "dispatch.maxAgents".into(),
        label: "max agents".into(),
        kind: Kind::Number(n("dispatch.maxAgents").max(1), 1, 8),
        heading: false,
        help: "fenced runs at once; the rest wait in line, and a backlog run always runs alone",
    });
    out.push(Row {
        path: "dispatch.auto".into(),
        label: "auto".into(),
        kind: Kind::Toggle(b("dispatch.auto")),
        heading: false,
        help: "send the runners at new arrivals on their own — every run is a model call; off means you press a",
    });
    // Read-only here: a model name is a string nobody wants to step through
    // one character at a time. Edit the JSON for these.
    out.push(fact("opencode", s("dispatch.models.opencode"), "does the work — triage, plan, review; the ChatGPT subscription's model"));
    out.push(fact("claude", s("dispatch.models.claude"), "checks it — every status opencode writes, and the verify at the end"));

    out.push(heading("scan"));
    out.push(Row {
        path: "scan.enabled".into(),
        label: "scan projects".into(),
        kind: Kind::Toggle(b("scan.enabled")),
        heading: false,
        help: "look for .claude/skills inside repositories; always read-only",
    });
    out.push(Row {
        path: "scan.depth".into(),
        label: "depth".into(),
        kind: Kind::Number(n("scan.depth"), 1, 6),
        heading: false,
        help: "",
    });
    for (i, root) in get(cfg, "scan.roots").and_then(Value::as_array).unwrap_or(&vec![]).iter().enumerate() {
        out.push(fact(&format!("  root {}", i + 1), root.as_str().unwrap_or("").into(), ""));
    }

    out.push(heading("other"));
    out.push(Row {
        path: "cadence.sessionHook".into(),
        label: "session line".into(),
        kind: Kind::Toggle(b("cadence.sessionHook")),
        heading: false,
        help: "one line per session — untriaged count and the busiest skill",
    });
    out.push(Row {
        path: "asks.enabled".into(),
        label: "watch asks".into(),
        kind: Kind::Toggle(b("asks.enabled")),
        heading: false,
        help: "weekly pass reads your prompt log for asks you keep repeating; off by default",
    });
    out.push(fact("weekly pass", s("cadence.weekly"), ""));
    out.push(fact("api", format!("{}:{}", s("server.host"), n("server.port")), ""));

    out
}

/// Apply a row's edit to the config. Returns false when the row is a fact.
pub fn apply(cfg: &mut Value, row: &Row) -> bool {
    match &row.kind {
        Kind::Fact(_) => false,
        Kind::Toggle(on) => {
            set(cfg, &row.path, Value::Bool(!on));
            true
        }
        Kind::Number(v, lo, hi) => {
            // Wraps rather than sticking: the ranges are short and a value stuck
            // at the top with no way back is worse than a wrap you can undo.
            let next = if *v >= *hi { *lo } else { v + 1 };
            set(cfg, &row.path, Value::from(next));
            true
        }
        Kind::Choice(options, current) => {
            let i = options.iter().position(|o| o == current).unwrap_or(0);
            set(cfg, &row.path, Value::from(options[(i + 1) % options.len()]));
            true
        }
        Kind::Member(inside) => {
            // `surface.types.determinism` is a membership row, not a real path:
            // the list is the parent and the leaf is the value.
            let (list, item) = row.path.rsplit_once('.').unwrap();
            let mut values: Vec<Value> = get(cfg, list)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|v| v.as_str() != Some(item))
                .collect();
            if !inside {
                values.push(Value::from(item));
            }
            set(cfg, list, Value::Array(values));
            true
        }
    }
}

/// Rows you can land on. Headings and facts are skipped by the cursor, because
/// stopping on something you cannot change is a keypress that does nothing.
pub fn editable(rows: &[Row]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| !r.heading && !matches!(r.kind, Kind::Fact(_)))
        .map(|(i, _)| i)
        .collect()
}

fn render(row: &Row, selected: bool) -> ListItem<'static> {
    if row.heading {
        return ListItem::new(Line::styled(
            format!("  {}", row.label),
            Style::new().fg(theme::accent()).add_modifier(Modifier::BOLD),
        ));
    }
    let (value, tone) = match &row.kind {
        Kind::Toggle(true) => ("on".to_string(), theme::ok()),
        Kind::Toggle(false) => ("OFF".to_string(), theme::err()),
        Kind::Member(true) => ("×".to_string(), theme::ok()),
        Kind::Member(false) => ("·".to_string(), theme::dim()),
        Kind::Number(v, _, _) => (v.to_string(), theme::accent()),
        Kind::Choice(_, v) => (v.clone(), theme::accent()),
        Kind::Fact(v) => (v.clone(), theme::dim()),
    };
    let mut spans = vec![
        Span::styled(format!("    {:<26}", row.label), Style::new()),
        Span::styled(format!("{value:<10}"), Style::new().fg(tone)),
    ];
    // The reason is shown only for the row you are on: all of them at once is a
    // wall, none of them is a mystery.
    if selected && !row.help.is_empty() {
        spans.push(Span::styled(row.help.to_string(), Style::new().fg(theme::dim())));
    }
    ListItem::new(Line::from(spans))
}

pub fn draw(frame: &mut Frame, area: Rect, cfg: Option<&Value>, dirty: bool, errors: &[String], sel: usize) {
    let title = match (cfg.is_some(), dirty) {
        (false, _) => "Settings".to_string(),
        (true, true) => "Settings ● unsaved — s saves".to_string(),
        (true, false) => "Settings".to_string(),
    };
    let outer = titled(&title, area, true);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    let Some(cfg) = cfg else {
        frame.render_widget(
            Paragraph::new("reading config…").style(Style::new().fg(theme::dim())),
            inner,
        );
        return;
    };

    let all = rows(cfg);
    let landable = editable(&all);
    let cursor = landable.get(sel).copied();
    let mut items: Vec<ListItem> = all
        .iter()
        .enumerate()
        .map(|(i, r)| render(r, Some(i) == cursor))
        .collect();

    if !errors.is_empty() {
        items.push(ListItem::new(Line::raw("")));
        for e in errors {
            items.push(ListItem::new(Line::styled(
                format!("  {e}"),
                Style::new().fg(theme::err()),
            )));
        }
    }

    let mut state = ListState::default().with_selected(cursor);
    frame.render_stateful_widget(
        List::new(items)
            .highlight_style(Style::new().bg(theme::selection_bg()))
            .scroll_padding(3),
        inner,
        &mut state,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg() -> Value {
        json!({
            "targets": [{ "name": "user", "skills": "/s", "feedback": "/f", "writable": true }],
            "applyGuards": { "requireCleanTree": true, "requireDiffApplies": false },
            "surface": { "types": ["determinism"], "objectives": [], "minSeverity": "low" },
            "scan": { "enabled": false, "roots": [], "depth": 3 },
            "cadence": { "weekly": "SUN 09:00", "sessionHook": true },
            "server": { "host": "127.0.0.1", "port": 7777 }
        })
    }

    fn row_for(c: &Value, path: &str) -> Row {
        rows(c).into_iter().find(|r| r.path == path).expect(path)
    }

    #[test]
    fn a_toggle_flips_and_writes_back_to_the_json() {
        let mut c = cfg();
        let r = row_for(&c, "applyGuards.requireDiffApplies");
        assert_eq!(r.kind, Kind::Toggle(false));
        assert!(apply(&mut c, &r));
        assert_eq!(c["applyGuards"]["requireDiffApplies"], json!(true));
    }

    #[test]
    fn a_number_steps_and_wraps_rather_than_sticking() {
        let mut c = cfg();
        // Wraps at the top: a value stuck with no way back is worse than a wrap
        // you can go round again.
        set(&mut c, "scan.depth", json!(6));
        let r = row_for(&c, "scan.depth");
        apply(&mut c, &r);
        assert_eq!(c["scan"]["depth"], json!(1));
        let r = row_for(&c, "scan.depth");
        apply(&mut c, &r);
        assert_eq!(c["scan"]["depth"], json!(2));
    }

    #[test]
    fn a_choice_cycles_through_its_closed_set() {
        let mut c = cfg();
        for expected in ["medium", "high", "low"] {
            let r = row_for(&c, "surface.minSeverity");
            apply(&mut c, &r);
            assert_eq!(c["surface"]["minSeverity"], json!(expected));
        }
    }

    /// The membership rows are the fiddly ones: the path names an item inside a
    /// list, not a key, so the write has to rebuild the array.
    #[test]
    fn membership_adds_and_removes_without_disturbing_the_rest() {
        let mut c = cfg();
        let r = row_for(&c, "surface.types.structural");
        apply(&mut c, &r);
        let types = c["surface"]["types"].as_array().unwrap().clone();
        assert!(types.contains(&json!("determinism")), "the existing one survives");
        assert!(types.contains(&json!("structural")));

        let r = row_for(&c, "surface.types.determinism");
        apply(&mut c, &r);
        let types = c["surface"]["types"].as_array().unwrap();
        assert!(!types.contains(&json!("determinism")));
        assert_eq!(types.len(), 1);
    }

    #[test]
    fn a_fact_is_not_editable_and_the_cursor_skips_it() {
        let mut c = cfg();
        let all = rows(&c);
        let a_fact = all.iter().find(|r| matches!(r.kind, Kind::Fact(_))).cloned().expect("a fact");
        assert!(!apply(&mut c, &a_fact), "applying one changes nothing");

        // Nothing landable is a heading or a fact, so every keypress does something.
        for i in editable(&all) {
            assert!(!all[i].heading);
            assert!(!matches!(all[i].kind, Kind::Fact(_)));
        }
    }

    #[test]
    fn rows_follow_the_config_rather_than_a_hand_written_list() {
        // A target added to the JSON grows a row without anyone editing this file.
        let mut c = cfg();
        let before = rows(&c).len();
        c["targets"].as_array_mut().unwrap().push(json!({
            "name": "project", "skills": "/p", "feedback": "/pf", "writable": false
        }));
        assert!(rows(&c).len() > before);
        assert_eq!(row_for(&c, "targets.1.writable").kind, Kind::Toggle(false));
    }

    /// Auto-dispatch is a toggle like any guard: off by default, and a press
    /// writes `dispatch.auto` into the JSON the server validates.
    #[test]
    fn auto_dispatch_is_a_toggle_off_by_default() {
        let mut c = cfg();
        assert_eq!(row_for(&c, "dispatch.auto").kind, Kind::Toggle(false));
        let row = row_for(&c, "dispatch.auto");
        apply(&mut c, &row);
        assert_eq!(c["dispatch"]["auto"], json!(true));
    }

    #[test]
    fn set_creates_the_objects_it_needs() {
        let mut c = json!({});
        set(&mut c, "a.b.c", json!(1));
        assert_eq!(c["a"]["b"]["c"], json!(1));
    }
}
