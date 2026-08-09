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

/// Three columns instead of nine. `approved` is most of the queue most of the
/// time, so the word was paying rent on the one column you actually read.
pub fn status_abbrev(s: &str) -> &'static str {
    status_spec(s).map(|x| x.abbrev.as_str()).unwrap_or("—")
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
