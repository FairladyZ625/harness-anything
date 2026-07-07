---
name: vertical-creator
description: Create, review, or update Harness Anything verticals. Use when designing vertical-definition JSON, vertical template catalogs, entity kinds, package scaffolds, checker profiles, projection schemas, and preset layering for a new Harness Anything domain such as coding, QA, docs, design, or operations.
---

# Vertical Creator

## Core Rule

Keep verticals declarative. A vertical defines entity shape, template catalogs, scaffolds, defaults, and applicable presets. It must not require CLI core branches for a specific domain.

The CLI may provide only generic vertical infrastructure:

- Schema validation.
- Template catalog loading.
- Template materialization.
- Settings/dev-mode gating.
- Generic preset and profile selection.

Vertical-specific behavior belongs in vertical assets, template catalogs, preset manifests, and process scripts.

## Workflow

1. Name the domain and list its entity kinds using the entity declaration tuple.
2. Decide which entities are lifecycle package entities and which are schema-only metadata entities.
3. Define package scaffolds and repository roots for every lifecycle entity.
4. Put template bodies in Markdown assets under `assets/<vertical>/templates/<slot>/<locale>.md`.
5. Register those assets in `template-catalog/v2` with `bodyPath`; do not use inline `body`.
6. Define required documents as `templateSelections` that point at catalog refs.
7. Choose the checker profile and projection schemas.
8. Define applicable presets separately as `preset-manifest/v2`; do not bury preset behavior in the vertical.
9. Run `ha vertical validate <path>` before publishing the vertical.
10. Add validation tests for schema shape, materialized paths, catalog body paths, and default preset/profile behavior.
11. Add integration tests only for real CLI/filesystem behavior.

## Entity Declaration Tuple

Declare each entity with the v2 five-part contract:

- `id`
- `entityType`
- `packageKind` for lifecycle entities or `schemaRef` for schema entities
- `contractEntity`
- matching scaffold/root membership where required

Lifecycle entities must have both a `packageScaffolds` entry and a `repositoryScaffold.entityRoots` entry. Schema entities must not have package scaffolds or repository roots.

## Vertical Definition Pattern

This minimal shape was validated with `ha vertical validate vertical.json`.

```json
{
  "schema": "vertical-definition/v1",
  "id": "example/work",
  "title": "Example Work",
  "version": "1.0.0",
  "entityFieldExtensions": [],
  "entityKinds": [
    {
      "id": "task",
      "entityType": "lifecycle",
      "packageKind": "task-package/v2",
      "contractEntity": true
    },
    {
      "id": "fact",
      "entityType": "schema",
      "schemaRef": "schema://fact-record",
      "contractEntity": true
    }
  ],
  "contractEntityKinds": ["task", "fact"],
  "packageScaffolds": [
    {
      "entityKind": "task",
      "templateSelections": []
    }
  ],
  "repositoryScaffold": {
    "entityRoots": [
      {
        "entityKind": "task",
        "path": "{{paths.tasksRoot}}",
        "create": "init"
      }
    ],
    "dirs": [],
    "seededDocs": []
  },
  "scripts": [],
  "templateSelections": [],
  "checkerProfile": "standard",
  "projectionSchemas": []
}
```

Validate it:

```sh
ha vertical validate vertical.json
```

## Template Catalog v2

A vertical package should keep bodies as Markdown assets and register them by `bodyPath`:

```text
assets/software-coding/
  vertical.json
  template-catalog.json
  templates/
    task.plan/
      en-US.md
      zh-CN.md
  presets/
    standard-task/
      preset.json
```

Catalog root:

```json
{
  "schema": "template-catalog/v2",
  "package": {
    "id": "software-coding-core",
    "title": "Software Coding Core Templates",
    "version": "1.0.0",
    "owner": "harness-anything",
    "locales": ["zh-CN", "en-US"]
  },
  "documents": [
    {
      "id": "planning/task-plan",
      "version": "1",
      "documentKind": "task-plan",
      "slot": "task.plan",
      "materializeAs": "task_plan.md",
      "frontmatterSchema": "task-package/v2",
      "requiredAnchors": ["## Goal", "## Verification"],
      "fallbackLocale": "en-US",
      "locales": [
        {
          "locale": "en-US",
          "anchors": ["## Goal", "## Verification"],
          "bodyPath": "templates/task.plan/en-US.md"
        },
        {
          "locale": "zh-CN",
          "anchors": ["## Goal", "## Verification"],
          "bodyPath": "templates/task.plan/zh-CN.md"
        }
      ]
    }
  ]
}
```

`templates/task.plan/en-US.md` must contain all required anchors:

```md
## Goal

Describe the target outcome.

## Verification

List the validation steps.
```

Preset overlays should reference the same catalog documents from `preset-manifest/v2` profiles:

```json
{
  "id": "baseline",
  "title": "Baseline",
  "checkerProfile": "standard",
  "templateSelections": [
    {
      "slot": "task.plan",
      "templateRef": "template://planning/task-plan@1",
      "materializeAs": "task_plan.md",
      "localePolicy": { "prefer": "project", "fallback": "en-US" }
    }
  ]
}
```

## Design Rules

- Use templates for document structure, not ad hoc file writes.
- Use presets for optional process or content overlays.
- Use `preset-manifest/v2` for all new preset examples.
- Use `template-catalog/v2` with `bodyPath`; never teach inline template `body`.
- Keep project/user overrides additive and fail closed on invalid active overrides.
- Do not promise unattended conversion when the system supports Legacy Intake plus explicit rebuild only.
- Keep private harness operating state out of public docs unless explicitly designing public product documentation.

## Review Checklist

- `ha vertical validate <path>` passes.
- Entity kinds declare `entityType` and exactly one of `packageKind` or `schemaRef`.
- Every lifecycle entity has a package scaffold and repository root.
- Schema entities do not declare package scaffolds or repository roots.
- Template refs exist in `template-catalog/v2` and use asset-backed `bodyPath`.
- Required anchors match locale anchors and appear in each body asset.
- Presets shipped with the vertical use `preset-manifest/v2`, `profiles`, and `defaultProfile`.
- Preset manifests pass `ha preset validate <manifest>`.
- The vertical works without CLI branches keyed by vertical id.
- Template refs exist in the catalog and materialize to stable paths.
- Default preset/profile behavior is explicit.
- Custom verticals remain gated by user dev mode and project settings.
- Tests are placed in the proper tier manifest when new test files are added.
