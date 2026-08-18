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

/// The status the one attended phase produces — what "you said yes" looks like.
pub fn decision_status() -> &'static str {
    lifecycle()
        .phases
        .iter()
        .find(|p| p.attended)
        .map(|p| p.produces.as_str())
        .unwrap_or("approved")
}

/// One lane on: the next status some phase produces. `None` at the end of the
/// pipeline, and for a terminal.
pub fn forward(from: &str) -> Option<&'static str> {
    let l = lifecycle();
    next_statuses(from)
        .iter()
        .map(String::as_str)
        .find(|n| l.phases.iter().any(|p| p.produces == *n))
}

/// The way out that is not forward: the first terminal in `next` no phase
/// produces. `rejected` while you can still say no, `superseded` once a yes was
/// given, none for a status the pipeline owns (`failed` only goes back to plan).
pub fn exit(from: &str) -> Option<&'static str> {
    let l = lifecycle();
    next_statuses(from)
        .iter()
        .map(String::as_str)
        .find(|n| is_terminal(n) && !l.phases.iter().any(|p| p.produces == *n))
}

/// What the phase right after the decision produces — the status only the
/// server writes, because it is a statement that git returned a sha.
// ponytail: by position, not declared; if a phase ever slides in between
// decide and apply, give the spec an owner field instead.
pub fn landed_status() -> Option<&'static str> {
    let l = lifecycle();
    let at = l.phases.iter().position(|p| p.attended)?;
    l.phases.get(at + 1).map(|p| p.produces.as_str())
}

/// Who runs the phase that produces this status — the spec's own words.
pub fn actor_of(status: &str) -> Option<&'static str> {
    lifecycle().phases.iter().find(|p| p.produces == status).map(|p| p.actor.as_str())
}

/// Can the unattended pre-decision pass (triage, plan) still move this status
/// forward? Mirrors the server's dispatch gate so the TUI counts the same work
/// the server would accept a dispatch for.
pub fn awaits_pass(status: &str) -> bool {
    let l = lifecycle();
    let Some(at) = l.phases.iter().position(|p| p.attended) else { return false };
    l.phases[..at].iter().any(|p| can_transition(status, &p.produces))
}

/// Is there anything an unattended pass can do for this card right now? The
/// server's gate, mirrored: `awaits_pass` answers for the status, and a card
/// carrying `blocked_on` answers no whatever its status — it is parked on
/// something outside the pipeline, and a run fenced to it can only re-stamp.
pub fn pending_pass(status: &str, blocked_on: &str) -> bool {
    awaits_pass(status) && blocked_on.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dispatch gate. `triaged` is the one that was once refused: the old
    /// gate counted untriaged items only, and a fully-triaged backlog with no
    /// plans read as "nothing to do".
    #[test]
    fn the_pass_covers_recorded_triaged_and_failed_but_not_the_decided() {
        assert!(awaits_pass("recorded"));
        assert!(awaits_pass("triaged"));
        assert!(awaits_pass("failed"), "a failed item goes back for a new plan");
        assert!(!awaits_pass("planned"), "planned waits on you");
        assert!(!awaits_pass("approved"), "approved waits on the server");
        assert!(!awaits_pass("verified"));
        assert!(!awaits_pass("rejected"));
    }

    /// `a` and `x` are one key each across every lane, so what they do has to
    /// fall out of the spec: forward is the next stage, exit the first
    /// non-forward terminal, and a status the pipeline owns has no exit.
    #[test]
    fn advance_and_discard_are_derived_per_lane() {
        assert_eq!(forward("recorded"), Some("triaged"));
        assert_eq!(forward("planned"), Some("approved"));
        assert_eq!(forward("failed"), Some("planned"), "failed goes back for a plan");
        assert_eq!(forward("verified"), None);
        assert_eq!(exit("recorded"), Some("rejected"), "you can still say no");
        assert_eq!(exit("approved"), Some("superseded"), "a yes given can only be overtaken");
        assert_eq!(exit("failed"), None, "the pipeline owns a failed item");
        assert_eq!(landed_status(), Some("applied"));
    }

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
