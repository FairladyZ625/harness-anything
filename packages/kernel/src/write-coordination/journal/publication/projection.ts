import type { HarnessLayoutInput } from "../../../layout/index.ts";
import type { VersionControlSystem } from "../../../ports/version-control-system.ts";
import type { ProjectionChangeEvent } from "../../../projection/projection-change-event.ts";
import {
  captureTrustedAuthoredProjectionFingerprint,
  rememberTrustedAuthoredProjectionFingerprint
} from "../../../projection/projection-source-baseline.ts";
import { updateTaskProjectionIncrementally } from "../../../projection/sqlite-task-incremental-projection.ts";
import { hashTaskProjectionRows } from "../../../projection/sqlite-task-projection.ts";
import { makeLocalVersionControlSystem } from "../../../persistence/git/local-version-control-system.ts";

export function rebuildProjectionHash(
  rootDir: string,
  rootInput: HarnessLayoutInput,
  touchedPaths: ReadonlyArray<string>,
  previousSourceFingerprint: string | undefined,
  entityIds: ReadonlyArray<string>,
  versionControlSystem?: VersionControlSystem
): { readonly hash: string; readonly event: ProjectionChangeEvent } {
  const vcs = versionControlSystem ?? makeLocalVersionControlSystem();
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  const result = updateTaskProjectionIncrementally({
    rootDir,
    layoutOverrides,
    touchedPaths,
    previousSourceFingerprint
  });
  const sourceHash = result.change?.sourceHash ?? captureTrustedAuthoredProjectionFingerprint(rootInput, vcs);
  rememberTrustedAuthoredProjectionFingerprint(rootInput, sourceHash, vcs);
  return {
    hash: hashTaskProjectionRows(result.rows),
    event: result.change ?? {
      schema: "projection-change/v1",
      sourceHash,
      entities: entityIds.map((entityId) => {
        const separator = entityId.indexOf("/");
        return separator < 0
          ? { kind: "entity", id: entityId }
          : { kind: entityId.slice(0, separator), id: entityId.slice(separator + 1) };
      })
    }
  };
}
