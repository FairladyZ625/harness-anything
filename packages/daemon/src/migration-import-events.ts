import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  consumeKnownError,
  decisionStates,
  migrationImportWritePlan,
  sha256Text,
  taskEntryToRow,
  type ActorIdentity,
  type ColdDecisionProjectionRow,
  type DecisionState,
  type MigrationDocumentClaim,
  type MigrationImportEventV1,
  type RelationFactRow,
} from "../../kernel/src/index.ts";
import { isMigrationImportRecord, nonEmpty, timestamp } from "./migration-import-report.ts";
import { migrationOperationId } from "./migration-import-source.ts";
import type { ImportedTask, Prepared } from "./migration-import-types.ts";

export function prepare(
  sourceKey: string,
  actor: ActorIdentity,
  kind: string,
  migratedFrom: string,
  occurredAt: string,
  workspaceRevision: number,
  entity: MigrationImportEventV1["payload"]["entity"],
  blobs: Prepared["blobs"],
): Prepared {
  const opId = migrationOperationId(sourceKey, kind, migratedFrom),
    event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: `event-${sha256Text(opId)}`,
      workspaceRevision,
      opId,
      type: "entity_migrated",
      actor,
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt,
      payload: { migratedFrom, generation: "v0", entity },
    };
  return { event, plan: migrationImportWritePlan(event), blobs };
}

export function claim(
  target: string,
  body: string,
  mediaType: MigrationDocumentClaim["mediaType"],
): MigrationDocumentClaim {
  return {
    path: target,
    sha256: sha256Text(body),
    size: Buffer.byteLength(body),
    mediaType,
    policyId: MIGRATION_DOCUMENT_POLICY_ID,
  };
}

export function blob(body: string, mediaType: string): Prepared["blobs"][number] {
  return {
    sha256: sha256Text(body),
    size: Buffer.byteLength(body),
    mediaType,
    body,
  };
}

export function readSourceAttribution(authoredRoot: string): ReadonlyMap<string, { readonly personId: string }> {
  const dir = path.join(authoredRoot, "attribution-events"),
    earliest = new Map<string, { readonly at: string; readonly personId: string }>();
  let names: readonly string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    consumeKnownError(error);
    return new Map();
  }
  for (const name of names)
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        consumeKnownError(error);
        continue;
      }
      if (
        !isMigrationImportRecord(row) ||
        !nonEmpty(row.entityId) ||
        !nonEmpty(row.at) ||
        !isMigrationImportRecord(row.actor) ||
        !isMigrationImportRecord(row.actor.principal) ||
        !nonEmpty(row.actor.principal.personId)
      )
        continue;
      const held = earliest.get(row.entityId);
      if (!held || row.at < held.at)
        earliest.set(row.entityId, {
          at: row.at,
          personId: row.actor.principal.personId,
        });
    }
  return new Map([...earliest].map(([entityId, held]) => [entityId, { personId: held.personId }]));
}

export function taskDocument(
  task: ImportedTask,
  migratedFrom: string,
  originalStatus: string,
  occurredAt: string,
  row: ReturnType<typeof taskEntryToRow>,
  sourceBody: string,
): string {
  const frontmatter = [
    "---",
    "schema: task-package/v2",
    `task_id: ${task.taskId}`,
    `title: ${JSON.stringify(task.title)}`,
    "lifecycle:",
    `  status: ${task.status}`,
    "  engine: migration-import/v1",
    `bindingCreatedAt: ${occurredAt}`,
    "generation: v0",
    `migratedFrom: ${migratedFrom}`,
    `originalStatus: ${originalStatus}`,
    ...(task.metadata?.parentTaskId ? [`parent: ${task.metadata.parentTaskId}`] : []),
    ...(row.vertical ? [`vertical: ${row.vertical}`] : []),
    ...(row.preset ? [`preset: ${row.preset}`] : []),
    ...(row.profile ? [`profile: ${row.profile}`] : []),
    "---",
    "",
  ].join("\n");
  return [frontmatter, "\n", `${preservedSourceDocument(sourceBody, `# ${task.title}\n`)}`, ""].join("");
}

export function preservedSourceDocument(body: string, fallback: string): string {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(body),
    sourceProse = match ? body.slice(match[0].length) : body,
    prose = sourceProse.trim() ? sourceProse : fallback,
    frontmatter = match?.[1];
  return frontmatter === undefined
    ? prose
    : [
        "",
        `${prose}`,
        "",
        `${prose.endsWith("\n") ? "" : "\n"}`,
        "\n## Migrated source frontmatter\n\n````yaml\n",
        `${frontmatter}`,
        "\n````\n",
      ].join("");
}

export function taskStatus(value: string): ImportedTask["status"] {
  return value === "done" || value === "cancelled"
    ? "done"
    : value === "active"
      ? "active"
      : value === "in_review"
        ? "in_review"
        : "planned";
}

/** Legacy sources predate the CH3 status rename; the importer is the one sanctioned ingest boundary,
 * so it maps the two renamed decision states exactly like it already maps legacy decisionClass and task statuses. */
export function legacyDecisionState(value: string): DecisionState | null {
  if (value === "active") return "in_effect";
  if (value === "retired") return "outcome_retired";
  return (decisionStates as readonly string[]).includes(value) ? (value as DecisionState) : null;
}

export function validDecision(row: ColdDecisionProjectionRow): boolean {
  return (
    /^dec_[A-Za-z0-9_-]+$/u.test(row.decisionId) &&
    legacyDecisionState(row.state) !== null &&
    [row.title, row.question, row.vertical, row.preset, row.proposedAt].every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
    [row.riskTier, row.urgency].every((value) => ["low", "medium", "high"].includes(value ?? "")) &&
    row.chosenRecords.every(({ id, text }) => /^CH[A-Za-z0-9_-]+$/u.test(id) && !!text) &&
    row.rejectedRecords.every(({ id, text, whyNot }) => /^RJ[A-Za-z0-9_-]+$/u.test(id) && !!text && !!whyNot) &&
    row.claimRecords.every(({ id, text }) => /^C[A-Za-z0-9_-]+$/u.test(id) && !!text)
  );
}

export function validFact(row: RelationFactRow): boolean {
  return (
    ["low", "medium", "high"].includes(row.confidence) &&
    ["semantic", "episodic", "procedural"].includes(row.memoryClass) &&
    row.memoryTags.every((tag) =>
      ["episode", "procedural", "tool_memory", "pattern", "task_skill", "abstract_rule", "other"].includes(tag),
    ) &&
    row.provenance.length > 0 &&
    row.provenance.every(
      ({ runtime, sessionId, boundAt }) =>
        ["human", "claude-code", "codex", "zcode", "antigravity"].includes(runtime) &&
        !!sessionId &&
        !!timestamp(boundAt),
    )
  );
}
