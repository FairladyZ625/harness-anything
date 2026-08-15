---
name: preset-creator
description: Create, review, or update Harness Anything preset-manifest/v3 packages, including profiles, completion gates, template selections, output shapes, script entrypoints, capability declarations, package validation, and preset tests. Use when authoring or migrating a Harness Anything preset.
---

# Preset Creator

## Use the current contract

Treat `packages/preset/src/preset.contract.ts` as the contract and
`packages/preset/assets/software-coding/presets/standard-task/preset.json` as
the minimal bundled example. Presets are declaration-first packages. Keep
preset-specific behavior in package assets or scripts; never add a CLI core
branch keyed by preset id, title, or action name.

A self-contained package contains:

```text
<preset-id>/
  preset.json
  PRESET.md
  policy.json       # only when policyPath declares it
  scripts/          # only when an entrypoint declares a script
```

`PRESET.md` uses this frontmatter:

```markdown
---
schema: preset-document/v1
description: One sentence describing the supplied workflow or shape.
whenToUse: One sentence naming the triggering situation.
---
```

## Manifest v3

Use `schema: "preset-manifest/v3"`. Required top-level keys are exactly:

- `schema`, `id`, `title`, `vertical`, `version`, `kind`, and `outputShape`
- `kernelVersionRange` and `capabilityImports`
- `profiles` and `defaultProfile`

Optional top-level keys are `extends`, `policyPath`, and `entrypoints`. No other
top-level key is accepted. `kind` is `template-content` or `process-action`.
`outputShape` is a required non-empty string.

Each profile requires `id`, `title`, `completionGates`, and
`templateSelections`; it may add `checkerProfile` and `capabilityImports`.
`completionGates` is an array of gate-id strings, including an explicit empty
array when the profile has no gates. `defaultProfile` must name one declared
profile.

Each template selection is exactly:

```json
{
  "slot": "task.plan",
  "templateRef": "template://planning/task-plan@1",
  "materializeAs": "task_plan.md",
  "localePolicy": { "prefer": "project", "fallback": "en-US" }
}
```

`localePolicy.prefer` is `project`, `preset`, or `explicit`; `fallback` is
`zh-CN` or `en-US`.

Top-level `capabilityImports` items require `id`, `kind`, `version`, and a
boolean `required`. Profile and entrypoint capability items use `id`, `kind`,
and `version`, with an optional boolean `required`. Valid kinds are `checker`,
`scaffold`, `projection`, `command`, `template`, and `raw-fs`.

## Minimal valid package

Use this manifest shape:

```json
{
  "schema": "preset-manifest/v3",
  "id": "example-note",
  "title": "Example Note",
  "vertical": "software/coding",
  "version": "1.0.0",
  "kind": "template-content",
  "outputShape": "repository-diff",
  "kernelVersionRange": { "min": "1.0.0", "maxExclusive": "2.0.0" },
  "capabilityImports": [],
  "profiles": [
    {
      "id": "baseline",
      "title": "Baseline",
      "checkerProfile": "standard",
      "completionGates": ["ci", "code-doc-reconciliation"],
      "templateSelections": []
    }
  ],
  "defaultProfile": "baseline"
}
```

Validate the package directory, not an individual manifest file:

```bash
ha preset validate --source /path/to/example-note --json
```

Continue only when the report has `"valid": true` and an empty `issues` array.

## Script entrypoints

A v3 entrypoint is a named object with exactly these fields:

```json
{
  "type": "script",
  "intent": "Produce a bounded preset result.",
  "inputs": [
    { "name": "title", "type": "string", "required": true }
  ],
  "requires": [
    { "id": "capability:input/v1", "kind": "command", "version": "1" }
  ],
  "produces": [
    { "id": "capability:result/v1", "kind": "projection", "version": "1" }
  ],
  "sideEffects": [],
  "command": "scripts/run.mjs"
}
```

Input types are `string`, `number`, `boolean`, or `json`. `intent` is a plain
string. `requires`, `produces`, and `sideEffects` are flat capability-ref
arrays. The command path must name a regular package-local file. The script
reads its context from `HARNESS_PRESET_CONTEXT`; do not invent undeclared
filesystem permissions.

## Migrating v2 packages

Do not relabel a v2 object and leave its fields in place. Apply these mappings:

- Add the required top-level `outputShape` when absent.
- Keep profile ids, titles, optional checker profile, string completion-gate
  ids, and valid current template selections.
- Convert script `inputs` from an object/map to the v3 array of
  `{name,type,required}` only when the types and requiredness are explicit.
- Convert a structured/object `intent` to one plain string only when its exact
  user-visible meaning is present.
- Replace nested capability selectors with flat `requires`, `produces`, and
  `sideEffects` refs only when current providers are explicitly known.
- Discard v2 raw-filesystem `reads` and `writes` path-glob fields. They have no
  v3 manifest counterpart. A `raw-fs` capability ref names a provider; it does
  not restore those old path scopes.
- Remove any entrypoint whose authority or input meaning cannot be expressed
  without guessing. Preserve its user-visible procedure in `PRESET.md` and
  report the removed behavior to the owner.
- Delete all unknown v2 keys. Validation is exact-field and fails closed.

## Template assets

Preset manifests select templates; the vertical template catalog owns template
metadata and Markdown assets own bodies. Use
`template://<id>@<version>` references. Do not inline template bodies in the
manifest. Run `ha template list` to discover current builtin declarations and
validate that every selected slot, path, locale policy, and required anchor
resolves.

## Workflow

1. State the preset job in one sentence and choose `template-content` or
   `process-action`.
2. Read the v3 contract and a nearby bundled manifest; do not copy a v2 schema.
3. Create `preset.json` and `PRESET.md`, then add only declared policy, template,
   or script files.
4. Run `ha preset validate --source <package-directory> --json`.
5. Run `ha preset install --source <package-directory> --dry-run --json` before an
   installation and inspect its issues.
6. Add resolver, materialization, permission, or execution tests at the tier
   matching the behavior. Put exactly one `// harness-test-tier:` declaration
   on the first line of every new Node test file.

## Review checklist

- The schema is `preset-manifest/v3`; `outputShape` is present.
- Top-level, profile, selection, capability, input, and entrypoint fields are
  exact current-contract fields.
- `profiles` is non-empty and `defaultProfile` resolves.
- Completion gates are string ids; template selections use the current nested
  locale policy.
- No v2 `reads`, `writes`, object input/intent, or nested capability selector
  survives.
- `PRESET.md` has valid `preset-document/v1` frontmatter.
- Package validation reports valid with no issues.
- No preset-specific behavior was added to generic CLI dispatch.
