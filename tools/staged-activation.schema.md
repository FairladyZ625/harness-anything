# Staged Activation Registry Schema

`tools/staged-activation.json` is the machine-readable inventory of contracts
that exist in production source but are not yet connected to a production
composition root. The registry makes that deliberate phase visible without
calling it a defect or silently treating an unexecuted probe as evidence.

## Top-Level Shape

- `schema`: stable schema id. The current value is
  `harness-anything/staged-activation/v1`.
- `schemaDocumentation`: this document's repository-relative path.
- `islands`: array of staged activation entries. IDs must be unique.

Unknown top-level and entry fields are rejected so misspelled policy does not
become inert configuration.

## Island Entry

Every island declares:

- `id`: stable kebab-case identifier.
- `description`: the production capability whose composition remains staged.
- `probe`: a structured, non-shell command object described below.
- `anchor`: the owning `task_*` or `milestone_*` identifier.
- `registeredAt`: UTC calendar date in `YYYY-MM-DD` form.
- `expiresAt`: optional UTC calendar date. This is the first date on which an
  inactive island is overdue, so `today >= expiresAt` is red.

`expiresAt` cannot precede `registeredAt`. Removing an activated entry is a
normal implementation change and preserves the history in Git.

## Probe Command

`probe` has exactly these fields:

- `command`: must be `node`.
- `args`: argument vector. The first argument must be
  `tools/probe-production-consumer.mjs`; no shell command string is accepted.
- `timeoutMs`: integer from 100 through 30000.

The fixed executable shape is deliberate: registered probes are read-only
TypeScript import-graph queries, not an extensible command-execution allowlist.
The runner uses `shell: false`, bounds captured output, and terminates probes at
their declared timeout.

Each probe follows this exit protocol:

- `0`: activated; a production consumer was found. The registry entry is now
  stale and must be removed.
- `1`: inactive; no qualifying production consumer exists.
- `2` or greater, a signal, spawn failure, or timeout: instrument error. This
  is never reclassified as inactive.

## Runner Result

`tools/run-staged-activation.mjs` prints the required inactive, activated, and
overdue counts plus any instrument errors. It exits:

- `0` when every entry is inactive and not overdue;
- `1` when an entry is activated-but-registered or overdue-and-inactive;
- `2` when the registry or a probe is invalid, fails, or times out.

The third state is intentionally fail-loud: a broken instrument cannot provide
honest evidence that an island remains inactive.
