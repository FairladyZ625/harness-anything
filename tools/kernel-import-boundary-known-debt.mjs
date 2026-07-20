export const kernelImportBoundaryKnownDebt = [
  {
    file: "packages/adapters/local/src/index.ts",
    specifier: "@harness-anything/kernel/store/index",
    target: "packages/kernel/src/store/index.ts",
    decision: "task_01KXW80M803GR3EKRDV3X7T0MM",
    reason: "B7 owns the real package-subpath edge while daemon runtime moves to its final package and the transitional store barrel retires."
  },
  {
    file: "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
    specifier: "../../../kernel/src/store/index.ts",
    target: "packages/kernel/src/store/index.ts",
    decision: "task_01KXW80M803GR3EKRDV3X7T0MM",
    reason: "B7 retires the remaining store barrel after runtime ownership moves; this test-only relative edge stays exact until then."
  }
];

for (const [index, entry] of kernelImportBoundaryKnownDebt.entries()) {
  for (const field of ["file", "specifier", "target", "decision", "reason"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`kernelImportBoundaryKnownDebt[${index}] must include non-empty ${field}`);
    }
  }
  if (!/^(?:dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)$/u.test(entry.decision)) {
    throw new Error(`kernelImportBoundaryKnownDebt[${index}].decision must cite a decision id or task id`);
  }
}
