export interface TaskPacketTemplate {
  readonly fileName: "submission.json" | "approval.json";
  readonly value: Readonly<Record<string, unknown>>;
}

const taskPacketTemplates: Readonly<Record<string, TaskPacketTemplate>> = {
  "task-submit": {
    fileName: "submission.json",
    value: {
      completionClaim: "<what is complete>",
      deliverables: ["<deliverable>"],
      outputs: ["<output evidence>"],
      verificationNotes: ["<verification command and result>"],
      knownGaps: [],
      residualRisks: []
    }
  },
  "task-complete": {
    fileName: "approval.json",
    value: {
      findings: "<review findings>",
      rationale: "<why the evidence supports approval>",
      evidenceChecked: [],
      archiveWarningsAcknowledged: false,
      consentAssertedRationale: "<how owner approval was obtained>",
      consentActions: ["approve_execution", "complete_task"],
      ci: "passed",
      paths: [],
      reviewerId: "local-reviewer"
    }
  }
};

export function taskPacketTemplateFor(commandKind: string): TaskPacketTemplate | undefined {
  return taskPacketTemplates[commandKind];
}
