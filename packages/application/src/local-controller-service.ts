import * as fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { EngineError, HarnessLayoutInput, WriteError } from "../../kernel/src/index.ts";
import { createHarnessRuntimeContext, readTaskProjection, taskDocumentPath as harnessTaskDocumentPath } from "../../kernel/src/index.ts";
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
  const layoutInput = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const taskWriter = options.taskWriter;
  const lifecycleOrchestrator = makeTaskLifecycleOrchestrator({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    taskWriter
  });

  return {
    getTasks: () => {
      const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
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
        documents: await Effect.runPromise(listKnownTaskDocuments(layoutInput, payload.taskId))
      };
    },
    getTaskDocument: async (payload) => {
      validateLocalControllerTaskId(payload.taskId);
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      const documentPath = taskDocumentPath(layoutInput, parsed.taskId, parsed.path);
      return Effect.runPromise(readTaskDocument(documentPath, parsed.taskId, parsed.path));
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
      const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
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

function listKnownTaskDocuments(rootInput: HarnessLayoutInput, taskId: string): Effect.Effect<ReadonlyArray<{ readonly path: string }>> {
  return Effect.promise(async () => {
    const documents: Array<{ readonly path: string }> = [];
    for (const documentPath of ["INDEX.md", "progress.md", "review.md", "findings.md"] as const) {
      const exists = await pathExists(taskDocumentPath(rootInput, taskId, documentPath));
      if (exists) documents.push({ path: documentPath });
    }
    return documents;
  });
}

function taskDocumentPath(rootInput: HarnessLayoutInput, taskId: string, documentPath: string): string {
  validateLocalControllerTaskId(taskId);
  return harnessTaskDocumentPath(rootInput, taskId, documentPath);
}

function taskNotFound(taskId: string): LocalControllerFailure {
  return { ok: false, error: { code: "task_not_found", hint: `task not found: ${taskId}` } };
}

function readTaskDocument(documentPath: string, taskId: string, portablePath: string): Effect.Effect<LocalControllerResult & { readonly taskId?: string; readonly path?: string; readonly body?: string }> {
  return Effect.promise(() => fs.promises.readFile(documentPath, "utf8").catch(() => null)).pipe(
    Effect.map((body) => body === null
      ? ({ ok: false, error: { code: "document_not_found", hint: portablePath } } satisfies LocalControllerFailure)
      : ({ ok: true, taskId, path: portablePath, body }))
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises.access(filePath).then(
    () => true,
    () => false
  );
}

function toLocalControllerResult(result: { readonly ok: true } | { readonly ok: false; readonly error: LocalControllerError }): LocalControllerResult {
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function toProgressFailure(error: EngineError | WriteError): LocalControllerResult {
  return { ok: false, error: { code: error._tag, hint: "Progress append failed." } };
}
