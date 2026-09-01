use std::{process::Child, thread, time::{Duration, Instant}};

#[cfg(unix)]
pub fn configure(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: this runs after fork and calls only the async-signal-safe setpgid.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
        });
    }
}

#[cfg(not(unix))]
pub fn configure(_command: &mut std::process::Command) {}

pub fn terminate(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    unsafe {
        let group = -(child.id() as i32);
        let _ = libc::kill(group, libc::SIGTERM);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            let _ = child.try_wait();
            if libc::kill(group, 0) != 0 { break; }
            thread::sleep(Duration::from_millis(25));
        }
        // Kill the whole group even if the direct child has already exited.
        if libc::kill(group, 0) == 0 { let _ = libc::kill(group, libc::SIGKILL); }
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}
