export const kernelImportBoundaryKnownDebt = [
  {
    file: "packages/adapters/local/src/index.ts",
    specifier: "../../../kernel/src/store/index.ts",
    target: "packages/kernel/src/store/index.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Local adapter composition root still reaches the store implementation to construct the journaled WriteCoordinator; F6 owns the seam cleanup."
  },
  {
    file: "packages/adapters/local/src/task-writes.ts",
    specifier: "../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Task write helpers call write-coordination helpers directly instead of consuming a public WriteCoordinator-facing application seam; F6 owns the cleanup."
  },
  {
    file: "packages/adapters/multica/src/index.ts",
    specifier: "../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Multica adoption writes call write-coordination helpers directly; F6 owns the WriteCoordinator seam cleanup."
  },
  {
    file: "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
    specifier: "../../../kernel/src/store/index.ts",
    target: "packages/kernel/src/store/index.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Multica test constructs the store-backed coordinator directly; F6 owns the test seam cleanup."
  },
  {
    file: "packages/application/src/decision-write-service.ts",
    specifier: "../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Decision write service calls write-coordination helpers directly; F6 owns the application/write seam cleanup."
  },
  {
    file: "packages/application/src/fact-write-service.ts",
    specifier: "../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Fact write service calls write-coordination helpers directly; F6 owns the application/write seam cleanup."
  },
  {
    file: "packages/cli/src/commands/anchor-backfill.ts",
    specifier: "../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "CLI anchor backfill calls write-coordination helpers directly; F6 owns the CLI/write seam cleanup."
  },
  {
    file: "packages/cli/src/commands/core/provenance-backfill.ts",
    specifier: "../../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "CLI provenance backfill calls write-coordination helpers directly; F6 owns the CLI/write seam cleanup."
  },
  {
    file: "packages/cli/src/commands/extensions/module.ts",
    specifier: "../../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Module extension commands call write-coordination helpers directly; F6 owns the extension/write seam cleanup."
  },
  {
    file: "packages/cli/src/commands/extensions/state.ts",
    specifier: "../../../../kernel/src/write-coordination/write-helpers.ts",
    target: "packages/kernel/src/write-coordination/write-helpers.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "State extension commands call write-coordination helpers directly; F6 owns the extension/write seam cleanup."
  }
];
