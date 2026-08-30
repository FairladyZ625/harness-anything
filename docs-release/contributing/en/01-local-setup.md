# Local setup

The canonical prerequisites, clone command, and worktree sequence live in
[Environment and worktree](../../../skills/harness-contributing/SKILL.md#environment-and-worktree).
Use that sequence for every contribution rather than translating this page into
a second setup recipe.

## Why the isolated worktree is required

The primary checkout is a coordination point, not an implementation surface.
One contribution per worktree makes branch ownership visible, keeps concurrent
human or agent edits separate, and makes the final public diff attributable to
one scope. A dirty or shared worktree destroys that evidence even when the code
itself is correct.

## Public checkout boundary

The contribution checkout may contain public source, tests, tools, CI,
fixtures, examples, and release documentation. Local planning, agent runtime
state, caches, credentials, private URLs, absolute machine paths, and unrelated
changes are not contribution material. The skill's boundary and staged-diff
checks are the operational authority for enforcing this distinction.

Product installation and repository contribution are different jobs. For using
the product from source, follow [Start / Install](../../start/en/01-install.md).
For changing this repository, follow the contribution skill.
