# Project policy settings

Project policy belongs in `harness/harness.yaml` so it is reviewable with the
repository. Environment variables are emergency machine/deployment overrides;
when a command has an explicit flag, that flag remains highest priority.
Invalid YAML or environment values fail before the command creates a write
coordinator or changes repository state.

## Execution consent

```yaml
settings:
  execution:
    consentTtlMs: 86400000
```

`settings.execution.consentTtlMs` controls the independent freshness ceiling
for a matching human execution consent. The default is `86400000` ms (24
hours). `HARNESS_EXECUTION_CONSENT_TTL_MS` overrides YAML. Values must be
positive safe integers in milliseconds. Content-pin, principal, action-scope,
and expiry checks remain mandatory.

## Multica snapshot cache

```yaml
settings:
  adapters:
    multica:
      staleTtlMs: 300000
```

`settings.adapters.multica.staleTtlMs` controls how long a cached Multica
snapshot can remain stale-but-usable when the provider is unavailable. The
default is `300000` ms (5 minutes).
`HARNESS_MULTICA_STALE_TTL_MS` overrides YAML. Values must be positive safe
integers in milliseconds.

The effective precedence for both keys is: environment override, project YAML,
then the documented compiled default. These commands do not currently expose
single-use TTL flags.

## Operational environment overrides

These machine-local limits are not project policy and therefore do not belong
in YAML. Invalid values fail before the associated subprocess, scan, or GUI
window starts.

| Variable | Default | Valid range / precedence |
| --- | ---: | --- |
| `HARNESS_FDE_PROBE_TIMEOUT_MS` | `10000` | `1..120000` ms; detector option/runner injection remains higher priority. |
| `HARNESS_FDE_PROBE_MAX_BUFFER_BYTES` | `1048576` | `1..67108864` bytes. Probe failure remains indeterminate, never encrypted. |
| `HARNESS_GIT_MAX_BUFFER_BYTES` | `268435456` | `1..1073741824` bytes; shared by kernel and local adapter Git subprocesses. |
| `HARNESS_PROJECTION_MAX_CHANGED_PATHS` | `50000` | `1..1000000` paths; overflow still returns `dirty-unbounded`. |
| `HARNESS_RUNTIME_LOG_SEARCH_DEPTH` | `8` | `1..64`; an explicit `RuntimeLogOptions.maxSearchDepth` wins. |
| `ELECTRON_RENDERER_URL` | unset | Development only: `http://127.0.0.1:<explicit-port>`; its validated origin is the single source for load, navigation, IPC trust, and CSP. Remote hosts, HTTPS, credentials, and implicit ports are rejected. |
| `HARNESS_PRESET_CONTEXT_MAX_MILESTONES` | `20` | `1..200`; explicit builder option wins. |
| `HARNESS_PRESET_CONTEXT_MAX_NOTES` | `3` | `1..50`; explicit builder option wins. |

The receipt-honesty benchmark also accepts `HARNESS_BENCH_LOCK_MAX_WAIT_MS`,
`HARNESS_BENCH_LOCK_INITIAL_DELAY_MS`, `HARNESS_BENCH_LOCK_MAX_DELAY_MS`,
`HARNESS_BENCH_BARRIER_TIMEOUT_MS`, and `HARNESS_BENCH_BARRIER_POLL_MS`.
Their matching `--lock-*` / `--barrier-*` flags win over env. Defaults remain
`100/5/10` ms for lock retry and `10000/5` ms for barrier timeout/poll.
