import type { CommandReceiptEnvelope } from "@harness-anything/application";
import type { RepoWriteJsonValue } from "./repo-write-protocol.ts";
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
    ["ok", "schema", "command", "action", "summary", "meta"],
    success
      ? ["entity", "rows", "item", "items", "paths", "warnings", "next", "details"]
      : ["error", "warnings", "next", "details"],
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
    const next = repoWriteCommandReceiptOptionalNextAt(record.next, `${path}.next`);
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
      ...(next ? { next } : {}),
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
    ...(details ? { details } : {})
  };
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
