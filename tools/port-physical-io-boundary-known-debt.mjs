export const portPhysicalIoBoundaryKnownDebt = [
  {
    file: "packages/application/src/decision-document-reader.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing application read-side local document adapter uses filesystem reads; W3 freezes this file-level exception until the read port implementation is extracted."
  },
  {
    file: "packages/application/src/fact-write-service.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing application fact write service still performs direct authored-file writes; W3 records the exception instead of migrating write semantics."
  },
  {
    file: "packages/application/src/runtime-event-ledger-service.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing runtime event ledger append implementation owns local ledger persistence; W3 freezes this file-level exception until a dedicated adapter boundary exists."
  },
  {
    file: "packages/application/src/runtime-session-logs.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing runtime session log reader owns local log filesystem access; W3 freezes this file-level exception until the read port is extracted."
  },
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
    file: "packages/kernel/src/projection/sqlite-decision-source.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing decision projection source traverses authored markdown files; W3 records the projection implementation exception."
  },
  {
    file: "packages/kernel/src/projection/sqlite-projection-store.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing sqlite projection store owns generated projection database writes; W3 freezes this storage implementation exception."
  },
  {
    file: "packages/kernel/src/projection/sqlite-task-incremental-projection.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing incremental projection path reads filesystem metadata for freshness; W3 records this projection implementation exception."
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
    file: "packages/kernel/src/store/local-lock-registry.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing local lock registry implementation owns filesystem-backed lock cleanup."
  },
  {
    file: "packages/kernel/src/store/local-version-control-system.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing local VersionControlSystem port implementation shells out to git; W3 allows only this precise git implementation file."
  },
  {
    file: "packages/kernel/src/store/markdown-artifact-store.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing markdown artifact store implementation owns local package document reads and writes."
  },
  {
    file: "packages/kernel/src/store/write-journal-coordinator.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing write coordinator still performs local recovery/disposition filesystem checks; W3 records this implementation exception without migrating behavior."
  },
  {
    file: "packages/kernel/src/store/write-journal-decision-documents.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing decision document write helper owns directory creation for authored decision documents."
  },
  {
    file: "packages/kernel/src/store/write-journal-durable.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing durable journal writer owns atomic filesystem writes for the journal implementation."
  },
  {
    file: "packages/kernel/src/store/write-journal-locks.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing journal lock implementation owns filesystem lock files and host metadata."
  },
  {
    file: "packages/kernel/src/store/write-journal-operations.ts",
    decision: "task_01KWXKR6YSV4J4E0H5FGPHKZYN",
    reason: "Existing journal operation implementation owns local authored-file write operations."
  }
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
