# PR #1799 CI Repair Report

## Failure Root Cause

The task-scoped local doc action falsely required an empty `paths` field alongside the lifecycle-known `taskId`, while two integration fixtures still invoked the removed public `--execution-id` doc-sync option.

## Design Conclusion

Task-scoped and path-scoped local doc actions are closed alternatives: task mode sends exactly `{ kind, taskId }`, while non-task mode sends exactly `{ kind, paths }`. This matches the public rule that a task id replaces scanner paths, lets `task complete` reuse its lifecycle context without fabricating an empty field, and rejects mixed actions instead of adding a compatibility layer.

## Modified Files

- `packages/cli/src/cli/thin-command-doc.ts`
- `packages/daemon/src/doc-sync-adjudication.ts`
- `packages/cli/test/thin-command-script-doc-runtime.test.ts`
- `packages/daemon/test/doc-sync-slice-a.test.ts`
- `packages/cli/test/daemon-multi-repo-lifecycle-cli.test.ts`
- `packages/cli/test/task-closeout.integration.test.ts`
- `artifacts/reports/task_2777d62ff4991eeb29c8bd2abc-pr-1799-ci-repair.md`

## Observed Evidence

Initial isolated positive control:

```text
PASS hermetic test configuration
tests 1; pass 0; fail 1
code: unknown_field
nextAction: Unknown option --execution-id. Run ha doc sync --submit --help.
[test-isolation] target=ubuntu exit=1
```

Final isolated integration runs after rebasing `origin/main` at `3ce49cb40094e8d4f96f0daaad2c005e83720419`:

```text
PASS hermetic test configuration
daemon-multi-repo-lifecycle-cli.test.ts: tests 2; pass 2; fail 0; target=ubuntu exit=0
task-closeout.integration.test.ts: tests 1; pass 1; fail 0; target=ubuntu exit=0
task-closeout-docs-ci.integration.test.ts: tests 1; pass 1; fail 0; target=ubuntu exit=0
doc-sync-slice-a.test.ts: tests 6; pass 6; fail 0; target=ubuntu exit=0
```

Focused fast parser:

```text
tests 5; pass 5; fail 0
```

Final local gate using Node `v24.18.0`:

```text
G36 line-density: pass
typecheck: pass
test:fast: tests 334; pass 334; fail 0
test:contract: tests 588; pass 588; fail 0
lint: pass
Local check passed (fast tier) in 135.6s.
```

Production delta against `origin/main` with the corrected declaration:

```text
production +68/-31
G33 production-delta: pass
```

Final declaration required in the English block:

```text
Production-Delta: +68/-31
```

Chinese block value: `生产代码变更：+68/-31`.

## Remote PR Body Status

The PR body was read from the public GitHub API, but this worker could not write it because `gh pr view 1799` returned:

```text
To get started with GitHub CLI, please run: gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
```

No push, PR edit, or other remote mutation was performed.

## Residual Risk And Unverified Items

- GitHub CI after the local commit is unverified.
- PR #1799 still declares the stale Production-Delta until an authenticated actor applies `+68/-31` in both language blocks.
