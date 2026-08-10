import type {
  CommandReceiptEnvelope,
  CommandReceiptSettlement
} from "@harness-anything/application";
import type { RepoWriteJsonObject, RepoWriteJsonValue } from "./repo-write-protocol.ts";
import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
import {
  repoWriteJsonBudget,
  repoWriteJsonObjectAt,
  repoWriteJsonValueAt,
  type RepoWriteJsonBudget
} from "./repo-write-json-budget.ts";

const maximumIdentifierBytes = 4_096;
const maximumJsonStringBytes = 256 * 1_024;

export function decodeRepoWriteCommandReceiptV2(
  value: unknown,
  path: string
): CommandReceiptEnvelope {
  const aggregateBudget = repoWriteJsonBudget();
  repoWriteJsonObjectAt(value, path, aggregateBudget, 0);
  const record = repoWriteCommandReceiptRecordAt(value, path);
  if (record.ok !== true && record.ok !== false) {
    repoWriteCommandReceiptInvalid(path, "boolean ok field");
  }
  if (record.schema !== "command-receipt/v2") {
    repoWriteCommandReceiptInvalid(`${path}.schema`, "command-receipt/v2");
  }
  const success = record.ok === true;
  repoWriteCommandReceiptExactKeys(
    record,
    success
      ? ["ok", "schema", "command", "action", "summary", "next", "meta"]
      : ["ok", "schema", "command", "action", "summary", "meta"],
    success
      ? ["entity", "rows", "item", "items", "paths", "warnings", "settlement", "details"]
      : ["error", "warnings", "next", "settlement", "details"],
    path
  );

  const budget = repoWriteJsonBudget();
  const common = {
    command: repoWriteCommandReceiptIdentifierAt(record.command, `${path}.command`),
    action: repoWriteCommandReceiptIdentifierAt(record.action, `${path}.action`),
    summary: repoWriteCommandReceiptStringAt(record.summary, `${path}.summary`),
    meta: repoWriteCommandReceiptMetaAt(record.meta, `${path}.meta`, success)
  };
  if (success) {
    const entity = repoWriteCommandReceiptOptionalEntityAt(record.entity, `${path}.entity`);
    const rows = record.rows === undefined
      ? undefined
      : repoWriteCommandReceiptNonNegativeIntegerAt(record.rows, `${path}.rows`);
    const item = record.item === undefined
      ? undefined
      : repoWriteJsonValueAt(record.item, `${path}.item`, budget, 1);
    const items = repoWriteCommandReceiptOptionalJsonArrayAt(
      record.items,
      `${path}.items`,
      budget
    );
    const paths = repoWriteCommandReceiptOptionalPathsAt(record.paths, `${path}.paths`);
    const warnings = repoWriteCommandReceiptOptionalJsonArrayAt(
      record.warnings,
      `${path}.warnings`,
      budget
    );
    const settlement = record.settlement === undefined
      ? undefined
      : repoWriteCommandReceiptSettlementAt(record.settlement, `${path}.settlement`);
    const next = repoWriteCommandReceiptOptionalNextAt(record.next, `${path}.next`);
    if (!next) repoWriteCommandReceiptInvalid(`${path}.next`, "array");
    const details = record.details === undefined
      ? undefined
      : repoWriteJsonObjectAt(record.details, `${path}.details`, budget, 1);
    return {
      ok: true,
      schema: "command-receipt/v2",
      ...common,
      ...(entity ? { entity } : {}),
      ...(rows !== undefined ? { rows } : {}),
      ...(item !== undefined ? { item } : {}),
      ...(items ? { items } : {}),
      ...(paths ? { paths } : {}),
      ...(warnings ? { warnings } : {}),
      ...(settlement ? { settlement } : {}),
      next,
      ...(details ? { details } : {})
    };
  }

  const error = repoWriteCommandReceiptOptionalErrorAt(record.error, `${path}.error`, budget);
  const warnings = repoWriteCommandReceiptOptionalJsonArrayAt(
    record.warnings,
    `${path}.warnings`,
    budget
  );
  const next = repoWriteCommandReceiptOptionalNextAt(record.next, `${path}.next`);
  const settlement = record.settlement === undefined
    ? undefined
    : repoWriteCommandReceiptSettlementAt(record.settlement, `${path}.settlement`);
  const details = record.details === undefined
    ? undefined
    : repoWriteJsonObjectAt(record.details, `${path}.details`, budget, 1);
  return {
    ok: false,
    schema: "command-receipt/v2",
    ...common,
    ...(error ? { error } : {}),
    ...(warnings ? { warnings } : {}),
    ...(next ? { next } : {}),
    ...(settlement ? { settlement } : {}),
    ...(details ? { details } : {})
  };
}

