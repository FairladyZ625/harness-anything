---
name: create-skill
description: Write or revise a project skill for a Harness Anything Agent — a SKILL.md with frontmatter, real trigger conditions, executable steps, and an explicit deletion budget, discovered from the workspace or harness skill roots. Use when a user wants to add a skill, teach an Agent a procedure, turn a repeated manual sequence into a skill, or audit an existing skill for entropy.
---

# Create a Skill

A skill is not documentation. It is a **procedure an Agent loads before acting**, discovered by
name, and injected as a path plus a `SKILL.md` the Agent will open. If the Agent could follow the
same steps from the task plan, the skill should not exist. If the Agent must be told the same thing
on every dispatch, that belongs in `instructions`, not a skill.

## Where skills come from

Before writing a path, confirm which root the serving node actually scans. The authoritative reader
is `packages/daemon/src/agent-skills.ts` (`discoverAgentSkills` / `resolveAgentSkills`); it scans,
in order:

| Root (relative to the project or home) | Source | Notes |
| --- | --- | --- |
| `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` | user | shared across projects |
| `<project>/.claude/skills` | project | |
| `<project>/skills` | project | where this repository keeps its shipped skills |
| `<project>/.agents/skills` | project | symlinks followed |
| `<harness authored root>/skills` | project | the private ledger's skill root |

A directory is a skill when it contains a **regular** `SKILL.md` — a symlinked `SKILL.md` is
rejected. The skill `id` is the directory basename. Two rules follow:

- **Name the directory after the id**, and keep it stable; `skills[].id` in an Agent declaration is
  matched to the path, not to the frontmatter `name`.
- **Declare the path in the Agent**, not just create the file. Creating a skill does not attach it;
  `ha agent install` with `skills: [{ "id": "<dir>", "path": "skills/<dir>" }]` does. A path that
  does not resolve on the serving node fails the whole dispatch with `agent_skill_not_found`.

For this repository, link a new project skill into runtime directories with:

```bash
npm run harness:sync-runtime-skills     # verifies collisions first; never overwrites foreign links
```

## Frontmatter is a contract

```markdown
---
name: <must equal the directory basename>
description: <what the skill does + WHEN to load it, in the same sentence>
---
```

The `description` is the only text a model sees before deciding to load the skill. Write it as
trigger, not as table of contents:

- Include the situation: *"Use when a submitted cut must be re-reviewed after an amendment…"*.
- Include the object: which files, commands, or artifacts the skill governs.
- Exclude the procedure; that is the body's job.
- Do not write "helps with", "best practices", or a list of topics. Those descriptions lose to a
  competitor that names the trigger.

## Body structure that survives contact

Use these sections, in this order, and delete any that carries no judgment:

1. **Boundary** — when this applies and, more usefully, when it does not. Name the adjacent skill or
   rule that owns the excluded case, so the Agent is routed rather than left guessing.
2. **Contract source** — the file, `--help`, or command that is authoritative, with a path. Never
   restate a schema that has a machine-readable source; point at it. Restated schemas drift and the
   Agent follows the stale copy.
3. **Procedure** — numbered steps an Agent can execute, each with the command it runs and what a
   correct result looks like. A step that says "verify carefully" is not a step.
4. **Failure branches** — the specific error codes or symptoms, and the concrete next action. This is
   where most skills earn their size: an Agent that hits `agent_skill_not_found` needs the fix, not
   the philosophy.
5. **Evidence** — what the Agent must report back so the owner can check it.

Rules of thumb learned from real skills in this repository:

- **Never duplicate the injected baseline.** If the role prompt already says it, the skill repeating
  it makes two sources and no authority. Delete the duplicate and name where it lives.
- **One authoritative home per rule.** If two skills state the same rule, one states it and the
  other points at it with its trigger condition.
- **Put the long tail in `references/`**, linked from the body with *when* to open it. A reference
  nobody is told to read is dead weight; a body that inlines everything becomes unread.
- **Prefer a command over a reminder.** If a mistake can be made impossible by a flag, a check, or a
  script, write the command into the procedure instead of a "remember to…" line.
- **Front-load the trigger.** The first screen decides whether the rest is read.

## Deletion budget

Every edit states what it removes. Before adding a section, answer:

- Which existing paragraph does this replace, narrow, or absorb?
- If this is a genuinely new dimension, what older rule is now false or redundant?

Measure both sides and put the numbers in the change description:

```bash
wc -c skills/<id>/SKILL.md          # before and after
```

Growth without a named shrink is how a skill becomes a document nobody finishes. A skill that grows
must name the section it condensed, moved to `references/`, or deleted.

## Verification

A skill is correct when an Agent that did not write it can act from it. Check, cheapest first:

1. **Structural:** frontmatter parses, `name` equals the directory, the file is a regular file.
   `npm run harness:sync-runtime-skills` fails on collisions; `node --test tools/skill-contracts.test.mjs`
   asserts the repository's skill contract (registration list, agent metadata presence).
2. **Resolution:** the skill resolves from the root the serving node scans —
   `ha agent validate --source <declaration>` fails when a declared path is missing.
3. **Composition:** `ha agent run <id> --task <task-id> --dry-run` shows the resolved skill path in
   the assembled prompt. A skill that exists but is not in that list is not mounted.
4. **Behavior:** give a reader who has not seen this change the scenario and the skill, and observe
   whether they take the intended path. Record the scenario and the result; a green structural check
   proves the file is well-formed, not that the procedure works.

## What not to do

- **Do not create a skill for a one-off task.** If it will not be loaded again, it is a task plan.
- **Do not copy a public skill into a project and rename it.** Forking duplicates the maintenance
  and the two copies drift; reference the public skill and add only what is project-specific.
- **Do not put secrets, absolute machine paths, or private URLs in a skill.** Skills are read paths
  that travel with the declaration and may be published.
- **Do not turn a single failure into a permanent prohibition.** Write the failing condition and the
  action; give a local guard an expiry or a removal trigger.
- **Do not let the skill become the place you put everything.** `instructions` is judgment for every
  dispatch; a skill is a procedure for a situation; a task plan is this delivery.

## Output contract

Report: skill path and id, the frontmatter `description` sentence, the contract sources it points at,
the registered Agent(s) and the declaration change that mounts it, before/after `wc -c`, the deletion
list, verification commands run with their results, and what remains unverified.
