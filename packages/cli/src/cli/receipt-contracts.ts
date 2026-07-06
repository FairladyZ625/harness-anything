import type { ParsedCommand } from "./types.ts";

export interface CommandReceiptContract {
  readonly data: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly optionalData?: Readonly<Record<string, string>>;
  readonly optionalPaths?: Readonly<Record<string, string>>;
}

export type CommandKind = ParsedCommand["action"]["kind"];

export const commandReceiptContractsByKind = {
  "help": { data: ["commands", "report"], paths: [] },
  "version": { data: ["version"], paths: [] },
  "entity-list": { data: ["rows", "report"], paths: [] },
  "capabilities": { data: ["rows", "report"], paths: [] },
  "init": { data: ["generated"], paths: ["primary", "config"] },
  "new-task": {
    data: ["taskId", "slug", "status"],
    optionalData: {
      preset: "Only emitted when task creation runs through a selected preset.",
      module: "Only emitted when --module is supplied or preset/module routing materializes module metadata.",
      generated: "Only emitted when preset or template materialization produces generated files.",
      report: "Only emitted when the creation path produces a structured creation report."
    },
    paths: ["package"]
  },
  "status-set": {
    data: ["taskId", "status"],
    optionalData: {
      forced: "Only emitted for audited terminal recovery transitions invoked with --force.",
      forceAudit: "Only emitted for audited terminal recovery transitions that append force audit evidence."
    },
    paths: [],
    optionalPaths: {
      primary: "Only emitted for audited terminal recovery transitions where the audit progress path is returned as the primary path.",
      forceAudit: "Only emitted for audited terminal recovery transitions that append force audit evidence."
    }
  },
  "progress-append": {
    data: ["taskId"],
    optionalData: {
      report: "Only emitted when --evidence is supplied and the receipt includes the appended evidence payload."
    },
    paths: ["primary", "progress"]
  },
  "task-amend": { data: ["taskId", "report"], paths: ["primary"] },
  "task-archive": { data: ["taskId", "status", "report"], paths: [] },
  "task-supersede": {
    data: ["taskId"],
    optionalData: {
      report: "Only emitted when superseding by an existing replacement task via --by."
    },
    paths: ["primary", "replacement"],
    optionalPaths: {
      package: "Only emitted when supersede creates a new replacement task package."
    }
  },
  "task-delete": {
    data: ["taskId", "mode"],
    optionalData: {
      report: "Only emitted when delete attribution such as --deleted-by is supplied."
    },
    paths: []
  },
  "task-reopen": { data: ["taskId", "status"], paths: ["primary"] },
  "task-review": {
    data: ["taskId", "reviewContract", "report"],
    optionalData: {
      completionGate: "Only emitted by completion-oriented task gate results; ordinary task review emits the review contract only."
    },
    paths: []
  },
  "task-complete": {
    data: ["taskId", "status", "reviewContract", "completionGate"],
    optionalData: {
      report: "Only emitted for completion paths that surface a review or gate report; clean completion emits reviewContract and completionGate."
    },
    paths: []
  },
  "task-tree": { data: ["taskId", "tasks", "report"], paths: [] },
  "task-relate": { data: ["taskId", "report"], paths: ["primary"] },
  "decision-list": { data: ["rows", "report"], paths: [] },
  "decision-show": { data: ["decisionId", "report"], paths: ["primary"] },
  "decision-propose": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-accept": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-reject": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-defer": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-supersede": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-amend": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-relate": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-reckon": { data: ["decisionId", "taskId", "factId", "factRef", "report"], paths: ["primary"] },
  "decision-relation-retire": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-relation-replace": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "decision-retire": { data: ["decisionId", "decisionState", "report"], paths: ["primary"] },
  "fact-list": { data: ["taskId", "rows", "report"], paths: ["primary"] },
  "fact-show": { data: ["taskId", "factId", "factRef", "report"], paths: ["primary"] },
  "record-fact": { data: ["taskId", "factId", "factRef", "report"], paths: ["primary"] },
  "fact-invalidate": { data: ["taskId", "factId", "factRef", "report"], paths: ["primary"] },
  "distill-candidate": { data: ["taskId", "report"], paths: ["primary"] },
  "distill-commit": { data: ["taskId", "factId", "factRef", "report"], paths: ["primary"] },
  "runtime-event-append": { data: ["report"], paths: ["primary"] },
  "runtime-event-list": { data: ["rows", "report"], paths: ["primary"] },
  "materializer-run": { data: ["rows", "warnings", "report"], paths: [] },
  "session-export": { data: ["rows", "report"], paths: ["primary"] },
  "session-backfill": { data: ["rows", "report"], paths: ["primary"] },
  "session-sync": { data: ["rows", "report"], paths: ["primary"] },
  "doc-list": { data: ["rows", "report"], paths: ["primary"] },
  "doc-map": { data: ["rows", "report"], paths: ["primary"] },
  "doc-generate": { data: ["rows", "report"], paths: ["primary"] },
  "template-list": { data: ["templates", "issues"], paths: [] },
  "template-render": { data: ["document", "issues"], paths: [] },
  "task-list": { data: ["tasks"], paths: [] },
  "status": { data: ["rows", "summary", "report", "commands"], paths: ["projection"] },
  "check": { data: ["profile", "rows", "report", "commands"], paths: [] },
  "governance-rebuild": {
    data: ["mode", "rows", "report"],
    optionalData: {
      generated: "Only emitted for apply/archive rebuild modes that write generated governance views."
    },
    paths: ["projection"]
  },
  "lesson-promote": { data: ["taskId", "mode", "generated", "report"], paths: [] },
  "lesson-sediment": { data: ["taskId", "mode", "generated", "report"], paths: [] },
  "adopt-multica": { data: ["taskId", "report"], paths: ["primary"] },
  "snapshot-multica": { data: ["report"], paths: [] },
  "migrate-plan": { data: ["rows", "report"], paths: [] },
  "migrate-structure": { data: ["migrationMode", "rows", "report"], paths: [] },
  "migrate-anchors": { data: ["migrationMode", "rows", "report"], paths: [] },
  "migrate-provenance": { data: ["migrationMode", "rows", "report"], paths: [] },
  "migrate-run": { data: ["rows", "report"], paths: ["primary", "session"] },
  "migrate-verify": { data: ["report"], paths: [] },
  "legacy-scan": { data: ["rows", "report"], paths: [] },
  "legacy-intake-plan": { data: ["rows", "report"], paths: ["primary", "plan"] },
  "legacy-copy-safe-docs": { data: ["migrationMode", "rows", "report"], paths: [] },
  "legacy-index": { data: ["migrationMode", "rows", "report"], paths: ["primary", "index"] },
  "legacy-verify": { data: ["rows", "report"], paths: [] },
  "git-diff": { data: ["report"], paths: [] },
  "doctor": { data: ["report"], paths: [] },
  "graph": { data: ["rows", "report"], paths: ["primary", "projection"] },
  "preset-validate": { data: ["preset", "report"], paths: [] },
  "preset-list": { data: ["presets", "issues"], paths: [] },
  "preset-inspect": { data: ["preset", "issues"], paths: [] },
  "preset-check": { data: ["preset", "issues"], paths: [] },
  "preset-install": { data: ["preset"], paths: [] },
  "preset-seed": { data: ["presets", "report"], paths: [] },
  "preset-audit": { data: ["presets", "issues", "report"], paths: [] },
  "preset-uninstall": { data: ["preset"], paths: [] },
  "preset-run": { data: ["taskId", "preset", "evidenceBundle", "generated", "rows", "report"], paths: [] },
  "preset-action": {
    data: ["preset", "evidenceBundle", "generated", "report"],
    optionalData: {
      taskId: "Only emitted by scripted preset actions that echo the task id in their script result.",
      rows: "Only emitted when a scripted preset action writes a numeric rows value in its result."
    },
    paths: []
  },
  "script-list": { data: ["scripts", "rows"], paths: [] },
  "script-inspect": { data: ["script"], paths: [] },
  "script-run": {
    data: ["script", "runId", "evidenceBundle", "generated", "report"],
    optionalData: {
      rows: "Only emitted when a script writes a numeric rows value in its script-result/v1 payload."
    },
    paths: []
  },
  "module-list": { data: ["modules"], paths: [] },
  "module-inspect": { data: ["module"], paths: [] },
  "module-register": { data: ["module"], paths: [] },
  "module-scaffold": { data: ["module"], paths: ["primary", "modulePlan"] },
  "module-unregister": { data: ["module"], paths: [] },
  "module-step": { data: ["module"], paths: [] },
  "vertical-validate": { data: ["issues"], paths: [] },
  "gui": { data: ["launchPlan"], paths: [] }
} as const satisfies Record<CommandKind, CommandReceiptContract>;
