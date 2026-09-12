import { readFileSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

const facadeKinds = ["vertical-kind-upsert", "vertical-kind-publish-schema", "vertical-kind-retire"];

export function isVerticalKindFacadeCommand(command: ThinCommand): boolean {
  return facadeKinds.includes(command.action.kind) && !("expectedVersion" in command.action);
}

/**
 * The declaration file lives on the caller's disk, so the CLI reads it here; the addressed Kind's
 * accepted revision lives in the center, so the daemon fences the command on it when the caller
 * states no `expectedVersion`. Retire carries no file and goes straight through.
 */
export async function runVerticalKindFacadeCommand(command: ThinCommand): Promise<JsonObject> {
  if (command.action.kind === "vertical-kind-retire") return runCommandThroughDaemon(command);
  const source = String(command.action.fromFile),
    file = path.isAbsolute(source) ? source : path.join(command.rootDir, source);
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return rejectedReceipt(command, "invalid_field", `--from-file could not be read as JSON: ${errorText(error)}`);
  }
  const { fromFile: _fromFile, ...action } = command.action;
  if (command.action.kind === "vertical-kind-publish-schema") {
    if (!isJsonRecord(body))
      return rejectedReceipt(command, "invalid_field", "--from-file must contain one attribute declaration object.");
    return runCommandThroughDaemon({ ...command, action: { ...action, attributes: body } });
  }
  if (!isJsonRecord(body) || body.entityType !== "artifact" || typeof body.id !== "string")
    return rejectedReceipt(
      command,
      "invalid_field",
      "--from-file must contain one complete Artifact kind declaration.",
    );
  // An existing kind is addressed by its stable identity when the declaration states one, so a rename
  // reaches the same row instead of creating a second kind under the new name.
  const kindId = typeof body.kindId === "string" ? body.kindId : body.id;
  return runCommandThroughDaemon({ ...command, action: { ...action, kindId, declaration: body } });
}

function rejectedReceipt(command: ThinCommand, code: string, nextAction: string): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: command.action.kind,
    outcome: "op_rejected",
    code,
    nextAction,
    exitCode: 1,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
