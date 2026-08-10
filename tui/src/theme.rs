//! Colour, and the two vocabularies that spend it.
//!
//! One palette, for a dark terminal. There were three: a `light` one that
//! assumed a light background, and a `dark` one whose dim was `DarkGray` —
//! grey-on-black, the least readable text on screen and the reason this is now
//! a single set of constants rather than a switch.
//!
//! With one palette there is nothing to cycle, so the atomic, the index and the
//! `t` key went with the other two.

use ratatui::style::Color;

use crate::lifecycle::status_spec;

/// Bright enough to read as text, not as a hint. Everything secondary uses this,
/// so it is the colour most of the screen is actually made of.
pub const fn dim() -> Color {
    Color::Rgb(190, 190, 190)
}

pub const fn accent() -> Color {
    Color::Rgb(0, 220, 255)
}

pub const fn ok() -> Color {
    Color::Rgb(0, 230, 100)
}

pub const fn warn() -> Color {
    Color::Rgb(255, 210, 0)
}

pub const fn err() -> Color {
    Color::Rgb(255, 95, 95)
}

pub const fn selection_bg() -> Color {
    Color::Rgb(70, 70, 70)
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

/// The spec's tone is semantic so a front end can spend its own palette. A
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
