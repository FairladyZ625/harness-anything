import {
  strictArray,
  strictBoolean,
  strictEnum,
  strictLiteral,
  strictNumber,
  strictObject,
  strictString,
  strictStringRecord
} from "./strict-command-schema.ts";

const sessionRuntime = strictEnum("claude-code", "codex", "zcode", "antigravity");

export const repoWriteOperationsActionSchemas = {
  init: strictObject({
    kind: strictLiteral("init"),
    addNpmScripts: strictBoolean
  }, {
    projectName: strictString
  }),
  "runtime-event-append": strictObject({
    kind: strictLiteral("runtime-event-append"),
    sessionId: strictString,
    eventKind: strictEnum("session", "turn", "step", "tool", "approval", "interrupt", "result", "cost", "lease"),
    runtime: strictEnum("human", "claude-code", "codex", "zcode", "antigravity", "unknown")
  }, {
    eventId: strictString,
    recordedAt: strictString,
    taskId: strictString,
    turnId: strictString,
    stepId: strictString,
    toolName: strictString,
    approval: strictEnum("approved", "rejected", "timeout", "unknown"),
    interrupt: strictEnum("pause", "cancel", "resume", "append", "branch", "unknown"),
    result: strictEnum("started", "succeeded", "failed", "cancelled", "unknown"),
    summary: strictString,
    totalTokens: strictNumber
  }),
  "materializer-run": strictObject({
    kind: strictLiteral("materializer-run"),
    dryRun: strictBoolean
  }, {
    currentSessionOnly: strictLiteral(true)
  }),
  "session-export": strictObject({
    kind: strictLiteral("session-export")
  }, {
    sessionId: strictString,
    runtime: sessionRuntime,
    source: strictEnum("runtime", "manual"),
    detectedAt: strictString,
    user: strictString,
    transcriptFile: strictString
  }),
  "session-backfill": strictObject({
    kind: strictLiteral("session-backfill")
  }, {
    runtime: sessionRuntime,
    limit: strictNumber
  }),
  "session-sync": strictObject({
    kind: strictLiteral("session-sync"),
    mode: strictEnum("dry-run", "apply")
  }),
  "cas-gc": strictObject({
    kind: strictLiteral("cas-gc"),
    mode: strictEnum("dry-run", "apply")
  }),
  "artifact-add": strictObject({
    kind: strictLiteral("artifact-add"),
    taskId: strictString,
    sourcePaths: strictArray(strictString)
  }),
  "governance-rebuild": strictObject({
    kind: strictLiteral("governance-rebuild"),
    mode: strictEnum("dry-run", "archive", "apply")
  }),
  "adopt-multica": strictObject({
    kind: strictLiteral("adopt-multica"),
    taskId: strictString,
    ref: strictString,
    title: strictString,
    status: strictString,
    url: strictString
  }),
  "migrate-structure": strictObject({
    kind: strictLiteral("migrate-structure"),
    mode: strictEnum("plan", "apply"),
    confirmPlan: strictBoolean
  }),
  "migrate-anchors": strictObject({
    kind: strictLiteral("migrate-anchors"),
    mode: strictEnum("dry-run", "apply")
  }),
  "migrate-fact-execution": strictObject({
    kind: strictLiteral("migrate-fact-execution"),
    mode: strictEnum("dry-run", "apply"),
    batchSize: strictNumber,
    batch: strictNumber,
    sampleSize: strictNumber
  }, {
    confirmPlan: strictString,
    manualListFile: strictString
  }),
  "migrate-retired-attribution-fields": strictObject({
    kind: strictLiteral("migrate-retired-attribution-fields"),
    mode: strictEnum("dry-run", "apply"),
    batchSize: strictNumber
  }, {
    confirmPlan: strictString,
    evidenceRef: strictString
  }),
  "migrate-provenance": strictObject({
    kind: strictLiteral("migrate-provenance"),
    mode: strictEnum("dry-run", "apply")
  }),
  "migrate-run": strictObject({
    kind: strictLiteral("migrate-run"),
    planOnly: strictBoolean,
    outDir: strictString,
    allowDirty: strictBoolean
  }, {
    locale: strictEnum("zh-CN", "en-US"),
    assumeLocale: strictEnum("zh-CN", "en-US"),
    sessionDir: strictString
  }),
  "legacy-intake-plan": strictObject({
    kind: strictLiteral("legacy-intake-plan"),
    sourcePath: strictString
  }, {
    outPath: strictString
  }),
  "legacy-copy-safe-docs": strictObject({
    kind: strictLiteral("legacy-copy-safe-docs"),
    sourcePath: strictString,
    apply: strictBoolean
  }),
  "legacy-index": strictObject({
    kind: strictLiteral("legacy-index"),
    sourcePath: strictString,
    apply: strictBoolean
  }),
  "git-diff": strictObject({
    kind: strictLiteral("git-diff")
  }, {
    baseRef: strictString
  }),
  "worktree-create": strictObject({
    kind: strictLiteral("worktree-create"),
    taskId: strictString
  }, {
    agent: strictString,
    branchPrefix: strictString,
    baseRef: strictString,
    worktreePath: strictString
  }),
  graph: strictObject({
    kind: strictLiteral("graph"),
    includeArchived: strictBoolean
  }, {
    outputPath: strictString,
    focus: strictString,
    projectionPath: strictString
  }),
  gui: strictObject({
    kind: strictLiteral("gui")
  }),
  "preset-install": strictObject({
    kind: strictLiteral("preset-install"),
    sourcePath: strictString,
    layer: strictEnum("project", "user")
  }),
  "preset-seed": strictObject({
    kind: strictLiteral("preset-seed")
  }),
  "preset-uninstall": strictObject({
    kind: strictLiteral("preset-uninstall"),
    presetId: strictString,
    layer: strictEnum("project", "user"),
    dryRun: strictBoolean
  }),
  "preset-entrypoint": strictObject({
    kind: strictLiteral("preset-entrypoint"),
    presetId: strictString,
    entrypointName: strictString,
    entrypointType: strictEnum("run", "action"),
    taskId: strictString,
    allowScripts: strictBoolean,
    inputs: strictStringRecord()
  }),
  "script-run": strictObject({
    kind: strictLiteral("script-run"),
    scriptId: strictString,
    dryRun: strictBoolean,
    inputs: strictStringRecord()
  }, {
    taskId: strictString
  }),
  "module-register": strictObject({
    kind: strictLiteral("module-register"),
    moduleKey: strictString,
    title: strictString,
    scope: strictString,
    shared: strictArray(strictString),
    dependsOn: strictArray(strictString)
  }, {
    prefix: strictString,
    status: strictString,
    branch: strictString,
    owner: strictString,
    currentStep: strictString
  }),
  "module-scaffold": strictObject({
    kind: strictLiteral("module-scaffold"),
    moduleKey: strictString
  }),
  "module-unregister": strictObject({
    kind: strictLiteral("module-unregister"),
    moduleKey: strictString
  }),
  "module-step": strictObject({
    kind: strictLiteral("module-step"),
    moduleKey: strictString,
    stepId: strictString,
    state: strictEnum("planned", "in-progress", "blocked", "done")
  })
} as const;
