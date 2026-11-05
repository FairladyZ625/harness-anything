# External daemon probe

The daemon's own monitoring cannot witness a wedged event loop. This probe runs as an
independent process, sends a minimal request pair on a fixed interval, reads the daemon
process counters from the operating system, and records a capture when the daemon stops
answering or stays saturated.

It is read-only: it never restarts, stops, or signals the daemon. The only tool that may
briefly suspend the target is the OS stack sampler used for a capture (`sample` on macOS);
Linux capture reads `/proc` files.

## Run it

```bash
ha daemon probe --user-root ~/.harness --daemon-id default
```

Defaults: one sample every 5s, 2s timeout per request, `slow` at 1s, capture after 30s of
unresponsiveness, after 60s at or above 90% CPU, or immediately above 8 GiB RSS. Stop with
Ctrl-C; the final receipt reports sample and capture counts.

```bash
ha daemon probe --interval 5s --timeout 2s --slow-ms 1000 \
  --unresponsive 30s --cpu-percent 90 --cpu-sustain 60s \
  --rss-bytes 8589934592 --cooldown 10m \
  --user-root ~/.harness --daemon-id default
```

A bounded run is useful for acceptance evidence:

```bash
ha daemon probe --iterations 120 --interval 5s --json
ha daemon probe --duration 10m
```

`--json` suppresses per-sample lines and prints one run receipt at the end. Without it the
command prints one line per sample to stdout, so a terminal or a log shipper sees the live
timeline.

## What is recorded

Samples and capture events are appended as `daemon-probe/v1` JSONL to
`<user-root>/logs/daemon-<daemon-id>-probe-<YYYYMMDD>.jsonl`, rolled by UTC day and pruned
after 7 days (`--kept-days`). Each sample carries:

- `state`: `up` (both requests answered under the slow threshold), `slow` (answered, but at or
  above `--slow-ms`), or `down` (hello or status timed out or failed);
- `latencyMs`, `helloMs`, `statusMs` and the failure code;
- `cpuPercent`, `rssBytes`, `threadCount`, `openFileCount`, the counter source, and a
  `metricsUnavailable` list naming any counter the platform could not provide.

Counter sources: `/proc/<pid>/{stat,status,fd}` on Linux, `ps`/`lsof` on macOS, and PowerShell
`Get-Process` on Windows. Windows is best-effort and less tested; fields that cannot be read
stay `null` and are listed in `metricsUnavailable`.

An unknown PID is recorded as skipped; a capture with no diagnostic content is recorded as failed.
Both remain pending and are retried after `--cooldown` while the event persists. Every attempt,
including a failure or skip, starts the cooldown. A successful capture runs at most once for an
ongoing event; the event must clear before it can arm again. Capture artifacts go to
`<user-root>/logs/probe-captures/`:

- macOS: `sample <pid> <seconds> -file <artifact>`;
- Linux: `/proc/<pid>/{status,stack,wchan,syscall,stat}` concatenated into one text file;
  an unreadable file is named in that dump; at least one nonempty proc file or a successful JS stack is required for a successful capture;
- JS stack: only when the daemon advertises the method in `protocol.hello.methods`. The
  expected method is `daemon.diagnostics.stack`; `--js-stack-method` only accepts this
  read-only diagnostic name (control methods such as `daemon.stop` are refused). When it is
  absent the record says `not-advertised` and the probe continues.

## Summarize

```bash
ha daemon probe summary --window 24h
ha daemon probe summary --day 20261103
ha daemon probe summary --day 20261103 --until 2026-11-03T15:20:00Z
ha daemon probe summary --window 1h --min-silence 5m --json
```

`--until <ISO-8601>` freezes the window end, so a day that is still running can be
summarized reproducibly from later evidence.

The summary prints two independent views:

1. **Probe timeline** for the window: sample counts, availability (answered samples / all
   samples), healthy percent, latency percentiles, downtime and slow segments, and the
   capture artifacts. With no samples it prints `unobserved`; absence is never reported as
   0% availability.
   The summary also reports observed and unobserved time: a gap between probe runs or
   between samples wider than max(three sample intervals, 15 seconds) is reported as unobserved, not as downtime.

2. **Offline log view**, always available even if the probe never ran: process starts per
   UTC day from the lifecycle log, repository attach durations from
   `repo_attach_completed.durationMs`, and unavailable intervals. A normal restart is dated
   by `process_exit → next process_start`. A generation with a start and no exit is dated by
   that pid's last conn activity and labelled `unrecorded-stop` — this is how the 56-minute
   wedge on 2026-11-03 appears. The conn log also yields "silent" intervals with no request
   activity; they are reported separately and are not counted as downtime.

A fixed cutoff uses only log evidence at or before that time, never the current PID. Both logs are streamed line by line; the summary keeps only per-pid first/last timestamps and
a one-byte-per-minute activity bitmap, so a 70 MB conn day is not loaded into memory.

## Keep it running without installing it here

Installing a resident service is a host change. The commands below are examples for the
machine owner; this repository does not install them.

macOS `launchd` user agent (`~/Library/LaunchAgents/com.example.harness-probe.plist`) — replace
the placeholders with the absolute `ha` and user-root paths for that machine:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.harness-probe</string>
  <key>ProgramArguments</key><array>
    <string>HA_ABSOLUTE_PATH</string><string>daemon</string><string>probe</string>
    <string>--user-root</string><string>USER_ROOT_ABSOLUTE_PATH</string>
    <string>--daemon-id</string><string>default</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>USER_ROOT_ABSOLUTE_PATH/logs/daemon-probe.stderr.log</string>
</dict></plist>
```

Linux systemd user unit (`~/.config/systemd/user/harness-probe.service`):

```ini
[Unit]
Description=Harness Anything external daemon probe
After=default.target

[Service]
ExecStart=HA_ABSOLUTE_PATH daemon probe --user-root %h/.harness --daemon-id default
Restart=always
RestartSec=5
StandardError=append:%h/.harness/logs/daemon-probe.stderr.log

[Install]
WantedBy=default.target
```

Enable with `systemctl --user daemon-reload && systemctl --user enable --now harness-probe`.
The probe writes only its own timeline and capture files; rotating or shipping those files is
outside this command.
