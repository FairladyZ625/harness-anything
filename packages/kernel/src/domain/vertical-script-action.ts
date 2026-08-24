import { hasOnlyFields, isNonEmptyString, isRecord } from "./write-chain.contract.ts";

export interface VerticalScriptActionV1 {
  readonly schema: "vertical-script-action/v1";
  readonly kind: "script-run";
  readonly scriptId: string;
  readonly taskId: string | null;
  readonly inputs: Readonly<Record<string, string>>;
  readonly dryRun: boolean;
}
export interface VerticalScriptChangeV1 {
  readonly path: string;
  readonly body: string;
  readonly mediaType: "application/json" | "text/markdown" | "text/plain";
  readonly disposition: "create" | "replace";
}
export interface VerticalScriptPlanV1 {
  readonly schema: "vertical-script-plan/v1";
  readonly scriptId: string;
  readonly ok: boolean;
  readonly status: string;
  readonly report: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly changes: readonly VerticalScriptChangeV1[];
}
export interface VerticalScriptDocumentV1 {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
  readonly size: number;
  readonly mediaType: VerticalScriptChangeV1["mediaType"];
  readonly disposition: VerticalScriptChangeV1["disposition"];
}
export interface VerticalScriptResultV1 {
  readonly schema: "vertical-script-result/v1";
  readonly scriptId: string;
  readonly mode: "dry-run" | "apply";
  readonly ok: boolean;
  readonly status: string;
  readonly report: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly documents: readonly VerticalScriptDocumentV1[];
  readonly planDigest: `sha256:${string}`;
}
export class VerticalScriptContractError extends Error {
  readonly code: "invalid_script_action" | "invalid_script_plan";
  constructor(code: VerticalScriptContractError["code"], message: string) {
    super(message);
    this.name = "VerticalScriptContractError";
    this.code = code;
  }
}

const actionFields = ["schema", "kind", "scriptId", "taskId", "inputs", "dryRun"],
  planFields = ["schema", "scriptId", "ok", "status", "report", "warnings", "changes"],
  changeFields = ["path", "body", "mediaType", "disposition"];
const resultFields = ["schema", "scriptId", "mode", "ok", "status", "report", "warnings", "documents", "planDigest"],
  documentFields = ["path", "sha256", "size", "mediaType", "disposition"],
  digestPattern = /^sha256:[0-9a-f]{64}$/u;
export function validateVerticalScriptAction(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, actionFields))
    return ["vertical script action fields are incomplete or unknown"];
  const inputs = value.inputs,
    validInputs =
      isRecord(inputs) &&
      Object.entries(inputs).every(([key, input]) => isNonEmptyString(key) && typeof input === "string");
  return value.schema === "vertical-script-action/v1" &&
    value.kind === "script-run" &&
    /^vertical:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u.test(String(value.scriptId)) &&
    (value.taskId === null ||
      (isNonEmptyString(value.taskId) && !/[\\/]/u.test(value.taskId) && !value.taskId.includes(".."))) &&
    validInputs &&
    typeof value.dryRun === "boolean"
    ? []
    : ["vertical script action values are invalid"];
}
export function parseVerticalScriptAction(value: unknown): VerticalScriptActionV1 {
  const errors = validateVerticalScriptAction(value);
  if (errors.length) throw new VerticalScriptContractError("invalid_script_action", errors.join("; "));
  return value as VerticalScriptActionV1;
}
export function validateVerticalScriptPlan(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, planFields) ||
    value.schema !== "vertical-script-plan/v1" ||
    !/^vertical:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u.test(String(value.scriptId)) ||
    typeof value.ok !== "boolean" ||
    !isNonEmptyString(value.status) ||
    !isRecord(value.report) ||
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string") ||
    !Array.isArray(value.changes)
  )
    return ["vertical script plan fields are invalid"];
  const seen = new Set<string>();
  for (const change of value.changes) {
    if (
      !isRecord(change) ||
      !hasOnlyFields(change, changeFields) ||
      !safeVerticalScriptPath(change.path) ||
      typeof change.body !== "string" ||
      change.body.includes("\r") ||
      !["application/json", "text/markdown", "text/plain"].includes(String(change.mediaType)) ||
      !["create", "replace"].includes(String(change.disposition))
    )
      return ["vertical script change is invalid"];
    const key = String(change.path).normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) return ["vertical script change paths collide"];
    seen.add(key);
  }
  return [];
}
export function parseVerticalScriptPlan(value: unknown): VerticalScriptPlanV1 {
  const errors = validateVerticalScriptPlan(value);
  if (errors.length) throw new VerticalScriptContractError("invalid_script_plan", errors.join("; "));
  return value as unknown as VerticalScriptPlanV1;
}
export function validateVerticalScriptResult(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, resultFields) ||
    value.schema !== "vertical-script-result/v1" ||
    !/^vertical:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u.test(String(value.scriptId)) ||
    !["dry-run", "apply"].includes(String(value.mode)) ||
    typeof value.ok !== "boolean" ||
    !isNonEmptyString(value.status) ||
    !isRecord(value.report) ||
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string") ||
    !Array.isArray(value.documents) ||
    !digestPattern.test(String(value.planDigest))
  )
    return ["vertical script result fields are invalid"];
  return value.documents.every(
    (document) =>
      isRecord(document) &&
      hasOnlyFields(document, documentFields) &&
      safeVerticalScriptPath(document.path) &&
      digestPattern.test(String(document.sha256)) &&
      Number.isSafeInteger(document.size) &&
      Number(document.size) >= 0 &&
      ["application/json", "text/markdown", "text/plain"].includes(String(document.mediaType)) &&
      ["create", "replace"].includes(String(document.disposition)),
  )
    ? []
    : ["vertical script result document is invalid"];
}
export function parseVerticalScriptResult(value: unknown): VerticalScriptResultV1 {
  const errors = validateVerticalScriptResult(value);
  if (errors.length) throw new VerticalScriptContractError("invalid_script_plan", errors.join("; "));
  return value as unknown as VerticalScriptResultV1;
}
function safeVerticalScriptPath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value === value.normalize("NFC") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}
