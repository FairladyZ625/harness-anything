import type {
  DeclaredEntityDocumentPrecondition,
  DeclaredEntityDocumentWritePayload
} from "../entity/declaration.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { documentTargetPath } from "./write-journal-operations-internal.ts";
import { rejectWrite } from "../write-coordination/journal/rejection.ts";

export function declaredEntityPreconditions(
  payload: DeclaredEntityDocumentWritePayload
): ReadonlyArray<DeclaredEntityDocumentPrecondition> {
  const preconditions = payload.preconditions ?? [];
  if (!Array.isArray(preconditions) || preconditions.some((entry) =>
    !entry || typeof entry.path !== "string" || (entry.bodySha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.bodySha256)))) {
    rejectWrite("declared entity preconditions must name task documents and an exact body sha256 or null");
  }
  return preconditions;
}

export function assertDeclaredEntityPreconditions(
  rootInput: HarnessLayoutInput,
  preconditions: ReadonlyArray<DeclaredEntityDocumentPrecondition>,
  op: WriteOp,
  readBodySha256: (targetPath: string) => string | null
): void {
  const seen = new Set<string>();
  for (const precondition of preconditions) {
    const targetPath = documentTargetPath(rootInput, {
      taskId: precondition.taskId,
      path: precondition.path,
      body: ""
    });
    if (seen.has(targetPath)) rejectWrite(`duplicate declared entity precondition: ${precondition.path}`, op.entityId);
    seen.add(targetPath);
    const actual = readBodySha256(targetPath);
    if (actual !== precondition.bodySha256) {
      rejectWrite(
        `declared entity precondition changed: ${precondition.path}; expected ${precondition.bodySha256 ?? "<missing>"}, current ${actual ?? "<missing>"}`,
        op.entityId
      );
    }
  }
}
