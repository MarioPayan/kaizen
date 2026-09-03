//! Every key, once.
//!
//! Three things need to agree about a keybinding: what happens when you press
//! it, what the footer says you can press, and what the help card lists. They
//! used to be three hand-written lists, and the footer advertised `?` for help
//! on a build where `?` did nothing.
//!
//! So there is one table. `resolve` drives the key loop, `hints` draws the
//! footer, `sections` draws the help — all from `BINDINGS`. A key that works on
//! a tab is offered on that tab, and a key that does not, is not, because both
//! answers come from the same `tabs` field.

use ratatui::crossterm::event::KeyCode;

/// The four places you work. Overlays are things you consult on top of one.
/// The board comes first: it is the command centre, and where the TUI starts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Board,
    Agent,
    Skills,
    Settings,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Board, Tab::Agent, Tab::Skills, Tab::Settings];

    pub fn label(self) -> &'static str {
        match self {
            Tab::Board => "board",
            Tab::Agent => "agents",
            Tab::Skills => "skills",
            Tab::Settings => "settings",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Move(isize),
    /// Board only: step across lanes; `Move` steps within one.
    Lane(isize),
    Back,
    Quit,
    Go(Tab),
    Help,
    Guide,
    /// Board: move the selected card one lane on, by whatever that lane waits
    /// for — a run, your yes, or the server landing the patch.
    Advance,
    /// Board: the same, for every card the selected lane's move can take.
    AdvanceAll,
    /// Board: the card's way out that is not forward — reject, or supersede.
    Discard,
    /// Board: write what the card is waiting on, or clear it once you have done
    /// it. The one field on a card whose value is a sentence you own.
    Block,
    /// Board: type a uid or a bit of a name and land on the card, any lane.
    Find,
    Diff,
    Open,
    Refresh,
    /// Settings: flip a boolean, step a choice, or start editing a value.
    Edit,
    Save,
}

pub struct Binding {
    pub keys: &'static [KeyCode],
    /// How the key is written in the footer and the help card.
    pub hint: &'static str,
    pub label: &'static str,
    pub section: &'static str,
    /// Where it applies. Empty means every tab.
    pub tabs: &'static [Tab],
    pub action: Action,
}

const ALL: &[Tab] = &[];
/// Where the per-suggestion decide keys work: the board is the only place a
/// suggestion is selected.
const BOARD: &[Tab] = &[Tab::Board];
const SKILLS: &[Tab] = &[Tab::Skills];
const SETTINGS: &[Tab] = &[Tab::Settings];

