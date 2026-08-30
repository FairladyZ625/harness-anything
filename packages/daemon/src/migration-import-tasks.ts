import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  consumeKnownError,
  readScalar,
  sha256Text,
  slugifyTaskTitle,
  taskEntryToRow,
  validateTaskIdSyntax,
  validateTaskV2,
  type CanonicalContentBlob,
  type TaskSourceEntry,
} from "../../kernel/src/index.ts";
import type { ProjectionOracleTask } from "./migration-import-oracle.ts";
import { scheduleArchivedEntity } from "./migration-import-dispositions.ts";
import { isMigrationImportRecord } from "./migration-import-report.ts";
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
    projectedTask = context.oracle.tasks.get(taskId)?.snapshot.task,
    projectedMetadata =
      isMigrationImportRecord(projectedTask) && isMigrationImportRecord(projectedTask.metadata)
        ? projectedTask.metadata
        : null,
    projectedParent = typeof projectedMetadata?.parentTaskId === "string" ? projectedMetadata.parentTaskId : null;
  if (row.parentTaskId && !context.oracle.tasks.has(row.parentTaskId)) {
    if (projectedParent !== null && context.oracle.tasks.has(projectedParent)) {
      row = { ...row, parentTaskId: projectedParent };
      recordDerivation(
        context,
        "task",
        taskId,
        "metadata.parentTaskId",
        `projection:task_snapshot@${context.oracle.watermark}`,
      );
    } else {
      context.skips.push({
        entityType: "task",
        migratedFrom: taskId,
        sourcePath: row.sourcePath,
        reason: `task parent ${row.parentTaskId} has no same-cut active witness`,
      });
      return;
    }
  }
  const titleWitness = taskTitleWitness(context, entry, readScalar(entry.frontmatter, "title")),
    title = titleWitness?.value ?? "",
    sourceOccurredAt =
      context.timestamp(readScalar(entry.frontmatter, "  bindingCreatedAt")) ??
      context.timestamp(readScalar(entry.frontmatter, "bindingCreatedAt")) ??
      context.timestamp(readScalar(entry.frontmatter, "createdAt")),
    eventWitness = context.oracle.tasks.get(taskId)?.firstEvent ?? null,
    occurredAt = sourceOccurredAt ?? eventWitness?.occurredAt ?? null;
  if (titleWitness?.derived === true) recordDerivation(context, "task", taskId, "title", titleWitness.source);
  if (sourceOccurredAt === null && eventWitness !== null)
    recordDerivation(context, "task", taskId, "occurredAt", `event:${eventWitness.eventId}`);
  if (!title || !occurredAt) {
    context.skips.push({
      entityType: "task",
      migratedFrom: taskId,
      sourcePath: row.sourcePath,
      reason: "task title or occurredAt is invalid",
    });
    return;
  }
  row = { ...row, title };
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
    sourceTask = context.legacyTaskRestatements.get(taskId),
    task: ImportedTask = {
      schema: "task/v2",
      taskId: targetTaskId,
      title: context.clean(row.title),
      taskClass: "standard",
      status,
      graph: REPLAY_TASK_GRAPH,
      currentNode: status === "in_review" ? "review" : "implementation",
      iteration: 0,
      pinned: sourceTask === undefined ? false : sourceTask.pinned,
      packageDisposition: row.packageDisposition,
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
          provenance: "imported_snapshot",
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

export function addOracleTask(context: MigrationImportContext, source: ProjectionOracleTask): boolean {
  if (context.taskMap.has(source.taskId)) return true;
  const projected = isMigrationImportRecord(source.snapshot.task) ? source.snapshot.task : null,
    packagePath = source.packagePath,
    packageRoot = packagePath === null ? null : path.join(context.sourceLayout.authoredRoot, packagePath),
    indexPath = packageRoot === null ? null : path.join(packageRoot, "INDEX.md"),
    sourceBody = indexPath === null ? null : utf8Absolute(indexPath),
    titleWitness = taskTitleFromPackage(packageRoot, sourceBody, context.sourceLayout.authoredRoot),
    occurredAt = source.firstEvent?.occurredAt ?? null;
  if (projected === null || titleWitness === null || occurredAt === null) return false;
  const targetTaskId = context.mappedIdentifier(
      "task",
      source.taskId,
      context.existingTasks,
      new Set(context.taskMap.values()),
    ),
    status = context.taskStatus(String(projected.status ?? "unknown")),
    task = {
      ...projected,
      schema: "task/v2",
      taskId: targetTaskId,
      title: titleWitness.value,
      status,
      pinned: projected.pinned === true,
      packageDisposition: ["active", "archived", "tombstoned"].includes(String(projected.packageDisposition))
        ? projected.packageDisposition
        : "active",
    } as unknown as ImportedTask;
  if (validateTaskV2(task, true).length) return false;
  const targetPackage =
      packagePath !== null && targetTaskId === source.taskId && packagePath.startsWith(`tasks/${targetTaskId}-`)
        ? packagePath
        : `tasks/${targetTaskId}-${slugifyTaskTitle(task.title)}`,
    syntheticEntry: TaskSourceEntry = {
      taskId: source.taskId,
      indexPath: indexPath ?? path.join(context.sourceLayout.tasksRoot, source.taskId, "INDEX.md"),
      body: sourceBody ?? `# ${task.title}\n`,
      frontmatter: [
        `task_id: ${source.taskId}`,
        `title: ${JSON.stringify(task.title)}`,
        "lifecycle:",
        `  status: ${status}`,
        ...(isMigrationImportRecord(task.metadata) && typeof task.metadata.verticalId === "string"
          ? [`vertical: ${task.metadata.verticalId}`]
          : []),
        ...(isMigrationImportRecord(task.metadata) && typeof task.metadata.presetId === "string"
          ? [`preset: ${task.metadata.presetId}`]
          : []),
        ...(isMigrationImportRecord(task.metadata) && typeof task.metadata.profileId === "string"
          ? [`profile: ${task.metadata.profileId}`]
          : []),
      ].join("\n"),
    },
    row = taskEntryToRow(context.sourceRoot, syntheticEntry),
    body = context.taskDocument(
      task,
      source.taskId,
      String(projected.status ?? "unknown"),
      occurredAt,
      row,
      syntheticEntry.body,
    ),
    documentClaim = context.claim(`${targetPackage}/INDEX.md`, body, "text/markdown");
  context.taskMap.set(source.taskId, targetTaskId);
  context.taskPackages.set(source.taskId, targetPackage);
  context.taskOccurredAt.set(source.taskId, occurredAt);
  recordDerivation(context, "task", source.taskId, "entity", `projection:task_snapshot@${context.oracle.watermark}`);
  recordDerivation(context, "task", source.taskId, "title", titleWitness.source);
  recordDerivation(context, "task", source.taskId, "occurredAt", `event:${source.firstEvent!.eventId}`);
  context.drafts.push({
    kind: "task",
    migratedFrom: source.taskId,
    occurredAt,
    build: (workspaceRevision: number) =>
      context.prepare(
        context.sourceKey,
        context.actorFor(`task/${source.taskId}`),
        "task",
        source.taskId,
        occurredAt,
        workspaceRevision,
        {
          kind: "task",
          provenance: "imported_snapshot",
          task,
          originalStatus: String(projected.status ?? "unknown"),
          packagePath: targetPackage,
          documentClaim,
        },
        [context.blob(body, "text/markdown")],
      ),
  });
  return true;
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
      if (!legacy) {
        const original = jsonRecordOrBody(body),
          declaredId =
            typeof original.execution_id === "string" && original.execution_id.trim()
              ? original.execution_id
              : path.basename(relative, path.extname(relative));
        if (!(typeof original.execution_id === "string" && original.execution_id.trim()))
          context.fieldDerivations.push({
            entityType: "execution",
            entityId: declaredId,
            field: "id",
            derived_from: source.path,
          });
        scheduleArchivedEntity(context, {
          entityKind: "execution",
          entityId: declaredId,
          sourcePath: source.path,
          originalFields: original,
          occurredAt: context.taskOccurredAt.get(taskId) ?? context.input.now(),
        });
        continue;
      }
      const execution = context.archivedExecution(legacy, mappedTaskId),
        target = `${packagePath}/executions/${execution.executionId}.md`;
      context.nativeExecutionIds.add(legacy.execution_id);
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

function taskTitleWitness(
  context: MigrationImportContext,
  entry: TaskSourceEntry,
  declared: string,
): { readonly value: string; readonly source: string; readonly derived: boolean } | null {
  const cleanDeclared = context.clean(declared).trim();
  if (cleanDeclared) return { value: cleanDeclared, source: entry.indexPath, derived: false };
  const fromPackage = taskTitleFromPackage(
    path.dirname(entry.indexPath),
    entry.body,
    context.sourceLayout.authoredRoot,
  );
  return fromPackage === null ? null : { ...fromPackage, derived: true };
}

export function taskTitleFromPackage(
  packageRoot: string | null,
  indexBody: string | null,
  authoredRoot: string,
): { readonly value: string; readonly source: string } | null {
  if (packageRoot === null) return null;
  const planPath = path.join(packageRoot, "task_plan.md"),
    planTitle = markdownH1(utf8Absolute(planPath));
  if (planTitle) return { value: planTitle, source: path.relative(authoredRoot, planPath) };
  const indexPath = path.join(packageRoot, "INDEX.md"),
    indexTitle = markdownH1(indexBody ?? utf8Absolute(indexPath));
  return indexTitle ? { value: indexTitle, source: path.relative(authoredRoot, indexPath) } : null;
}

function markdownH1(body: string | null): string | null {
  const value = body?.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim() ?? "";
  return value || null;
}

function utf8Absolute(target: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(target));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function recordDerivation(
  context: MigrationImportContext,
  entityType: "task" | "execution",
  entityId: string,
  field: string,
  derivedFrom: string,
): void {
  if (
    context.fieldDerivations.some(
      (row) =>
        row.entityType === entityType &&
        row.entityId === entityId &&
        row.field === field &&
        row.derived_from === derivedFrom,
    )
  )
    return;
  context.fieldDerivations.push({ entityType, entityId, field, derived_from: derivedFrom });
  if (entityType === "task") context.derivedIds.task.add(entityId);
}

function jsonRecordOrBody(body: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(body);
    return isMigrationImportRecord(value) ? value : { rawBody: body };
  } catch (error) {
    consumeKnownError(error);
    return { rawBody: body };
  }
}
