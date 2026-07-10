# Verticals: the declaration engine

[The extension model](../../learn/en/04-verticals-and-extension.md) promises
that you can add a hundred domain concepts without the kernel changing by a
single line, because a vertical is a declarative artifact rather than compiled
code. This page shows the artifact and the engine that reads it: the schema a
`vertical.json` is validated against, and how the engine turns that JSON into
entity kinds, materialized documents, and a scaffolded repository.

## The artifact: one JSON, one schema

A vertical is a single `vertical.json` file. Before the engine acts on it, the
file is validated against `VerticalDefinitionSchema` in
`packages/kernel/src/schemas/vertical-definition.ts`. The schema is written with
effect-Schema, so validation is total: a malformed vertical is rejected before
any directory is touched, not discovered halfway through a scaffold.

The top-level shape a vertical must declare is fixed. Every field below is a
required member of the struct (except where noted):

| Field | What it declares |
|-------|------------------|
| `schema` | The literal `"vertical-definition/v1"` — a version stamp |
| `id`, `title`, `version` | Identity of the vertical (`"software/coding"`, etc.) |
| `entityKinds[]` | The kinds this domain cares about, each `lifecycle` or `schema` |
| `contractEntityKinds[]` | Which of those kinds are load-bearing contract entities |
| `packageScaffolds[]` | Per entity kind, the documents its package materializes |
| `repositoryScaffold` | The top-level directory layout, seeded docs, and agents entry |
| `scripts[]` | Declarative script entries the vertical ships |
| `templateSelections[]` | Vertical-wide template selections outside any package |
| `checkerProfile` | The name of the checker profile that guards this vertical |
| `projectionSchemas[]` | The frontmatter schemas the projection validates rows against |

The engine never invents any of these; it reads exactly what the JSON declares.
The rest of this page walks the four parts that carry the domain: entity kinds,
template selections, the repository scaffold, and the agents entry.

## Entity kinds: lifecycle vs. schema

`entityKinds[]` is a discriminated union. Each entry is one of two shapes, and
the `entityType` field picks which:

- A **lifecycle** kind declares `packageKind` — the frontmatter contract its
  document package is written against (`task-package/v2`, `decision-package/v1`).
  Lifecycle kinds get a full document package.
- A **schema** kind declares `schemaRef` — a pointer to a field schema
  (`schema://fact-record`) and nothing more. A schema kind constrains fields; it
  gets no document template.

Both carry `contractEntity: true` when the kind is load-bearing. In the real
`software/coding` vertical the union resolves to exactly three entries: `task`
and `decision` are lifecycle kinds, `fact` is a schema kind, and all three are
listed again in `contractEntityKinds`. That mapping — lifecycle gets a package,
schema gets only fields — is the same split [learn/04](../../learn/en/04-verticals-and-extension.md)
describes, expressed as two branches of one schema union.

## Template selections: slot to document

A **template selection** is how the engine knows which document to write where.
`TemplateSelectionSchema` has four required members plus an optional guard:

```text
slot            a stable name for the document's role   ("task.plan")
templateRef     which catalog template to draw from     ("template://planning/task-plan@1")
materializeAs   the on-disk filename it becomes          ("task_plan.md")
localePolicy    how to pick a language body              { prefer, fallback }
requiredWhen    optional key/value guard on selection
```

`localePolicy` is where the locale policy lives. `prefer` is one of `project`,
`preset`, or `explicit` — the order in which the engine looks for a language
preference — and `fallback` is a literal `zh-CN` or `en-US`, the body it drops
to when the preferred locale is missing. The template bodies themselves live in
the vertical's `template-catalog.json`; each catalog document lists a `zh-CN`
and an `en-US` locale with its own `bodyPath`. So a selection names the slot and
the policy; the catalog holds the actual localized text. If the preferred locale
has no body, the fallback is materialized rather than a broken document.

In the `software/coding` vertical, the `task` package scaffold lists six
selections — `task_plan.md`, `progress.md`, `facts.md`, `review.md`,
`closeout.md`, and a `.gitkeep` slot for the `artifacts/` directory — each
preferring the project locale and falling back to `en-US`. References are
opt-in: the `reference-task` preset adds the existing localized
`references/INDEX.md` template only when a task needs a durable input snapshot.
The `decision` package lists an empty selection array: a decision materializes
its `INDEX.md` from its package contract, so the vertical adds no extra body
documents to it.

