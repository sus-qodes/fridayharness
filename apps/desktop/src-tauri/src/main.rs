#![windows_subsystem = "windows"]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let text = format!("{info}\n{:?}", std::backtrace::Backtrace::capture());
        let _ = std::fs::write("desktop-panic.log", text);
    }));
    friday_desktop_lib::run();
}

