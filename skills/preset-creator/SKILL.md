---
name: preset-creator
description: Create, review, or update Harness Anything presets. Use when designing preset-manifest JSON, preset script entrypoints, reads/writes scopes, preset profiles, process-action presets, or preset tests for Harness Anything. Enforces declaration-first presets and forbids hardcoding preset-specific behavior in CLI core TypeScript.
---

# Preset Creator

## Core Rule

Keep presets declaration-first. A preset is a `preset-manifest/v2` manifest plus optional package-local scripts and template selections. Template bodies are assets owned by a template catalog, not inline manifest strings. Do not add `presetId` or action-specific branches to CLI core code.

The CLI may provide only generic infrastructure:

- Manifest/schema validation.
- Layer resolution: builtin, user, project.
- Generic script execution.
- Declared `reads`/`writes` permission handling.
- Generic result envelope collection.

Preset behavior belongs in the preset package:

- `preset.json`
- `scripts/*`
- `profiles[*].templateSelections`
- declared inputs, reads, and writes

## Workflow

1. Define the preset's job in one sentence.
2. Decide whether it is `template-content` or `process-action`.
3. Write or update `preset.json` as `preset-manifest/v2`.
4. Put template overlays in `profiles[*].templateSelections`; point each selection at `template://<id>@<version>`.
5. Put template body Markdown in the vertical template assets, then reference it from `template-catalog/v2` with `bodyPath`.
6. For script entrypoints, declare the narrowest possible `reads` and `writes`.
7. Put all preset-specific action logic in `scripts/`, not CLI command dispatch.
8. Run `ha preset validate <manifest>` before publishing the preset.
9. Add tests in the correct tier by putting exactly one `// harness-test-tier: fast|contract|integration` declaration on each new Node test file's first line.

## Manifest v2 Contract

Allowed top-level keys are exactly:

- `schema`
- `id`
- `title`
- `vertical`
- `version`
- `kind`
- `extends`
- `kernelVersionRange`
- `capabilityImports`
- `entrypoints`
- `profiles`
- `defaultProfile`

Use `schema: "preset-manifest/v2"`. `profiles` must contain at least one profile, and `defaultProfile` must match one declared profile id. `extends` is optional; when present, the parent preset must be available to the validation context. A standalone `ha preset validate <manifest>` run validates only that one manifest, so omit `extends` in minimal examples unless you also validate through a resolved preset set.

Allowed profile keys are exactly:

- `id`
- `title`
- `checkerProfile`
- `completionGates`
- `templateSelections`
- `capabilityImports`

Every `preset-manifest/v2` profile must declare `completionGates`, even when the
array is empty. Gate IDs are opaque, portable identifiers at the manifest
boundary; the application validates which IDs it implements. A coding profile
normally declares `ci` and `code-doc-reconciliation`, while a non-coding or
purpose-built profile may declare a different set or none. This makes completion
derive from the selected preset/profile contract instead of promoting CI or any
other coding convention into a universal kernel gate (ADR-0027 D7).

## Minimal Valid Preset

This example was validated with `ha preset validate preset.json`.

```json
{
  "schema": "preset-manifest/v2",
  "id": "example-note",
  "title": "Example Note",
  "vertical": "software/coding",
  "version": "1.0.0",
  "kind": "template-content",
  "kernelVersionRange": { "min": "1.0.0", "maxExclusive": "2.0.0" },
  "capabilityImports": [
    { "id": "example-note-template", "kind": "template", "version": "1", "required": false }
  ],
  "entrypoints": {
    "scaffold": {
      "type": "template",
      "writes": ["{{outputRoot}}/notes/example.md"],
      "templates": {
        "note": "template://example/note@1"
      }
    }
  },
  "profiles": [
    {
      "id": "baseline",
      "title": "Baseline",
      "checkerProfile": "standard",
      "completionGates": ["ci", "code-doc-reconciliation"],
      "templateSelections": [
        {
          "slot": "example.note",
          "templateRef": "template://example/note@1",
          "materializeAs": "notes/example.md",
          "localePolicy": { "prefer": "project", "fallback": "en-US" }
        }
      ]
    }
  ],
  "defaultProfile": "baseline"
}
```

Validate it:

```sh
ha preset validate preset.json
```

## Asset-Based Templates

Preset manifests select templates; template catalogs own template metadata; Markdown files own template bodies. Do not put inline `body` content in `template-catalog/v2`; v2 catalogs use `bodyPath` only.

Preferred package layout:

```text
assets/software-coding/
  template-catalog.json
  templates/
    example.note/
      en-US.md
      zh-CN.md
  presets/
    example-note/
      preset.json
```

Catalog entry:

```json
{
  "id": "example/note",
  "version": "1",
  "documentKind": "example-note",
  "slot": "example.note",
  "materializeAs": "notes/example.md",
  "frontmatterSchema": "task-package/v2",
  "requiredAnchors": ["## Summary"],
  "fallbackLocale": "en-US",
  "locales": [
    {
      "locale": "en-US",
      "anchors": ["## Summary"],
      "bodyPath": "templates/example.note/en-US.md"
    },
    {
      "locale": "zh-CN",
      "anchors": ["## Summary"],
      "bodyPath": "templates/example.note/zh-CN.md"
    }
  ]
}
```

`templates/example.note/en-US.md` must contain every required anchor:

```md
## Summary

Write the note here.
```

## Script Pattern

Process-action presets use script entrypoints. Use `reads` for input permissions and `writes` for output permissions:

```json
{
  "type": "script",
  "command": "scripts/preset-action.mjs",
  "reads": ["{{outputRoot}}/**"],
  "writes": ["{{outputRoot}}/**"],
  "inputs": {}
}
```

Scripts should read `process.env.HARNESS_PRESET_CONTEXT`, use only declared paths, and write outputs under `context.outputRoot`.

If the CLI should surface a domain result, write:

```json
{
  "ok": true,
  "rows": 1,
  "report": { "schema": "example-report/v1" }
}
```

to `artifacts/preset-result.json`.

## Review Checklist

- `preset.json` uses `schema: "preset-manifest/v2"`.
- Top-level manifest keys match the v2 allowed key list.
- Every profile uses only the v2 allowed profile keys and explicitly declares
  `completionGates`; `profiles` and `defaultProfile` are consistent (ADR-0027
  D7).
- Any `extends` parent is available to the validation path used.
- Template bodies live in `.md` assets referenced by `template-catalog/v2` `bodyPath`.
- No catalog or manifest example teaches inline `body`.
- `ha preset validate <manifest>` passes for the manifest being published.
- No CLI core branch checks `presetId`, preset title, or action name for behavior.
- No preset script requires permissions not declared in `preset.json`.
- `writes` never grants repo-root write access.
- Any repo-wide read is deliberate and justified by the preset's job.
- Process-action presets are not left as capability-smoke placeholders.
- Tests prove unauthorized script runs fail and authorized runs produce expected artifacts.
