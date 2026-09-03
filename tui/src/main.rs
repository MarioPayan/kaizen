//! kaizen-tui — the board, in the terminal.
//!
//! A second front end to the local API, not a second implementation of anything:
//! `@kaizen/core` still does the scanning, grouping and scoring, and the server
//! still owns the writes and their guards.

mod api;
mod keys;
mod lifecycle;
mod theme;
mod tui;
mod ui;
mod unblock;
mod views;

const HELP: &str = "\
kaizen-tui — the kaizen board in the terminal

USAGE:
    kaizen-tui [--base URL]

    --base URL   the kaizen server (default http://127.0.0.1:7777,
                 or $KAIZEN_API)

Needs a running server: `kaizen serve`.
";

fn main() {
    let mut args = std::env::args().skip(1);
    let mut base = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" | "help" => return print!("{HELP}"),
            "--base" => base = args.next(),
            other => {
                eprintln!("kaizen-tui: unknown argument \"{other}\"\n\n{HELP}");
                std::process::exit(2);
            }
        }
    }

    if let Err(e) = tui::main(base) {
        eprintln!("kaizen-tui: {e}");
        std::process::exit(1);
    }
}
