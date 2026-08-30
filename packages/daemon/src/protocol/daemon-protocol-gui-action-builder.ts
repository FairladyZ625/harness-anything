import type { RpcShape } from "./daemon-protocol-gui-types.ts";
import { shape } from "./daemon-protocol-gui-types.ts";
import { DAEMON_GUI_COMMAND_RECEIPT_SCHEMA, DAEMON_PROTOCOL_ERROR_SCHEMA } from "./daemon-protocol-schema-ids.ts";

export const guiAction = <
  const I extends string,
  const M extends string,
  const A extends string,
  const B extends string,
>(
  id: I,
  method: M,
  actionKind: A,
  params: RpcShape,
  guiBridgeMethod: B,
  pathName: string,
  commandClass: "repo-read" | "repo-write" | "arbiter",
  actionDefaults?: Readonly<Record<string, unknown>>,
) => ({
  id,
  phase: "W5-GUI-S2",
  method,
  actionKind,
  requiresRepo: true,
  params: shape({ repo: shape({ repoId: "string" }), payload: params }),
  guiBridgeMethod,
  httpMethod: "POST" as const,
  path: pathName,
  inputSchemaId: `gui.${id}/v1`,
  outputSchemaId: DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  errorSchemaId: DAEMON_PROTOCOL_ERROR_SCHEMA.id,
  serviceMethod: id,
  auth: "local-session-token" as const,
  commandClass,
  ...(actionDefaults === undefined ? {} : { actionDefaults }),
});

export const guiS3Action = <
  const I extends string,
  const M extends string,
  const A extends string,
  const B extends string,
>(
  id: I,
  method: M,
  actionKind: A,
  params: RpcShape,
  guiBridgeMethod: B,
  pathName: string,
  commandClass: "repo-read" | "repo-write",
  outputSchemaId: string,
) => ({
  id,
  phase: "W5-GUI-S3",
  method,
  actionKind,
  requiresRepo: true,
  params: shape({ repo: shape({ repoId: "string" }), payload: params }),
  guiBridgeMethod,
  httpMethod: "POST" as const,
  path: pathName,
  inputSchemaId: `gui.${id}/v1`,
  outputSchemaId,
  errorSchemaId: DAEMON_PROTOCOL_ERROR_SCHEMA.id,
  serviceMethod: id,
  auth: "local-session-token" as const,
  commandClass,
});
