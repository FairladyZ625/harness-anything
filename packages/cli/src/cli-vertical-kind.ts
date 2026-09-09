import { readFileSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

type DeclarationRead = {
  readonly schema: "repository-vertical-declaration-read/v1";
  readonly declarationRevision: number;
  readonly declaration: { readonly entityKinds: readonly unknown[] };
};

const facadeKinds = ["vertical-kind-upsert", "vertical-kind-publish-schema", "vertical-kind-retire"];

export function isVerticalKindFacadeCommand(command: ThinCommand): boolean {
  return facadeKinds.includes(command.action.kind) && !("expectedVersion" in command.action);
}

/**
 * Read the addressed Kind's own accepted revision, then send the command fenced on it. A Kind is its
 * own concurrency subject, so a command here is never staled by an unrelated Kind someone else wrote.
 * Immutability of the opaque identity, the id prefix, the store path and every published schema
 * version is the center's judgement, not a second copy of the rules here.
 */
export async function runVerticalKindFacadeCommand(command: ThinCommand): Promise<JsonObject> {
  const current = await runCommandThroughDaemon({
    ...command,
    method: "repo.vertical.declaration.read",
    action: { kind: "vertical-declaration-read-cli" },
  });
  if (!isDeclarationRead(current)) return current;
  if (command.action.kind === "vertical-kind-retire")
    return runCommandThroughDaemon({
      ...command,
      action: {
        kind: "vertical-kind-retire",
        kindId: command.action.kindId,
        reason: command.action.reason,
        expectedVersion: kindFence(current, String(command.action.kindId)),
      },
    });

  const source = String(command.action.fromFile),
    file = path.isAbsolute(source) ? source : path.join(command.rootDir, source);
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return rejectedReceipt(command, "invalid_field", `--from-file could not be read as JSON: ${errorText(error)}`);
  }
  if (command.action.kind === "vertical-kind-publish-schema") {
    if (!isJsonRecord(body))
      return rejectedReceipt(command, "invalid_field", "--from-file must contain one attribute declaration object.");
    return runCommandThroughDaemon({
      ...command,
      action: {
        kind: "vertical-kind-publish-schema",
        kindId: command.action.kindId,
        attributes: body,
        expectedVersion: kindFence(current, String(command.action.kindId)),
      },
    });
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
  return runCommandThroughDaemon({
    ...command,
    action: {
      kind: "vertical-kind-upsert",
      kindId,
      declaration: body,
      expectedVersion: kindFence(current, kindId),
    },
  });
}

/**
 * The revision the addressed Kind was last accepted at, or `0` when no Kind answers to that name yet,
 * which is how a caller states the intent to create one.
 */
function kindFence(read: DeclarationRead, kindId: string): number {
  const row = read.declaration.entityKinds.find(
    (candidate) =>
      isJsonRecord(candidate) &&
      candidate.entityType === "artifact" &&
      (candidate.kindId === kindId || `entity-kind/${String(candidate.kindId)}` === kindId || candidate.id === kindId),
  ) as { readonly revision?: unknown } | undefined;
  return Number.isSafeInteger(row?.revision) ? Number(row?.revision) : 0;
}

function isDeclarationRead(value: unknown): value is DeclarationRead {
  return (
    isJsonRecord(value) &&
    value.schema === "repository-vertical-declaration-read/v1" &&
    Number.isSafeInteger(value.declarationRevision) &&
    isJsonRecord(value.declaration) &&
    Array.isArray(value.declaration.entityKinds)
  );
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
