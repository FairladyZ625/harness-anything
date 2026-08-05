import type {
  RepoWriteCommandDto,
  RepoWriteJsonObject
} from "../../src/runtime/repo-write-protocol.ts";

export function repoWriteProgressCommand(
  actor: RepoWriteJsonObject = {},
  context: RepoWriteJsonObject = {}
): RepoWriteCommandDto {
  return {
    commandName: "progress-append",
    actor,
    context,
    payload: {
      command: {
        rootDir: "/repo",
        json: true,
        action: {
          kind: "progress-append",
          taskId: "task_01KY",
          text: "progress",
          dryRun: false
        }
      },
      session: {
        runtime: "codex",
        sessionId: "session-repo-write-fixture",
        source: "runtime",
        detectedAt: "2026-08-05T00:00:00.000Z"
      }
    }
  };
}
