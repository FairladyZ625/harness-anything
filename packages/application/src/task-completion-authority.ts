import { Schema } from "effect";
import {
  decodeEntityDeclaration,
  jsonEntityDocumentCodec,
  projectDeclaredEntities,
  readDeclaredProjectionRows,
  sha256Text,
  type HarnessLayoutInput,
  type TaskHolderPrincipal,
  type VersionControlSystem
} from "@harness-anything/kernel";
import { inspectExecutionCompletionReadiness, type ExecutionCompletionReadinessIssue } from "./execution-completion-service.ts";
import type { CompletionCiGateStatus } from "./task-lifecycle-gates.ts";

export const TASK_COMPLETION_EVIDENCE_DOCUMENT = "completion-evidence.json";

const NonBlank = Schema.String.pipe(Schema.minLength(1));
const Sha = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/u));
const CompletionEvidenceSchema = Schema.Struct({
  schema: Schema.Literal("task-completion-evidence/v1"),
  taskId: NonBlank,
  mode: Schema.Literal("commit-anchor"),
  anchor: Schema.Struct({
    sha: Sha,
    repository: Schema.Literal("workspace"),
    codeDocRecordIds: Schema.Array(NonBlank),
    codeDocDocumentSha256: Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u))
  }),
  judgment: Schema.Struct({
    actor: Schema.Struct({
      principal: Schema.Struct({ kind: Schema.Literal("person"), personId: NonBlank }),
      executor: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("agent"), id: NonBlank }))
    }),
    sessionRef: NonBlank,
    rationale: Schema.String,
    judgedAt: NonBlank
  }),
  gateReceipt: Schema.Struct({
    applicableGates: Schema.Array(NonBlank),
    ci: Schema.Literal("passed", "failed", "not-applicable"),
    closeout: Schema.Literal("passed"),
    codeDoc: Schema.Literal("passed")
  })
});

export type TaskCompletionEvidence = Schema.Schema.Type<typeof CompletionEvidenceSchema>;
export type TaskCompletionEvidenceProjectionRow = Readonly<Record<string, string | number | null>>;
export interface TaskCompletionEvidenceProjectionResult {
  readonly table: string;
  readonly rows: ReadonlyArray<TaskCompletionEvidenceProjectionRow>;
}

export function decodeTaskCompletionEvidence(value: unknown): TaskCompletionEvidence {
  return Schema.decodeUnknownSync(CompletionEvidenceSchema)(value);
}

export const taskCompletionEvidenceDeclaration: ReturnType<typeof decodeEntityDeclaration> = decodeEntityDeclaration({
  kind: "task",
  schema: CompletionEvidenceSchema,
  documentCodec: jsonEntityDocumentCodec,
  mutabilityContract: {
    evidence: {
      mutability: "immutable",
      read: [{ kind: "show", path: "task.completionEvidence" }],
      write: [{ kind: "command", operation: "task.complete.commit" }],
      reason: "completion judgment is immutable"
    }
  },
  anchors: { entityRef: "task/{taskId}/completion-evidence", anchors: [] },
  dispositionMatrix: {
    entries: {
      retire: { level: "D1", action: "retire", supported: false, writeOpKinds: [], reason: "completion evidence is immutable" },
      supersede: { level: "D1", action: "supersede", supported: false, writeOpKinds: [], reason: "completion evidence is immutable" },
      invalidate: { level: "D1", action: "invalidate", supported: false, writeOpKinds: [], reason: "completion evidence is immutable" },
      archive: { level: "D2", action: "archive", supported: false, writeOpKinds: [], reason: "evidence follows its task" },
      tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "completion evidence is immutable" },
      "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "completion evidence is immutable" }
    }
  },
  storageForm: "hosted-entity",
  rootResolver: {
    pathTemplate: `tasks/{taskId}/${TASK_COMPLETION_EVIDENCE_DOCUMENT}`,
    identity: ["taskId"],
    host: { entityKind: "task", pathTemplate: "tasks/{taskId}", identity: ["taskId"] }
  },
  projection: {
    table: "task_completion_evidence_projection",
    columns: [{ name: "task_id", field: "taskId", type: "text", primaryKey: true }]
  }
});

export function projectTaskCompletionEvidence(
  rootInput: HarnessLayoutInput,
  projectionPath: string
): TaskCompletionEvidenceProjectionResult {
  return projectDeclaredEntities(rootInput, taskCompletionEvidenceDeclaration, projectionPath);
}

export function readTaskCompletionEvidenceProjection(
  projectionPath: string
): ReadonlyArray<TaskCompletionEvidenceProjectionRow> {
  return readDeclaredProjectionRows(projectionPath, taskCompletionEvidenceDeclaration);
}

export type TaskCompletionEvidenceMode = "execution-review" | "commit-anchor";

export interface TaskCompletionAuthorityIssue {
  readonly code:
    | ExecutionCompletionReadinessIssue["code"]
    | "commit_completion_anchor_missing"
    | "commit_completion_git_ref_missing"
    | "commit_completion_non_commit_object";
  readonly message: string;
  readonly nextCommand?: string;
}

