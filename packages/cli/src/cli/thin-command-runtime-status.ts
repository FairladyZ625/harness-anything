import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejectInput } from "./thin-command-flags.ts";
import type {
  ProtocolCommand,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

type ParsedFlags = Extract<ReturnType<typeof readFlags>, { readonly ok: true }>;

export function parseRuntimeStatus(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  runtimeSessionId: string | undefined,
  flags: ParsedFlags,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const wait = flags.booleans.has("--wait"),
    noStream = flags.booleans.has("--no-stream");
  if (runtimeSessionId && flags.one.has("--task"))
    return rejectInput(inputs, route.id, "--task", json);
  if (!runtimeSessionId && wait)
    return rejectInput(inputs, route.id, "--wait", json);
  if (!wait && noStream)
    return rejectInput(inputs, route.id, "--no-stream", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      ...(runtimeSessionId
        ? {
            runtimeSessionId,
            ...(wait ? { wait: true } : {}),
            ...(noStream ? { noStream: true } : {}),
          }
        : flags.one.get("--task")
          ? { taskId: flags.one.get("--task") }
          : {}),
    },
    runtimeSessionId ? "repo.agentRuntime.sessions.read" : route.method,
  );
}
