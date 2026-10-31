import { sha256Text, stableStringify } from "./integrity/stable-hash.ts";

export type HandoffMode = "review" | "collaborate" | "transfer";

export interface HandoffPacketV1 {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly revision: number;
  readonly mode: HandoffMode;
  readonly goal: {
    readonly workItemId: string;
    readonly title: string;
    readonly description: string;
    readonly specRevision: number;
    readonly specDigest: string;
  };
  readonly source: {
    readonly attemptId: string | null;
    readonly status: string | null;
    readonly sessionId: string | null;
    readonly employeeId: string | null;
    readonly runtime: string | null;
  };
  readonly completed: readonly { readonly artifactId: string; readonly digest: string }[];
  readonly decisions: readonly { readonly knowledgeId: string; readonly version: number }[];
  readonly openItems: readonly string[];
  readonly knownFailures: readonly string[];
  readonly sideEffects: string;
  readonly skills: readonly string[];
  readonly sourceScope: {
    readonly sourceRefs: readonly { readonly sourceId: string; readonly revision: number; readonly digest: string }[];
    readonly readers: readonly string[] | null;
  };
  readonly target: { readonly employeeId: string; readonly name: string };
  readonly expiresAt: string;
  /** Bounded causal context produced by assembleTaskCausalContext at dispatch time. */
  readonly taskContext: string | null;
}

export interface HandoffPacketInput {
  readonly handoffId: string;
  readonly revision: number;
  readonly mode: HandoffMode;
  readonly expiresAt: string;
  /** Optional project and upstream labels retained for callers that build the causal cut here. */
  readonly project?: { readonly id: string; readonly name: string };
  readonly work: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly specRevision: number;
    readonly specDigest: string;
    readonly createdAt?: string;
  };
  readonly upstream?: { readonly id: string; readonly title: string } | null;
  readonly attempt?: {
    readonly id: string;
    readonly status: string;
    readonly sessionId?: string | null;
    readonly runtime?: string | null;
    readonly error?: string | null;
    readonly artifactId?: string | null;
    readonly artifactDigest?: string | null;
  } | null;
  readonly sourceEmployeeId?: string | null;
  readonly completed?: readonly { readonly artifactId: string; readonly digest: string }[];
  readonly decisions?: readonly { readonly knowledgeId: string; readonly version: number }[];
  readonly knowledge?: readonly {
    readonly id: string;
    readonly version: number;
    readonly statement?: string;
    readonly sources?: readonly {
      readonly sourceId: string;
      readonly revision: number;
      readonly digest: string;
      readonly title?: string;
      readonly text?: string;
    }[];
  }[];
  readonly sourceRefs?: readonly { readonly sourceId: string; readonly revision: number; readonly digest: string }[];
  readonly readers?: readonly string[] | null;
  readonly openItems?: readonly string[];
  readonly knownFailures?: readonly string[];
  readonly sideEffects?: string;
  readonly skills?: readonly string[];
  readonly target: { readonly employeeId: string; readonly name: string };
  readonly taskContext?: string | null;
  /** Alias for callers that name the rendered causal block directly. */
  readonly causalContext?: string | null;
}

export interface HandoffPacketResult {
  readonly packet: HandoffPacketV1;
  readonly digest: string;
  readonly text: string;
}

/** Canonical JSON is the repository's stable key-sorted JSON substrate. */
export function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

export function packetDigest(packet: HandoffPacketV1): string {
  return sha256Text(canonicalJson(packet));
}

export function verifyHandoffPacketDigest(
  packetOrResult: HandoffPacketV1 | HandoffPacketResult,
  expectedDigest?: string,
): boolean {
  const packet = "packet" in packetOrResult ? packetOrResult.packet : packetOrResult;
  const supplied = expectedDigest ?? ("digest" in packetOrResult ? packetOrResult.digest : undefined);
  return supplied !== undefined && packetDigest(packet) === supplied;
}

function failureList(input: HandoffPacketInput): readonly string[] {
  if (input.knownFailures !== undefined) return [...input.knownFailures];
  const attempt = input.attempt;
  if (attempt === null || attempt === undefined || !["failed", "unknown", "stopped"].includes(attempt.status))
    return [];
  return [`${attempt.status}${attempt.error ? `: ${attempt.error.slice(0, 500)}` : ""}`];
}