export function repoWriteCommandReceiptJsonObject(value: unknown): RepoWriteJsonObject {
  return decodeRepoWriteCommandReceiptV2(value, "$.receipt") as unknown as RepoWriteJsonObject;
}

function repoWriteCommandReceiptSettlementAt(
  value: unknown,
  path: string
): CommandReceiptSettlement {
  const record = repoWriteCommandReceiptRecordAt(value, path);
  const visibility = record.canonicalVisibility;
  const commonRequired = [
    "schema", "receiptId", "durability", "canonicalVisibility", "acceptedAt",
    "sessionId", "acceptedCommitSha", "statusQuery"
  ];
  repoWriteCommandReceiptExactKeys(
    record,
    visibility === "visible"
      ? [...commonRequired, "canonicalCommitSha", "settledAt"]
      : visibility === "failed"
        ? [...commonRequired, "failedAt", "failure"]
        : commonRequired,
    ["authorityOperationIds"],
    path
  );
  if (record.schema !== "command-receipt-settlement/v1") {
    repoWriteCommandReceiptInvalid(`${path}.schema`, "command-receipt-settlement/v1");
  }
  if (record.durability !== "session-durable") {
    repoWriteCommandReceiptInvalid(`${path}.durability`, "session-durable");
  }
  if (visibility !== "pending" && visibility !== "visible" && visibility !== "failed") {
    repoWriteCommandReceiptInvalid(`${path}.canonicalVisibility`, "pending, visible, or failed");
  }
  const statusQuery = repoWriteCommandReceiptRecordAt(record.statusQuery, `${path}.statusQuery`);
  repoWriteCommandReceiptExactKeys(
    statusQuery,
    ["method", "command", "receiptId"],
    [],
    `${path}.statusQuery`
  );
  if (statusQuery.method !== "repo.write.receipt.status") {
    repoWriteCommandReceiptInvalid(`${path}.statusQuery.method`, "repo.write.receipt.status");
  }
  const common = {
    schema: "command-receipt-settlement/v1" as const,
    receiptId: repoWriteCommandReceiptIdentifierAt(record.receiptId, `${path}.receiptId`),
    durability: "session-durable" as const,
    acceptedAt: repoWriteCommandReceiptCanonicalTimestampAt(record.acceptedAt, `${path}.acceptedAt`),
    sessionId: repoWriteCommandReceiptIdentifierAt(record.sessionId, `${path}.sessionId`),
    acceptedCommitSha: repoWriteCommandReceiptCommitShaAt(record.acceptedCommitSha, `${path}.acceptedCommitSha`),
    ...(record.authorityOperationIds === undefined ? {} : {
      authorityOperationIds: repoWriteCommandReceiptOperationIdsAt(
        record.authorityOperationIds,
        `${path}.authorityOperationIds`
      )
    }),
    statusQuery: {
      method: "repo.write.receipt.status" as const,
      command: repoWriteCommandReceiptStringAt(statusQuery.command, `${path}.statusQuery.command`),
      receiptId: repoWriteCommandReceiptIdentifierAt(statusQuery.receiptId, `${path}.statusQuery.receiptId`)
    }
  };
  if (common.statusQuery.receiptId !== common.receiptId) {
    repoWriteCommandReceiptInvalid(`${path}.statusQuery.receiptId`, "the enclosing receiptId");
  }
  if (visibility === "pending") return { ...common, canonicalVisibility: visibility };
  if (visibility === "visible") {
    return {
      ...common,
      canonicalVisibility: visibility,
      canonicalCommitSha: repoWriteCommandReceiptCommitShaAt(record.canonicalCommitSha, `${path}.canonicalCommitSha`),
      settledAt: repoWriteCommandReceiptCanonicalTimestampAt(record.settledAt, `${path}.settledAt`)
    };
  }
  const failure = repoWriteCommandReceiptRecordAt(record.failure, `${path}.failure`);
  repoWriteCommandReceiptExactKeys(
    failure,
    ["stage", "code", "message", "retryable", "recoveryCommand"],
    [],
    `${path}.failure`
  );
  if (!["materializer", "publication-proof", "evidence", "integrity", "unknown"].includes(String(failure.stage))) {
    repoWriteCommandReceiptInvalid(`${path}.failure.stage`, "settlement failure stage");
  }
  if (typeof failure.retryable !== "boolean") {
    repoWriteCommandReceiptInvalid(`${path}.failure.retryable`, "boolean");
  }
  return {
    ...common,
    canonicalVisibility: visibility,
    failedAt: repoWriteCommandReceiptCanonicalTimestampAt(record.failedAt, `${path}.failedAt`),
    failure: {
      stage: failure.stage as "materializer" | "publication-proof" | "evidence" | "integrity" | "unknown",
      code: repoWriteCommandReceiptIdentifierAt(failure.code, `${path}.failure.code`),
      message: repoWriteCommandReceiptStringAt(failure.message, `${path}.failure.message`),
      retryable: failure.retryable,
      recoveryCommand: repoWriteCommandReceiptStringAt(failure.recoveryCommand, `${path}.failure.recoveryCommand`)
    }
  };
}

