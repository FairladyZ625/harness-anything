# Repository Architecture

## Purpose

This folder is the coding vertical's durable navigation surface for understanding the repository before changing it. Keep the model at component or subsystem level; it is not a file inventory.

## Activation

This README does not enable architecture tooling. The feature is configured only when `architecture-manifest.json` exists beside this file. A present manifest must use `"enabled": true`; delete the manifest to disable the feature.

Run architecture initialization explicitly before replacing the placeholders below. Harness does not install LikeC4 or any extractor automatically.

## Source of Truth

- `architecture-manifest.json` owns provider routing, model location, stable view IDs, source scopes, and extractor declarations. `modelRoot` resolves from the manifest directory; `provider.config` and every `views[].path` resolve from `modelRoot`.
- The bundled executable `architecture-model/v1` contract owns the stable metadata keys, lifecycle values, relationship expectations, evidence formats, and required view IDs used by scripts and adapters.
- `model/**/*.c4` owns human-authored architecture intent: semantic nodes, responsibilities, boundaries, and expected relations.
- Generated code snapshots are observations. Store them outside the authored model and never copy them back into the model automatically.

Physical manifest paths (`modelRoot`, `provider.config`, and `views[].path`) must be NFC-normalized POSIX paths relative to their resolution bases defined above, and they must be portable on Windows. Provider config and view targets are compared after NFC normalization and case folding; a collision is invalid. Source scope globs are repository-root-relative selectors rather than physical paths, so they retain glob metacharacters such as `*` and `?` while still rejecting NUL, absolute paths, traversal, backslashes, and leading `!` negation.

The manifest links a source scope to a semantic node through `sourceScopes[].nodeId`. That value must resolve to exactly one node whose LikeC4 `metadata.archId` is identical. Scope globs match normalized repository-root-relative POSIX paths: includes form a union, excludes always win, and array order has no precedence. Mapping is evaluated separately for each extractor using only its `sourceScopeIds`: zero matches means `unmapped`, while more than one means an ambiguous, invalid mapping.

## Authoring Contract

Use `metadata.archId` as identity; LikeC4 names, fully qualified names, titles, layouts, and source paths may change without changing it. Element `archId` values are globally unique within the model, and relationship `archId` values are globally unique within the model. Starter nodes and relations are marked `draft` placeholders and must be replaced with repository evidence; architecture checks treat remaining placeholders as invalid configuration, not as a fresh model.

Every element records `archId`, `status`, `owner`, `responsibilities`, and `nonResponsibilities`. Every relationship records `archId`, `status`, and an `expectation` of `allowed`, `required`, or `forbidden`. An optional `extractorIds` array references manifest extractor IDs; only a relationship that names an extractor participates in that extractor's drift comparison. Both endpoint `archId` values must be covered by that extractor's referenced scopes, or the configuration is invalid. Relationships without `extractorIds` remain queryable architecture intent and are not guessed to be import edges. A `verified` element or relationship must cite at least one evidence value: `adrRefs` are repository-root-relative POSIX paths, while `decisionRefs` use canonical `decision/<decision-id>` references. Source paths live only in manifest source scopes.

## Views

The V1 contract requires three stable view IDs while keeping model and views in separate files:

- `landscape`: the component-level system map.
- `write-path`: the authored change/write flow.
- `runtime`: the important runtime boundaries.

Agents cite the stable manifest view ID and node `archId`, not a display title.

## Agent Query Routing

Before a cross-module code change, answer the smallest useful set of questions: which stable node owns the behavior, which view or flow contains it, what directly enters and leaves it, which multi-hop paths are affected, and why the selected implementation layer is canonical. Record only those references and the current snapshot digest in the task's `code-impact-analysis.md`.

When a LikeC4 MCP server is already available, use `search-element` or `read-element` to resolve the stable node, `read-view` for the declared flow, `query-graph` for direct incomers/outgoers, and the recursive graph or relationship-path tools only when the change crosses boundaries. The official server can be exposed by an active editor extension, `likec4 mcp`, or `@likec4/mcp`; MCP is an optional query accelerator, never a task prerequisite.

The deterministic fallback is always available: read the manifest and `.c4` text in the order above, then run `ha script run vertical:software-coding:architecture-check --task <task-id>`. If the project already provides LikeC4, `likec4 validate` checks model syntax. Do not install or start network tooling merely to complete an ordinary task.

Interpret check states explicitly: `not-configured` means the normal coding workflow continues; `fresh` supplies a snapshot digest to cite; `drifted` must preserve both model intent and conflicting code evidence; `invalid` must expose the configuration issue; `tool-missing` must record the missing tool and continue with text-model navigation where possible. Docs-only or clearly local low-risk work may record N/A with a reason instead of running external queries.

## Validation

Validate the manifest with the bundled `architecture-manifest/v1` contract. If LikeC4 is explicitly available, run `likec4 validate` from the manifest's `modelRoot`. Tool absence is a deterministic degraded state, never a reason to auto-install over the network.

Read in this order: manifest, relevant view, referenced nodes and relations, then their ADR/decision evidence. If a generated snapshot disagrees with the model, report the conflict instead of silently editing either side.

## Migration and Conflicts

Initialization is no-overwrite. Existing architecture files must be reviewed and migrated deliberately; an initializer reports every conflicting path and leaves all existing content unchanged. Commit authored intent, but follow the repository policy for generated or local snapshots.
