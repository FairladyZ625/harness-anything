# Pull requests and integration supervision

## Keep delivery states distinct

Track implementation, local verification, submitted cut, published branch, pull request, remote checks, review, merge, release, and adoption as separate states. Never describe a pending or missing check as green. Read the task's actual submit and review records as well as the hosting platform's PR state.

For repository tasks, use `ha task submit <task-id>` to freeze the current delivery cut and start the configured review flow, then `ha task push <task-id>` to publish the task branch. Create or update the PR through the host's available CLI or UI. Confirm it points at the submitted head and intended base. Do not use a parallel ad hoc push path when the task flow owns publication.

## Review and merge in order

1. Confirm the submitted commit and PR head match; inspect the full diff and changed-path scope.
2. Confirm every required check has completed successfully. If no checks are reported, first inspect PR state and whether the workflow could run; missing results are not a pass.
3. Read independent review findings against the submitted content. Verify them in the diff or behavior, then repair confirmed blockers and republish the new cut. Do not treat approval as proof of the semantic goal.
4. Complete required content-pinned consent through `ha task review-consent` when the task lifecycle calls for it.
5. Merge only after checks, review, consent, conflict resolution, repository policy, and user authorization are satisfied.
6. Verify the host reports the intended merge commit. Then complete the task record and, if applicable, its work root through their normal lifecycle.

The CEO or explicitly authorized integrator owns PR creation, merge, and post-merge accounting. A worker's assigned implementation or local commit does not grant these permissions. Never merge first and add review evidence afterward.

If the host presents automated review findings, treat them as claims: verify each material finding against the exact cut, route confirmed blockers for repair, and record why a finding does not apply. Do not wait for an optional second scan when required checks and review are already complete. Repeated queue failures without new evidence call for diagnosis of the integration contract, not blind requeueing.

## Diagnose integration failures without weakening the contract

Read the exact failing check and run context. Distinguish a code regression, environment failure, missing workflow, stale PR head, merge conflict, required-check configuration problem, and a failure already present on the base. Verify the base-side behavior before attributing a failure to the change.

For a blocked PR queue, inspect the merge state before treating absent check results as pending. Determine which required checks actually apply, whether the expected job can report on this event, and whether a merge conflict prevented the workflow from starting. Do not delete, bypass, make optional, or extend a required gate simply to make a PR merge. Changes to protected CI or branch policy require their normal governance and authorization.

For dependent PRs, state the dependency graph and intended merge order. Use stacked changes only when each child has a clear base and the host's check semantics are understood. After each base moves, verify the resulting PR head and rerun affected evidence. If the host or task contract does not support safe stacking, serialize integration.

## Treat post-merge failures as new evidence

If main or the deployed product fails after merge, preserve the exact commit, run, and artifact. Determine whether the failure belongs to the merged change, the integration base, or the deployment path. Start the authorized repair process without hiding the incident. Do not rewrite history or directly overwrite a protected branch as a shortcut.
