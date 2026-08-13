//! The lifecycle spec, embedded at compile time.
//!
//! `lifecycle.json` at the repo root is where the phases, statuses and item
//! format are written down once. This crate reads it *directly* rather than
//! through a generated file, which the TypeScript side cannot do — a `.json`
//! import there widens every string and the unions stop being unions. Rust has
//! no such problem, so there is nothing to generate and nothing to keep in step.
//!
//! Embedded rather than fetched: the docs, the status abbreviations and the
//! queue's own filter all have to work before the first request lands, and on a
//! machine where the server is down they are exactly what you want to read.
//!
//! Its own module because both `api` (which decides what is still open) and
//! `tui` (which draws it) need the same answers, and a second copy in either
//! would be the thing this file exists to prevent.

use serde::Deserialize;

const LIFECYCLE_JSON: &str = include_str!("../../lifecycle.json");

#[derive(Debug, Deserialize)]
pub struct Lifecycle {
    pub phases: Vec<PhaseSpec>,
    pub statuses: Vec<StatusSpec>,
    pub fields: Vec<FieldSpec>,
}

#[derive(Debug, Deserialize)]
pub struct PhaseSpec {
    pub id: String,
    pub title: String,
    pub actor: String,
    pub produces: String,
    pub attended: bool,
    pub summary: String,
    #[serde(default)]
    pub requires: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct StatusSpec {
    pub id: String,
    pub abbrev: String,
    /// One glyph, one cell — the queue column. Spec data like the abbrev, so
    /// swapping a glyph is a JSON edit, never a code change.
    #[serde(default)]
    pub icon: String,
    pub phase: String,
    pub tone: String,
    pub terminal: bool,
    pub help: String,
    #[serde(default)]
    pub next: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct FieldSpec {
    pub id: String,
    pub phase: String,
    pub help: String,
}

pub fn lifecycle() -> &'static Lifecycle {
    static CELL: std::sync::OnceLock<Lifecycle> = std::sync::OnceLock::new();
    // The string is a compile-time constant and `cargo test` parses it, so a
    // failure here means the spec was broken and shipped anyway — which is worth
    // a loud death rather than a queue that silently loses its labels.
    CELL.get_or_init(|| {
        serde_json::from_str(LIFECYCLE_JSON).expect("lifecycle.json (embedded) does not parse")
    })
}

/// There is one spelling per status, so this is a lookup rather than a resolve.
pub fn status_spec(s: &str) -> Option<&'static StatusSpec> {
    lifecycle().statuses.iter().find(|x| x.id == s)
}

/// One cell instead of a word. Falls back to the abbrev for a status the spec
/// gives no icon, and to a dash for one it does not know at all.
pub fn status_icon(s: &str) -> &'static str {
    status_spec(s)
        .map(|x| if x.icon.is_empty() { x.abbrev.as_str() } else { x.icon.as_str() })
        .unwrap_or("—")
}

/// No exit: the item has left the pipeline for good.
///
/// Note `applied` is *not* terminal. A landed change whose validation plan has
/// not run is unfinished, and the verify phase exists to say so — which means
/// the queue keeps showing it, on purpose.
pub fn is_terminal(s: &str) -> bool {
    status_spec(s).map(|x| x.terminal).unwrap_or(false)
}

/// Where a status may legally go, canonically. Empty for a terminal one.
pub fn next_statuses(from: &str) -> &'static [String] {
    status_spec(from).map(|s| s.next.as_slice()).unwrap_or(&[])
}

/// Is this move legal?
pub fn can_transition(from: &str, to: &str) -> bool {
    let Some(target) = status_spec(to) else { return false };
    next_statuses(from).iter().any(|n| n == &target.id)
}

/// Which phase produced this status, by position.
fn phase_index(status: &str) -> Option<usize> {
    let id = &status_spec(status)?.id;
    lifecycle().phases.iter().position(|p| &p.produces == id)
}

/// A commit already exists behind this status — the problem is addressed, even
/// while verify has yet to confirm it. Derived from which phase first requires
/// `applied_sha` rather than from a list of names, for the same reason as
/// `is_before_decision` below.
pub fn has_landed(status: &str) -> bool {
    let Some(apply) =
        lifecycle().phases.iter().position(|p| p.requires.iter().any(|r| r == "applied_sha"))
    else {
        return false;
    };
    phase_index(status).is_some_and(|i| i >= apply)
}

/// The status the one attended phase produces — what "you said yes" looks like.
pub fn decision_status() -> &'static str {
    lifecycle()
        .phases
        .iter()
        .find(|p| p.attended)
        .map(|p| p.produces.as_str())
        .unwrap_or("approved")
}

/// Still short of the decision, and still in play.
///
/// Derived from where the attended phase sits rather than from a list of names,
/// so the filter cannot fall behind a renamed status. Terminals are excluded
/// even when their phase is early: `superseded` is produced during triage but
/// nobody is going to decide it.
pub fn is_before_decision(status: &str) -> bool {
    if is_terminal(status) {
        return false;
    }
    let attended = lifecycle().phases.iter().position(|p| p.attended);
    matches!((phase_index(status), attended), (Some(a), Some(b)) if a < b)
}

/// The unattended phases that still owe work before this status can reach the
/// decision. What "why can't I approve this" is actually asking: none of these
/// are keys in the TUI, they belong to whoever each phase names as its actor.
pub fn phases_until_decision(status: &str) -> Vec<&'static PhaseSpec> {
    if !is_before_decision(status) {
        return Vec::new();
    }
    let l = lifecycle();
    match (phase_index(status), l.phases.iter().position(|p| p.attended)) {
        (Some(here), Some(decide)) => l.phases[here + 1..decide].iter().collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Icons are spec data, so the spec is where a two-cell glyph would sneak
    /// in and shear every row after it. Emoji fail this on purpose.
    #[test]
    fn every_status_icon_is_one_cell_and_none_repeats() {
        use unicode_width::UnicodeWidthStr;
        let mut seen = std::collections::HashSet::new();
        for s in &lifecycle().statuses {
            assert!(!s.icon.is_empty(), "{} has no icon", s.id);
            assert_eq!(s.icon.width(), 1, "{} icon {:?} is not one cell", s.id, s.icon);
            assert!(seen.insert(&s.icon), "{} repeats another status's icon", s.id);
        }
    }
}
