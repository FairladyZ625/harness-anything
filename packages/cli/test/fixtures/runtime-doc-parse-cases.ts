export const runtimeDocParseCases = [
  { name: "event append", argv: ["event", "append", "--session", "codex-session-1", "--kind", "interrupt", "--runtime", "codex", "--task", "task_1", "--interrupt", "append", "--result", "succeeded", "--summary", "Guidance appended", "--total-tokens", "42"], kind: "runtime-event-append", fields: { sessionId: "codex-session-1", eventKind: "interrupt", runtime: "codex", taskId: "task_1", interrupt: "append", result: "succeeded", summary: "Guidance appended", totalTokens: 42 } },
  { name: "event list", argv: ["event", "list", "--session", "codex-session-1"], kind: "runtime-event-list", fields: { sessionId: "codex-session-1" } },
  { name: "materializer run", argv: ["materializer", "run", "--dry-run"], kind: "materializer-run", fields: { dryRun: true } },
  { name: "session export current", argv: ["session", "export"], kind: "session-export", fields: { sessionId: undefined, runtime: undefined } },
  { name: "session export explicit", argv: ["session", "export", "--session", "codex-thread", "--runtime", "codex", "--source", "manual", "--detected-at", "2026-07-04T00:00:00.000Z", "--user", "Zeyu", "--transcript-file", "/tmp/codex-thread.jsonl"], kind: "session-export", fields: { sessionId: "codex-thread", runtime: "codex", source: "manual", detectedAt: "2026-07-04T00:00:00.000Z", user: "Zeyu", transcriptFile: "/tmp/codex-thread.jsonl" } },
  { name: "session backfill", argv: ["session", "backfill", "--runtime", "codex", "--limit", "5"], kind: "session-backfill", fields: { runtime: "codex", limit: 5 } },
  { name: "session sync", argv: ["session", "sync"], kind: "session-sync", fields: { mode: "dry-run" } },
  { name: "session sync apply", argv: ["session", "sync", "--apply"], kind: "session-sync", fields: { mode: "apply" } },
  { name: "cas gc preview", argv: ["cas", "gc"], kind: "cas-gc", fields: { mode: "dry-run" } },
  { name: "cas gc apply", argv: ["cas", "gc", "--apply"], kind: "cas-gc", fields: { mode: "apply" } },
  { name: "doc status", argv: ["doc", "status"], kind: "doc-status" },
  { name: "doc sync dry-run", argv: ["doc", "sync", "--dry-run"], kind: "doc-sync", fields: { mode: "dry-run", paths: [] } },
  { name: "doc sync submit", argv: ["doc", "sync", "--submit"], kind: "doc-sync", fields: { mode: "submit", paths: [] } }
] as const;