function completedArtifacts(
  input: HandoffPacketInput,
): readonly { readonly artifactId: string; readonly digest: string }[] {
  if (input.completed !== undefined) return [...input.completed];
  const attempt = input.attempt;
  return attempt?.artifactId && attempt.artifactDigest
    ? [{ artifactId: attempt.artifactId, digest: attempt.artifactDigest }]
    : [];
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Small fallback for callers that have the causal rows but have not rendered the daemon block yet. */
function causalContextFromInput(input: HandoffPacketInput): string | null {
  if (
    input.project === undefined &&
    (input.upstream === undefined || input.upstream === null) &&
    (input.knowledge === undefined || input.knowledge.length === 0) &&
    (input.decisions === undefined || input.decisions.length === 0)
  )
    return null;
  const lines: string[] = ["<task-context>"],
    refs: string[] = [];
  if (input.project !== undefined) {
    lines.push(`<work ref="task/${xmlText(input.project.id)}">${xmlText(input.project.name)}</work>`);
    refs.push(`task/${input.project.id}`);
  }
  if (input.upstream !== undefined && input.upstream !== null) {
    lines.push(`<parent ref="task/${xmlText(input.upstream.id)}">${xmlText(input.upstream.title)}</parent>`);
    refs.push(`task/${input.upstream.id}`);
  }
  lines.push(`<task ref="task/${xmlText(input.work.id)}">${xmlText(input.work.title)}</task>`);
  refs.push(`task/${input.work.id}`);
  for (const decision of input.knowledge ?? input.decisions ?? []) {
    const id = "id" in decision ? decision.id : decision.knowledgeId;
    lines.push(`<decision ref="decision/${xmlText(id)}" version="${decision.version}"/>`);
    refs.push(`decision/${id}`);
    if ("statement" in decision && decision.statement)
      lines.push(`<chosen ref="decision/${xmlText(id)}">${xmlText(decision.statement)}</chosen>`);
    for (const source of "sources" in decision ? (decision.sources ?? []) : []) {
      const ref = `fact/${source.sourceId}@r${source.revision}`;
      lines.push(`<fact ref="${xmlText(ref)}">${xmlText(source.text ?? source.title ?? ref)}</fact>`);
      refs.push(ref);
    }
  }
  if (refs.length === 0) return null;
  lines.push(`<refs>${refs.join(" ")}</refs>`, "</task-context>");
  return lines.join("\n");
}

/** Build one digest-bound handoff from a single caller-provided causal-context cut. */
export function buildHandoffPacket(input: HandoffPacketInput): HandoffPacketResult {
  const packet: HandoffPacketV1 = {
    schemaVersion: 1,
    handoffId: input.handoffId,
    revision: input.revision,
    mode: input.mode,
    goal: {
      workItemId: input.work.id,
      title: input.work.title,
      description: input.work.description,
      specRevision: input.work.specRevision,
      specDigest: input.work.specDigest,
    },
    source: {
      attemptId: input.attempt?.id ?? null,
      status: input.attempt?.status ?? null,
      sessionId: input.attempt?.sessionId ?? null,
      employeeId: input.sourceEmployeeId ?? null,
      runtime: input.attempt?.runtime ?? null,
    },
    completed: completedArtifacts(input),
    decisions:
      input.decisions ??
      input.knowledge?.map((decision) => ({ knowledgeId: decision.id, version: decision.version })) ??
      [],
    openItems: input.openItems ?? [],
    knownFailures: failureList(input),
    sideEffects: input.sideEffects ?? "未声明",
    skills: input.skills ?? [],
    sourceScope: {
      sourceRefs: input.sourceRefs ?? [],
      readers: input.readers ?? null,
    },
    target: input.target,
    expiresAt: input.expiresAt,
    taskContext: input.taskContext ?? input.causalContext ?? causalContextFromInput(input),
  };
  return { packet, digest: packetDigest(packet), text: formatHandoffPacket(packet) };
}

/** Human-readable display view; the packet and digest remain the machine contract. */
export function formatHandoffPacket(packet: HandoffPacketV1): string {
  return [
    `【交接包 · ${packet.handoffId} r${packet.revision} · ${packet.mode}】`,
    `目标：${packet.goal.title}（任务 ${packet.goal.workItemId}，规格版本 ${packet.goal.specRevision}，sha256=${packet.goal.specDigest}）`,
    `原执行：${packet.source.attemptId ? `attempt ${packet.source.attemptId}（${packet.source.status ?? "unknown"}）` : "尚无执行"}`,
    `当前交付：${packet.completed.map((artifact) => `artifact ${artifact.artifactId} sha256=${artifact.digest}`).join("；") || "无"}`,
    `已确认决定：${packet.decisions.map((decision) => `${decision.knowledgeId} v${decision.version}`).join("；") || "无"}`,
    `未完事项：${packet.openItems.join("；") || "无"}`,
    `已知失败：${packet.knownFailures.join("；") || "无"}`,
    `外部副作用：${packet.sideEffects}`,
    `必要 Skill：${packet.skills.join("；") || "无"}`,
    `资料范围：${packet.sourceScope.sourceRefs.map((source) => `${source.sourceId}@r${source.revision}`).join("；") || "无"}`,
    `接手人：${packet.target.name}（${packet.target.employeeId}）`,
    `有效期至：${packet.expiresAt}`,
    ...(packet.taskContext ? ["", packet.taskContext] : []),
  ].join("\n");
}