function repoWriteCommandReceiptOperationIdsAt(
  value: unknown,
  path: string
): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    repoWriteCommandReceiptInvalid(path, "non-empty bounded authority operation id array");
  }
  const values = value.map((entry, index) =>
    repoWriteCommandReceiptIdentifierAt(entry, `${path}[${index}]`)
  );
  if (new Set(values).size !== values.length) {
    repoWriteCommandReceiptInvalid(path, "unique authority operation ids");
  }
  return values;
}

function repoWriteCommandReceiptCommitShaAt(value: unknown, path: string): string {
  const sha = repoWriteCommandReceiptStringAt(value, path, 40);
  if (!/^[a-f0-9]{40}$/u.test(sha)) repoWriteCommandReceiptInvalid(path, "40-character Git commit SHA");
  return sha;
}

function repoWriteCommandReceiptMetaAt(value: unknown, path: string, success: boolean) {
  const record = repoWriteCommandReceiptRecordAt(value, path);
  repoWriteCommandReceiptExactKeys(record, ["generatedAt", "compatibility"], [], path);
  const generatedAt = repoWriteCommandReceiptCanonicalTimestampAt(
    record.generatedAt,
    `${path}.generatedAt`
  );
  const compatibility = repoWriteCommandReceiptRecordAt(
    record.compatibility,
    `${path}.compatibility`
  );
  repoWriteCommandReceiptExactKeys(
    compatibility,
    [],
    success ? ["legacyReceipt", "legacyReport"] : ["legacyReceipt"],
    `${path}.compatibility`
  );
  return {
    generatedAt,
    compatibility: {
      ...(compatibility.legacyReceipt === undefined
        ? {}
        : {
            legacyReceipt: repoWriteCommandReceiptStringAt(
              compatibility.legacyReceipt,
              `${path}.compatibility.legacyReceipt`
            )
          }),
      ...(compatibility.legacyReport === undefined
        ? {}
        : {
            legacyReport: repoWriteCommandReceiptStringAt(
              compatibility.legacyReport,
              `${path}.compatibility.legacyReport`
            )
          })
    }
  };
}