export type TaskCompletionAuthorityResult = {
  readonly ok: true;
  readonly evidenceMode: "execution-review";
  readonly executionId: string;
} | {
  readonly ok: true;
  readonly evidenceMode: "commit-anchor";
  readonly evidence: TaskCompletionEvidence;
} | {
  readonly ok: false;
  readonly evidenceMode: TaskCompletionEvidenceMode;
  readonly issues: ReadonlyArray<TaskCompletionAuthorityIssue>;
};

export interface TaskCompletionAuthorityInput {
  readonly taskId: string;
  readonly executionId?: string;
  readonly mode: TaskCompletionEvidenceMode;
  readonly status: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly actor: TaskHolderPrincipal;
  readonly sessionRef: string;
  readonly judgedAt: string;
  readonly applicableGates: ReadonlyArray<string>;
  readonly ciGate?: CompletionCiGateStatus;
  readonly commitRef?: string;
  readonly judgment?: string;
  readonly rootDir: string;
  readonly versionControlSystem?: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "resolveCommit">;
}

export function evaluateTaskCompletionAuthority(input: TaskCompletionAuthorityInput): TaskCompletionAuthorityResult {
  if (input.mode === "execution-review") {
    const readiness = inspectExecutionCompletionReadiness({
      taskId: input.taskId,
      actor: input.actor,
      executionId: input.executionId,
      documents: input.documents
    });
    return readiness.ok && readiness.executionId
      ? { ok: true, evidenceMode: "execution-review", executionId: readiness.executionId }
      : { ok: false, evidenceMode: "execution-review", issues: readiness.issues };
  }

  const issues: TaskCompletionAuthorityIssue[] = [];
  const rationale = input.judgment?.trim() ?? "";
  if (!input.commitRef?.trim()) {
    issues.push({ code: "commit_completion_anchor_missing", message: "Commit-anchor completion requires --commit-anchor." });
  }
  if (issues.length > 0) return { ok: false, evidenceMode: "commit-anchor", issues };

  const commit = resolveWorkspaceCommit(input.rootDir, input.commitRef!, input.versionControlSystem);
  if (!commit.ok) {
    return {
      ok: false,
      evidenceMode: "commit-anchor",
      issues: [{
        code: commit.reason === "non-commit" ? "commit_completion_non_commit_object" : "commit_completion_git_ref_missing",
        message: commit.reason === "non-commit"
          ? `Commit anchor ${input.commitRef} resolves to a ${commit.objectType ?? "non-commit"} object, not a commit.`
          : `Commit anchor ${input.commitRef} is not resolvable in the workspace repository.`
      }]
    };
  }

  const codeDoc = input.documents.find((document) => document.path === "code-doc-anchors.json");
  const anchored = codeDoc ? matchingCodeDocRecords(codeDoc.body, input.taskId, commit.sha) ?? [] : [];
  const codeDocBody = codeDoc?.body ?? "";

  const evidence: TaskCompletionEvidence = {
    schema: "task-completion-evidence/v1",
    taskId: input.taskId,
    mode: "commit-anchor",
    anchor: {
      sha: commit.sha,
      repository: "workspace",
      codeDocRecordIds: [...anchored],
      codeDocDocumentSha256: `sha256:${sha256Text(codeDocBody)}`
    },
    judgment: {
      actor: {
        principal: { kind: "person", personId: input.actor.principal.personId },
        executor: input.actor.executor
      },
      sessionRef: input.sessionRef,
      rationale,
      judgedAt: input.judgedAt
    },
    gateReceipt: {
      applicableGates: [...input.applicableGates],
      ci: input.ciGate ?? "not-applicable",
      closeout: "passed",
      codeDoc: "passed"
    }
  };
  Schema.decodeUnknownSync(CompletionEvidenceSchema)(evidence);
  return { ok: true, evidenceMode: "commit-anchor", evidence };
}

function resolveWorkspaceCommit(
  rootDir: string,
  ref: string,
  versionControlSystem: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "resolveCommit"> | undefined
):
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: "missing" | "non-commit"; readonly objectType?: string } {
  if (!versionControlSystem) return { ok: false, reason: "missing" };
  const repoRoot = versionControlSystem.topLevel(rootDir);
  if (!repoRoot) return { ok: false, reason: "missing" };
  try {
    if (versionControlSystem.normalizePath(repoRoot) !== versionControlSystem.normalizePath(rootDir)) {
      return { ok: false, reason: "missing" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return versionControlSystem.resolveCommit(repoRoot, ref);
}

function matchingCodeDocRecords(body: string, taskId: string, sha: string): ReadonlyArray<string> | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isCompletionRecord(value) || value.schema !== "code-doc-reconciliation/v1" || value.taskId !== taskId || !Array.isArray(value.records) || value.records.length === 0) {
    return null;
  }
  const ids: string[] = [];
  for (const rawRecord of value.records) {
    if (!isCompletionRecord(rawRecord) || typeof rawRecord.id !== "string" || !Array.isArray(rawRecord.anchors)) return null;
    const hardMatch = rawRecord.anchors.some((anchor) => isCompletionRecord(anchor)
      && (anchor.kind === "commit" || anchor.kind === "path")
      && anchor.sha === sha);
    if (hardMatch) ids.push(rawRecord.id);
  }
  return ids;
}

function isCompletionRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
