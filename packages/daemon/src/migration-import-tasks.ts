import { lstatSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  consumeKnownError,
  readScalar,
  sha256Text,
  slugifyTaskTitle,
  taskEntryToRow,
  validateTaskIdSyntax,
  type CanonicalContentBlob,
  type TaskSourceEntry,
} from "../../kernel/src/index.ts";
import type { ImportedTask } from "./migration-import-types.ts";
import type { MigrationImportContext } from "./migration-import-run.ts";

export function addTask(context: MigrationImportContext, entry: TaskSourceEntry): void {
  let row;
  try {
    row = taskEntryToRow(context.sourceRoot, entry);
    validateTaskIdSyntax(row.taskId);
  } catch (error) {
    const reason = context.message(error);
    consumeKnownError(error);
    context.skips.push({
      entityType: "task",
      migratedFrom: entry.taskId,
      sourcePath: path.relative(context.sourceRoot, entry.indexPath),
      reason,
    });
    return;
  }
  const taskId = row.taskId,
    occurredAt =
      context.timestamp(readScalar(entry.frontmatter, "  bindingCreatedAt")) ??
      context.timestamp(readScalar(entry.frontmatter, "bindingCreatedAt")) ??
      context.timestamp(readScalar(entry.frontmatter, "createdAt"));
  if (!row.title.trim() || !occurredAt) {
    context.skips.push({
      entityType: "task",
      migratedFrom: taskId,
      sourcePath: row.sourcePath,
      reason: "task title or occurredAt is invalid",
    });
    return;
  }
  if (context.taskMap.has(taskId)) {
    context.skips.push({
      entityType: "task",
      migratedFrom: taskId,
      sourcePath: row.sourcePath,
      reason: "task id occurs more than once in the same source repository",
    });
    return;
  }
  const held = context.existingSourceEntity("task", taskId);
  if (held?.kind === "task") {
    context.taskMap.set(taskId, held.task.taskId);
    context.taskPackages.set(taskId, held.packagePath);
    context.taskOccurredAt.set(taskId, occurredAt);
    context.alreadyImported.task += 1;
    return;
  }
  const targetTaskId = context.mappedIdentifier(
      "task",
      taskId,
      context.existingTasks,
      new Set(context.taskMap.values()),
    ),
    status = context.taskStatus(row.rawStatus),
    packagePath = `tasks/${targetTaskId}-${slugifyTaskTitle(row.title)}`,
    task: ImportedTask = {
      schema: "task/v1",
      taskId: targetTaskId,
      title: context.clean(row.title),
      taskClass: "standard",
      status,
      graph: REPLAY_TASK_GRAPH,
      currentNode: status === "in_review" ? "review" : "implementation",
      iteration: 0,
      createdBy: context.actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
    };
  context.taskMap.set(taskId, targetTaskId);
  context.taskPackages.set(taskId, packagePath);
  context.taskOccurredAt.set(taskId, occurredAt);
  context.drafts.push({
    kind: "task",
    migratedFrom: taskId,
    occurredAt,
    build: (workspaceRevision: number) => {
      const migrated = {
          ...task,
          ...context.importedTaskMetadata(row, taskId),
        },
        body = context.taskDocument(migrated, taskId, row.rawStatus, occurredAt, row, entry.body),
        documentClaim = context.claim(`${packagePath}/INDEX.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(`task/${taskId}`),
        "task",
        taskId,
        occurredAt,
        workspaceRevision,
        {
          kind: "task",
          task: migrated,
          originalStatus: row.rawStatus,
          packagePath,
          documentClaim,
        },
        [context.blob(body, "text/markdown")],
      );
    },
  });
}

export function importedTaskMetadata(
  context: MigrationImportContext,
  row: ReturnType<typeof taskEntryToRow>,
  taskId: string,
): {
  readonly metadata?: ImportedTask["metadata"];
} {
  const parent = row.parentTaskId ? (context.taskMap.get(row.parentTaskId) ?? null) : null;
  if (row.parentTaskId && !parent)
    context.skips.push({
      entityType: "relation",
      migratedFrom: `${taskId} parent`,
      sourcePath: row.sourcePath,
      reason: "task parent does not resolve to a migrated task",
    });
  if (!row.vertical || !row.preset || !row.profile) {
    if (parent)
      context.skips.push({
        entityType: "relation",
        migratedFrom: `${taskId} parent`,
        sourcePath: row.sourcePath,
        reason: "task metadata needs vertical, preset, and profile to carry a parent binding",
      });
    return {};
  }
  return {
    metadata: {
      idempotencyKey: null,
      parentTaskId: parent,
      workKind: null,
      riskTier: null,
      urgency: null,
      verticalId: row.vertical,
      presetId: row.preset,
      profileId: row.profile,
      moduleKey: row.moduleKey ?? null,
      slug: slugifyTaskTitle(row.title),
      surfaces: [],
      fromLegacyId: null,
    },
  };
}

export function addTaskPackage(context: MigrationImportContext, entry: TaskSourceEntry): void {
  const sourcePackage = context.portableMigrationPath(
      path.relative(context.sourceLayout.authoredRoot, path.dirname(entry.indexPath)),
    ),
    taskId = context.packageOwners.get(sourcePackage)!,
    mappedTaskId = context.taskMap.get(taskId),
    packagePath = context.taskPackages.get(taskId),
    prefix = `${sourcePackage}/`;
  if (!packagePath || !mappedTaskId) return;
  for (const source of context.authoredEntries) {
    if (source.symlink || !source.path.startsWith(prefix) || source.path === `${sourcePackage}/INDEX.md`) continue;
    const relative = source.path.slice(prefix.length),
      body = context.utf8File(context.sourceLayout.authoredRoot, source.path);
    if (body === null) continue;
    const legacy = /^executions\/[^/]+\.md$/u.test(relative) ? context.decodeLegacyExecution(body, taskId) : null;
    if (relative.startsWith("executions/")) {
      if (!legacy) continue;
      const execution = context.archivedExecution(legacy, mappedTaskId),
        target = `${packagePath}/executions/${execution.executionId}.md`;
      context.packageDrafts.push({
        migratedFrom: legacy.execution_id,
        occurredAt: legacy.claimed_at,
        build: (workspaceRevision: number) =>
          context.prepare(
            context.sourceKey,
            context.actorFor(`entity/execution/${legacy.execution_id}`),
            "execution",
            legacy.execution_id,
            legacy.claimed_at,
            workspaceRevision,
            {
              kind: "execution",
              execution,
              documentClaim: context.claim(target, body, "application/json"),
            },
            [context.blob(body, "application/json")],
          ),
      });
      continue;
    }
    const target = `${packagePath}/${relative}`,
      occurredAt = context.taskOccurredAt.get(taskId)!;
    context.packageDrafts.push({
      migratedFrom: source.path,
      occurredAt,
      build: (workspaceRevision: number) =>
        context.prepare(
          context.sourceKey,
          context.actorFor(`task/${taskId}`),
          "task-document",
          source.path,
          occurredAt,
          workspaceRevision,
          {
            kind: "task-document",
            taskId: mappedTaskId,
            documentClaim: context.claim(target, body, context.mediaType(target)),
          },
          [context.blob(body, context.mediaType(target))],
        ),
    });
  }
}

export function addRepoDocuments(context: MigrationImportContext): void {
  for (const source of context.authoredEntries) {
    const classification = context.resolveAuthoredConflict(
      context.classifyAuthored(
        context.sourceLayout.authoredRoot,
        context.destinationLayout.authoredRoot,
        source.path,
        source.symlink,
        context.packageOwners,
      ),
      context.sourceRoot,
      context.sourceLayout.authoredRoot,
      context.destinationLayout.authoredRoot,
      source.path,
      source.symlink,
      context.resolutions,
    );
    if (
      classification.disposition !== "migrated" ||
      (classification.surface !== "repo-document" && classification.surface !== context.PEOPLE_REGISTRY_SURFACE)
    )
      continue;
    const body =
        classification.mergedBody ??
        (source.symlink
          ? context.symlinkTarget(context.sourceLayout.authoredRoot, source.path)!
          : context.utf8File(context.sourceLayout.authoredRoot, source.path)!),
      occurredAt = lstatSync(path.join(context.sourceLayout.authoredRoot, source.path)).mtime.toISOString();
    if (classification.surface === context.PEOPLE_REGISTRY_SURFACE) {
      const currentBody = context.readFileSync(
          path.join(context.destinationLayout.authoredRoot, context.PEOPLE_ROSTER_PATH),
          "utf8",
        ),
        migrationAction =
          classification.resolution === "source"
            ? { kind: "people-replace" as const, sourceBody: body }
            : {
                kind: "people-reconcile" as const,
                sourceBody: context.utf8File(context.sourceLayout.authoredRoot, source.path)!,
              },
        opId = context.migrationOperationId(context.sourceKey, "people", source.path);
      context.packageDrafts.push({
        migratedFrom: source.path,
        occurredAt,
        build: (workspaceRevision: number) => {
          const compiled = context.compilePeopleRosterActionEvent({
            currentBody,
            action: migrationAction,
            eventId: `event-${sha256Text(opId)}`,
            opId,
            workspaceRevision,
            actor: context.actorFor(`person/${source.path}`),
            source: context.MIGRATION_IMPORT_SOURCE,
            occurredAt,
          });
          if (compiled.bundle === null) throw new Error("people migration classification produced no change");
          return compiled.bundle;
        },
      });
      continue;
    }
    const references = source.symlink
      ? { blobs: [] }
      : context.referencedContent(context.sourceLayout.authoredRoot, body);
    if ("error" in references) continue;
    const type = source.symlink ? "application/vnd.harness.symbolic-link" : context.mediaType(source.path),
      documentHash = sha256Text(body),
      referenced = references.blobs.filter(({ sha256 }) => sha256 !== documentHash);
    context.packageDrafts.push({
      migratedFrom: source.path,
      occurredAt,
      build: (workspaceRevision: number) =>
        context.prepare(
          context.sourceKey,
          context.actorFor(`document/${source.path}`),
          "repo-document",
          source.path,
          occurredAt,
          workspaceRevision,
          {
            kind: "repo-document",
            nodeKind: source.symlink ? "symbolic-link" : "file",
            documentClaim: context.claim(source.path, body, type),
            referencedContentClaims: referenced.map(
              ({ body: _body, ...contentClaim }: CanonicalContentBlob) => contentClaim,
            ),
            ...(classification.destinationPreimage ? { destinationPreimage: classification.destinationPreimage } : {}),
          },
          [context.blob(body, type), ...referenced],
        ),
    });
  }
}
