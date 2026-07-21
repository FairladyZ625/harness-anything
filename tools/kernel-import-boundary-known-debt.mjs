export const kernelImportBoundaryKnownDebt = [];

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