/// Order matters twice: the footer offers these left to right and drops from
/// the right when the row is tight, and the help card groups them by `section`
/// in first-seen order. Most useful first, therefore.
pub const BINDINGS: &[Binding] = &[
    Binding {
        keys: &[KeyCode::Char('j'), KeyCode::Down],
        hint: "j/k",
        label: "move",
        section: "navigate",
        tabs: ALL,
        action: Action::Move(1),
    },
    Binding {
        keys: &[KeyCode::Char('k'), KeyCode::Up],
        hint: "",
        label: "",
        section: "navigate",
        tabs: ALL,
        action: Action::Move(-1),
    },
    Binding {
        keys: &[KeyCode::PageDown],
        hint: "",
        label: "",
        section: "navigate",
        tabs: ALL,
        action: Action::Move(10),
    },
    Binding {
        keys: &[KeyCode::PageUp],
        hint: "",
        label: "",
        section: "navigate",
        tabs: ALL,
        action: Action::Move(-10),
    },
    Binding {
        keys: &[KeyCode::Left],
        hint: "←/→",
        label: "lanes",
        section: "navigate",
        tabs: BOARD,
        action: Action::Lane(-1),
    },
    Binding {
        keys: &[KeyCode::Right],
        hint: "",
        label: "",
        section: "navigate",
        tabs: BOARD,
        action: Action::Lane(1),
    },
    // One verb per direction, the same in every lane: `a` moves the card on,
    // `x` takes it out. What "on" costs — a run, you, or git — is the lane's
    // business, and its subtitle says which. The shifted key widens the same
    // verb to the lane; one footer entry carries both spellings, and the
    // shifted binding rides under it as a blank-hint alternate.
    Binding {
        keys: &[KeyCode::Char('a')],
        hint: "a",
        label: "advance (A lane)",
        section: "decide",
        tabs: BOARD,
        action: Action::Advance,
    },
    Binding {
        keys: &[KeyCode::Char('A')],
        hint: "",
        label: "",
        section: "decide",
        tabs: BOARD,
        action: Action::AdvanceAll,
    },
    Binding {
        keys: &[KeyCode::Char('x')],
        hint: "x",
        label: "discard",
        section: "decide",
        tabs: BOARD,
        action: Action::Discard,
    },
    Binding {
        keys: &[KeyCode::Char('b')],
        hint: "b",
        label: "answer block",
        section: "decide",
        tabs: BOARD,
        action: Action::Block,
    },
    Binding {
        keys: &[KeyCode::Enter],
        hint: "enter",
        label: "detail",
        // Reading one item happens in a window over the board, so your place
        // never moves.
        section: "decide",
        tabs: BOARD,
        action: Action::Open,
    },
    Binding {
        keys: &[KeyCode::Enter],
        hint: "enter",
        label: "open file",
        // Not "decide": reading a skill is looking, not choosing.
        section: "navigate",
        tabs: SKILLS,
        action: Action::Open,
    },
    Binding {
        keys: &[KeyCode::Char('d')],
        hint: "d",
        label: "patch",
        section: "decide",
        tabs: BOARD,
        action: Action::Diff,
    },
    Binding {
        keys: &[KeyCode::Char('/')],
        hint: "/",
        label: "find",
        section: "navigate",
        tabs: BOARD,
        action: Action::Find,
    },
    Binding {
        keys: &[KeyCode::Char(' '), KeyCode::Enter],
        hint: "space",
        label: "change",
        section: "settings",
        tabs: SETTINGS,
        action: Action::Edit,
    },
    Binding {
        keys: &[KeyCode::Char('s')],
        hint: "s",
        label: "save",
        section: "settings",
        tabs: SETTINGS,
        action: Action::Save,
    },
    Binding {
        keys: &[KeyCode::Char('1')],
        hint: "1-4",
        label: "tabs",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Board),
    },
    Binding {
        keys: &[KeyCode::Char('2')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Agent),
    },
    Binding {
        keys: &[KeyCode::Char('3')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Skills),
    },
    Binding {
        keys: &[KeyCode::Char('4')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Settings),
    },
    Binding {
        keys: &[KeyCode::Char('h')],
        hint: "h",
        label: "help",
        section: "other",
        tabs: ALL,
        action: Action::Help,
    },
    Binding {
        keys: &[KeyCode::Char('D')],
        hint: "D",
        label: "guide",
        section: "other",
        tabs: ALL,
        action: Action::Guide,
    },
    Binding {
        keys: &[KeyCode::Char('g')],
        hint: "g",
        label: "refresh",
        section: "other",
        tabs: ALL,
        action: Action::Refresh,
    },
    Binding {
        keys: &[KeyCode::Esc],
        hint: "esc",
        label: "back",
        section: "other",
        tabs: ALL,
        action: Action::Back,
    },
    Binding {
        keys: &[KeyCode::Char('q')],
        hint: "q",
        label: "quit",
        section: "other",
        tabs: ALL,
        action: Action::Quit,
    },
];

fn applies(b: &Binding, tab: Tab) -> bool {
    b.tabs.is_empty() || b.tabs.contains(&tab)
}

/// What this key does here, if anything. The first match wins, which is why
/// `enter` can mean three things without any of them needing to know about the
/// others.
pub fn resolve(key: KeyCode, tab: Tab) -> Option<Action> {
    BINDINGS
        .iter()
        .find(|b| applies(b, tab) && b.keys.contains(&key))
        .map(|b| b.action)
}

/// The footer's offer for this tab. Bindings with a blank hint are alternates
/// of the one above them — `k` is `j/k`, `2` is part of `1-4` — and are not
/// offered twice.
pub fn hints(tab: Tab) -> Vec<(&'static str, &'static str)> {
    BINDINGS
        .iter()
        .filter(|b| applies(b, tab) && !b.hint.is_empty())
        .map(|b| (b.hint, b.label))
        .collect()
}

/// The help card for one tab, grouped by section in first-seen order.
///
/// Filtered to the tab rather than listing everything with a "where" column.
/// That is what lets one key carry a different meaning per view without the
/// card reading as a contradiction: on the queue `enter` is "apply", on
/// the board it is "open in queue", and you only ever see the one that is true
/// where you are standing.
pub fn sections(tab: Tab) -> Vec<(&'static str, Vec<&'static Binding>)> {
    let mut out: Vec<(&'static str, Vec<&'static Binding>)> = Vec::new();
    for b in BINDINGS.iter().filter(|b| applies(b, tab) && !b.hint.is_empty()) {
        match out.iter_mut().find(|(name, _)| *name == b.section) {
            Some((_, list)) => list.push(b),
            None => out.push((b.section, vec![b])),
        }
    }
    out
}
