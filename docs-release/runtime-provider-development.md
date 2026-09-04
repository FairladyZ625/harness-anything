# Add a built-in runtime provider

Runtime providers are product-owned integrations. They are not user-installed entities.

To add one, extend `packages/daemon/src/runtime-inventory.ts` with one declaration and add its frame parser to
`packages/daemon/src/runtime-spawn-provider-frames.ts`. The declaration owns the provider identity, executable
discovery, model and authentication probes, instance configuration fields, permission and isolation constraints,
launch metadata, session identity extraction, renderer plane, and measured capability states.

Use `unverified` for a capability until a parser or runtime observation establishes it. Do not add a parallel kind
union, CLI enum, preload allowlist, renderer plane table, or response DTO branch. The inventory lookup rejects an
unknown kind explicitly, and the frame-parser registry checks that every declaration has a parser.

Keep stored instance configuration under the declaration's dynamic kind key. This lets existing instance files keep
their canonical bytes while new built-in kinds use the same parser, persistence, protocol, and renderer path.
