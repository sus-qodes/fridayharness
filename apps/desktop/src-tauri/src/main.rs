// No console window in release builds; `cargo run` (debug) keeps one for its output.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    friday_desktop_lib::run();
}
