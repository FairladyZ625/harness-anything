# Field guide

Use this with [`issue-body-template.md`](issue-body-template.md). The headings
come from [`.github/ISSUE_TEMPLATE/issue.yml`](../../../.github/ISSUE_TEMPLATE/issue.yml);
this guide only explains when a section is ready.

| Section | Enter when | Exit when | Evidence command or source |
| --- | --- | --- | --- |
| `Issue type` | The finding fits exactly one public category. | One of Bug, Documentation gap, Scoped improvement, or Failing command or CI lane is selected. | The failing surface and the user-visible outcome. |
| `Impact` | Actual behavior is known. | All five lines are answered: who is affected, how often, what breaks, the workaround, and the blast radius. | The report or reproduction that shows the scope; no telemetry is required. |
| `Expected behavior` | The desired result can be stated without naming an implementation. | One observable outcome is written. | The contract, docs, or prior behavior that sets the expectation. |
| `Actual behavior` | The observed result is reproducible or was captured once. | The observed result is written separately from the proposed fix. | The failing run, screenshot, or log. |
| `Reproduction steps` | The smallest repeatable sequence is known. | Ordered steps start from a clean checkout, include the exact command, and report the exit code. | The command sequence itself. |
| `Version / build` | The failing run and the tool versions are known. | `ha --version`, daemon `commit=`, branch or commit, package version, and agent/runtime are listed. | `ha --version`; `ha daemon status`; `git branch --show-current`; `git rev-parse --short HEAD`; `npm pkg get version`. |
| `Screenshot or recording` | The finding has a visible surface. | Visible evidence is attached or linked. Omit the section when there is nothing to show; text evidence belongs in Command output or logs. | The capture, or the finding is text-only and the section is omitted. |
| `Command output or logs` | A command or log shows the failure. | The exact command, exit code, and smallest relevant stdout/stderr are present, with secrets redacted. | `<command>; printf '\nexit=%s\n' "$?"` |
| `Reporter environment` | The finding depends on a host or runtime. | OS, shell, Node, package manager, branch or commit, and agent/runtime are listed. | `uname -srm`; `printf '%s\n' "$SHELL"`; `node --version`; `npm --version`; `git branch --show-current`; `git rev-parse --short HEAD`. |
| `Source-level triage` | At least one public source path, contract, or generated artifact was read. | One section states all five parts: what was read, the source-level hypothesis, what to investigate first, checks run, and checks not run with the reason. | `git grep -n '<symbol>' -- <path>`; `git log --oneline -- <path>`; the relevant test command and its result. |
| `Stop condition or acceptance criteria` | The fix can be described as an observable end state, or a maintainer decision is needed first. | The end state is checkable, or the decision is named. | The command, page state, or decision that ends the work. |
| `Public issue checklist` | The body is otherwise complete. | All three assertions are true: redaction done, source triage present, Impact quantified. | Re-read the body and rerun the redaction scan. |

## Source-level triage is one section, not four

Write the five parts in one pass:

- **Read:** public files, functions, schemas, contracts, generated artifacts, or
  docs, using repository-relative paths.
- **Hypothesis:** which data flow, path handling, command contract, platform
  assumption, or validation rule is failing.
- **Investigate first:** the file, function, validation rule, or test a
  maintainer should open first. This is directional input, not authority over
  the final fix.
- **Checks run:** the exact commands and their results.
- **Checks not run / why:** every skipped check and its reason.

Keep history searches bounded: use `git log --oneline -- <path>` first. Do not
run an all-history `git log -S` without a path; narrow the commit set before
asking what changed.

## Ready-to-publish check

The body is ready when:

1. every required `### <label>` from the form is present and unchanged;
2. both self-check commands in the skill print nothing;
3. the redaction scan has no hits;
4. the optional Screenshot or recording section is present only when it carries
   visible evidence, and the title starts with `[Issue]: ` and names one focus.

If any item is false, fix the body. Do not publish a partial body and wait for
the intake comment to list the gaps.
