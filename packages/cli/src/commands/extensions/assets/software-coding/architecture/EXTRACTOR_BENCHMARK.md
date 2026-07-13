# JavaScript and TypeScript Extractor Benchmark

Evidence date: 2026-07-14

Base commit: `1e72b9a3e4f036649e1b8737b24ccf278b2426aa`

Environment: Apple silicon macOS, Node 25.8.0, dependency-cruiser 17.4.3. Cache was not enabled.

Scope: JavaScript and TypeScript source under `packages/` and `tools/`; default test, `dist`, `node_modules`, test-file, and spec-file exclusions were active.

| Run | Cold elapsed | Files | Packages | Dependency edges | Canonical bytes | Digest |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2,785.79 ms | 691 | 10 | 1,590 | 485,387 | `sha256:3aef37e7535376857b3ee7277e8563b9ee4784a3750f7d95db0c87d0058f68b7` |
| 2 | 2,827.05 ms | 691 | 10 | 1,590 | 485,387 | `sha256:3aef37e7535376857b3ee7277e8563b9ee4784a3750f7d95db0c87d0058f68b7` |

The two canonical JSON snapshots were byte-for-byte equal and produced the same digest. Both uncached runs stayed below the P3b ten-second checkpoint. These are measured repository results, not a comparative performance claim about dependency-cruiser or alternatives.
