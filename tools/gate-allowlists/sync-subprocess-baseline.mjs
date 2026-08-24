// Stable source-attached identities for frozen synchronous-subprocess sites.
//
// Identity is the @gate-identity marker attached to the governed syntax node.
// The marker moves with its subject across formatting, reorder, split, and rename.
// Baseline membership still rejects unmarked additions, unknown ids, duplicate ids,
// and stale identities.
export const syncSubprocessBaseline = Object.freeze([
  { key: "sync-subprocess-001", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-002", kind: "call", api: "execFileSync" }, // execFileSync call @ runExecutableSync.stdout
  { key: "sync-subprocess-003", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-004", kind: "call", api: "execFileSync" }, // execFileSync call @ gitTracked
  { key: "sync-subprocess-005", kind: "call", api: "execFileSync" }, // execFileSync call @ gitModified
  { key: "sync-subprocess-006", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-007", kind: "call", api: "execFileSync" }, // execFileSync call @ gitNames
  { key: "sync-subprocess-008", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-009", kind: "call", api: "execFileSync" }, // execFileSync call @ runProcessText
  { key: "sync-subprocess-010", kind: "import", api: "spawnSync" }, // spawnSync import @ <module>
  { key: "sync-subprocess-011", kind: "call", api: "spawnSync" }, // spawnSync call @ terminateRuntimeProcess
  { key: "sync-subprocess-012", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-013", kind: "call", api: "execFileSync" }, // execFileSync call @ findTrackedGeneratedFiles.output
  { key: "sync-subprocess-014", kind: "import", api: "execFileSync" }, // execFileSync import @ <module>
  { key: "sync-subprocess-015", kind: "call", api: "execFileSync" }, // execFileSync call @ runGitAs
  { key: "sync-subprocess-016", kind: "call", api: "execFileSync" }, // execFileSync call @ localGitBytes
  { key: "sync-subprocess-017", kind: "call", api: "execFileSync" }, // execFileSync call @ <module>
]);
