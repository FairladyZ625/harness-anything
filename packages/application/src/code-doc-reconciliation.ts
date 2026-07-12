import { makeCodeDocGitEvidenceResolver, type VersionControlSystem } from "../../kernel/src/index.ts";

export const CODE_DOC_RECONCILIATION_DOCUMENT = "code-doc-anchors.json";

export type CodeDocLoadBearingKind = "closeout" | "evidence" | "decision-claim" | "review";

export interface CodeDocReconciliationInput {
  readonly taskId: string;
  readonly documents: ReadonlyArray<CodeDocDocument>;
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly versionControlSystem?: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit">;
}

export interface CodeDocDocument {
  readonly path: string;
  readonly body: string;
}

export interface CodeDocReconciliationDraftInput {
  readonly taskId: string;
  readonly documents: ReadonlyArray<CodeDocDocument>;
  readonly sha: string;
  readonly paths?: ReadonlyArray<string>;
  readonly prRef?: string;
}

export interface CodeDocReconciliationDraft {
  readonly body: string;
  readonly recordIds: ReadonlyArray<string>;
}

export interface CodeDocReconciliationIssue {
  readonly code:
    | "code_doc_anchors_missing"
    | "code_doc_anchors_invalid"
    | "code_doc_record_invalid"
    | "code_doc_anchor_invalid"
    | "code_doc_git_unavailable"
    | "code_doc_git_ref_missing"
    | "code_doc_path_missing";
  readonly recordId?: string;
  readonly message: string;
}

export interface CodeDocReconciliationWarning {
  readonly code: "code_doc_pr_status_unverified";
  readonly recordId: string;
  readonly message: string;
}

export type CodeDocReconciliationResult = {
  readonly ok: true;
  readonly checkedRecords: number;
  readonly checkedAnchors: number;
  readonly warnings: ReadonlyArray<CodeDocReconciliationWarning>;
  readonly issues: readonly [];
} | {
  readonly ok: false;
  readonly checkedRecords: number;
  readonly checkedAnchors: number;
  readonly warnings: ReadonlyArray<CodeDocReconciliationWarning>;
  readonly issues: ReadonlyArray<CodeDocReconciliationIssue>;
};

interface CodeDocAnchorDocument {
  readonly schema: "code-doc-reconciliation/v1";
  readonly taskId: string;
  readonly records: ReadonlyArray<CodeDocRecord>;
}

interface CodeDocRecord {
  readonly id: string;
  readonly ledgerPath: string;
  readonly kind: CodeDocLoadBearingKind;
  readonly anchors: ReadonlyArray<CodeDocAnchor>;
}

type CodeDocAnchor =
  | { readonly kind: "commit"; readonly sha: string }
  | { readonly kind: "path"; readonly sha: string; readonly path: string }
  | { readonly kind: "pr"; readonly ref: string; readonly sha?: string };

const authoredLedgerRecords: ReadonlyArray<Pick<CodeDocRecord, "id" | "ledgerPath" | "kind">> = [
  { id: "closeout", ledgerPath: "closeout.md", kind: "closeout" },
  { id: "review", ledgerPath: "review.md", kind: "review" }
];

export function renderCodeDocReconciliationDraft(input: CodeDocReconciliationDraftInput): CodeDocReconciliationDraft {
  const documentPaths = new Set(input.documents.map((document) => document.path));
  const paths = [...new Set(input.paths ?? [])].sort();
  const anchors: CodeDocAnchor[] = [
    { kind: "commit", sha: input.sha },
    ...paths.map((anchorPath): CodeDocAnchor => ({ kind: "path", sha: input.sha, path: anchorPath })),
    ...(input.prRef ? [{ kind: "pr" as const, ref: input.prRef, sha: input.sha }] : [])
  ];
  const records: CodeDocRecord[] = authoredLedgerRecords
    .filter((record) => documentPaths.has(record.ledgerPath))
    .map((record) => ({ ...record, anchors }));
  return {
    body: `${JSON.stringify({
      schema: "code-doc-reconciliation/v1",
      taskId: input.taskId,
      records
    }, null, 2)}\n`,
    recordIds: records.map((record) => record.id)
  };
}

