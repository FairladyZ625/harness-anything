# Your first loop

Run this end to end in a scratch git repo. In a few minutes you'll have a real task, a fact, and an adjudicated decision — all as Markdown in your repo. Every output below is captured from an actual run.

## 1. Initialize

```bash
$ ha init
ok command=init path=harness/harness.yaml summary="initialized harness at harness/harness.yaml"
```

This creates the authored `harness/` directory — your tasks, decisions, and standards live here and go into git. (The generated `.harness/` cache is local-only and stays out of git.)

```text
harness/
├── harness.yaml
├── adr/
├── context/
├── milestones/
├── standards/
└── tasks/
```

## 2. Create a task

```bash
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug
```

You get a stable `task_<id>` and a task package on disk. IDs are identity; titles are just display metadata.

## 3. Move it through the lifecycle

```bash
$ ha task transition task_01KWPP52D062Q7BWTD8BCNDRWF active
ok command="task transition" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=active
   summary="set task task_01KWPP52D062Q7BWTD8BCNDRWF to active"
```

Tasks move through six states: `planned → active → blocked → in_review → done → cancelled`. `done` and `cancelled` are terminal.

## 4. Record a fact, then a decision

Facts are append-only observations, anchored to the task that produced them:

```bash
$ ha fact record --task task_01KWPP52D062Q7BWTD8BCNDRWF \
    --statement "Redirect loops when the session cookie is missing" \
    --source "manual repro" --confidence high
ok command="fact record" task=task_01KWPP52D062Q7BWTD8BCNDRWF path=facts.md
```

Now propose a decision — the WHY — and adjudicate it:

```bash
$ ha decision propose --title "Use a server-side redirect guard" \
    --question "How do we stop the login redirect loop?" \
    --chosen "Add a server-side guard" \
    --rejected "Client-only fix" \
    --why-not "Client fix races with cookie set"
ok command="decision propose" path=harness/decisions/decision-dec_mr6f3b4z/decision.md

$ ha decision accept dec_mr6f3b4z --arbiter human:you
ok command="decision accept" path=harness/decisions/decision-dec_mr6f3b4z/decision.md
```

`accept` is the adjudication checkpoint: it's where a decision's evidence relations (attach them with `--evidence-relation` on propose, or `ha decision relate` later) are validated before the decision becomes binding. This is what makes an accepted decision *trustworthy* rather than just asserted — the full fail-closed policy is covered in **[learn/](../../learn/en/00-overview.md)**.

## 5. Watch the structure grow

```bash
$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1

$ ha graph
ok command=graph path=.harness/generated/graph-panorama/index.html
```

`graph` renders a self-contained HTML panorama linking your tasks, decisions, and facts.

**This is the aha:** what you produced isn't a chat log. It's real, versioned structure in your repo — the task, the fact it observed, and the decision it justified, all linked and all reviewable in a git diff.

![demo](../assets/demo.gif)

> **GIF coming soon** — replaced with a live clip once the GUI ships.

---

Next: go deeper on the *why* → **[learn/](../../learn/en/00-overview.md)**, or grab the **[daily commands cheat sheet](03-daily-commands.md)**.
