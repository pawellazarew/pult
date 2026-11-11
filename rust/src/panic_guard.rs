//! Process-wide startup policy for panics crossing worker/sink boundaries.
//! Catching a panic does not silence Rust's default hook: install this before
//! workers or untrusted callbacks run. The hook never formats the payload,
//! thread name, location, or a backtrace, and never invokes a previous hook.
//! It performs no IO or allocation, so stderr backpressure cannot block unwind.
use std::sync::Once;

static INSTALLED: Once = Once::new();

/// Replace the process panic hook once. Applications embedding this library
/// must call this at startup, before spawning workers. A later custom hook can
/// override the policy; this function does not temporarily swap global hooks.
pub fn install() {
    INSTALLED.call_once(|| {
        std::panic::set_hook(Box::new(|_| {}));
    });
}
