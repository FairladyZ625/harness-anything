---
name: vertical-creator
description: Create, review, or update Harness Anything verticals. Use when designing vertical-definition JSON, vertical template catalogs, entity kinds, package scaffolds, checker profiles, projection schemas, and preset layering for a new Harness Anything domain such as coding, QA, docs, design, or operations.
---

# Vertical Creator

## Core Rule

Keep verticals declarative. A vertical defines domain shape, templates, defaults, and applicable presets. It must not require CLI core branches for a specific domain.

The CLI may provide only generic vertical infrastructure:

- Schema validation.
- Template catalog loading.
- Template materialization.
- Settings/dev-mode gating.
- Generic preset and profile selection.

Vertical-specific behavior belongs in vertical assets, template catalogs, presets, and process scripts.

## Workflow

1. Name the domain and list its entity kinds.
2. Decide which entities become task packages and which are metadata-only.
3. Define required task documents as template selections.
4. Choose the checker profile and projection schemas.
5. Define applicable presets separately; do not bury preset behavior in the vertical.
6. Add validation tests for schema shape, materialized paths, and default profile behavior.
7. Add integration tests only for real CLI/filesystem behavior.

## Vertical Definition Pattern

```json
{
  "schema": "vertical-definition/v1",
  "id": "software/coding",
  "title": "Software Coding",
  "version": "1.0.0",
  "entityKinds": [
    { "id": "task", "packageKind": "task", "contractEntity": true }
  ],
  "contractEntityKinds": ["task"],
  "packageScaffolds": [],
  "templateSelections": [],
  "checkerProfile": "standard",
  "projectionSchemas": []
}
```

## Design Rules

- Use templates for document structure, not ad hoc file writes.
- Use presets for optional process or content overlays.
- Keep project/user overrides additive and fail closed on invalid active overrides.
- Do not promise unattended conversion when the system supports Legacy Intake plus explicit rebuild only.
- Keep private harness operating state out of public docs unless explicitly designing public product documentation.

## Review Checklist

- The vertical works without CLI branches keyed by vertical id.
- Template refs exist in the catalog and materialize to stable paths.
- Default preset/profile behavior is explicit.
- Custom verticals remain gated by user dev mode and project settings.
- Tests are placed in the proper tier manifest when new test files are added.
