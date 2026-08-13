//! The tabs.
//!
//! One module per screen, each a pure renderer: it is handed the data and an
//! area and draws. None of them owns state or talks to the API — that stays in
//! `tui.rs`, so a view cannot quietly start fetching on a redraw.
//!
//! The queue is not here. It has a second pane, a focus model and a breakpoint
//! of its own, and moving it would have been churn for symmetry's sake.

pub mod board;
pub mod categories;
pub mod settings;
pub mod skills;
