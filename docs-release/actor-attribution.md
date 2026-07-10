# Actor Attribution

Every load-bearing write carries an actor and the channel that supplied it.
This is audit data, not a convenience label: the write journal persists both
`actor.kind` / `actor.id` and `actor.source`.

## Actor kinds and sources

There are three actor kinds and three sources. A source answers a different
question from a kind: it says how the process obtained the identity.

| Actor kind    | `HARNESS_ACTOR` environment | Global `--actor` flag | Authenticated daemon                                                                                       |
| ------------- | --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `human:<id>`  | Rejected                    | Allowed               | Allowed when daemon authentication resolves a person                                                       |
| `agent:<id>`  | Allowed                     | Allowed               | Not a daemon journal actor; an agent may instead be recorded as an executor where that command supports it |
| `system:<id>` | Allowed                     | Allowed               | Not a daemon journal actor                                                                                 |

The local CLI resolves an explicit flag before it considers `HARNESS_ACTOR`.
That makes a deliberate flag authoritative even if a parent process supplied an
environment value. In addition to actor attribution, local writes need a git
author name and email. Set `HARNESS_GIT_AUTHOR_NAME` and
`HARNESS_GIT_AUTHOR_EMAIL` in examples and automation; the CLI also accepts
the corresponding Git author variables as a fallback.

### Human invocation

Use the global flag for a human write:

```bash
ha --actor human:alice task create --title "Review the release notes"
```

Do **not** export `HARNESS_ACTOR=human:alice`. Environment variables are
inherited by child processes, so a child agent could write while carrying the
parent shell's human value. That value proves only that it was inherited, not
that a human was present for the write. The CLI therefore rejects human values
from `HARNESS_ACTOR` fail-closed.

Agent and system automation can still use a per-command environment value:

```bash
HARNESS_ACTOR=agent:release-bot ha task list
HARNESS_ACTOR=system:nightly ha fact record --task task_01ABC --statement "Nightly check passed" --source ci --confidence high
```

### A safe interactive shell wrapper

Typing a flag for every interactive command is tedious, but a naive shell
function is unsafe. An agent source snapshot can see an interactive shell's
`ha()` function; if that function always adds a human flag, a non-interactive
agent invocation of bare `ha` silently inherits the human identity.

Use an interactive gate in the wrapper instead (shown for zsh):

```zsh
ha() { if [[ -o interactive ]]; then command ha --actor human:<your-id> "$@"; else command ha "$@"; fi }
```

Replace `<your-id>` with the stable person id. This function adds the flag only
to a human's interactive shell. In a non-interactive process it calls the real
binary unchanged, so an agent must supply its own `HARNESS_ACTOR=agent:<id>` or
an explicit `--actor` value. Never turn the human identity into an exported
environment variable.

### Daemon attribution

Daemon-backed writes use `source: daemon`, not a client-supplied human
environment value. The daemon authenticates a person, resolves that person in
`harness/people.yaml`, and uses the resolved display name and primary email for
the commit author. The authenticated daemon actor is always a human journal
actor; agent executors, when a command carries one, are separate from the
daemon's principal.

For remote SSH access, see [Server Daemon Operations](operations-server-daemon.md).

## Checking historical journal entries

`ha check` treats `human_actor_from_inherited_env` as a hard failure. It means
the journal contains a historical record whose actor is `kind: human` and whose
source is `env`. Preserve that record as audit evidence; do not rewrite history
to make the check quiet. Correct future human invocations by using
`--actor human:<id>` (or the interactive wrapper above), then run `ha check`
again after subsequent writes use the compliant source.
