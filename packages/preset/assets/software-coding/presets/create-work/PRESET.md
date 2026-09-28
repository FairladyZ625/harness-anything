---
schema: preset-document/v1
description: Create a work root task whose plan is the work map and whose subtree carries the work's tasks.
whenToUse: Use when a body of work needs one root, coordinated waves, explicit dependencies, and closeout criteria.
---
# Create Work

A work is one root task plus its parent-child subtree. Create it with `ha work create --title "<name>"`; this preset supplies the root's plan shape. It does not run a scaffold or checker script.

## Workflow

1. Propose the charter decision (`ha decision propose`) with a concise mission and the first user or system that benefits. Leave it `proposed`; do not accept it yet.
2. Create the work root with `ha work create --title "<name>"` and keep the returned task id as the durable anchor. Root creation does not require an accepted charter.
3. Anchor the charter's load-bearing claims to evidence, then accept it (`ha decision accept`). Record observations as Facts on the root task and relate each claim with `evidenced-by`; a Task target is also accepted by the evidence floor. Reserve `--judgment-only` for claims that genuinely rest on judgement rather than observation — accepting an `evidenced` claim through it leaves the evidence chain empty.
4. Write the mission, waves, dependencies, entry conditions, and closeout criteria into the root's `task_plan.md`; it is the work map.
5. Create each task of the work with `ha task create --work <root-task-id>` and add real dependency relations through governed write roads.
6. Read the work's status with `ha work show <root-task-id>`; `ha agenda --work <root-task-id>` narrows the agenda to it.

## Done when

- The root task, accepted decision, and work map resolve to one another.
- Every wave has an owner, entry condition, dependency boundary, and exit evidence.
- `ha work show` agrees with the work map's task mapping.
