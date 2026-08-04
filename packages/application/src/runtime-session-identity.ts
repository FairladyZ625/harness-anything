import path from "node:path";
import type { CurrentSessionRuntime } from "@harness-anything/kernel";

export function sessionIdFromRuntimeLog(
  runtime: Exclude<CurrentSessionRuntime, "human">,
  logPath: string
): string | undefined {
  const basename = path.basename(logPath, ".jsonl");
  if (runtime === "codex") {
    return basename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/u)?.[1]
      ?? basename.match(/^rollout-(.+)$/u)?.[1]
      ?? basename;
  }
  if (runtime === "zcode") return basename.match(/^model-io-(sess_[A-Za-z0-9._-]+)$/u)?.[1];
  return basename;
}

export function fileNameMatchesSession(filePath: string, sessionId: string): boolean {
  const basename = path.basename(filePath, ".jsonl");
  if (basename === sessionId) return true;
  const codexSessionId = basename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/u)?.[1];
  if (codexSessionId !== undefined) return codexSessionId === sessionId;
  const legacyCodexSessionId = basename.match(/^rollout-(.+)$/u)?.[1];
  if (legacyCodexSessionId !== undefined) return legacyCodexSessionId === sessionId;
  const zcodeSessionId = basename.match(/^model-io-(sess_[A-Za-z0-9._-]+)$/u)?.[1];
  return zcodeSessionId === sessionId;
}
