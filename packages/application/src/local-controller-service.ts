import path from "node:path";
import { Effect } from "effect";
import type { ArtifactStore, EngineError, WriteError } from "../../kernel/src/index.ts";
import { queryTaskProjection, readTaskProjection } from "../../kernel/src/index.ts";
import {
  readTaskDocumentPayload,
  validateLocalControllerTaskId
} from "./local-controller-payloads.ts";
import type {
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