## The repository scaffold

`repositoryScaffold` describes the top-level layout the engine lays down when a
project adopts the vertical. It has four parts:

- **`entityRoots[]`** — one per entity kind, each an `{ entityKind, path, create }`
  triple. `path` is a template like `{{paths.tasksRoot}}` resolved at scaffold
  time; `create` is `init` or `lazy`. `init` roots are created up front; `lazy`
  roots are created only when the first entity of that kind appears. In
  `software/coding`, the task root is `init` and the decision root is `lazy` —
  tasks exist from the start, decisions arrive on demand.
- **`dirs[]`** — plain directories with the same `init`|`lazy` create mode, for
  layout that is not an entity root (a directory for supporting documents, a
  context tree, a place records accumulate).
- **`seededDocs[]`** — documents dropped in at scaffold time. Each is a
  `RepositorySeededDoc`: the same `slot`/`templateRef`/`materializeAs`/`localePolicy`
  fields as a template selection, plus an optional `overwrite` boolean that
  decides whether an existing file is replaced. Seeded docs are how a fresh repo
  arrives with its README files and starter documents already in place.
- **`agentsEntry`** — an optional composite, described next.

`create: init | lazy` is the whole of the eager-vs-deferred policy: the engine
either lays a directory down immediately or waits for the first occupant.

## The agents entry: a layered composite

`agentsEntry` is the one materialization that is not a straight
template-to-file copy. It is a composite of three layers assembled into a single
file. `AgentsEntrySchema` declares:

```text
materializeAs         the file it becomes            ("AGENTS.md")
localePolicy          language selection             { prefer, fallback }
baseRef               layer 1: the base body
overlayRef            layer 2: the vertical overlay
repoSpecificsAnchor   optional: a heading below which repo specifics are appended
overwrite             optional
```

The engine composes `baseRef` (a base layer) and `overlayRef` (a vertical
overlay) into one document. The `repoSpecificsAnchor` names a heading — in
`software/coding` it is `"## Repository Specifics"` — below which repository-local
material is appended without rewriting the two composed layers above it. So the
base and overlay are regenerated from templates, while anything a project writes
under the anchor is preserved across regeneration. This is the only place the
vertical schema describes stacking one body on top of another; everywhere else a
template maps one-to-one to a file.

## Scripts and projection schemas

Two smaller arrays finish the artifact.

`scripts[]` declares script entries the vertical ships — each a
`{ id, type: "script", command, reads[], writes[], inputs, metadata }` record.
The `reads`/`writes` arrays are glob templates (`{{paths.docsRoot}}/**`) that
declare what the script touches, and `metadata.purpose` is one of `scaffold`,
`generate`, `transform`, or `audit`. In `software/coding` the scripts render
documents from decisions and seed them into the repository. The declaration
states what each script reads,
writes, and produces; it does not embed the script's logic.

`projectionSchemas[]` names the frontmatter schemas the projection validates
against — `schema://task-frontmatter`, `schema://decision-frontmatter`,
`schema://fact-record` — tying the vertical's entity kinds to the schemas the
[projection](03-projection.md) checks each row against.

## Convention over declaration, in the schema

The reason the JSON stays small is the split
[learn/04](../../learn/en/04-verticals-and-extension.md) names: the engine
declares only what it cannot infer, and detects the rest. You can see the line
directly in what the schema does and does not carry.

**Detected — convention.** Directory structure, whether a file already exists,
which naming slot a document fills, and whether the frontmatter validates
against its schema are all read from the filesystem. The engine scans for these
and fails closed when the structure is illegal — a malformed `vertical.json`
never validates, and a seeded doc whose template body is missing surfaces an
error rather than writing an empty file.

**Declared — intent.** What no filesystem reveals must be stated, and only that:
whether a kind is a load-bearing `contractEntity`, which `checkerProfile` guards
the vertical, how to degrade when a locale is missing (`localePolicy.fallback`),
whether a directory is created eagerly or lazily (`create`), and how the agents
entry layers (`baseRef`, `overlayRef`, `repoSpecificsAnchor`). These are handfuls
of fields, not paragraphs of configuration.

The engine is a declaration parser working over convention: it validates the
JSON, resolves the path templates, reads the localized bodies from the catalog,
and writes the scaffold — and it does the same thing for every vertical. Add an
entity kind, a document slot, or a whole new domain, and you edit the
`vertical.json`. The kernel that reads it does not change.
