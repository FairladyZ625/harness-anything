---
name: preset-creator
description: Scaffold, customize, validate, and simulate Harness Anything preset-manifest/v3 packages using `ha preset init`, `ha preset validate`, and `ha vertical simulate`. Use when authoring or migrating presets within the FDE domain bootstrap workflow.
---

# Preset Creator (FDE Preset Authoring Workflow)

Treat `packages/preset/src/preset.contract.ts` as the single schema contract and `ha preset init` as the canonical starting point. Presets are declaration-first packages; never add CLI or daemon branches keyed by preset id.

## Workflow (Inside the 5-Step FDE Loop)

1. **Define the job**: choose `template-content` (deliverable/review tasks) or `process-action` (e.g. `work-root` orchestration) and its `outputShape` (`task-package-artifact` for non-code domains, `repository-diff` for code repos).
2. **Scaffold with `ha preset init`**:
   ```sh
   ha preset init vendor-check --vertical procurement/review --title "Vendor Check" --dry-run
   ha preset init vendor-check --vertical procurement/review --title "Vendor Check"
   ```
   - When `--vertical` points to a local vertical under `verticals/<slug>/`, the preset lands directly in `verticals/<slug>/presets/<preset-id>/` with matching `samples/<gate-id>/{positive,negative}.json` fixtures.
   - For a builtin vertical without a local override, it scaffolds into `presets/<preset-id>/` for installation via `ha preset install --source presets/<preset-id>`.
   - Generated files include `preset.json` (`preset-manifest/v3`), `PRESET.md` (`preset-document/v1`), `template-catalog.json` (`template-catalog/v2`), bilingual `templates/brief/{en-US,zh-CN}.md`, and `checks/verify-deliverable.mjs`.
3. **Customize profiles, templates & gates**:
   - Keep shared domain completion rules in `vertical.json` and preset-specific gates in `preset.json`'s optional `completion` object; profiles only select gate ids via `profiles[].completionGates` (use `[]` when no gate applies).
   - Reference templates via `template://<id>@<version>` with `localePolicy: { prefer, fallback }`; keep template bodies in `bodyPath` Markdown assets, never inline.
   - For command completion sources, import and produce `{ id: "completion-witness", kind: "checker", version: "1" }` and read frozen inputs from `HA_PRESET_INPUT` (see [gate-customization](../gate-customization/SKILL.md)).
4. **Validate & Dry-Run Simulate**:
   ```sh
   ha preset validate --source verticals/procurement-review/presets/vendor-check --json
   ha vertical simulate --source procurement/review --preset vendor-check --json
   ```
   For user-installed presets outside a local vertical:
   ```sh
   ha preset install --source ./presets/<preset-id> --dry-run --json
   ha preset install --source ./presets/<preset-id>
   ha preset audit --vertical <vertical-id>
   ```
5. **Diagnose broken user pointers**: if `ha preset list` or `ha preset audit` reports a blocked user shadow (such as a legacy manifest carrying the retired `checkerProfile` field), follow its printed remediation: remove the stale pointer with `ha preset uninstall <preset-id>` or migrate the manifest to `preset-manifest/v3` and reinstall.

## Migrating Legacy (v2) Presets

Validation is closed-field and fails closed:

- Upgrade `schema` to `preset-manifest/v3` and add required `outputShape`, `profiles`, and `defaultProfile`.
- Remove retired keys (`checkerProfile`, raw-fs `reads`/`writes` globs, object `inputs`/`intent`); replace `checkerProfile` with declarative `completion.sources` + `completion.gates` selected in `profiles[].completionGates`.
- Convert entrypoint `inputs` to `{ name, type, required }[]` and capability refs to flat `{ id, kind, version }` arrays.

## Review Checklist

- `ha preset validate --source <dir> --json` reports `valid: true` with zero issues.
- `ha vertical simulate --source <vertical-id> --preset <preset-id>` passes materialization and positive/negative gate probes.
- `PRESET.md` carries valid `preset-document/v1` frontmatter (`description`, `whenToUse`).
- Every profile declares `completionGates` explicitly and every selected gate resolves in the merged vertical/preset declaration.
- New tests carry `// harness-test-tier:` on line 1 and verify real contract behavior.
