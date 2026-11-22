---
name: vertical-creator
description: Productized FDE 5-step workflow to interview a domain, scaffold a complete local vertical with `ha vertical init`, customize entities/templates/agents/gates, dry-run simulate with `ha vertical simulate`, and hand off a verified non-code or code vertical.
---

# Vertical Creator (FDE Domain Bootstrap Workflow)

Keep verticals 100% declarative: entity kinds, bilingual templates, presets, agents, and completion gates live under `verticals/<slug>/`. Never add domain-specific branches keyed by vertical id to the kernel, daemon, or CLI.

## 5-Step FDE Domain Bootstrap Loop

```text
1. Domain Interview ─▶ 2. ha vertical init ─▶ 3. Author Rules & Gates ─▶ 4. ha vertical simulate ─▶ 5. Preview & Handoff
   (entities, roles,      (work-root + default    (entities, bilingual       (zero-side-effect          (ha init --vertical,
    artifacts, gates)      preset + agents)        templates, checkers)       PASS/FAIL probes)          ha work create)
```

### Step 1 — Domain Interview

Extract four concrete decisions before touching files:

1. **Vertical ID & Title**: lowercase `<domain>/<name>` (e.g. `procurement/review`, `finance/audit`). Never reuse `software/coding`.
2. **Lifecycle & Artifact Entities**: `task`, `decision` (lifecycle) and `fact` (schema) are contract entities; add domain `artifact` kinds (e.g. `vendor-dossier`, `audit-finding`) with `idPrefix`, `schemaVersions`, `store.pathTemplate`, and `maturityVocabulary`.
3. **Roles**: domain worker (`agents/contributor.json`) and independent reviewer (`agents/closeout-reviewer.json`) declarations (`agent-declaration/v1`).
4. **Declarative Completion Gates**: what structured JSON artifact under `artifacts/` proves readiness, which fields are bound via RFC 6901 JSON Pointer, and what positive vs. negative sample payloads look like.

### Step 2 — Scaffold the Vertical (`ha vertical init`)

Generate a complete, immediately-valid package instead of hand-writing JSON:

```sh
ha vertical init procurement/review --title "Procurement Review" --preset review-task --dry-run
ha vertical init procurement/review --title "Procurement Review" --preset review-task
```

Out of the box, `ha vertical init` creates `verticals/<slug>/` with:

- `vertical.json`, `capabilities.json` (with `completion-witness` and `requiredTaskClass: "work"` provider), and `template-catalog.json` (`template-catalog/v2`, `bodyPath`-backed `en-US`/`zh-CN` templates).
- `presets/work-root/` so `ha work create` works immediately.
- `presets/<default-preset>/` (`preset-manifest/v3`) with a working artifact-only command gate (`checks/verify-deliverable.mjs`).
- `agents/{contributor,closeout-reviewer}.json` so domain agents load without falling back to `software/coding`.
- `samples/<gate-id>/{positive,negative}.json` ready for dry-run gate probes.

Existing files are protected by default; pass `--force` only when intentionally regenerating. Add extra task presets with `ha preset init <preset-id> --vertical <vertical-id>` (see [preset-creator](../preset-creator/SKILL.md)).

### Step 3 — Author Domain Rules, Templates & Gates

Customize the scaffolded files inside `verticals/<slug>/`:

- **Entities**: extend `vertical.json` `entityKinds` (`artifact` kinds only need `kindId`, `schemaVersions`, `store`, `locatorKinds`, `maturityVocabulary`; lifecycle entities need matching `packageScaffolds` and `repositoryScaffold.entityRoots`).
- **Templates**: edit bilingual Markdown under `templates/<slot>/{en-US,zh-CN}.md` and keep `requiredAnchors` aligned with each locale's `anchors` in `template-catalog.json`. Never inline template bodies.
- **Agents**: refine role instructions in `agents/*.json`.
- **Gates**: add or customize command/manual/external sources, `resultSchema`, and artifact `bindings` (see [gate-customization](../gate-customization/SKILL.md)), updating `samples/<gate-id>/{positive,negative}.json` to match.

### Step 4 — Zero-Side-Effect Dry-Run Simulation (`ha vertical simulate`)

Verify the entire vertical before creating any ledger events or tasks:

```sh
ha vertical validate --source procurement/review
ha vertical simulate --source procurement/review --locale zh-CN --json
```

`ha vertical simulate` runs in an isolated temporary sandbox (**0 ledger writes**) and checks six dimensions in one pass:

1. `validateVerticalSource` schema and catalog integrity.
2. `resolveRepoBootstrapDefaults` and `work-root` (`taskClass="work"`) resolution.
3. Full rendered repository scaffold preview (`AGENTS.md`, `CLAUDE.md`, context/standards).
4. Dual-mode task materialization previews for both regular tasks and `taskClass="work"` roots.
5. Domain `agents/*.json` roster resolution (`listBundledAgentDeclarationIds`).
6. Real sandbox execution of every declarative command completion gate against `positive.json` (must PASS with 0 predicate issues) and `negative.json` (must FAIL with deterministic `gate_witness_missing` blocker).

If `preset-audit` or `vertical-simulate` warns about a broken legacy user preset pointer (for example unknown field `checkerProfile`), remove it with `ha preset uninstall <id>` or migrate its manifest and reinstall.

### Step 5 — Preview & Handoff

1. Inspect the rendered file trees and gate diagnostics from `ha vertical simulate --source <id>`.
2. Activate in a target repository via `ha init --vertical <id>` and prove `ha work create` + `ha task create`.
3. Add automated validation/simulation tests at the matching tier (`// harness-test-tier:`) without introducing vertical-id branches in core code.

## Review Checklist

- `ha vertical validate --source <id>` and `ha vertical simulate --source <id>` both pass (`ok: true`, `zeroLedgerWrites: true`).
- `work-root` preset declares `requiredTaskClass: "work"` and at least one non-work default preset resolves.
- `agents/*.json` declares domain worker and reviewer roles.
- Positive gate probes PASS and negative gate probes FAIL with `gate_witness_missing`.
- No vertical-id branches were added to kernel, daemon, or CLI.
