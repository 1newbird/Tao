#[cfg(windows)]
mod runner;
#[cfg(windows)]
fn main() { runner::main(); }
#[cfg(not(windows))]
fn main() { eprintln!("Windows native sandbox requires Windows 10 or later."); std::process::exit(1); }
