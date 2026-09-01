export const portPhysicalIoBoundaryKnownDebt = [
  {
    file: "packages/kernel/src/daemon/registry.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing daemon registry implementation owns local lock and socket registry persistence; W3 records the precise implementation exception."
  },
  {
    file: "packages/kernel/src/local/local-layout-file-system.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing local layout filesystem adapter is the current filesystem-backed implementation of layout discovery."
  },
  {
    file: "packages/kernel/src/projection/post-merge-checks.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing post-merge projection checker performs local git and filesystem probes; W3 records this implementation exception without changing projection behavior."
  },
  {
    file: "packages/kernel/src/projection/relation-graph-projection.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing relation graph projection builder reads authored markdown from disk; W3 freezes this projection implementation exception."
  },
  {
    file: "packages/kernel/src/projection/sqlite-projection-store.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing sqlite projection store owns generated projection database writes; W3 freezes this storage implementation exception."
  },
  {
    file: "packages/kernel/src/projection/sqlite-task-projection.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing task projection orchestration checks generated projection files; W3 freezes this projection implementation exception."
  },
  {
    file: "packages/kernel/src/projection/sqlite-task-source.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing task projection source traverses authored task markdown; W3 records the projection implementation exception."
  },
  {
    file: "packages/kernel/src/projection/toctou-safe-fs.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing projection helper centralizes TOCTOU-safe filesystem reads for projection builders."
  },
  {
    file: "packages/kernel/src/store/local-version-control-system.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing local VersionControlSystem port implementation shells out to git; W3 allows only this precise git implementation file."
  },
];

for (const [index, entry] of portPhysicalIoBoundaryKnownDebt.entries()) {
  for (const field of ["file", "decision", "reason"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`portPhysicalIoBoundaryKnownDebt[${index}] must include non-empty ${field}`);
    }
  }
  if (!/^(dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)$/u.test(entry.decision)) {
    throw new Error(`portPhysicalIoBoundaryKnownDebt[${index}].decision must cite a decision id or task id`);
  }
}
