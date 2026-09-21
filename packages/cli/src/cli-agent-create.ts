import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

/** agent-create is one daemon request: the designer spawn, declaration validation, and install
 * saga runs inside the RepoCell and returns a finished receipt for the transport to render. */
export async function runAgentCreate(command: ThinCommand): Promise<JsonObject> {
  return runCommandThroughDaemon(command);
}