export function evaluateCodeDocReconciliationGate(input: CodeDocReconciliationInput): CodeDocReconciliationResult {
  const document = input.documents.find((item) => item.path === CODE_DOC_RECONCILIATION_DOCUMENT);
  if (!document) {
    return failed(0, 0, [], [{
      code: "code_doc_anchors_missing",
      message: `Task completion requires ${CODE_DOC_RECONCILIATION_DOCUMENT}.`
    }]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(document.body);
  } catch {
    return failed(0, 0, [], [{
      code: "code_doc_anchors_invalid",
      message: `${CODE_DOC_RECONCILIATION_DOCUMENT} must be valid JSON.`
    }]);
  }

  const schemaIssues = validateDocumentShape(parsed, input);
  if (schemaIssues.length > 0) return failed(0, 0, [], schemaIssues);

  const contract = parsed as CodeDocAnchorDocument;
  if (!input.versionControlSystem) {
    return failed(contract.records.length, 0, [], [{
      code: "code_doc_git_unavailable",
      message: "Code-doc reconciliation requires an injected version-control system."
    }]);
  }
  const versionControlSystem = input.versionControlSystem;
  const gitEvidence = makeCodeDocGitEvidenceResolver({
    rootDir: input.rootDir,
    authoredRoot: input.authoredRoot
  }, versionControlSystem);
  const warnings: CodeDocReconciliationWarning[] = [];
  const issues: CodeDocReconciliationIssue[] = [];
  let checkedAnchors = 0;

  for (const record of contract.records) {
    let hardAnchorCount = 0;
    for (const anchor of record.anchors) {
      checkedAnchors += 1;
      if (anchor.kind === "commit") {
        hardAnchorCount += 1;
        if (!gitEvidence.resolve({ sha: anchor.sha }).ok) {
          issues.push({
            code: "code_doc_git_ref_missing",
            recordId: record.id,
            message: `Record ${record.id} references missing commit ${anchor.sha}.`
          });
        }
        continue;
      }
      if (anchor.kind === "path") {
        hardAnchorCount += 1;
        const resolution = gitEvidence.resolve({ sha: anchor.sha, path: anchor.path });
        if (!resolution.ok && resolution.reason === "commit-missing") {
          issues.push({
            code: "code_doc_git_ref_missing",
            recordId: record.id,
            message: `Record ${record.id} references missing commit ${anchor.sha}.`
          });
          continue;
        }
        if (!resolution.ok) {
          issues.push({
            code: "code_doc_path_missing",
            recordId: record.id,
            message: `Record ${record.id} references missing path at commit: ${anchor.path}@${anchor.sha}.`
          });
        }
        continue;
      }
      if (anchor.sha) {
        hardAnchorCount += 1;
        if (!gitEvidence.resolve({ sha: anchor.sha }).ok) {
          issues.push({
            code: "code_doc_git_ref_missing",
            recordId: record.id,
            message: `Record ${record.id} references missing PR commit ${anchor.sha}.`
          });
        }
      }
      warnings.push({
        code: "code_doc_pr_status_unverified",
        recordId: record.id,
        message: `PR ref ${anchor.ref} status was not verified in the offline completion gate; anchor sha is checked when present.`
      });
    }
    if (hardAnchorCount === 0) {
      issues.push({
        code: "code_doc_anchor_invalid",
        recordId: record.id,
        message: `Record ${record.id} must include at least one commit or path anchor.`
      });
    }
  }

  return issues.length === 0
    ? { ok: true, checkedRecords: contract.records.length, checkedAnchors, warnings, issues: [] }
    : failed(contract.records.length, checkedAnchors, warnings, issues);
}

function validateDocumentShape(value: unknown, input: CodeDocReconciliationInput): ReadonlyArray<CodeDocReconciliationIssue> {
  if (!isCodeDocObject(value)) {
    return [{ code: "code_doc_anchors_invalid", message: `${CODE_DOC_RECONCILIATION_DOCUMENT} must be a JSON object.` }];
  }
  const allowedDocumentKeys = new Set(["schema", "taskId", "records"]);
  const extraDocumentKeys = Object.keys(value).filter((key) => !allowedDocumentKeys.has(key));
  if (extraDocumentKeys.length > 0) {
    return [{ code: "code_doc_anchors_invalid", message: `${CODE_DOC_RECONCILIATION_DOCUMENT} has unsupported keys: ${extraDocumentKeys.sort().join(", ")}.` }];
  }
  if (value.schema !== "code-doc-reconciliation/v1") {
    return [{ code: "code_doc_anchors_invalid", message: `${CODE_DOC_RECONCILIATION_DOCUMENT} schema must be code-doc-reconciliation/v1.` }];
  }
  if (value.taskId !== input.taskId) {
    return [{ code: "code_doc_anchors_invalid", message: `${CODE_DOC_RECONCILIATION_DOCUMENT} taskId must match ${input.taskId}.` }];
  }
  if (!Array.isArray(value.records)) {
    return [{ code: "code_doc_anchors_invalid", message: `${CODE_DOC_RECONCILIATION_DOCUMENT} records must be an array.` }];
  }
  const issues: CodeDocReconciliationIssue[] = [];
  const taskDocumentPaths = new Set(input.documents.map((document) => document.path));
  const ids = new Set<string>();
  for (const record of value.records) {
    const recordId = isCodeDocObject(record) && typeof record.id === "string" ? record.id : undefined;
    const recordIssues = validateRecordShape(record, taskDocumentPaths);
    issues.push(...recordIssues);
    if (recordId) {
      if (ids.has(recordId)) {
        issues.push({ code: "code_doc_record_invalid", recordId, message: `Duplicate code-doc record id: ${recordId}.` });
      }
      ids.add(recordId);
    }
  }
  return issues;
}

function validateRecordShape(value: unknown, taskDocumentPaths: ReadonlySet<string>): ReadonlyArray<CodeDocReconciliationIssue> {
  if (!isCodeDocObject(value)) return [{ code: "code_doc_record_invalid", message: "Each code-doc record must be an object." }];
  const recordId = typeof value.id === "string" ? value.id : undefined;
  const allowedKeys = new Set(["id", "ledgerPath", "kind", "anchors"]);
  const extraKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const issues: CodeDocReconciliationIssue[] = [];
  if (extraKeys.length > 0) {
    issues.push({ code: "code_doc_record_invalid", recordId, message: `Record ${recordId ?? "<unknown>"} has unsupported keys: ${extraKeys.sort().join(", ")}.` });
  }
  if (!recordId || recordId.trim().length === 0) {
    issues.push({ code: "code_doc_record_invalid", message: "Code-doc record id is required." });
  }
  if (typeof value.ledgerPath !== "string" || !taskDocumentPaths.has(value.ledgerPath)) {
    issues.push({ code: "code_doc_record_invalid", recordId, message: `Record ${recordId ?? "<unknown>"} ledgerPath must name a task package document.` });
  }
  if (!isLoadBearingKind(value.kind)) {
    issues.push({ code: "code_doc_record_invalid", recordId, message: `Record ${recordId ?? "<unknown>"} kind is invalid.` });
  }
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    issues.push({ code: "code_doc_record_invalid", recordId, message: `Record ${recordId ?? "<unknown>"} anchors must be a non-empty array.` });
    return issues;
  }
  for (const anchor of value.anchors) {
    issues.push(...validateAnchorShape(anchor, recordId));
  }
  return issues;
}

