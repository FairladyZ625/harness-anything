# Actor Attribution

Every load-bearing write carries an actor and the channel that supplied it.
This is audit data, not a convenience label: the write journal persists both
`actor.kind` / `actor.id` and `actor.source`.

## Actor kinds and sources

There are three actor kinds and three sources. A source answers a different
question from a kind: it says how the process obtained the identity.

| Actor kind    | `HARNESS_ACTOR` environment | Global `--actor` flag | Authenticated daemon                                                                                       |
| ------------- | --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `human:<id>`  | Rejected                    | Not supported         | Allowed when daemon authentication resolves a person                                                       |
| `agent:<id>`  | Allowed                     | Allowed               | Not a daemon journal actor; an agent may instead be recorded as an executor where that command supports it |
| `system:<id>` | Allowed                     | Allowed               | Not a daemon journal actor                                                                                 |

The local CLI uses `HARNESS_ACTOR` only for agent/system execution context. Human
writes are authenticated by the daemon. Local writes also need a git author name
and email. Set `HARNESS_GIT_AUTHOR_NAME` and
`HARNESS_GIT_AUTHOR_EMAIL` in examples and automation; the CLI also accepts
the corresponding Git author variables as a fallback.

### Human invocation

Initialize the workspace with a person identity, then use plain `ha` commands:

```bash
ha init --person-id alice --display-name "Alice"
ha task create --title "Review the release notes"
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
ha() { command ha "$@"; }
```

Agents must supply their own `HARNESS_ACTOR=agent:<id>` value. Never turn the
human identity into an exported environment variable.

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
daemon-authenticated plain `ha` commands, then run `ha check`
again after subsequent writes use the compliant source.
