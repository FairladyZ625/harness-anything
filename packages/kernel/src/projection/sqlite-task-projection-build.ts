import { createHarnessRuntimeContext } from "../layout/index.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import {
  captureProjectionSourceCacheSnapshot,
  type ProjectionSourceCacheSnapshot
} from "./sqlite-projection-source-cache.ts";
import {
  captureProjectionSourceFingerprint,
  captureProjectionSourceSnapshot
} from "./projection-source-snapshot.ts";

export function captureStableProjectionBuild(runtimeContext: ReturnType<typeof createHarnessRuntimeContext>): {
  readonly snapshot: ReturnType<typeof captureProjectionSourceSnapshot>;
  readonly relationGraph: ReturnType<typeof buildRelationGraphProjection>;
  readonly sourceCache: ProjectionSourceCacheSnapshot;
} {
  let lastFailure: unknown = new Error("projection authored sources did not stabilize during rebuild");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const snapshot = captureProjectionSourceSnapshot(runtimeContext);
      const relationGraph = buildRelationGraphProjection(runtimeContext, snapshot.taskSource.sourceInputs);
      const verified = captureProjectionSourceFingerprint(runtimeContext, [], "verify");
      const sourceCache = captureProjectionSourceCacheSnapshot(runtimeContext, true);
      if (verified.fingerprint === snapshot.fingerprint && sourceCache) return { snapshot, relationGraph, sourceCache };
      lastFailure = new Error("projection authored sources did not stabilize during rebuild");
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure;
}
