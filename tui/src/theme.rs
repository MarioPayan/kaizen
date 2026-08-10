//! Colour, and the two vocabularies that spend it.
//!
//! Separate from the views because a palette is the one thing every view shares
//! and none of them should redefine. A status tone comes from `lifecycle.json`
//! and is semantic — five names — so this is where it becomes a terminal colour.

use ratatui::style::Color;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::lifecycle::status_spec;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
/// Two, both for a dark terminal.
///
/// There was a `light` one, and it was the wrong shape: `Gray` dim, a `Blue`
/// accent and a near-white selection all assume a light background, so on the
/// terminal anyone actually runs this in it read as grey-on-grey. A theme that
/// only works somewhere else is worse than not offering one.
pub const NAMES: [&str; 2] = ["dark", "high-contrast"];

pub fn cycle() {
    let _ = CURRENT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |i| Some((i + 1) % NAMES.len()));
}

fn i() -> usize {
    CURRENT.load(Ordering::Relaxed)
}

pub fn accent() -> Color {
    [Color::Cyan, Color::Rgb(0, 255, 255)][i()]
}
pub fn dim() -> Color {
    // High contrast means high contrast: `Gray` sat on a #464646 selection and
    // was the least readable thing on screen, in the theme named for being the
    // most readable.
    [Color::DarkGray, Color::Rgb(190, 190, 190)][i()]
}
pub fn ok() -> Color {
    [Color::Green, Color::Rgb(0, 255, 0)][i()]
}
pub fn warn() -> Color {
    [Color::Yellow, Color::Rgb(255, 255, 0)][i()]
}
pub fn err() -> Color {
    [Color::Red, Color::Rgb(255, 80, 80)][i()]
}
pub fn selection_bg() -> Color {
    [Color::Rgb(45, 55, 70), Color::Rgb(70, 70, 70)][i()]
}

pub fn severity_colour(s: &str) -> Color {
    match s {
        "high" => err(),
        "medium" => warn(),
        "low" => ok(),
        _ => dim(),
    }
}

pub fn status_colour(s: &str) -> Color {
    status_spec(s).map(|x| tone_colour(&x.tone)).unwrap_or_else(dim)
}

/// One column instead of seven. The word is still spelled out in the detail pane,
/// and the letter survives a terminal with no colour where a bare hue would not.
pub fn severity_letter(s: &str) -> &'static str {
    match s {
        "high" => "H",
        "medium" => "M",
        "low" => "L",
        _ => "·",
    }
}

/// The spec's tone is semantic so each front end can spend its own palette. A
/// terminal has green and red, so all five land somewhere distinct here.
pub fn tone_colour(tone: &str) -> Color {
    match tone {
        "accent" => accent(),
        "positive" => ok(),
        "warning" => warn(),
        "negative" => err(),
        _ => dim(),
    }
}
