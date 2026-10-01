// Preloaded into every test child. A daemon a test starts is detached into its own process group,
// so the runner's process-group reap never reaches it, and a `daemon stop` that is refused, skipped
// by a failing test, or never reached because the watchdog killed the file leaves it running with
// its state directory already deleted. The daemon stops itself once the process named here is gone,
// so naming the test file's own process ends every daemon that file started along with it.
process.env.HARNESS_DAEMON_OWNER_PID = String(process.pid);
