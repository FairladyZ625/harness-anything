import type { DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";

/**
 * The renderer's only door to a named use-case projection (dec_5B135F46 CH4 layer two).
 *
 * The read path goes through one bridge method for every projection, so a view's data contract is
 * the projection's name rather than a per-store endpoint. This file unwraps the envelope and hands
 * back the inner projection unchanged — the shapes are identical to the reads they replaced, which
 * is why no view file changes: CH4 puts the boundary at write authority and visibility, not at
 * field renaming.
 */

type RepoScope = { readonly repoId: string };

export type UseCaseProjectionRequest = DaemonGuiReadPayloadMap["repo.projection.read"] & RepoScope;

/**
 * Read one projection and return its inner value. The envelope is checked here — a response that
 * names a different projection than the one asked for is a routing fault, not a rendering problem,
 * so it fails loudly instead of painting another view's data.
 */
export async function readUseCaseProjection(request: UseCaseProjectionRequest): Promise<unknown> {
  const value = await invoke("repo.projection.read", request, "readUseCaseProjection");
  if (!isRendererRecord(value) || value.ok !== true || value.schema !== "daemon.use-case-projection/v1")
    throw new Error(rendererErrorHint(value, "Use-case projection bridge returned an invalid result."));
  if (value.name !== request.name)
    throw new Error(
      rendererErrorHint(value, `Use-case projection bridge answered ${String(value.name)} for ${request.name}.`),
    );
  return value.projection;
}
