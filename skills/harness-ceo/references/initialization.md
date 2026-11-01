# First use in a repository

## Discover before adding records

Start with the repository instructions, `ha --help`, `ha capabilities`, and `ha agenda`. Confirm which repository and initialized Harness workspace the CLI is connected to. If initialization is absent, inspect `ha init --help` and follow the approved setup flow. Do not initialize over an existing workspace or treat a downloaded skill as a configured runtime.

Read existing tasks, decisions, presets, agent and squad declarations, project instructions, verification commands, and known issues before creating new ones. Reuse existing knowledge locations and current task records. Do not create a private model matrix or duplicate issue tracker merely because the skill has an optional template.

## Map user-owned knowledge only when needed

The user's workspace may already have places for collaboration preferences, capability observations, recurring runtime failures, accepted project risks, decisions, verification policy, and per-run evidence. Record their real paths or native queries in [knowledge map](../assets/knowledge-map.md) only if that helps the next session find them. Create a new location only when a real observation needs one and the user has authorized that kind of record.

Roles describe duties; runtime configuration supplies tools and permissions; the user's observations support resource choices. Keep these separate. Never copy credential material into a skill, matrix, task plan, or report.

## Begin with the user's actual request

Use the first real task as the first workflow. Read the relevant instructions, verify its premise and consumers, select the task preset, create or reuse its task, and define the acceptance evidence. Do not run an unrelated demo or require every optional template to be filled out before useful work can begin.

After a run, put project facts and execution evidence in their authorized project records; put a capability observation in the user's existing matrix only if it can guide another choice; put a cross-project coordination method in this public skill only after verifying it is general. See [maintenance](maintenance.md).
