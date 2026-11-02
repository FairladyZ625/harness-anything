# @harness-anything/storage

Storage adapters for the Harness Anything kernel ports.

SQLite and external PostgreSQL require Node.js 24 or newer. The embedded PGlite backend
requires Node.js 26 or newer: Node 24's V8 has a [WASM wrapper reclamation defect](https://github.com/nodejs/node/issues/66366)
that can terminate the entire host process. The PGlite factory refuses unsupported runtimes
before constructing WASM with error code `pglite_runtime_unsupported`.

CI runs the PGlite database integration assertions on Node 26 and the factory refusal
contract on Node 24. The package's Node 24 engine requirement continues to cover SQLite
and external PostgreSQL.
