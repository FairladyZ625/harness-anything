# Your first loop

Run this end to end in a scratch git repo. In a few minutes you'll have a real
task, a fact, and an adjudicated decision — all as Markdown inside the private
`harness/` ledger. Every output below is captured from an actual run.

## 0. Set write attribution

Local `ha` write commands require explicit attribution. For this human-run
loop, pass the human identity as a global flag and set the commit author
variables:

```bash
export HARNESS_GIT_AUTHOR_NAME="Your Name"
export HARNESS_GIT_AUTHOR_EMAIL="you@example.com"
ha --actor human:you init
```

Continue this loop by prefixing each write command with `ha --actor human:you`.
Do not export `HARNESS_ACTOR=human:you`: a child process inherits environment
variables, so it cannot prove a human was present for its write. Agent and
system automation may use `HARNESS_ACTOR=agent:<id>` or `system:<id>` per
command. See [Actor Attribution](../../actor-attribution.md) for the safe
interactive wrapper and complete source matrix.

## 1. Initialize

```bash
$ ha --actor human:you init
ok command=init path=harness/harness.yaml summary="initialized harness at harness/harness.yaml"
```

This creates the authored `harness/` directory. Your tasks, decisions, and
standards live here, but not in your project git repository. `ha init` adds
`harness/` to the outer `.gitignore` and initializes `harness/` as its own
private nested git repository.

That isolation is the leak-prevention design: code PRs must not include
`harness/` changes. Commit ledger changes inside `harness/` when you want to
version the private ledger:

```bash
git -C harness status
git -C harness add .
git -C harness -c user.name="$HARNESS_GIT_AUTHOR_NAME" \
  -c user.email="$HARNESS_GIT_AUTHOR_EMAIL" \
  commit -m "docs: update harness ledger"
```

The generated `.harness/` cache is local-only and also stays out of the outer
project git repository.

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
$ ha --actor human:you task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug
```

You get a stable `task_<id>` and a task package on disk. IDs are identity; titles are just display metadata.

## 3. Move it through the lifecycle

```bash
$ ha --actor human:you task transition task_01KWPP52D062Q7BWTD8BCNDRWF active
ok command="task transition" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=active
   summary="set task task_01KWPP52D062Q7BWTD8BCNDRWF to active"
```

Tasks move through six states: `planned → active → blocked → in_review → done → cancelled`. `done` and `cancelled` are terminal.

## 4. Record a fact, then a decision

Facts are append-only observations, anchored to the task that produced them:

```bash
$ ha --actor human:you fact record --task task_01KWPP52D062Q7BWTD8BCNDRWF \
    --statement "Redirect loops when the session cookie is missing" \
    --source "manual repro" --confidence high
ok command="fact record" task=task_01KWPP52D062Q7BWTD8BCNDRWF path=facts.md
```

Now propose a decision — the WHY — and adjudicate it:

```bash
$ ha --actor human:you decision propose --title "Use a server-side redirect guard" \
    --question "How do we stop the login redirect loop?" \
    --chosen "Add a server-side guard" \
    --rejected "Client-only fix" \
    --why-not "Client fix races with cookie set"
ok command="decision propose" path=harness/decisions/decision-dec_mr6f3b4z/decision.md

$ ha --actor human:you decision accept dec_mr6f3b4z --arbiter human:you
ok command="decision accept" path=harness/decisions/decision-dec_mr6f3b4z/decision.md
```

`accept` is the adjudication checkpoint: it's where a decision's evidence relations (attach them with `--evidence-relation` on propose, or `ha decision relate` later) are validated before the decision becomes binding. This is what makes an accepted decision _trustworthy_ rather than just asserted — the full fail-closed policy is covered in **[learn/](../../learn/en/00-overview.md)**.

## 5. Watch the structure grow

```bash
$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1

$ ha graph
ok command=graph path=.harness/generated/graph-panorama/index.html
```

`graph` renders a self-contained HTML panorama linking your tasks, decisions, and facts.

**This is the aha:** what you produced isn't a chat log. It's real, versioned
structure in the private `harness/` ledger — the task, the fact it observed, and
the decision it justified, all linked and reviewable with `git -C harness diff`.

![demo](../assets/demo.gif)

> **GIF coming soon** — replaced with a live clip once the GUI ships.

---

Next: go deeper on the _why_ → **[learn/](../../learn/en/00-overview.md)**, or grab the **[daily commands cheat sheet](03-daily-commands.md)**.
