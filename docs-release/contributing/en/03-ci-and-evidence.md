# CI and evidence

The current commands for targeted tests, manifest-selected workflow jobs, the
narrow local GitHub-credential exception, and typecheck live in
[Run local gates](../../../skills/harness-contributing/SKILL.md#run-local-gates).
That section is the executable authority; this page explains what the results
mean.

## Gate authority

`tools/gate-manifest.json` classifies gates by tier and maps them to GitHub
workflow jobs. Contributors select the job that owns their changed surface and
run it through the manifest runner. A remembered list of package scripts is not
equivalent, because the manifest and workflow can evolve.

GitHub's required PR contexts remain authoritative. A local pass is evidence
for review, not permission to waive CI. Likewise, the aggregate full-check lane
used on `main`, schedules, or manual dispatch is not the standard pre-PR loop.

## Evidence standard

Useful evidence names the exact command, result, scope, and any reason it was
not run. Confidence language and a bare “not needed” are not evidence. The PR
should make it possible for a reviewer to distinguish a passing relevant check,
an unrelated check intentionally omitted, and a check still pending in GitHub.

When a check fails, read its output, repair the contribution branch, rerun the
smallest proving test and affected manifest job, and let GitHub evaluate the new
commit. A failed gate remains part of the review record; it is not a reason to
rewrite history or bypass protection.
