import path from "node:path";
import { Effect } from "effect";
import type { ArtifactStore, EngineError, FactRecord, WriteError } from "../../kernel/src/index.ts";
import {
  parseFactFlowRecords,
  queryDecisionProjection,
  queryTaskProjection,
  readRelationGraphProjection,
  readTaskProjection,
  resolveHarnessLayout
} from "../../kernel/src/index.ts";
import {
  readTaskDocumentPayload,
  validateLocalControllerDecisionId,
  validateLocalControllerTaskId
} from "./local-controller-payloads.ts";
import type {
  FactProjectionRow,
  LocalControllerError,
  LocalControllerFailure,
  LocalControllerResult,
  LocalControllerService,
  LocalControllerServiceOptions
} from "./index.ts";
import { makeTaskLifecycleOrchestrator } from "./task-lifecycle-orchestrator.ts";

export function makeLocalControllerService(options: LocalControllerServiceOptions): LocalControllerService {
  const rootDir = path.resolve(options.rootDir);
  const taskWriter = options.taskWriter;
  const lifecycleOrchestrator = makeTaskLifecycleOrchestrator({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    taskWriter,
    artifactStore: options.artifactStore
  });

  return {
    getTasks: () => {
      const result = queryTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, filters: {} });
      return { ok: true, tasks: result.rows, warnings: result.warnings };
    },
    getTaskDetail: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
      const task = projection.rows.find((row) => row.taskId === payload.taskId);
      if (!task) return taskNotFound(payload.taskId);
      return {
        ok: true,
        task,
        documents: await Effect.runPromise(listKnownTaskDocuments(options.artifactStore, payload.taskId))
      };
    },
    getTaskDocument: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      return Effect.runPromise(readControllerTaskDocument(options.artifactStore, parsed.taskId, parsed.path));
    },
    getRelationGraph: () => {
      const result = readRelationGraphProjection({ rootDir, layoutOverrides: options.layoutOverrides });
      return {
        ok: true,
        edges: result.edges,
        coverageRows: result.coverageRows,
        factAnchors: result.factAnchors,
        warnings: result.warnings
      };
    },
    getDecisions: () => {
      const result = queryDecisionProjection({ rootDir, layoutOverrides: options.layoutOverrides, filters: {} });
      return { ok: true, decisions: result.rows, warnings: result.warnings };
    },
    getDecisionDetail: (payload) => {
      validateLocalControllerDecisionId(payload.decisionId);
      const result = queryDecisionProjection({ rootDir, layoutOverrides: options.layoutOverrides, filters: {} });
      const decision = result.rows.find((row) => row.decisionId === payload.decisionId || row.legacyId === payload.decisionId);
      if (!decision) return decisionNotFound(payload.decisionId);
      return { ok: true, decision, warnings: result.warnings };
    },
    getTaskFacts: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      const layout = resolveHarnessLayout({ rootDir, layoutOverrides: options.layoutOverrides });
      const factsPath = path.relative(layout.rootDir, layout.taskFactDocumentPath(payload.taskId)).split(path.sep).join("/");
      return Effect.runPromise(options.artifactStore.readTaskPackage(payload.taskId).pipe(
        Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === layout.factDocumentName)?.body ?? ""),
        Effect.catchAll(() => Effect.succeed("")),
        Effect.map((body) => ({
          ok: true,
          taskId: payload.taskId,
          path: factsPath,
          facts: parseFactFlowRecords(body).map((fact) => toFactProjectionRow(payload.taskId, fact))
        }))
      ));
    },
    setTaskStatus: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      return Effect.runPromise(lifecycleOrchestrator.setTaskStatus(payload).pipe(Effect.map(toLocalControllerResult)));
    },
    reviewTask: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      return Effect.runPromise(lifecycleOrchestrator.startTaskReview(payload).pipe(Effect.map(toLocalControllerResult)));
    },
    appendTaskProgress: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      return Effect.runPromise(taskWriter.appendProgress({ taskId: payload.taskId, text: payload.text }).pipe(
        Effect.match({
          onFailure: (error) => toProgressFailure(error as EngineError | WriteError),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    rebuildGovernance: () => {
      const result = queryTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, filters: {} });
      return { ok: true, tasks: result.rows, warnings: result.warnings };
    },
    archiveTask: () => ({
      ok: false,
      error: {
        code: "unsupported_in_kr09",
        hint: "Archive mutation is reserved for the closeout workflow task."
      }
    }),
    openShell: () => ({
      ok: true,
      policy: {
        displayOnly: true,
        outputCreatesTaskState: false
      }
    })
  };
}

const knownTaskDocuments = new Set(["INDEX.md", "progress.md", "review.md", "findings.md"]);

function listKnownTaskDocuments(artifactStore: Pick<ArtifactStore, "readTaskPackage">, taskId: string): Effect.Effect<ReadonlyArray<{ readonly path: string }>> {
  return artifactStore.readTaskPackage(taskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents
      .filter((document) => knownTaskDocuments.has(document.path))
      .map((document) => ({ path: document.path }))
      .sort((left, right) => left.path.localeCompare(right.path))),
    Effect.catchAll(() => Effect.succeed([]))
  );
}

function taskNotFound(taskId: string): LocalControllerFailure {
  return { ok: false, error: { code: "task_not_found", hint: `task not found: ${taskId}` } };
}

function decisionNotFound(decisionId: string): LocalControllerFailure {
  return { ok: false, error: { code: "decision_not_found", hint: `decision not found: ${decisionId}` } };
}

function toFactProjectionRow(taskId: string, fact: FactRecord): FactProjectionRow {
  return {
    schema: "task-fact-row/v1",
    ref: `fact/${taskId}/${fact.fact_id}`,
    taskId,
    factId: fact.fact_id,
    statement: fact.statement,
    source: fact.source,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    memoryClass: fact.memoryClass,
    memoryTags: fact.memoryTags,
    provenance: fact.provenance
  };
}

function readControllerTaskDocument(artifactStore: Pick<ArtifactStore, "readTaskPackage">, taskId: string, portablePath: string): Effect.Effect<LocalControllerResult & { readonly taskId?: string; readonly path?: string; readonly body?: string }> {
  return artifactStore.readTaskPackage(taskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === portablePath)?.body ?? null),
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.map((body) => body === null
      ? ({ ok: false, error: { code: "document_not_found", hint: portablePath } } satisfies LocalControllerFailure)
      : ({ ok: true, taskId, path: portablePath, body }))
  );
}

function toLocalControllerResult(result: { readonly ok: true } | { readonly ok: false; readonly error: LocalControllerError }): LocalControllerResult {
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function toProgressFailure(error: EngineError | WriteError): LocalControllerResult {
  return { ok: false, error: { code: error._tag, hint: "Progress append failed." } };
}
