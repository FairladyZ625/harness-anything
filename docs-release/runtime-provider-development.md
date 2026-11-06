# Add a built-in runtime provider

Runtime providers are product-owned integrations. They are not user-installed entities.

To add one, extend `packages/daemon/src/runtime-inventory.ts` with one declaration and add its frame parser to
`packages/daemon/src/runtime-spawn-provider-frames.ts`. The declaration owns the provider identity, executable
discovery, model and authentication probes, instance configuration fields, permission and isolation constraints,
launch metadata, session identity extraction, renderer plane, and measured capability states.

Use `unverified` for a capability until a parser or runtime observation establishes it. Do not add a parallel kind
union, CLI enum, preload allowlist, renderer plane table, or response DTO branch. The inventory lookup rejects an
unknown kind explicitly, and the frame-parser registry checks that every declaration has a parser.

Keep stored instance configuration under the declaration's dynamic kind key. This lets existing instance files keep
their canonical bytes while new built-in kinds use the same parser, persistence, protocol, and renderer path.

## Project command interceptions

Declare rules once in the repository's `harness.yaml` Settings facet:

```yaml
settings:
  runtime:
    commandInterceptions:
      - id: no-publish
        pattern: '\bnpm\s+publish\b'
      - id: no-release-script
        agent: implementer
        pattern: 'scripts/release\.sh'
```

Each JavaScript Unicode regular expression matches the shell command text supplied to the provider,
including script invocation paths. It does not inspect script contents or infer the effects of another command.
Omit `agent` for all agents, including reviewers and direct runtime dispatches. Global and matching agent
rules are combined; a different agent cannot override a global rule. The first matching rule denies the tool
call and returns its `id` and pattern to the agent.

Update an initialized repository through its existing Settings writer:

```sh
ha settings update --runtime-command-interceptions '[{"id":"no-publish","pattern":"\\bnpm\\s+publish\\b"}]'
```

The flag updates the same project declaration; `[]` clears it. Settings mutation remains principal-owned.
Fresh, rework, agent override, reviewer and resumed dispatches share the runtime launch compiler. A running
session keeps its launch snapshot; a subsequent dispatch reads current Settings. Steer uses the current session's
hook arguments.

Claude Code uses native `PreToolUse` through the existing `--settings` slot. A configured hook removes `--bare`,
which would disable hooks, for API-key calls. Codex uses inline native `PreToolUse` configuration and trusts
this generated hook for that invocation. CodeBuddy uses `--settings`. Kimi is unsupported: its `--config` replaces the whole native configuration, so a hook-only value would discard model and authentication settings.
Cursor, Copilot and Auggie receive an invocation-local plugin directory; Droid receives a settings file.
Generated files live under the instance's runtime-id-owned scratch directory and are reclaimed by existing
settlement/recovery. They do not modify user or project vendor configuration. Instance show/list replies expose
`capabilities.commandInterception` from the same native provider declaration.

Other HA runtime integrations currently report `commandInterception: unsupported` and refuse a launch carrying
applicable rules with `runtime_command_interception_unsupported`. Native vendor hook support alone does not imply
that its current HA protocol adapter can inject an independent launch policy. No prompt-only fallback is used.

These are provider tool hooks, not an operating-system sandbox or credential isolation. Configure credentials
and native execution permissions separately when those boundaries are required. Provider-specific hook failures
and tool paths outside the provider's native hook contract retain that provider's documented semantics.
