---
name: preset-creator
description: Create, review, or update Harness Anything presets. Use when designing preset-manifest JSON, preset script entrypoints, reads/writes scopes, preset profiles, process-action presets, or preset tests for Harness Anything. Enforces declaration-first presets and forbids hardcoding preset-specific behavior in CLI core TypeScript.
---

# Preset Creator

## Core Rule

Keep presets declaration-first. A preset is a manifest plus optional package-local scripts/templates. Do not add `presetId` or action-specific branches to CLI core code.

The CLI may provide only generic infrastructure:

- Manifest/schema validation.
- Layer resolution: builtin, user, project.
- Generic script execution.
- Declared `reads`/`writes` permission handling.
- Generic result envelope collection.

Preset behavior belongs in the preset package:

- `preset.json`
- `scripts/*`
- profile/template selections
- declared inputs, reads, and writes

## Workflow

1. Define the preset's job in one sentence.
2. Decide whether it is `template-content` or `process-action`.
3. Write or update `preset.json` with explicit `entrypoints`.
4. For script entrypoints, declare the narrowest possible `reads` and `writes`.
5. Put all preset-specific action logic in `scripts/`, not CLI command dispatch.
6. If a script needs to return rich command output, write `artifacts/preset-result.json`.
7. Add tests in the correct tier and update `tools/test-tier-manifest.mjs` when adding new test files.

## Manifest Pattern

Use `reads` for input permissions and `writes` for output permissions:

```json
{
  "schema": "preset-manifest/v2",
  "id": "example-process",
  "title": "Example Process",
  "vertical": "software/coding",
  "version": "1.0.0",
  "kind": "process-action",
  "kernelVersionRange": { "min": "1.0.0", "maxExclusive": "2.0.0" },
  "capabilityImports": [],
  "entrypoints": {
    "plan": {
      "type": "script",
      "command": "scripts/preset-action.mjs",
      "reads": ["{{outputRoot}}/**"],
      "writes": ["{{outputRoot}}/**"],
      "inputs": {}
    }
  },
  "profiles": [{ "id": "baseline", "title": "Baseline", "checkerProfile": "standard", "templateSelections": [] }],
  "defaultProfile": "baseline"
}
```

## Script Pattern

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

- No CLI core branch checks `presetId`, preset title, or action name for behavior.
- No preset script requires permissions not declared in `preset.json`.
- `writes` never grants repo-root write access.
- Any repo-wide read is deliberate and justified by the preset's job.
- Process-action presets are not left as capability-smoke placeholders.
- Tests prove unauthorized script runs fail and authorized runs produce expected artifacts.
