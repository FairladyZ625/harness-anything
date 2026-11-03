# Center load and incident bench

The bench starts one dedicated product daemon and one load generator. Up to 1,000 lightweight
TLS replication sinks run in the generator process. Each campaign owns a temporary repository,
user root, certificate, ports and sockets, and closes them on completion. It never connects to a
resident daemon. Product code is unchanged.
RPC replay uses the daemon's local JSON-RPC socket. Fleet admission, replication, backups and
document uploads use TLS. WAN latency and per-request remote-proxy authorization are unverified.

Run the two registered tests through your repository's isolated-test dispatcher:

```sh
node <isolation-dispatcher> --file tools/scale/center-model.test.mjs \
  --file tools/scale/center-bench.integration.test.mjs
```

Ordinary tests use 225 synthetic events, 135 documents and two replica clients. Large campaigns
must run on the test server, within the dispatcher's reservation. Do not run them on a developer
host, start Docker locally, or point them at an existing daemon.

## Synthetic ledger

The scale-one profile targets 225,000 events, 135,000 distinct logical documents, 5,000 tasks and
1.9 GB of serialized event and document JSON. Scale 0.1 and 10 multiply these counts. Large JSON
documents are 10, 50 and 286 MB at scale one; scale ten repeats that size distribution instead of
making a string larger than the supported runtime permits. Calibration profiles below one scale
their large documents down as well.

The production preset compiler creates task bootstrap events. Four canonical runtime events seed
one installation, dispatch/definition and exited session, without starting an agent. Remaining events write synthetic
JSON documents with the production opaque-text policy; later rewrites retain the same content.
The production SQLite append boundary validates and persists these events. Fixture construction
batches up to 256 events per transaction and excludes command/CLI overhead. Its output is an
ordinary canonical SQLite ledger, not a collection of JSON files approximating the schema.
Before launching the daemon, the production Git/worktree followers settle the offline seed. Cold
attachment therefore does not inherit an artificial backlog of unpublished fixture documents.
The follower cut is recorded. The product's normal attach budget remains enabled; the controller
records state transitions and resource samples and waits at most ten minutes for background
attachment to become ready.
Readiness probes run at 250 ms cadence; local lifecycle-event checks run at 25 ms cadence.
Both wait for observed state transitions and stop at their watchdog deadline.

This matches counts and document sizes, not production's lifecycle, runtime, relation, fact or
historical object-churn distributions. Each report states actual counts, event types, JSON bytes,
large-document sizes and deviation from the requested profile. Read latency involving empty
runtime histories is not evidence about a populated runtime history.

Inside an already isolated benchmark environment, generate a reusable new repository:

```sh
FLEET_STRESS_CENTER_ISOLATED=1 node tools/scale/center-bench.mjs generate \
  --scale 1 --seed 20261103 --out <new-directory>
```

Existing directories are refused. The generated `.harness/center-bench-ledger.json` describes the
fixture. Reproducibility compares canonical event serialization and content objects; SQLite
history identifiers and acceptance timestamps are storage-owned and are not byte-identical files.

## Measured traffic

```sh
node tools/scale/center-bench.mjs model \
  --log <daemon-conn.jsonl> --log <rotated-daemon-conn.jsonl> \
  --from <ISO-time> --until <ISO-time> --out <model.json>
```

Extraction streams JSONL, sorts request starts, and retains method, command, arrival offset and
an anonymized connection number. It removes repository IDs, actor identities, PID and payloads.
It includes hello requests, reports dropped log lines, and derives read/write classification from
production declarations (repo-write and arbiter are writes). The mean rate includes empty
seconds; busy-second quantiles use occupied seconds. Malformed input and unknown methods fail.

Because connection logs omit payloads, commands need synthetic bindings. The built-in workload
covers representative task/document reads, a fact write, and GUI polling (`observe.tail` and
`repo.agentRuntime.overview`). Unbound commands stop replay before issuing traffic. Programmatic
`replayTraffic` and the isolated CLI `--bindings <json>` accept exact `method:command` to synthetic
parameter mappings. Do not pass production request payloads or credentials.
The default GUI calibration keeps one events cursor per modeled node: it bootstraps history,
then passes the returned live cursor to follow requests, matching the GUI's transport behavior.
It also exercises every method in the supplied measured baseline window. Session-detail lookups
use the terminal synthetic session; one sample does not reproduce a populated runtime history.
Trace arrivals remain open-loop; GUI rendering, page-driven catch-up cadence and provider discovery
are not measured. Custom bindings retain control of their own payloads.

Replay preserves a one-times trace's method composition, gaps and connection reuse within the
selected duration; arrivals at or after `durationMs` are excluded. Each node
gets the same trace at the same time. A missing hello at a window boundary adds an explicitly
counted handshake. Connections close after their last scheduled operation settles. Arrival
iteration uses O(trace + clients) memory instead of constructing N copies. Requests run on an
arrival schedule; a concurrency overflow is recorded as `generator_concurrency_limit` and makes
that curve point invalid. Histograms retain three significant figures and bounded memory.

## Server campaign and individual faults

