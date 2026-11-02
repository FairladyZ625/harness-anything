# Filing GitHub issues

GitHub issues are the public intake path for bugs, documentation gaps, and
small scoped improvements. Write the issue so a maintainer or coding agent can
reproduce the problem when possible and can always triage the likely source
boundary from public source-level evidence.

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

Use the repository's source-triaged issue form. Blank issues are disabled for
contributors. If a required section is missing, the issue intake workflow
comments with the missing sections; it does not close the issue, and you can
edit the issue to complete it.

Every issue includes these sections:

| Section | What to include |
| --- | --- |
| Issue type | One of Bug, Documentation gap, Scoped improvement, or Failing command or CI lane. |
| Impact | Who is affected, how often it happens, what breaks, the workaround, and the blast radius. |
| Expected behavior | What should happen. |
| Actual behavior | What happened instead. |
| Reproduction steps | The smallest ordered steps from a clean source checkout, with the exact command and exit code. |
| Version / build | `ha --version`, the daemon build or `commit=`, the repository branch or commit, the npm package version when relevant, and the agent/runtime version. Keep OS and shell details in Reporter environment. |
| Screenshot or recording | Visible evidence when one exists. When there is none, write `Not applicable — text evidence in Command output or logs` instead of pasting an unrelated screenshot. |
| Command output or logs | The exact command, exit code, and the smallest relevant stdout/stderr or log excerpt, with secrets redacted. |
| Reporter environment | OS, shell, Node version, package manager, branch or commit, and any agent/runtime involved. |
| Source-level triage | The public files and contracts read, the source-level hypothesis, what to investigate first, checks run, and checks not run with the reason. |
| Stop condition or acceptance criteria | The observable condition that means the issue is fixed, or the maintainer decision needed before implementation. |
| Public issue checklist | Confirm that private data was removed, source-level triage is present, and Impact names the affected users, frequency, and blast radius. |

## Source-level triage

Source-level evidence is what lets a maintainer inspect the likely source
boundary even when they cannot run the reporter's exact environment. Do not
assume maintainers share the reporter's operating system, shell, filesystem,
installed toolchain, or agent runtime.

Write the five parts in the one Source-level triage section:

- public files, functions, schemas, contracts, generated artifacts, or docs that
  were read, using repository-relative paths;
- the source-level hypothesis: which data flow, path handling, command contract,
  platform assumption, or validation rule may be failing;
- the file, function, contract, validation rule, or test case maintainers should
  investigate first;
- checks already run, with their results;
- checks not run, and the reason any relevant check was skipped.

The reporter's agent is not the authority on the final fix. Its repair
suggestion is directional input that helps maintainers locate the likely source
boundary. Maintainers may choose a different implementation after reading the
source.

## Filing as an agent

An agent that turns a finding into a public issue follows
[`skills/harness-issue/SKILL.md`](../../../skills/harness-issue/SKILL.md). The
skill routes the work through evidence collection, the canonical body template,
redaction, a heading self-check, and `gh issue create --body-file`. The issue
form remains the shape authority; the skill does not replace it.

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
  --input issueJson=artifacts/issue-<number>.json
```

Use `issueJson` or `fixtureFile` for deterministic intake. To let the preset make
a live GitHub request, pass `--input fetchMode=best-effort` and
`--input issue=<number>` explicitly; network access is best-effort in preset
sandboxes. The preset writes a structured repair intake under the task's
`artifacts/` directory. It does not merge code, bypass review, or replace the PR
template.

## After a fix

Once an issue is accepted for implementation, continue with the repository's
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) skill.
If the fix changes the issue's assumptions, call that out during scope review
instead of silently broadening the contribution.
