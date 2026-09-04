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
    #[serde(rename = "statusLine")]
    pub status_line: StatusLineSpec,
}

/// The legend for the line a session starts with and the segment
/// `kaizen status --bar` paints. The TUI draws none of it — it is the one
/// kaizen surface that is not on screen — which is exactly why the guide has to
/// explain it: the glyphs greet you in a prompt with nothing nearby to ask.
#[derive(Debug, Deserialize)]
pub struct StatusLineSpec {
    pub mark: String,
    pub help: String,
    pub piles: Vec<PileSpec>,
}

/// No `id`: the CLI addresses a pile by id to paint it, the TUI only ever reads
/// the legend top to bottom. Serde skips what nothing asks for.
#[derive(Debug, Deserialize)]
pub struct PileSpec {
    pub glyph: String,
    pub label: String,
    pub help: String,
}

#[derive(Debug, Deserialize)]
pub struct PhaseSpec {
    pub id: String,
    pub title: String,
    pub actor: String,
    /// Who does the work, as the server spawns it and the lane names it:
    /// `opencode`, `claude`, `you`, `server`, `skill`.
    pub runner: String,
    /// Who has to clear the runner's output before the card moves on. Empty
    /// for a phase whose status is settled the moment it is written.
    #[serde(default)]
    pub reviewer: String,
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

/// The status-line legend, straight off the spec the CLI paints from.
pub fn status_line() -> &'static StatusLineSpec {
    &lifecycle().status_line
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

/// Is this move legal? The lanes ask `forward` and `exit`; the ways out of a
/// parked card ask this, because a send-back is neither.
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

/// The phase a status moves into: the one producing `forward(status)`. By
/// `next` order, not phase order — a status can go back now, and capture sits
/// first in the file, so "first phase whose product is reachable" would send
/// every triaged card to the pile it came from.
pub fn next_phase(status: &str) -> Option<&'static PhaseSpec> {
    let to = forward(status)?;
    lifecycle().phases.iter().find(|p| p.produces == to)
}

/// Every reviewer the spec names, once each, in phase order — the name the
/// review lane wears.
pub fn reviewers() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for p in &lifecycle().phases {
        if !p.reviewer.is_empty() && !out.contains(&p.reviewer.as_str()) {
            out.push(&p.reviewer);
        }
    }
    out
}

/// Does a model move this status forward? True when the next phase is neither
/// yours nor the server's — so a run is what `a` sends. Mirrors the server's
/// dispatch gate so the TUI counts the same work the server would accept a
/// dispatch for.
pub fn awaits_pass(status: &str) -> bool {
    let Some(next) = next_phase(status) else { return false };
    !next.attended && Some(next.produces.as_str()) != landed_status()
}

/// Is there anything an unattended run can do for this card right now? The
/// server's gate, mirrored: `awaits_pass` answers for the status, a card
/// flagged for a check is the reviewer's whatever its status, and a card
/// carrying `blocked_on` answers no whatever else is true — it is parked on
/// something outside the pipeline, and a run fenced to it can only re-stamp.
pub fn pending_pass(status: &str, needs_review: &str, blocked_on: &str) -> bool {
    blocked_on.is_empty() && (!needs_review.is_empty() || awaits_pass(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dispatch gate. `triaged` is the one that was once refused: the old
    /// gate counted untriaged items only, and a fully-triaged backlog with no
    /// plans read as "nothing to do". `applied` and `reviewed` are the ones it
    /// used to stop short of: a landed change is opencode's to review and then
    /// claude's to verify, and neither had a key.
    #[test]
    fn a_run_moves_everything_that_is_not_yours_or_the_servers() {
        assert!(awaits_pass("recorded"));
        assert!(awaits_pass("triaged"));
        assert!(awaits_pass("failed"), "a failed item goes back for a new plan");
        assert!(awaits_pass("applied"), "a landed change gets reviewed");
        assert!(awaits_pass("reviewed"), "and then verified");
        assert!(!awaits_pass("planned"), "planned waits on you");
        assert!(!awaits_pass("approved"), "approved waits on the server");
        assert!(!awaits_pass("verified"));
        assert!(!awaits_pass("rejected"));

        // The flag overrides the status: an unchecked plan is claude's, and a
        // block overrides everything.
        assert!(pending_pass("planned", "claude", ""));
        assert!(!pending_pass("planned", "", ""));
        assert!(!pending_pass("planned", "claude", "waiting on a call"));
        assert!(!pending_pass("recorded", "", "waiting on a call"));
    }

    /// Whose move it is comes off the spec, and the back-edges a failed check
    /// adds never become the way forward: `triaged` can go to `recorded` now,
    /// and its next phase is still plan.
    #[test]
    fn the_next_phase_is_the_forward_one_and_names_its_runner() {
        let next = |s: &str| next_phase(s).map(|p| (p.id.as_str(), p.runner.as_str()));
        assert_eq!(next("recorded"), Some(("triage", "opencode")));
        assert_eq!(next("triaged"), Some(("plan", "opencode")));
        assert_eq!(next("planned"), Some(("decide", "you")));
        assert_eq!(next("approved"), Some(("apply", "server")));
        assert_eq!(next("applied"), Some(("review", "opencode")));
        assert_eq!(next("reviewed"), Some(("verify", "claude")));
        assert_eq!(next("verified"), None);
        assert_eq!(reviewers(), ["claude"]);
    }

    /// `a` and `x` are one key each across every lane, so what they do has to
    /// fall out of the spec: forward is the next stage, exit the first
    /// non-forward terminal, and a status the pipeline owns has no exit.
    #[test]
    fn advance_and_discard_are_derived_per_lane() {
        assert_eq!(forward("recorded"), Some("triaged"));
        assert_eq!(forward("planned"), Some("approved"));
        assert_eq!(forward("approved"), Some("applied"));
        assert!(can_transition("approved", "planned"), "an invalidated approval returns to planning");
        assert_eq!(forward("failed"), Some("planned"), "failed goes back for a plan");
        assert_eq!(forward("applied"), Some("reviewed"), "a landed change is reviewed before it is verified");
        assert_eq!(forward("reviewed"), Some("verified"));
        assert_eq!(forward("verified"), None);
        assert_eq!(exit("recorded"), Some("rejected"), "you can still say no");
        assert_eq!(exit("approved"), Some("superseded"), "a yes given can still be overtaken");
        assert_eq!(exit("failed"), None, "the pipeline owns a failed item");
        assert_eq!(landed_status(), Some("applied"));
    }

    /// The bar's glyphs sit in a prompt beside a shell's own, so a two-cell one
    /// shifts everything after it — the same rule as the status icons, and the
    /// same reason: the spec is the only place either can go wrong.
    #[test]
    fn every_pile_glyph_is_one_cell_and_none_repeats() {
        use unicode_width::UnicodeWidthStr;
        let mut seen = std::collections::HashSet::new();
        let sl = status_line();
        assert!(!sl.mark.is_empty(), "the segment has no mark");
        for p in &sl.piles {
            assert_eq!(p.glyph.width(), 1, "{} glyph {:?} is not one cell", p.label, p.glyph);
            assert!(!p.help.is_empty(), "{} has no help", p.label);
            assert!(seen.insert(&p.glyph), "{} repeats another pile's glyph", p.label);
        }
        assert!(sl.piles.len() >= 2, "a legend of one pile explains nothing");
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
