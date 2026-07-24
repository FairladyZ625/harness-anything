export const taskLifecycleFacadeParseCases = [
  {
    name: "task start",
    argv: ["task", "start", "task_1", "--ttl-ms", "60000"],
    kind: "task-start",
    fields: { taskId: "task_1", ttlMs: 60000, dryRun: false }
  },
  {
    name: "task closeout structured packet",
    argv: ["task", "closeout", "task_1", "--json-input", JSON.stringify({ completionClaim: "ready", verdict: "approved", findings: "passed", rationale: "evidence checked", consentAssertedRationale: "external approval", consentActions: ["approve_execution", "complete_task"], ci: "passed" })],
    kind: "task-closeout",
    fields: { taskId: "task_1", submission: { completionClaim: "ready", deliverables: [], outputs: [], verificationNotes: [], knownGaps: [], residualRisks: [] }, review: { verdict: "approved", findings: "passed", evidenceChecked: [], rationale: "evidence checked", archiveWarningsAcknowledged: false, consentAssertedRationale: "external approval", consentActions: ["approve_execution", "complete_task"] }, commitRef: "HEAD", paths: [], forceCodeDoc: false, ciGate: "passed", reviewerId: "local-reviewer", dryRun: false }
  },
  {
    name: "task retire execution",
    argv: ["task", "retire-execution", "task_1", "--execution-id", "exe_1", "--reason", "stale claim"],
    kind: "task-retire-execution",
    fields: { taskId: "task_1", executionId: "exe_1", reason: "stale claim" }
  }
] as const;
