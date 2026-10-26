---
name: self-iteration
description: Turn one delivery into a bounded, evidence-backed proposal to change your own instructions, prompts, skills, or tool scripts — including what to delete. Use at the end of a delivery turn, or when the owner resumes a delivered Agent with "how would you do better next time / what tool would you give yourself / what should we change in your skill or prompt".
---

# Self-iteration

You are not being asked for a retrospective essay. You are being asked for a **diff proposal**
against your own declaration, with the evidence of this one dispatch behind it, and with the
deletions it costs. A proposal that only adds is rejected.

## When this runs

- **Inside the delivery, before you submit.** Write the proposal while your round still holds the
  lease, then let `ha task submit` carry it. This is the only moment _you_ can run it: once the cut
  is submitted, a task-bound implementation dispatch to the same task is refused
  (`execution_frozen`), and once the task is `done` there is no lease to dispatch under at all. A
  proposal written after submit would never be produced, so treat this as a closeout step and not a
  postscript.
- **Owner resumption while the round is live.** If the owner resumes your dispatch
  (`ha agent run <agent-id> --resume-dispatch <dispatch-id> --prompt "<question>"`) before the cut
  is submitted, answer with the same format below.
- **Periodic review.** A read-only Schedule occurrence (or a `permissionMode: read-only` Agent,
  which is the one identity admitted against a frozen submitted cut) reviews your recent
  dispatches. It can read the cut but cannot write to it, so its proposal goes to its own
  occurrence-owned artifact.

One dispatch produces one proposal. The proposal belongs to **that dispatch**; it is not a shared
notebook and not a standing backlog.

## Ask these questions, in this order

Answer with a pointer to the command output, CI round, review finding, or file line that shows it.
An answer you cannot point at is an observation, not a proposal.

1. **Cost.** Which step consumed the most turns or wall time? What made it expensive — missing
   context, a wrong assumption, a gate that only failed late, or a tool that did not exist?
2. **Re-read.** Which instruction, prompt line, or skill passage did you read twice, mis-apply, or
   only discover after being rejected? Quote it verbatim.
3. **Dead weight.** Which rule did you follow that no longer protects anything? Which check ran and
   caught nothing this delivery? Name it as a deletion candidate.
4. **Missing tool.** Which sequence did you do by hand more than once? What single command or script
   would collapse it — and what does that command make obsolete?
5. **Noise.** Which injected segment did you skip, or which did you lack and have to reconstruct?
6. **Truth source.** Where did you guess because the canonical source was unreadable or unnamed?
   That is a tooling or instruction defect, not a you defect.
7. **Near miss.** What almost went wrong and was caught only by luck? A proposal that removes luck
   from that path is worth more than one that adds a reminder.
8. **Metric.** If your change is right, which number moves next time (review findings, CI reds,
   rework rounds, turns to first green, tokens)? If no number can move, this is probably not worth
   changing.

## Proposal format

Write one Markdown file plus one fenced JSON block. Put the file at the dispatch-owned path
`artifacts/reflections/<dispatch-id>.md` inside the task package. Never a shared
`reflections.md`, never a file at the package root that two dispatches would both write.

Every proposal item answers six fields, and field 3 is mandatory:

| Field             | Content                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `target`          | The exact declaration field, skill path, prompt id, or script path                                                       |
| `change`          | `add` / `rewrite` / `delete` — with the new or removed text, not a description of it                                     |
| `deletion`        | What this item removes, narrows, merges, or moves to a reference; or `budget-neutral-rewrite` with the before/after size |
| `evidence`        | This dispatch's concrete anchors (command + output line, CI run, review finding, `file:line`)                            |
| `expected_effect` | The behavior that changes, and the metric from question 8                                                                |
| `risk`            | What could get worse, and how it would be noticed and reverted                                                           |

Rules that bind the proposal:

- **No net growth.** State measured before/after size for every touched surface
  (`wc -c` on skills and prompt segments, line counts for scripts). An item that grows a surface
  must name the item that shrinks or removes one.
- **Prefer the cheapest layer that fixes it.** Tool or command face beats a prompt reminder; a
  rewritten rule beats a new rule; deleting a stale rule beats clarifying it.
- **One dispatch's evidence proves one dispatch.** Do not generalize a single failure into a
  permanent prohibition, and do not propose a rule with no expiry when it is a local guard.
- **You cannot apply it.** A proposal to your own declaration is reviewed by the owner and lands
  through the center single-write path with an expected version. Editing the canonical
  declaration, the skill file, or another Agent's declaration yourself is out of bounds.

````markdown
```self-iteration-proposal/v1
{
  "schema": "self-iteration-proposal/v1",
  "agentId": "<your agent id>",
  "taskId": "task_...",
  "executionId": "exe_...",
  "dispatchId": "dispatch_...",
  "iteration": 0,
  "observations": [
    { "question": "cost | re-read | dead-weight | missing-tool | noise | truth-source | near-miss",
      "statement": "<what happened>", "evidence": "<command output / file:line / CI run>" }
  ],
  "items": [
    {
      "id": "P1",
      "target": "skills/<id>/SKILL.md",
      "change": "rewrite",
      "summary": "<one line>",
      "deletion": "<what this removes or narrows>",
      "evidence": ["<anchor>"],
      "expected_effect": "<behavior change>",
      "metric": "<number that should move>",
      "risk": "<what could regress and how to revert>"
    }
  ],
  "net_budget": { "surface": "instructions", "before_bytes": 0, "after_bytes": 0 },
  "not_proposed": ["<idea considered and rejected, with why>"]
}
```
````

`not_proposed` is not decoration: it shows the owner which tempting changes you rejected, so the
review spends its attention on the ones that survived.

## Concurrency and effectivation

Multiple edges may run the same Agent at the same time. Each proposal is written under its own
dispatch path, so two edges never write the same file. Nothing is merged at the edge.

The owner (or CEO) reads the proposal, accepts or rejects each item, and applies accepted items to
the declaration through the single center write:

```bash
ha agent inspect <agent-id>                       # read the current declaration and expected-version
ha agent install --source <declaration> --expected-version <n>
```

A stale expected version fails the write instead of overwriting a concurrent change. A declaration
whose items did not help is restored the same way, from the previous body. Do not produce a
"rollback plan" inside the proposal; the version history already is one.

## Output contract

Return, in this order:

1. The proposal file path.
2. One line per item: `P<n> <change> <target> — deletion: <what goes>`.
3. `not_proposed` count and the strongest rejected idea with its reason.
4. The metric you expect to move, and where it is read from.
5. Any item you could not evidence, marked `unverified`.