function validateAnchorShape(value: unknown, recordId: string | undefined): ReadonlyArray<CodeDocReconciliationIssue> {
  if (!isCodeDocObject(value)) return [{ code: "code_doc_anchor_invalid", recordId, message: `Record ${recordId ?? "<unknown>"} anchor must be an object.` }];
  if (value.kind === "commit") {
    const extraKeys = extraObjectKeys(value, ["kind", "sha"]);
    return [
      ...(extraKeys.length > 0 ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: `Commit anchor has unsupported keys: ${extraKeys.join(", ")}.` }] : []),
      ...(!isFullSha(value.sha) ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: "Commit anchor sha must be a full 40-character commit sha." }] : [])
    ];
  }
  if (value.kind === "path") {
    const extraKeys = extraObjectKeys(value, ["kind", "sha", "path"]);
    return [
      ...(extraKeys.length > 0 ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: `Path anchor has unsupported keys: ${extraKeys.join(", ")}.` }] : []),
      ...(!isFullSha(value.sha) ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: "Path anchor sha must be a full 40-character commit sha." }] : []),
      ...(!isSafeRelativePath(value.path) ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: "Path anchor path must be a safe repository-relative path." }] : [])
    ];
  }
  if (value.kind === "pr") {
    const extraKeys = extraObjectKeys(value, ["kind", "ref", "sha"]);
    return [
      ...(extraKeys.length > 0 ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: `PR anchor has unsupported keys: ${extraKeys.join(", ")}.` }] : []),
      ...(typeof value.ref !== "string" || value.ref.trim().length === 0 ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: "PR anchor ref is required." }] : []),
      ...(value.sha !== undefined && !isFullSha(value.sha) ? [{ code: "code_doc_anchor_invalid" as const, recordId, message: "PR anchor sha must be a full 40-character commit sha when present." }] : [])
    ];
  }
  return [{ code: "code_doc_anchor_invalid", recordId, message: `Unknown code-doc anchor kind: ${String(value.kind)}.` }];
}

function failed(
  checkedRecords: number,
  checkedAnchors: number,
  warnings: ReadonlyArray<CodeDocReconciliationWarning>,
  issues: ReadonlyArray<CodeDocReconciliationIssue>
): CodeDocReconciliationResult {
  return { ok: false, checkedRecords, checkedAnchors, warnings, issues };
}

function isCodeDocObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoadBearingKind(value: unknown): value is CodeDocLoadBearingKind {
  return value === "closeout" || value === "evidence" || value === "decision-claim" || value === "review";
}

function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("../") &&
    !value.includes("/../") &&
    !value.includes("\0");
}

function extraObjectKeys(value: Record<string, unknown>, allowedKeys: ReadonlyArray<string>): ReadonlyArray<string> {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).filter((key) => !allowed.has(key)).sort();
}
