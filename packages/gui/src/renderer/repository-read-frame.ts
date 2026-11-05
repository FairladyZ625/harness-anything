import { validateRepositoryReadFrame, type RepositoryReadFrame } from "@harness-anything/daemon/protocol";
import { isRendererRecord } from "./result-validation.ts";

/** Preserve the daemon's cut when a renderer parser unwraps or assembles a result. */
export function repositoryReadFrame(value: unknown): Partial<RepositoryReadFrame> {
  if (!isRendererRecord(value) || !Object.hasOwn(value, "freshness")) return {};
  const errors = validateRepositoryReadFrame(value);
  if (errors.length) throw new Error(errors.join("; "));
  const frame = value as unknown as RepositoryReadFrame;
  return { cut: frame.cut, freshness: frame.freshness, warning: frame.warning };
}

const reportedReadFailures = new Set(["replica_unavailable", "authorization_denied", "authentication_required"]);

export function repositoryReadFailure(value: unknown): Error | null {
  if (!isRendererRecord(value) || value.ok !== false) return null;
  const detail = isRendererRecord(value.error) ? value.error : value,
    code = detail.code ?? value.code;
  if (typeof code !== "string" || !reportedReadFailures.has(code)) return null;
  return Object.assign(new Error(String(detail.hint ?? detail.message ?? value.rejectionExplanation ?? code)), {
    code,
  });
}
