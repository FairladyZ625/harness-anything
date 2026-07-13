# Give coding agents an architecture map

The software/coding vertical can add an opt-in, repository-owned architecture
map. It is for changes that cross packages, services, write paths, or runtime
boundaries: the agent locates the canonical owner before editing the nearest
caller, and a deterministic check compares authored intent with observed
JavaScript/TypeScript imports.

This capability is not a required completion gate. Repositories that do not
initialize it keep the ordinary coding workflow, and other verticals do not
load its assets or scripts.

## What is authoritative

The model and the code snapshot have different jobs:

- `harness/context/architecture/architecture-manifest.json` selects the model,
  stable source scopes, views, and fixed extractors.
- `harness/context/architecture/model/**/*.c4` is human-authored intent. Stable
  `metadata.archId` values identify components and relationships; display names
  and layouts may change.
- A task-owned `artifacts/architecture/architecture-snapshot.json` is derived
  code evidence. It records the public-repository commit, model and source
  digests, tool versions, mappings, and findings. It is disposable and must
  never rewrite the model automatically.

Use component or package boundaries, not a node for every file. A source path
must match exactly one declared scope. Create only relationships supported by
code, an ADR/decision, or runtime evidence.

## Initialize explicitly

From a source checkout, install the pinned workspace dependencies and use the
workspace CLI build:

```bash
npm ci
npm run build -w @harness-anything/cli
node packages/cli/dist/cli/src/index.js script run \
  vertical:software-coding:architecture-init
```

Initialization is no-overwrite. It creates a manifest, a LikeC4 scaffold, and
landscape, write-path, and runtime view files only when every target is safe.
Replace every `draft` placeholder with repository evidence before taking a
snapshot. Harness does not install LikeC4 or an extractor from inside the
sandbox.

The bundled adapters currently require the versions pinned by the workspace:

- `likec4@1.58.0` for authored-model parsing;
- `dependency-cruiser@17.4.3` for JavaScript/TypeScript import facts;
- Node.js 24 or newer, matching the repository engine contract.

## Snapshot and check

Snapshots belong to the task that owns the observation:

```bash
ha script run vertical:software-coding:architecture-snapshot \
  --task <task-id> --json
ha script run vertical:software-coding:architecture-check \
  --task <task-id> --json
```

Run the snapshot twice when establishing a baseline. The snapshot digest,
source digest, model digest, commit, and tool versions should be identical. The
check reports one of five explicit states:

- `not-configured`: the repository did not opt in;
- `fresh`: commit, source, model, tools, and semantic comparison match;
- `drifted`: provenance changed or the comparison has findings;
- `invalid`: the manifest, model, mapping, or snapshot is malformed;
- `tool-missing`: a pinned provider or extractor is unavailable.

`forbidden-dependency`, `reverse-dependency`, `unexpected-dependency`,
`missing-required-dependency`, `unmapped-*`, and `architecture-cycle` findings
are review inputs. Decide whether to fix code, update authored intent with
evidence, or create a separately owned architecture-debt task. Do not turn the
model green by copying the import graph into it.

## Agent query route

For an applicable change, record the stable node, relevant view or flow, direct
incomers and outgoers, selected modification layer, snapshot digest, and any
ADR/decision reference. The `code-impact-analysis` preset provides those fields.

If a LikeC4 MCP server is already available, the agent may use element search,
view reads, and graph queries. MCP is only an accelerator. The deterministic
fallback is to read the manifest and `.c4` text, then run `architecture-check`.
Do not install or start network tooling merely to finish an ordinary task.

## Maintenance and failure recovery

Repository maintainers own the authored model. Re-run a snapshot when source
scopes, cross-component dependencies, provider inputs, or pinned tool versions
change. Preserve stable `archId` values across title and layout edits.

Common failures are deliberate:

- Remaining scaffold placeholders make the configuration `invalid`.
- A globally installed `ha` and a newer workspace script may not share the same
  trusted package boundary. Build and invoke the workspace CLI shown above, or
  restart the local daemon from that build; do not widen sandbox permissions.
- Recursive architecture read scopes fail closed when the context tree contains
  symlinks, including nested `node_modules`. Keep generated dependencies and
  prototype build output outside authored architecture context.
- A version mismatch stays visible. Run `npm ci` from the lockfile instead of
  silently accepting a different parser.

To disable the capability, remove the repository-owned architecture manifest
and model in a reviewed change, and remove task snapshot artifacts according to
the repository's evidence-retention policy. No kernel entity, database row, CI
requirement, or global configuration needs to be uninstalled.