function repoWriteCommandReceiptOptionalEntityAt(value: unknown, path: string) {
  if (value === undefined) return undefined;
  const record = repoWriteCommandReceiptRecordAt(value, path);
  repoWriteCommandReceiptExactKeys(record, ["kind"], ["id"], path);
  return {
    kind: repoWriteCommandReceiptIdentifierAt(record.kind, `${path}.kind`),
    ...(record.id === undefined
      ? {}
      : { id: repoWriteCommandReceiptIdentifierAt(record.id, `${path}.id`) })
  };
}

function repoWriteCommandReceiptOptionalPathsAt(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) repoWriteCommandReceiptInvalid(path, "array");
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = repoWriteCommandReceiptRecordAt(entry, entryPath);
    repoWriteCommandReceiptExactKeys(record, ["role", "path"], [], entryPath);
    return {
      role: repoWriteCommandReceiptIdentifierAt(record.role, `${entryPath}.role`),
      path: repoWriteCommandReceiptStringAt(record.path, `${entryPath}.path`)
    };
  });
}

function repoWriteCommandReceiptOptionalNextAt(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) repoWriteCommandReceiptInvalid(path, "array");
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = repoWriteCommandReceiptRecordAt(entry, entryPath);
    repoWriteCommandReceiptExactKeys(record, ["command"], ["description"], entryPath);
    return {
      command: repoWriteCommandReceiptStringAt(record.command, `${entryPath}.command`),
      ...(record.description === undefined
        ? {}
        : {
            description: repoWriteCommandReceiptStringAt(
              record.description,
              `${entryPath}.description`
            )
          })
    };
  });
}

function repoWriteCommandReceiptOptionalErrorAt(
  value: unknown,
  path: string,
  budget: RepoWriteJsonBudget
) {
  if (value === undefined) return undefined;
  const record = repoWriteCommandReceiptRecordAt(value, path);
  repoWriteCommandReceiptExactKeys(record, ["code", "hint"], ["context"], path);
  return {
    code: repoWriteCommandReceiptIdentifierAt(record.code, `${path}.code`),
    hint: repoWriteCommandReceiptStringAt(record.hint, `${path}.hint`),
    ...(record.context === undefined
      ? {}
      : { context: repoWriteJsonObjectAt(record.context, `${path}.context`, budget, 1) })
  };
}

function repoWriteCommandReceiptOptionalJsonArrayAt(
  value: unknown,
  path: string,
  budget: RepoWriteJsonBudget
): ReadonlyArray<RepoWriteJsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) repoWriteCommandReceiptInvalid(path, "array");
  return value.map((entry, index) =>
    repoWriteJsonValueAt(entry, `${path}[${index}]`, budget, 1));
}

function repoWriteCommandReceiptRecordAt(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    repoWriteCommandReceiptInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    repoWriteCommandReceiptInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function repoWriteCommandReceiptExactKeys(
  record: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    repoWriteCommandReceiptInvalid(path, "exact schema fields");
  }
}

function repoWriteCommandReceiptIdentifierAt(value: unknown, path: string): string {
  const text = repoWriteCommandReceiptStringAt(value, path, maximumIdentifierBytes);
  if (!text.trim() || /[\u0000-\u001f\u007f]/u.test(text)) {
    repoWriteCommandReceiptInvalid(path, "non-empty identifier");
  }
  return text;
}

function repoWriteCommandReceiptStringAt(
  value: unknown,
  path: string,
  maximumBytes = maximumJsonStringBytes
): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    repoWriteCommandReceiptInvalid(path, `string no larger than ${maximumBytes} bytes`);
  }
  return value;
}

function repoWriteCommandReceiptNonNegativeIntegerAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    repoWriteCommandReceiptInvalid(path, "non-negative safe integer");
  }
  return value;
}

function repoWriteCommandReceiptCanonicalTimestampAt(value: unknown, path: string): string {
  const timestamp = repoWriteCommandReceiptStringAt(value, path);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    repoWriteCommandReceiptInvalid(path, "canonical ISO timestamp");
  }
  return timestamp;
}

function repoWriteCommandReceiptInvalid(path: string, expected: string): never {
  throw new RepoWriteOutcomeValidationError(
    `Invalid command-receipt/v2 at ${path.slice(0, 160)}: expected ${expected}.`
  );
}
