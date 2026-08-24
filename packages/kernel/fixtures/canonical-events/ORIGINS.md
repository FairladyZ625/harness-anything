# Canonical event fixture origins

The ledger-derived events below were de-identified and then reserialized with the production `serializeCanonicalEvent` implementation. The `entity-event/v1` fixture was produced by the production compiler because the canonical ledger did not yet contain that schema. Every JSON file in this directory is protected by `packages/*/fixtures/** -text` in `.gitattributes`.

| Schema | Frozen sample | Source | Source blob |
| --- | --- | --- | --- |
| `migration-import-event/v1` | `packages/kernel/fixtures/canonical-events/migration-import-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/87/migration-5db94feeda01f0ca1c62d04b34.json` | `aab2f4430f7dc62abd07c0a0a7f72dab376594bd` |
| `task-event/v1` | `packages/kernel/fixtures/canonical-events/task-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/a9/op_efb2048e9125c83ead82ed097f9905194308571a0943b854e6a22ade8381a945.json` | `8d42819c6290a0562ac09db6b596295a16aa8314` |
| `decision-event/v1` | `packages/kernel/fixtures/canonical-events/decision-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/56/op_fb42c76955948c2f42e277bfa8897cc01ebeb69a67e0676818d5f38684a58174.json` | `a6b118c56267a1ef95001e27f3b1175e49a9e05c` |
| `preset-snapshot-upgrade-event/v1` | `packages/kernel/fixtures/canonical-events/preset-snapshot-upgrade-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/40/op_9297ed65122332c8bdf02eb06d0362ef8a7204103360f2cd32000da4e04ea6fe.json` | `e49077d22b4344b2782bae0026e9c288ae026071` |
| `fact-event/v1` | `packages/kernel/fixtures/canonical-events/fact-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/0f/op_4be52809c595fce21cb7cd190ba63f7c4b9bcea3cdb5dd9a16dd51a84d97da7f.json` | `6c9227c3ea7ab30333fbcc7f9077d1816f794d06` |
| `task-bootstrap-event/v1` | `packages/kernel/fixtures/canonical-events/task-bootstrap-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/17/op_732aecd32bf99b0cbe647d2862719f4e50158ab2f3446bc16cac2ff36c149ccc.json` | `5a3b4c6a3c23dd4072218db188c872e5fc0ffdb1` |
| `agent-runtime-event/v1` | `packages/kernel/fixtures/canonical-events/agent-runtime-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/2e/runtime-spawn-3ec2996ecec0aa442908f2147ea03a40-exited.json` | `6ba5a86a325683b8727414e00c5a84cec2a968a7` |
| `task-progress-event/v1` | `packages/kernel/fixtures/canonical-events/task-progress-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/e6/op_807bff628649092eafaab4c0b4880fb25176cccd13d3f3231ddfdf8037caa5c1.json` | `8c4804e03b8d86f62b8ca41e8dd72a0ea5ff1628` |
| `ledger-layout-event/v1` | `packages/kernel/fixtures/canonical-events/ledger-layout-event-v1/accepted.json` | `canonical ledger refs/ha/canonical:events/9f/op_73c908af2852b5ccafefa8eade5ad7fb045c4cd4435f16771bac6cc8071b287b.json` | `afe448f4450735a2a60338d45293081c554f519e` |
| `doc-event/v1` | `packages/kernel/fixtures/canonical-events/doc-event-v1/legacy-ledger-identity.json` | `packages/kernel/fixtures/events/doc-event-v1-legacy-ledger-identity.json` | `0948c1ba15338d108edd4bae136b9840a3e5d78a` |
| `entity-event/v1` | `packages/kernel/fixtures/canonical-events/entity-event-v1/accepted.json` | `compileEntityUpsert production compiler (no canonical event existed yet)` | N/A (compiler-generated) |
