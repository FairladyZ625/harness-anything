import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinParseResult } from "./thin-command-types.ts";

type ParsedFlags = Extract<ReturnType<typeof readFlags>, { readonly ok: true }>;

export function parseRuntimeStatus(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  runtimeSessionIds: readonly string[],
  flags: ParsedFlags,
): ThinParseResult {
  const wait = flags.booleans.has("--wait"),
    all = flags.booleans.has("--all"),
    noStream = flags.booleans.has("--no-stream"),
    taskIds = flags.many.get("--task") ?? [];
  if (all && !wait) return rejected("invalid_field", "Use --all only with --wait.", json);
  if (runtimeSessionIds.length > 0 && taskIds.length > 0)
    return rejected("invalid_field", "Use either <runtime-session-id> targets or --task <task-id>, not both.", json);
  if (runtimeSessionIds.length > 1 && !wait)
    return rejected("invalid_field", "Multiple runtime session ids require --wait.", json);
  if (taskIds.length > 1 && !wait) return rejected("invalid_field", "Multiple --task values require --wait.", json);
  if (wait && runtimeSessionIds.length === 0 && taskIds.length === 0)
    return rejected("invalid_field", "Use --wait with a runtime session id or --task <task-id>.", json);
  // Every --wait — one target or many — rides the daemon-side await; the CLI never polls for a
  // terminal verdict itself. The daemon answers with the settled/in-flight/unavailable split and
  // the authoritative outcome.
  if (wait)
    return accepted(
      rootDir,
      repoId,
      json,
      {
        kind: "runtime-sessions-await",
        ...(runtimeSessionIds.length > 0 ? { runtimeSessionIds } : {}),
        ...(taskIds.length > 0 ? { taskIds } : {}),
        ...(all ? { mode: "all" } : {}),
        ...(noStream ? { noStream: true } : {}),
      },
      "repo.agentRuntime.sessions.await",
    );
  const runtimeSessionId = runtimeSessionIds[0],
    taskId = taskIds[0];
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      ...(runtimeSessionId ? { runtimeSessionId } : taskId ? { taskId } : {}),
      ...(noStream ? { noStream: true } : {}),
    },
    runtimeSessionId ? "repo.agentRuntime.sessions.read" : route.method,
  );
}
