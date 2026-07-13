import path from "node:path";
import { Effect } from "effect";
import type { ArtifactDocumentKind, ArtifactStore, AuthoredDocumentDescriptor, EngineError, FactRecord, HarnessLayout, WriteError } from "../../kernel/src/index.ts";
import {
  parseFactFlowRecords,
  queryDecisionProjection,
  queryExecutionProjection,
  queryExecutions,
  queryExecutionsByTask,
  queryReviewProjection,
  queryTaskProjection,
  readRelationGraphProjection,
  readTaskProjection,
  readTriadicProjectionSnapshot,
  resolveHarnessLayout
} from "../../kernel/src/index.ts";
import {
  readPeripheralDocumentPayload,
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
  LocalControllerServiceOptions,
  PeripheralDocumentResult,
  TaskDocumentDescriptor,
  TaskDocumentKind
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
        documents: await Effect.runPromise(listTaskDocuments(options.artifactStore, payload.taskId))
      };
    },
    getTaskDocument: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      return Effect.runPromise(readControllerTaskDocument(options.artifactStore, parsed.taskId, parsed.path));
    },
    getPeripheralDocuments: async () => {
      const layout = resolveHarnessLayout({ rootDir, layoutOverrides: options.layoutOverrides });
      const boundary = peripheralDocumentBoundary(layout);
      if (!boundary.ok) return boundary;
      // kernel 的 AuthoredDocumentDescriptor 只在这一层(实现)被消费,不上服务面 DTO ——
      // controller 的 DTO 面不许泄漏 kernel 类型(check-service-mappability),所以这里
      // 显式收窄成 application 自己的 { path } 描述符。
      const documents = await Effect.runPromise(options.artifactStore.listAuthoredDocuments().pipe(
        Effect.map((authoredDocuments: ReadonlyArray<AuthoredDocumentDescriptor>) => authoredDocuments
          .filter((document) => boundary.includes(document.path))
          .map((document) => ({ path: document.path }))),
        Effect.catchAll(() => Effect.succeed([]))
      ));
      return { ok: true, documents };
    },
    getPeripheralDocument: async (payload) => {
      const parsed = readPeripheralDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      const boundary = peripheralDocumentBoundary(resolveHarnessLayout({ rootDir, layoutOverrides: options.layoutOverrides }));
      if (!boundary.ok) return boundary;
      if (!boundary.includes(parsed.path)) return documentNotFound(parsed.path);
      return Effect.runPromise(readControllerPeripheralDocument(options.artifactStore, parsed.path));
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
    getTaskExecutions: (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      return { ok: true, taskId: payload.taskId, executions: queryExecutionsByTask({ rootDir, layoutOverrides: options.layoutOverrides, taskId: payload.taskId }) };
    },
    getExecutions: () => ({
      ok: true,
      executions: queryExecutions({ rootDir, layoutOverrides: options.layoutOverrides })
    }),
    getExecutionDetail: (payload) => {
      validateLocalControllerDecisionId(payload.executionId);
      const execution = queryExecutionProjection({ rootDir, layoutOverrides: options.layoutOverrides, executionId: payload.executionId });
      return execution ? { ok: true, execution } : entityNotFound("execution", payload.executionId);
    },
    getReviewDetail: (payload) => {
      validateLocalControllerDecisionId(payload.reviewId);
      const review = queryReviewProjection({ rootDir, layoutOverrides: options.layoutOverrides, reviewId: payload.reviewId });
      return review ? { ok: true, review } : entityNotFound("review", payload.reviewId);
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
    getFacts: async () => {
      const graph = readRelationGraphProjection({ rootDir, layoutOverrides: options.layoutOverrides });
      const layout = resolveHarnessLayout({ rootDir, layoutOverrides: options.layoutOverrides });
      const documents = new Map<string, string>();
      for (const anchor of graph.factAnchors) {
        if (documents.has(anchor.taskId)) continue;
        const sourcePath = path.relative(layout.authoredRoot, layout.taskFactDocumentPath(anchor.taskId)).split(path.sep).join("/");
        documents.set(anchor.taskId, sourcePath);
      }
      const facts = await Effect.runPromise(Effect.all(
        [...documents].map(([taskId, sourcePath]) =>
          options.artifactStore.readAuthoredDocument(sourcePath).pipe(
            Effect.map((document) => parseFactFlowRecords(document.body).map((fact) => toFactProjectionRow(taskId, fact))),
            Effect.catchAll(() => Effect.succeed([]))
          )
        ),
        { concurrency: 8 }
      ));
      return { ok: true, facts: facts.flat() };
    },
    getTriadicProjection: async () => {
      const snapshot = readTriadicProjectionSnapshot({ rootDir, layoutOverrides: options.layoutOverrides });
      const layout = resolveHarnessLayout({ rootDir, layoutOverrides: options.layoutOverrides });
      const documents = new Map<string, string>();
      for (const anchor of snapshot.factAnchors) {
        if (documents.has(anchor.taskId)) continue;
        const sourcePath = path.relative(layout.authoredRoot, layout.taskFactDocumentPath(anchor.taskId)).split(path.sep).join("/");
        documents.set(anchor.taskId, sourcePath);
      }
      const facts = await Effect.runPromise(Effect.all(
        [...documents].map(([taskId, sourcePath]) =>
          options.artifactStore.readAuthoredDocument(sourcePath).pipe(
            Effect.map((document) => parseFactFlowRecords(document.body).map((fact) => toFactProjectionRow(taskId, fact))),
            Effect.catchAll(() => Effect.succeed([]))
          )
        ),
        { concurrency: 8 }
      ));
      return {
        ok: true,
        decisions: snapshot.decisions,
        edges: snapshot.edges,
        coverageRows: snapshot.coverageRows,
        factAnchors: snapshot.factAnchors,
        facts: facts.flat(),
        warnings: snapshot.warnings
      };
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

function listTaskDocuments(artifactStore: Pick<ArtifactStore, "readTaskPackage">, taskId: string): Effect.Effect<ReadonlyArray<TaskDocumentDescriptor>> {
  return artifactStore.readTaskPackage(taskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents
      .map((document) => ({ path: document.path, kind: toTaskDocumentKind(document.kind) }))
      .sort((left, right) => left.path.localeCompare(right.path))),
    Effect.catchAll(() => Effect.succeed([]))
  );
}

// kernel 的分类翻成服务面自己的分类。今天两者字面量相同,这个函数看着多余 ——
// 它的作用是让「kernel 的种类」与「controller DTO 的种类」在类型上是两件事:
// kernel 将来加一种(比如 diagram),这里会立刻编译不过,而不是悄悄穿透到 GUI。
function toTaskDocumentKind(kind: ArtifactDocumentKind): TaskDocumentKind {
  return kind === "document" ? "document" : "attachment";
}

function taskNotFound(taskId: string): LocalControllerFailure {
  return { ok: false, error: { code: "task_not_found", hint: `task not found: ${taskId}` } };
}

function decisionNotFound(decisionId: string): LocalControllerFailure {
  return { ok: false, error: { code: "decision_not_found", hint: `decision not found: ${decisionId}` } };
}

function documentNotFound(documentPath: string): LocalControllerFailure {
  return { ok: false, error: { code: "document_not_found", hint: documentPath } };
}

type PeripheralDocumentBoundary =
  | { readonly ok: true; readonly includes: (documentPath: string) => boolean }
  | LocalControllerFailure;

function peripheralDocumentBoundary(layout: Pick<HarnessLayout, "authoredRoot" | "tasksRoot">): PeripheralDocumentBoundary {
  const tasksPrefix = path.relative(layout.authoredRoot, layout.tasksRoot);
  const authoredPrefix = path.relative(layout.tasksRoot, layout.authoredRoot);
  if (tasksPrefix === "" || isContainedRelativePath(authoredPrefix)) {
    return {
      ok: false,
      error: {
        code: "invalid_layout",
        hint: "Peripheral documents require tasksRoot to differ from authoredRoot."
      }
    };
  }
  if (!isContainedRelativePath(tasksPrefix)) return { ok: true, includes: () => true };
  const portableTasksPrefix = tasksPrefix.split(path.sep).join("/");
  return {
    ok: true,
    includes: (documentPath) => documentPath !== portableTasksPrefix
      && !documentPath.startsWith(`${portableTasksPrefix}/`)
  };
}

function isContainedRelativePath(relativePath: string): boolean {
  return relativePath === "" || (!path.isAbsolute(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`));
}

function entityNotFound(kind: string, id: string): LocalControllerFailure {
  return { ok: false, error: { code: `${kind}_not_found`, hint: `${kind} not found: ${id}` } };
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
    Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === portablePath) ?? null),
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.map((document) => document === null
      ? ({ ok: false, error: { code: "document_not_found", hint: portablePath } } satisfies LocalControllerFailure)
      : document.kind === "attachment"
        ? ({ ok: false, error: { code: "attachment_not_renderable", hint: portablePath } } satisfies LocalControllerFailure)
        : ({ ok: true, taskId, path: portablePath, body: document.body }))
  );
}

function readControllerPeripheralDocument(
  artifactStore: Pick<ArtifactStore, "listAuthoredDocuments" | "readAuthoredDocument">,
  portablePath: string
): Effect.Effect<PeripheralDocumentResult> {
  return artifactStore.listAuthoredDocuments().pipe(
    Effect.flatMap((documents) => documents.some((document) => document.path === portablePath)
      ? artifactStore.readAuthoredDocument(portablePath).pipe(Effect.map((document) => document.body))
      : Effect.succeed(null)),
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.map((body) => body === null
      ? documentNotFound(portablePath)
      : ({ ok: true, path: portablePath, body } satisfies PeripheralDocumentResult))
  );
}

function toLocalControllerResult(result: { readonly ok: true } | { readonly ok: false; readonly error: LocalControllerError }): LocalControllerResult {
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function toProgressFailure(error: EngineError | WriteError): LocalControllerResult {
  return { ok: false, error: { code: error._tag, hint: "Progress append failed." } };
}
