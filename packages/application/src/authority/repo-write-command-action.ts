import { repoWriteAuthorityCutoverActionSchemas } from "./repo-write-authority-cutover-action-schemas.ts";
import { repoWriteKnowledgeActionSchemas } from "./repo-write-knowledge-action-schemas.ts";
import { repoWriteOperationsActionSchemas } from "./repo-write-operations-action-schemas.ts";
import { repoWriteTaskActionSchemas } from "./repo-write-task-action-schemas.ts";
import {
  strictInvalid,
  strictRecord,
  type StrictSchemaValue
} from "./strict-command-schema.ts";

const repoWriteCommandActionSchemas = {
  ...repoWriteTaskActionSchemas,
  ...repoWriteKnowledgeActionSchemas,
  ...repoWriteOperationsActionSchemas,
  ...repoWriteAuthorityCutoverActionSchemas
} as const;

type RepoWriteCommandActionSchemaMap = typeof repoWriteCommandActionSchemas;

/**
 * The complete normalized CLI action crossing the repo-write child boundary.
 * This is application-owned so CLI parsing and daemon transport share one shape authority.
 */
export type RepoWriteCommandAction = StrictSchemaValue<
  RepoWriteCommandActionSchemaMap[keyof RepoWriteCommandActionSchemaMap]
>;

export type RepoWriteCommandActionKind = RepoWriteCommandAction["kind"];

export type RepoWriteCommandActionFor<Kind extends RepoWriteCommandActionKind> =
  Extract<RepoWriteCommandAction, { readonly kind: Kind }>;

export const repoWriteCommandActionKinds = Object.freeze(
  Object.keys(repoWriteCommandActionSchemas)
) as ReadonlyArray<RepoWriteCommandActionKind>;

export function decodeRepoWriteCommandAction(
  value: unknown,
  path = "$.action"
): RepoWriteCommandAction {
  const input = strictRecord(value, path);
  if (typeof input.kind !== "string"
    || !Object.hasOwn(repoWriteCommandActionSchemas, input.kind)) {
    strictInvalid(`${path}.kind`, "registered repo-write command kind");
  }
  const schema = repoWriteCommandActionSchemas[
    input.kind as RepoWriteCommandActionKind
  ];
  return schema.decode(value, path) as RepoWriteCommandAction;
}
