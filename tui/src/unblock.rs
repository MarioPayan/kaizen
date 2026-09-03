//! The ways out of a parked card.
//!
//! A card parked on you used to offer one key: `b`, a text field, and the
//! knowledge of what to type. The board now offers the moves as a list — the
//! same list for a landing that could not happen, a check that sent the card
//! back, and a runner that parked it on a call — because what you can *do*
//! with a parked card falls out of the spec, not out of the reason.
//!
//! Which option leads does read the reason: claude and the server write a
//! prefix (`review:`, `apply:`) when the runner's output was wrong, and then
//! "send it back for a new plan" is the move you almost always want. A park
//! with no prefix is a runner asking you something, and "answer it" leads.
//!
//! Labels and one-line meanings live here; what each choice writes lives in
//! the server's `/api/unblock`, so the two cannot drift into different verbs.

use crate::api::{Suggestion, Target};
use crate::lifecycle::{can_transition, forward};

/// What a choice asks of you before it can be sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Needs {
    Nothing,
    /// A line of text — an answer, or where a fix lives.
    Text,
    /// One of the other writable targets.
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WayOut {
    /// The server's word for it.
    pub choice: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    pub needs: Needs,
}

const fn way(choice: &'static str, label: &'static str, help: &'static str, needs: Needs) -> WayOut {
    WayOut { choice, label, help, needs }
}

/// The reason came from a run that judged the runner's output, not from a
/// runner asking a question: the move that fixes it is a new plan.
pub fn is_send_back(reason: &str) -> bool {
    reason.starts_with("apply:") || reason.starts_with("review:")
}

/// The targets a card could move to: writable, holding suggestions, and not
/// the one it is already under.
pub fn other_targets<'a>(s: &Suggestion, targets: &'a [Target]) -> Vec<&'a Target> {
    targets
        .iter()
        .filter(|t| t.writable && !t.feedback.is_empty() && t.name != s.target)
        .collect()
}

/// The menu for one parked card, best move first.
pub fn ways_out(s: &Suggestion, targets: &[Target]) -> Vec<WayOut> {
    let from = s.status.as_str();
    // A send-back is a move *back* to triaged. Where triaged is the way
    // forward — a recorded card — the same edge is just the pass, and `clear`
    // already sends it.
    let replan = (forward(from) != Some("triaged") && can_transition(from, "triaged")).then(|| {
        way(
            "replan",
            "send back for a new plan",
            "back to triaged; opencode plans again against HEAD, with this reason as its brief",
            Needs::Nothing,
        )
    });
    let clear = way(
        "clear",
        "clear the block",
        "the reason no longer holds — the card resumes where it stands",
        Needs::Nothing,
    );
    let answer = way(
        "answer it",
        "answer it",
        "type what the run needs; it goes under ## Answer and the card resumes",
        Needs::Text,
    );
    let answer = WayOut { choice: "answer", ..answer };
    let retarget = (!other_targets(s, targets).is_empty()).then(|| {
        way(
            "retarget",
            "move to another target",
            "the fix lands in a different repo: move the card there and plan against that root",
            Needs::Target,
        )
    });
    let supersede = can_transition(from, "superseded").then(|| {
        way("supersede", "supersede", "the fix already lives somewhere — say where", Needs::Text)
    });
    let reject = can_transition(from, "rejected")
        .then(|| way("reject", "reject", "not worth doing; the file stays as a record", Needs::Nothing));

    let mut out = Vec::with_capacity(6);
    if is_send_back(&s.blocked_on) {
        out.extend(replan);
        out.extend(retarget);
        out.push(clear);
        out.push(answer);
    } else {
        out.push(answer);
        out.push(clear);
        out.extend(replan);
        out.extend(retarget);
    }
    out.extend(supersede);
    out.extend(reject);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(status: &str, reason: &str) -> Suggestion {
        Suggestion {
            id: "user/x/2026-09-03-thing.md".into(),
            target: "user".into(),
            status: status.into(),
            blocked_on: reason.into(),
            ..Default::default()
        }
    }

    fn target(name: &str, writable: bool) -> Target {
        Target { name: name.into(), skills: "/s".into(), feedback: "/f".into(), writable }
    }

    fn choices(ways: &[WayOut]) -> Vec<&str> {
        ways.iter().map(|w| w.choice).collect()
    }

    /// A landing that could not happen wants a new plan first; a runner's
    /// question wants an answer first. Same list, different lead.
    #[test]
    fn the_reason_picks_which_move_leads() {
        let parked = ways_out(&card("approved", "apply: patch does not apply"), &[]);
        assert_eq!(choices(&parked), ["replan", "clear", "answer", "supersede"]);
        let asked = ways_out(&card("triaged", "where should this live?"), &[]);
        assert_eq!(choices(&asked), ["answer", "clear", "supersede", "reject"]);
    }

    /// The moves fall out of the spec: `triaged` has no send-back (it is where
    /// a send-back lands), `approved` has no reject (a yes given can only be
    /// overtaken), and a card that is already where a plan starts is not
    /// offered a trip to itself.
    #[test]
    fn only_legal_moves_are_offered() {
        let approved = ways_out(&card("approved", "review: x"), &[]);
        assert!(!choices(&approved).contains(&"reject"));
        assert!(choices(&approved).contains(&"replan"));
        let planned = ways_out(&card("planned", "review: x"), &[]);
        assert_eq!(choices(&planned), ["replan", "clear", "answer", "supersede", "reject"]);
        let recorded = ways_out(&card("recorded", "review: x"), &[]);
        assert!(!choices(&recorded).contains(&"replan"), "recorded cannot go back to triaged");
    }

    /// Moving between targets is offered only when there is somewhere to go:
    /// another target, writable, holding suggestions.
    #[test]
    fn a_move_needs_somewhere_to_go() {
        let s = card("approved", "apply: plugins/x: No such file or directory");
        assert!(!choices(&ways_out(&s, &[target("user", true)])).contains(&"retarget"));
        assert!(!choices(&ways_out(&s, &[target("user", true), target("ro", false)])).contains(&"retarget"));
        let with = ways_out(&s, &[target("user", true), target("kaizen-plugin", true)]);
        assert_eq!(choices(&with), ["replan", "retarget", "clear", "answer", "supersede"]);
        assert_eq!(with[1].needs, Needs::Target);
        assert_eq!(other_targets(&s, &[target("user", true), target("kaizen-plugin", true)]).len(), 1);
    }
}
