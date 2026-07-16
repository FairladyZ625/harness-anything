# @harness-anything/adapter-github-issues

Read-only GitHub Issues adapter for fresh issue snapshots and repository-scoped
lists. It implements the current `LifecycleEngine` read shape without adding a
kernel port, local cache, binding/import path, or authored write.

## Capabilities

- `snapshots: true`
- `listTasks: true`
- `publishNote: false`

The provider exposes no close, reopen, transition, label, assign, comment, or
other external lifecycle write method. Its transport accepts only `GET`.

## References and projections

Snapshot input accepts `owner/repo#number` or a standard
`https://github.com/owner/repo/issues/number` URL. Both normalize to lowercase
`owner/repo#number`. Pull Request URLs and API responses carrying the
`pull_request` marker are rejected as `RefNotFound`.

Fresh snapshots use the existing `TaskSnapshot` shape with
`source=external-engine`, `engine=github`, the normalized ref, raw GitHub
status, title, URL, optional assignee, and injected-clock `fetchedAt`.

Closed status is deterministic: `completed` and legacy null reasons map to
`done`; `not_planned` maps to `cancelled`. Open issues use the documented
minimal heuristic order: blocked/on-hold label, review label, assignee, then
planned. The label layer never creates terminal status. Unsupported states or
closed reasons return `unknown` with `status_unmapped` in the snapshot warning
slot. Package options can replace the non-terminal label mapping; no broader
default label vocabulary is inferred.

## Authentication and errors

The default credential resolver checks source categories in this order:
`GH_TOKEN`, `GITHUB_TOKEN`, then fixed-argv `gh auth token`. The adapter does not
read keychain files or implement OAuth. Credentials exist only in provider
memory and the outbound Authorization header; they are not included in refs,
snapshots, errors, receipts, logs, fixtures, or cache keys.

Missing credentials fail before transport with `AuthMissing`. GitHub 401/403,
404, rate limit, network, timeout, and malformed payloads map to the existing
typed `EngineError` variants. HTTP response bodies and credential values are
discarded at error boundaries.

## CLI

```text
ha snapshot github owner/repo#123 --json
ha list github owner/repo --json
```

`list github` also accepts optional `--raw-status` and `--label` filters. Both
commands directly compose this read provider and do not enter daemon write,
SME, task lease, doc-sync, or local mutation paths.

## Hermetic verification

```text
node tools/run-node-tests.mjs --tier fast --prefix packages/adapters/github-issues
node tools/run-node-tests.mjs --tier contract --prefix packages/adapters/github-issues
node tools/run-node-tests.mjs --tier integration --prefix packages/cli/test/github-issues
```

Tests use sanitized REST v3 fixtures, fake credentials, fake subprocesses, a
fake clock, and fake GET transport. They do not access the network, process
credential environment, GitHub CLI credential store, or an OS keychain.

An optional manual smoke may use an operator-provided credential source and a
dedicated public test repository. Do not persist the shell environment, raw
private response, Authorization header, or command output in the repository or
task ledger.
