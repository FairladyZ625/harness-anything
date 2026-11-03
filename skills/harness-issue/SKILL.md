---
name: harness-issue
description: File a public issue in FairladyZ625/harness-anything from a finding — decide whether it is public, collect command and version evidence, fill the canonical source-triaged body, redact private data, and publish with `gh issue create --body-file`. Use when a user asks to file an issue, report a bug, send feedback, draft an issue, or turn a discovery into a public issue.
---

# Harness Issue

This is the executable path from a finding to a public issue that matches this
repository's form. It ends when the issue exists and carries every required
section; the contribution path starts only after a maintainer accepts it.

## Boundary

Use this skill when a finding should become a **new public issue** in
`FairladyZ625/harness-anything`.

Do not use it for:

- **Security vulnerabilities or private reports.** Use the security advisory
  entry in [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)
  instead of a public issue.
- **An issue that already exists.** Comment on that issue with new evidence
  instead of opening a duplicate.
- **Repairing an existing issue into a task evidence bundle.** That is the
  `github-issue-repair` preset's job, not this skill's.
- **Implementing an accepted issue.** Route to
  [`harness-contributing`](../harness-contributing/SKILL.md) after acceptance;
  this skill stops at the filed issue.

## Contract source

The shape has one authority: [`.github/ISSUE_TEMPLATE/issue.yml`](../../.github/ISSUE_TEMPLATE/issue.yml).
Its labels render as `### <label>` in the submitted body. Do not restate or
invent labels here.

| Source | What it owns |
| --- | --- |
| [`.github/ISSUE_TEMPLATE/issue.yml`](../../.github/ISSUE_TEMPLATE/issue.yml) | Required and optional sections, descriptions, and placeholders |
| [`.github/workflows/issue-intake.yml`](../../.github/workflows/issue-intake.yml) | Comments when a required section is missing; never closes the issue |
| [`references/issue-body-template.md`](references/issue-body-template.md) | The only copyable body skeleton |
| [`references/field-guide.md`](references/field-guide.md) | Enter/exit conditions and evidence commands per section |

`tools/skill-contracts.test.mjs` asserts that the intake list matches the
form's required sections and that the template covers the same form headings. If
you change one, change all three in the same change and run
`node --test tools/skill-contracts.test.mjs`.

## Procedure

### 1. Decide whether it belongs in public

File an issue when the finding is one of:

- a reproducible bug;
- a documentation gap or misleading public wording;
- a scoped improvement with a user-visible outcome;
- a failing command or CI lane with enough public logs to investigate.

Do not file when the report needs credentials, private harness records,
private URLs, or local-only plans. Reduce it to the public symptom first, or
stop. A broad roadmap debate is not an issue.

### 2. Collect evidence before drafting

Run only read-only commands that are safe in the current checkout, and capture
the exact command plus its exit code:

```bash
ha --version
ha daemon status
git branch --show-current
git rev-parse --short HEAD
node --version
npm --version
```

From `ha daemon status`, copy the `commit=` field for Version / build. For a
failing command, keep the smallest relevant stdout/stderr and its exit status:

```bash
<failing-command>; printf '\nexit=%s\n' "$?"
```

If the finding has a visible surface, capture a screenshot or recording and
attach or link it. If it does not, leave the optional Screenshot or recording
section out of the body; text evidence belongs in Command output or logs.

### 3. Fill the canonical body

Copy the skeleton to a temporary file, then fill it:

```bash
body_file="$(mktemp "${TMPDIR:-/tmp}/harness-issue-body.XXXXXX")"
cp skills/harness-issue/references/issue-body-template.md "$body_file"
```

Keep every required `### <label>` line exactly as written. Include the optional
`### Screenshot or recording` section only when there is visible evidence to
attach or link; delete it otherwise. Replace every italic hint with real content;
do not delete a required heading. Use
[`references/field-guide.md`](references/field-guide.md) when a section is
unclear.

Write the body file to the task worktree or the system temporary directory.
Never write it to the repository root or to a tracked path.

### 4. Redact before publishing

Remove or replace:

- absolute local paths such as `/Users/<name>/...`, `/home/<name>/...`, or
  `C:\Users\<name>\...` — use repository-relative paths;
- tokens, credentials, `Authorization` headers, and secret-looking values
  (`ghp_`, `github_pat_`, `sk-`, `Bearer`, `AKIA`);
- private harness records, task or decision text, private URLs, and local-only
  generated caches.

Scan the body and fix every hit:

```bash
grep -nE '/Users/|/home/[^/]+/|[A-Za-z]:\\Users|ghp_|github_pat_|sk-[A-Za-z0-9]|Bearer |Authorization:' "$body_file"
```

### 5. Write the title

Use the form prefix plus one focus:

```text
[Issue]: <one concrete symptom>
```

Keep the whole title within about 56 columns. Move environment, speculation,
and the proposed fix into the body.

### 6. Self-check the shape

Every required heading must be present (empty output means ready):

```bash
comm -23 \
  <(awk '/^      label: /{label=substr($0,14)} /^      required: true$/{print "### " label}' \
    .github/ISSUE_TEMPLATE/issue.yml | sort) \
  <(grep '^### ' "$body_file" | sort)
```

The body must not introduce a heading the form does not define (empty output
means ready):

```bash
comm -13 \
  <(sed -n 's/^      label: /### /p' .github/ISSUE_TEMPLATE/issue.yml | sort) \
  <(grep '^### ' "$body_file" | sort)
```

The optional `### Screenshot or recording` section may be present or absent. A
non-empty result means fix the body; do not publish yet. Also confirm the title
starts with `[Issue]: ` and the body has no redaction hit from step 4.

### 7. Publish and read the result

```bash
gh issue create --repo FairladyZ625/harness-anything \
  --title "[Issue]: <focus>" \
  --body-file "$body_file"
```

Record the returned issue URL and number. If the intake workflow comments that
sections are missing, edit the same issue instead of opening a second one:

```bash
gh issue edit <number> --repo FairladyZ625/harness-anything --body-file "$body_file"
```

The intake workflow runs on `opened` only, so the edit will not trigger a
second comment.

### 8. Route downstream

Once a maintainer accepts the issue for implementation, continue with
[`harness-contributing`](../harness-contributing/SKILL.md). It owns the
worktree, scoped tests, PR body, and review path. This skill grants no merge
authority.

## Failure branches

| Symptom | Action |
| --- | --- |
| `gh: command not found` | Stop and report the exact command. Do not substitute a hand-written HTTP call. |
| `gh auth status` reports no login | Stop. Do not ask for or paste a token into the issue or the body file. |
| Blank issue entry is disabled | Expected. Publish with `--body-file`, not through the blank editor. |
| Intake comments that sections are missing | Edit the issue with the same body file. Do not open a duplicate and do not remove required headings to make the comment go away. |
| The redaction scan prints a hit | Remove the value, then rerun the scan before publishing. |
| The self-check prints a heading | Fix the body until both self-check commands print nothing; the form and template are authoritative. |
| The issue needs private data to be actionable | Stop and report what cannot be shared; publish only the public symptom if that is still useful. |
| The finding is a security vulnerability | Stop. Use the security advisory entry in `.github/ISSUE_TEMPLATE/config.yml`. |
| An equivalent issue already exists | Comment with the new evidence instead of filing a duplicate. |

## Evidence to report

Report back:

- the issue URL and number, or the exact step that stopped the run;
- the title and the body-file path;
- the required-heading self-check result (empty or the failing lines);
- the redaction-scan result (no hits or the removed values, without repeating
  the secret itself);
- commands run and commands not run, with the reason.
