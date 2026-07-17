Fixed the production canonical-ingress feedback loop to override inherited `HARNESS_DAEMON_MODE=direct` with daemon-backed `local` for its CLI client subprocesses.
Verified the simulated CI regression test (2/2 pass) and root `check:local` (exit 0); no runner or unrelated test environment semantics changed.
