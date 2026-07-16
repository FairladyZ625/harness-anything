import type { TaskSnapshot } from "../../../kernel/src/index.ts";
import type { GithubRawIssue } from "./codec.ts";
import type { GithubLabelMapping, GithubOpenStatus } from "./types.ts";

export interface GithubStatusMapping {
  readonly canonicalStatus: TaskSnapshot["canonicalStatus"];
  readonly rawStatus: string;
  readonly warning?: "status_unmapped";
}

export interface GithubIssueMappingOptions {
  readonly ref: string;
  readonly fetchedAt: Date;
  readonly labelMapping?: GithubLabelMapping;
}

const labelPriority = ["blocked", "in_review", "active", "planned"] as const;
const defaultLabelPatterns: Readonly<Record<"blocked" | "in_review", ReadonlyArray<RegExp>>> = {
  blocked: [/^blocked/iu, /^on hold$/iu],
  in_review: [/review/iu]
};

export function mapGithubIssue(raw: GithubRawIssue, options: GithubIssueMappingOptions): TaskSnapshot {
  const status = mapGithubStatus(raw, options.labelMapping);
  return {
    canonicalStatus: status.canonicalStatus,
    rawStatus: status.rawStatus,
    freshness: "fresh",
    fetchedAt: options.fetchedAt.toISOString(),
    ...(status.warning ? { staleReason: status.warning } : {}),
    source: "external-engine",
    engine: "github",
    ref: options.ref,
    ...(raw.assignee ? { assignee: raw.assignee } : {}),
    url: raw.htmlUrl,
    title: raw.title
  };
}

export function mapGithubStatus(raw: GithubRawIssue, labelMapping?: GithubLabelMapping): GithubStatusMapping {
  const state = raw.state.toLowerCase();
  const stateReason = raw.stateReason?.toLowerCase() ?? null;
  const rawStatus = stateReason === null ? `${state}:null` : `${state}:${stateReason}`;

  if (state === "closed") {
    if (stateReason === "completed" || stateReason === null) return { canonicalStatus: "done", rawStatus };
    if (stateReason === "not_planned") return { canonicalStatus: "cancelled", rawStatus };
    return { canonicalStatus: "unknown", rawStatus, warning: "status_unmapped" };
  }

  if (state !== "open") return { canonicalStatus: "unknown", rawStatus, warning: "status_unmapped" };
  const labelStatus = matchOpenLabel(raw.labels, labelMapping);
  if (labelStatus) return { canonicalStatus: labelStatus, rawStatus };
  return { canonicalStatus: raw.assignee ? "active" : "planned", rawStatus };
}

function matchOpenLabel(labels: ReadonlyArray<string>, override?: GithubLabelMapping): GithubOpenStatus | undefined {
  if (override) {
    for (const status of labelPriority) {
      const candidates = override[status] ?? [];
      if (labels.some((label) => candidates.some((candidate) => sameLabel(label, candidate)))) return status;
    }
    return undefined;
  }

  for (const status of ["blocked", "in_review"] as const) {
    if (labels.some((label) => defaultLabelPatterns[status].some((pattern) => pattern.test(label.trim())))) return status;
  }
  return undefined;
}

function sameLabel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
