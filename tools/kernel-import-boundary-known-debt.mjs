export const kernelImportBoundaryKnownDebt = [
  {
    file: "packages/adapters/local/src/index.ts",
    specifier: "../../../kernel/src/store/index.ts",
    target: "packages/kernel/src/store/index.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Local adapter composition root still reaches the store implementation to construct the journaled WriteCoordinator; F6 owns the seam cleanup."
  },
  {
    file: "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
    specifier: "../../../kernel/src/store/index.ts",
    target: "packages/kernel/src/store/index.ts",
    decision: "dec_GATE_DEFENSE_ROOT_CAUSE",
    reason: "Multica test constructs the store-backed coordinator directly; F6 owns the test seam cleanup."
  }
];

for (const [index, entry] of kernelImportBoundaryKnownDebt.entries()) {
  for (const field of ["file", "specifier", "target", "decision", "reason"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`kernelImportBoundaryKnownDebt[${index}] must include non-empty ${field}`);
    }
  }
  if (!/^dec_[A-Za-z0-9_]+$/u.test(entry.decision)) {
    throw new Error(`kernelImportBoundaryKnownDebt[${index}].decision must cite a decision id`);
  }
}
