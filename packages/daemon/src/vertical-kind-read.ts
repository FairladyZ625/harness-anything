import type { WriteReceiptDraft } from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { requireCanonicalVerticalDeclaration } from "./vertical-declaration-action.ts";

type AnyKind = ReturnType<typeof requireCanonicalVerticalDeclaration>["definition"]["entityKinds"][number];
type ArtifactKindRow = Extract<AnyKind, { readonly entityType: "artifact" }>;

/**
 * The CLI's read side of declared Artifact kinds. It reads the same canonical declaration the GUI
 * reads (`repo.vertical.declaration.read`) and returns the rows the writer fences against, so a
 * caller can take `revision` from `list`/`show` straight into `--expected-version`.
 */
export function readVerticalKindAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceiptDraft {
  const declaration = requireCanonicalVerticalDeclaration(cell.projection),
    revision = cell.projection.readCut().sourceRevision,
    rows = declaration.definition.entityKinds.filter(isArtifactKind);
  if (action.kind === "vertical-kind-list") {
    const kinds = rows.filter((row) => action.includeRetired === true || row.retired !== true);
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, revision),
      { schema: "vertical-kind-list/v1", declarationRevision: declaration.revision, kinds },
      revision,
      null,
    );
  }
  const requested = cell.requiredCellText(action.kindId, "kindId"),
    row = rows.find((candidate) => matchesKind(candidate, requested));
  if (!row) throw cell.cellCodedError("entity_not_found", `Vertical kind ${requested} is not declared.`);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, revision),
    { schema: "vertical-kind-show/v1", declarationRevision: declaration.revision, kind: row },
    revision,
    null,
  );
}

function isArtifactKind(candidate: AnyKind): candidate is ArtifactKindRow {
  return candidate.entityType === "artifact";
}

function matchesKind(candidate: ArtifactKindRow, requested: string): boolean {
  return (
    candidate.kindId === requested || `entity-kind/${candidate.kindId}` === requested || candidate.id === requested
  );
}
