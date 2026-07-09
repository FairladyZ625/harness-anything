# Filing GitHub issues

GitHub issues are the public intake path for bugs, documentation gaps, and
small scoped improvements. Write the issue so a maintainer or coding agent can
reproduce the problem when possible, or triage an environment-specific failure
from source-level evidence when it cannot be reproduced locally.

## When to open an issue

Open an issue for:

- a reproducible bug;
- a documentation gap or misleading public wording;
- a small improvement with a clear user-visible outcome;
- a failing command or CI lane with enough logs to investigate.

Do not open an issue for credentials, private harness records, local-only plans,
or broad roadmap debates. If a report depends on private information, summarize
the public symptom and say what cannot be shared.

## Required issue content

Include:

- expected behavior;
- actual behavior;
- reproduction steps, starting from a clean source checkout when possible;
- exact command output or the smallest relevant log excerpt;
- environment details: OS, Node version, package manager, branch or commit;
- files or package area likely involved, if known;
- whether an agent produced the report or attempted a fix.

For agent-generated issues, also include the agent's evidence boundary: what it
read, what it changed, which checks it ran, and which checks it did not run.

## When maintainers cannot reproduce locally

Some failures depend on the reporter's operating system, shell, filesystem, or
installed toolchain. If a maintainer cannot reproduce the issue locally, the
reporter or the reporter's agent should provide a source-level triage target
instead of only asking the maintainer to recreate the environment.

Include:

- real environment output: command, exit code, relevant stdout or stderr, OS,
  shell, Node version, package manager, and branch or commit;
- key snippets from generated files or logs, using relative repository paths and
  redacting secrets or private data;
- related source areas the agent inspected, such as files, functions, schemas, or
  contracts that appear to control the failing behavior;
- what the agent read, including public docs, source files, generated artifacts,
  and any issue or PR context used for the diagnosis;
- the source-level hypothesis: which data flow, path handling, command contract,
  or platform assumption may be failing;
- a suggested repair target, such as the file, function, contract, validation
  rule, or test case maintainers should investigate first;
- checks already run, checks not run, and the reason any relevant check was
  skipped.

The reporter's agent is not the authority on the final fix. Its repair
suggestion is a directional input that helps maintainers locate the likely
source boundary when the exact environment is unavailable.

## Agent-ready issue shape

A good issue gives an agent a narrow repair lane:

- one concrete problem, not a bundle of unrelated symptoms;
- links to public files only;
- no absolute local filesystem paths, secrets, private notes, or generated
  caches;
- a clear stop condition, such as "the command exits 0" or "the page links to
  the new contribution step";
- any maintainer decision needed before implementation.

If the issue is not ready for implementation, use wording like "needs maintainer
decision" or "needs reproduction" instead of asking an agent to guess.

## Repair flow

Maintainers or authorized agents can use the bundled GitHub issue repair preset
to pull an issue into a task evidence bundle:

```bash
ha preset action github-issue-repair plan \
  --task <task-id> \
  --allow-scripts \
  --input repo=FairladyZ625/harness-anything \
  --input issue=<number>
```

Without `--input issue=<number>`, the preset selects the most recently updated
eligible open issue, excluding labels such as `blocked` and `needs-decision`.
The preset writes a repair plan and an agent prompt under the task's
`artifacts/` directory. It does not merge code, bypass review, or replace the PR
template.

## After a fix

The PR should reference the issue, explain the scope, include verification
evidence, and leave merge authority with maintainers. If the fix changes the
issue's assumptions, say that in the PR body rather than silently broadening the
scope.
