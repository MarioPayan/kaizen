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

/// The five places you work. Overlays are things you consult on top of one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Queue,
    Board,
    Categories,
    Skills,
    Settings,
}

impl Tab {
    pub const ALL: [Tab; 5] = [Tab::Queue, Tab::Board, Tab::Categories, Tab::Skills, Tab::Settings];

    pub fn label(self) -> &'static str {
        match self {
            Tab::Queue => "queue",
            Tab::Board => "board",
            Tab::Categories => "categories",
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
    ScrollDetail(i16),
    ToggleFocus,
    Back,
    Quit,
    Go(Tab),
    Help,
    Guide,
    Approve,
    Reject,
    ApproveCategory,
    /// Send one detached fable run at the untriaged backlog.
    Triage,
    Apply,
    Diff,
    Open,
    CycleFilter,
    Search,
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
const QUEUE: &[Tab] = &[Tab::Queue];
const BOARD: &[Tab] = &[Tab::Board];
/// Where the per-suggestion decide keys work: anywhere one suggestion is selected.
const DECIDING: &[Tab] = &[Tab::Queue, Tab::Board];
const CATEGORIES: &[Tab] = &[Tab::Categories];
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
        keys: &[KeyCode::Tab, KeyCode::BackTab],
        hint: "tab",
        label: "detail",
        section: "navigate",
        tabs: QUEUE,
        action: Action::ToggleFocus,
    },
    Binding {
        keys: &[KeyCode::Char('J')],
        hint: "J/K",
        label: "scroll detail",
        section: "navigate",
        tabs: QUEUE,
        action: Action::ScrollDetail(3),
    },
    Binding {
        keys: &[KeyCode::Char('K')],
        hint: "",
        label: "",
        section: "navigate",
        tabs: QUEUE,
        action: Action::ScrollDetail(-3),
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
    Binding {
        keys: &[KeyCode::Char('a')],
        hint: "a",
        label: "approve",
        section: "decide",
        tabs: DECIDING,
        action: Action::Approve,
    },
    Binding {
        keys: &[KeyCode::Char('r')],
        hint: "r",
        label: "reject",
        section: "decide",
        tabs: DECIDING,
        action: Action::Reject,
    },
    Binding {
        keys: &[KeyCode::Char('A')],
        hint: "A",
        label: "approve category",
        section: "decide",
        tabs: &[Tab::Queue, Tab::Categories],
        action: Action::ApproveCategory,
    },
    Binding {
        keys: &[KeyCode::Enter],
        hint: "enter",
        label: "apply",
        section: "decide",
        tabs: QUEUE,
        action: Action::Apply,
    },
    Binding {
        keys: &[KeyCode::Enter],
        hint: "enter",
        label: "open in queue",
        // The board shows where everything stands; reading and applying one
        // item happens in the queue, where the plan and validation are visible.
        section: "decide",
        tabs: BOARD,
        action: Action::Open,
    },
    Binding {
        keys: &[KeyCode::Enter],
        hint: "enter",
        label: "show members",
        section: "decide",
        tabs: CATEGORIES,
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
        keys: &[KeyCode::Char('t')],
        hint: "t",
        label: "dispatch fable",
        section: "decide",
        tabs: DECIDING,
        action: Action::Triage,
    },
    Binding {
        keys: &[KeyCode::Char('d')],
        hint: "d",
        label: "patch",
        section: "decide",
        tabs: DECIDING,
        action: Action::Diff,
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
        keys: &[KeyCode::Char('f')],
        hint: "f",
        label: "filter",
        section: "find",
        tabs: QUEUE,
        action: Action::CycleFilter,
    },
    Binding {
        keys: &[KeyCode::Char('/')],
        hint: "/",
        label: "search",
        section: "find",
        tabs: QUEUE,
        action: Action::Search,
    },
    Binding {
        keys: &[KeyCode::Char('1')],
        hint: "1-5",
        label: "tabs",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Queue),
    },
    Binding {
        keys: &[KeyCode::Char('2')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Board),
    },
    Binding {
        keys: &[KeyCode::Char('3')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Categories),
    },
    Binding {
        keys: &[KeyCode::Char('4')],
        hint: "",
        label: "",
        section: "tabs",
        tabs: ALL,
        action: Action::Go(Tab::Skills),
    },
    Binding {
        keys: &[KeyCode::Char('5')],
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
/// of the one above them — `k` is `j/k`, `2` is part of `1-5` — and are not
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
/// categories it is "show members", and you only ever see the one that is true
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
