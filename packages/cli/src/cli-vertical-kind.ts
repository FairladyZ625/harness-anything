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

export function isVerticalKindFacadeCommand(command: ThinCommand): boolean {
  return command.action.kind === "vertical-kind-upsert-cli" || command.action.kind === "vertical-kind-retire-cli";
}

export async function runVerticalKindFacadeCommand(command: ThinCommand): Promise<JsonObject> {
  const current = await runCommandThroughDaemon({
    ...command,
    method: "repo.vertical.declaration.read",
    action: { kind: "vertical-declaration-read-cli" },
  });
  if (!isDeclarationRead(current)) return current;
  if (command.action.kind === "vertical-kind-retire-cli")
    return runCommandThroughDaemon({
      ...command,
      action: {
        kind: "vertical-kind-retire",
        kindId: command.action.kindId,
        reason: command.action.reason,
        expectedVersion: current.declarationRevision,
      },
    });

  const source = String(command.action.fromFile),
    file = path.isAbsolute(source) ? source : path.join(command.rootDir, source);
  let declaration: unknown;
  try {
    declaration = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return rejected(command, "invalid_field", `--from-file could not be read as JSON: ${errorText(error)}`);
  }
  if (!isRecord(declaration) || declaration.entityType !== "artifact" || typeof declaration.id !== "string")
    return rejected(command, "invalid_field", "--from-file must contain one complete Artifact kind declaration.");
  const existing = current.declaration.entityKinds.find(
    (candidate) => isRecord(candidate) && candidate.id === declaration.id,
  );
  if (isRecord(existing)) {
    if (existing.idPrefix !== declaration.idPrefix)
      return rejected(
        command,
        "destructive_kind_change",
        "idPrefix is immutable because existing entity ids depend on it.",
      );
    if (
      isRecord(existing.store) &&
      isRecord(declaration.store) &&
      existing.store.pathTemplate !== declaration.store.pathTemplate
    )
      return rejected(
        command,
        "destructive_kind_change",
        "store.pathTemplate is immutable because existing entity documents depend on it.",
      );
  }
  return runCommandThroughDaemon({
    ...command,
    action: {
      kind: "vertical-kind-upsert",
      kindId: declaration.id,
      declaration,
      expectedVersion: current.declarationRevision,
    },
  });
}

function isDeclarationRead(value: unknown): value is DeclarationRead {
  return (
    isRecord(value) &&
    value.schema === "repository-vertical-declaration-read/v1" &&
    Number.isSafeInteger(value.declarationRevision) &&
    isRecord(value.declaration) &&
    Array.isArray(value.declaration.entityKinds)
  );
}

function rejected(command: ThinCommand, code: string, nextAction: string): JsonObject {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
