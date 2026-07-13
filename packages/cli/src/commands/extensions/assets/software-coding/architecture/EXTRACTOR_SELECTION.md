# JavaScript and TypeScript Dependency Extractor Selection

Status: accepted for the `javascript-typescript/imports-v1` adapter

Evidence checked: 2026-07-14

## Decision

Use dependency-cruiser behind a Harness-owned process and JSON adapter boundary. The raw tool output is not a public contract: the adapter must decode it into `architecture-code-graph/v1`, whose file, package, and dependency records contain no dependency-cruiser-specific types.

This selection does not add the dependency or enable scanning. The implementation slice owns the pinned package version, golden raw-output fixtures, execution limits, and real repository snapshot.

## Evidence

| Criterion | dependency-cruiser | Madge | TypeScript compiler API |
| --- | --- | --- | --- |
| License | MIT in the [official license](https://github.com/sverweij/dependency-cruiser/blob/main/LICENSE) | MIT in the [official license](https://github.com/pahen/madge/blob/master/LICENSE) | TypeScript is Apache-2.0; direct use would still make Harness own dependency traversal and resolution policy |
| Maintenance | npm registry metadata reported `18.1.0`, modified 2026-07-12 | npm registry metadata reported `8.0.0`, modified 2024-08-05 | Maintained with TypeScript, but it is a compiler building block rather than a dependency-graph product contract |
| Machine output | The official [output format](https://github.com/sverweij/dependency-cruiser/blob/main/doc/output-format.md) documents JSON modules, dependencies, rules, and summary; the project tests its output schema | The official [README](https://github.com/pahen/madge) documents JSON output and a programmatic API | Harness would have to design, implement, and maintain module-resolution traversal and graph serialization |
| Invocation isolation | The official [CLI](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md) supports explicit JSON output and scoped input; Harness can invoke an argv array with `shell: false` | CLI and API are available, but the package wraps `dependency-tree` and its resolver stack | In-process compiler objects and TypeScript-specific types would increase coupling to one language implementation |
| Performance posture | Include/exclude controls permit bounded scans; no official apples-to-apples benchmark was found, so P3b must record a deterministic fixture and measured repository runtime rather than claim an unverified advantage | No official apples-to-apples benchmark was found | Potentially tunable, but Harness would own caching, traversal, and performance regressions |
| Supply-chain surface | npm registry metadata reported 18 direct dependencies and Node `^22 || ^24 || >=26` | npm registry metadata reported multiple runtime dependencies and Node `>=18` | No extra parser package beyond the existing compiler, but substantially more first-party code and maintenance surface |

Primary metadata endpoints: [dependency-cruiser npm registry record](https://registry.npmjs.org/dependency-cruiser/latest) and [Madge npm registry record](https://registry.npmjs.org/madge/latest). dependency-cruiser's official [API documentation](https://github.com/sverweij/dependency-cruiser/blob/main/doc/api.md) also exposes an in-process API, but the fixed Harness seam deliberately chooses process isolation so tool types and failures cannot leak into common CLI contracts.

## Fixed boundary

- Adapter identity: `javascript-typescript/imports-v1`.
- Tool identity: `dependency-cruiser`.
- Invocation: executable plus argv, repository root as cwd, `shell: false`, JSON stdout only.
- Success: decoded and validated `architecture-code-graph/v1`.
- Missing executable or package capability: existing `tool-missing` contract.
- Non-zero exit, malformed JSON, unknown output fields, or graph-contract violation: existing `invalid` contract.
- Mapping files to architecture nodes and semantic drift comparison remain downstream responsibilities.

The seam is replaceable: a future Python, Go, or alternate JS/TS adapter can produce the same language-neutral graph without changing snapshot or comparator contracts.
