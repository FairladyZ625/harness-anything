import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

const facadeKinds = ["vertical-kind-upsert", "vertical-kind-publish-schema", "vertical-kind-retire"];

export function isVerticalKindFacadeCommand(command: ThinCommand): boolean {
  return facadeKinds.includes(command.action.kind) && !("expectedVersion" in command.action);
}

export async function runVerticalKindFacadeCommand(command: ThinCommand): Promise<JsonObject> {
  return runCommandThroughDaemon(command);
}