```sh
node <isolation-dispatcher> --target server \
  --file tools/scale/center-bench.integration.test.mjs \
  --test-env FLEET_STRESS_CENTER_ISOLATED=1 \
  --test-env FLEET_STRESS_CENTER_SCALE=1 \
  --test-env FLEET_STRESS_CENTER_NODES=1,10,100,500,1000 \
  --test-env FLEET_STRESS_CENTER_DURATION_MS=10000
```

`FLEET_STRESS_CENTER_MODEL` carries base64-encoded model JSON in the same dispatcher call. The
optional `FLEET_STRESS_CENTER_SCENARIOS` selects comma-separated faults; an empty value measures
capacity only. For example, `--test-env FLEET_STRESS_CENTER_SCENARIOS=reconnect` selects just the
reconnect fault after the configured capacity points. Unknown names fail before fixture creation.
The
default model is an explicitly synthetic calibration, not a measured traffic claim. Source HEAD,
base, operating system, Node version and scale accompany every report. `CENTER_PROGRESS` frames
include completed curve points; `CENTER_BENCH_REPORT` contains the final machine-readable report
in the dispatcher's returned stdout. `markdownReport` renders the capacity table and fault evidence.
If fixture setup fails, the report retains its source, error, completed ledger metadata and attach
resource samples, with empty capacity/fault arrays. The standalone CLI saves both reports and
exits nonzero; missing measurements are not success values.
Cleanup retains the last 100 product lifecycle records and the bounded child-stderr buffer, so a
background attach failure after the initial deadline is not lost when the temporary root is removed.
Failed fault controls retain diagnostic samples and business probes. A capacity-stage exception
retains completed points and a `campaignError`; the CLI exits nonzero for incomplete setup or capacity.
The short integration calibration asserts successful fault plumbing. Opt-in pressure runs assert
report completeness and pilot wire composition; failed fault outcomes remain measurements rather
than SLO passes. Always inspect errors, outage duration and invalid-point reasons.

Inside an owner-prepared isolated environment, the equivalent standalone command is:

```sh
FLEET_STRESS_CENTER_ISOLATED=1 node tools/scale/center-bench.mjs run \
  --model <model.json> --scale 1 --nodes 1,10,100,500,1000 --out <report.json>
```

Add `--scenario <name>` to run one named fault (repeat to select several):

| Name             | Real boundary exercised                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `drain-hang`     | Hold a RepoCell close, observe the drain, release it, and await `build_superseded` plus the replacement listener.     |
| `build-switch`   | Trigger the product build observer on the second scheduled request while replay continues.                            |
| `reconnect`      | Disconnect every warm replica, then reconnect all sockets simultaneously and measure individual recovery times.       |
| `base-backup`    | Start a replica at null position and consume the product base backup over TLS.                                        |
| `large-document` | Read the largest generated JSON document and attempt a same-size Fleet upload; report admission failures as failures. |
| `slow-read`      | Run eight simultaneous largest-document reads while sampling daemon responsiveness and event loop delay.              |
| `legacy-frame`   | Send old v2 backup metadata through a real current TLS edge stream and record the rejection and process survival.     |

Faults are triggered by observable request/close boundaries. No test sleeps arrange intermediate
states. An external watchdog bounds each control operation. The harness does not replace product
drain logic or inject a fake CPU spin. The historical edge binary is not exercised by the legacy
metadata probe; it cannot prove the original crash occurred in that binary.

## Reading reports

Read/write p50 and p99 cover successful requests from scheduled arrival to terminal reply,
including generator lag. Error rate includes all scheduled requests, including overload drops.
Throughput uses successful terminal replies. Failed-request exposure is reported separately from
unavailability, which is measured by ready-state `repo.tasks.list(limit=1)` probes at 250 ms cadence. CPU, RSS and event
loop delay are sampled in the dedicated daemon process, not the generator. Monitor IPC adds one
sample/s; probes add four requests/s plus their hellos.
The product's independent diagnostic socket (task_97df73f5) is also sampled once/s during load,
and every 10s during attachment. Reports retain heartbeat age, current RSS, the age and values of
the product's last histogram window, up to 20 active operations, and bounded recent stack evidence.
Product histogram windows are normally 10s and can be stale during a stall; independent heartbeat
and RSS remain live. The bench's 1s histogram is a separate measurement, labeled in `daemonSamples`.

Curves are warm-cache measurements in increasing node order. A warm replica starts at the current
replication head. A synthetic ACK does not write an edge database or run an edge projection; the
instrument measures center cost and recovery, not end-to-end edge durability. Fresh admission is
measured by the separate base-backup case. Inspect connected node counts, generator lag, errors,
resource samples, fixture deviations and source identity before drawing an SLO conclusion.

The implementation reuses the existing stress controller's watchdog, the storage store fixtures,
the accepted CLI entity bench's preset bootstrap path, and the real daemon/fleet protocol codecs.
Successors start in fresh OS processes, matching product cache lifetimes. Authorization uses the
repository Keycloak fixture and one owner with multiple device sessions; real IAM capacity is
not measured. No benchmark-only product endpoint or second action registry is introduced.
