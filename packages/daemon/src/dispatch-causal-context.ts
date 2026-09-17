import type { TaskIndexProjectionRow, TaskProjection } from "../../kernel/src/index.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./task-query-read.ts";

/**
 * Dispatch-time causal context: the bounded slice of the causal graph a freshly
 * spawned worker needs before it can query anything itself — the parent
 * milestone goal, the decision whose chosen anchor derives the task, and the
 * facts that evidence that decision's load-bearing claims.
 *
 * Every field is read from the canonical projection at one verified cut; the
 * block is task data for the worker, never an override of its role or safety
 * instructions. Fleet-edge dispatch has no canonical projection and gets no
 * block rather than a summary of stale mirrored markdown.
 *
 * Token budget: no tokenizer ships in this dependency set, so the block is
 * capped by a conservative UTF-8 byte ceiling. CJK text encodes near one token
 * per character (≈3 bytes) and English near 4 bytes per token, so 1400 bytes
 * stays under ~500 tokens for either extreme. Canonical refs are never
 * truncated away — a worker can always re-query `ha graph task/<id>`.
 */
const CAUSAL_CONTEXT_MAX_BYTES = 1400,
  FIELD_MAX_BYTES = 200,
  MAX_DECISIONS = 2,
  MAX_FACTS = 5,
  MAX_EVIDENCE_ANCHORS = 6,
  HEADER = "# Task Causal Context & Architectural Rationale";

interface ContextLine {
  readonly text: string;
  /** Structural lines stay even when optional detail must be dropped for budget. */
  readonly required: boolean;
}

export function assembleTaskCausalContext(input: {
  readonly projection: TaskProjection;
  readonly taskId: string;
}): string | null {
  const { projection, taskId } = input,
    reads: ProjectionCut[] = [projection.readCut()],
    taskIndex = projection.readTaskIndex({}),
    byId = new Map(taskIndex.rows.map((row) => [row.taskId, row] as const)),
    self = byId.get(taskId),
    ancestors: TaskIndexProjectionRow[] = [],
    visited = new Set([taskId]);
  reads.push(taskIndex);
  // Parent chain terminates on the ledger's own parentTaskId field, a missing
  // row, or a cycle guard — each round strictly consumes one unseen ancestor.
  for (let parentId = self?.parentTaskId ?? null; parentId !== null && !visited.has(parentId); ) {
    visited.add(parentId);
    const row = byId.get(parentId);
    if (row === undefined) break;
    ancestors.push(row);
    parentId = row.parentTaskId;
  }
  const parent = ancestors[0] ?? null,
    milestone = ancestors.find((row) => row.taskClass === "milestone") ?? ancestors.at(-1) ?? null,
    derives = projection.readTaskRelationsByTargets([`task/${taskId}`], "derives");
  reads.push(derives);
  const derivingAnchor = new Map<string, string>(),
    decisionIds: string[] = [];
  for (const edge of derives.rows) {
    if (edge.state !== "active" || edge.direction !== "directed") continue;
    const anchor = /^decision\/([^/]+)\/([^/]+)$/u.exec(edge.sourceRef);
    if (anchor === null) continue;
    derivingAnchor.set(anchor[1]!, anchor[2]!);
    if (!decisionIds.includes(anchor[1]!)) decisionIds.push(anchor[1]!);
  }
  decisionIds.length = Math.min(decisionIds.length, MAX_DECISIONS);
  const decisionRead = decisionIds.length === 0 ? null : projection.readDecisions(decisionIds);
  if (decisionRead !== null) reads.push(decisionRead);
  const decisions = new Map((decisionRead?.decisions ?? []).map((row) => [row.decisionId, row] as const)),
    factRefs: string[] = [];
  for (const decisionId of decisionIds) {
    const decision = decisions.get(decisionId);
    if (decision === undefined) continue;
    const anchors = [
      ...decision.claims.filter((claim) => claim.loadBearing),
      ...decision.claims.filter((claim) => !claim.loadBearing),
    ].slice(0, MAX_EVIDENCE_ANCHORS);
    for (const claim of anchors) {
      if (factRefs.length >= MAX_FACTS) break;
      const read = projection.readRelationQuery({
        source: `decision/${decisionId}/${claim.id}`,
        relationType: "evidenced-by",
        state: "active",
        limit: MAX_FACTS,
      });
      reads.push(read);
      for (const edge of read.rows)
        if (edge.targetRef.startsWith("fact/") && !factRefs.includes(edge.targetRef)) factRefs.push(edge.targetRef);
    }
  }
  const factRead = factRefs.length === 0 ? null : projection.searchFacts({ refs: factRefs.slice(0, MAX_FACTS) });
  if (factRead !== null) reads.push(factRead);
  const facts = new Map((factRead?.facts ?? []).map((row) => [row.ref, row] as const));
  let milestoneGoal: string | null = null;
  if (milestone?.packagePath) {
    const plan = projection.readDocument(`${milestone.packagePath}/task_plan.md`);
    reads.push(plan);
    if (plan.document !== null && plan.watermark >= plan.sourceRevision)
      milestoneGoal = planGoalSummary(plan.document.body);
  }
  requireSameProjectionCut("dispatch causal context", reads);
  if (milestone === null && parent === null && decisionIds.length === 0) return null;
  const lines: ContextLine[] = [{ text: HEADER, required: true }];
  if (milestone !== null) {
    lines.push({ text: `- Milestone: ${field(milestone.title)} (${milestone.taskId})`, required: true });
    if (milestoneGoal !== null) lines.push({ text: `  * Goal: ${milestoneGoal}`, required: false });
  }
  if (parent !== null && parent.taskId !== milestone?.taskId)
    lines.push({ text: `- Parent task: ${field(parent.title)} (${parent.taskId})`, required: true });
  for (const decisionId of decisionIds) {
    const decision = decisions.get(decisionId);
    if (decision === undefined) continue;
    lines.push({
      text: `- Derived from Decision: ${decisionId} "${field(decision.title, 120)}"`,
      required: true,
    });
    const anchorId = derivingAnchor.get(decisionId),
      chosen = decision.chosen.find((entry) => entry.id === anchorId) ?? decision.chosen[0];
    if (chosen !== undefined)
      lines.push({
        text:
          `  * Chosen ${chosen.id}: ${field(chosen.text)}` +
          (chosen.rationale ? ` — Rationale: ${field(chosen.rationale)}` : ""),
        required: true,
      });
    if (decision.question.trim()) lines.push({ text: `  * Question: ${field(decision.question)}`, required: false });
    const claims = decision.claims.filter((claim) => claim.loadBearing);
    if (claims.length > 0)
      lines.push({
        text: "  * Load-bearing Claims: " + claims.map((claim) => `${claim.id} ${field(claim.text, 120)}`).join("; "),
        required: false,
      });
  }
  if (factRefs.length > 0) {
    lines.push({ text: "- Evidenced by Facts:", required: false });
    for (const ref of factRefs.slice(0, MAX_FACTS)) {
      const fact = facts.get(ref);
      lines.push({
        text:
          `  * ${ref.replace(/^fact\//u, "")}: ` +
          (fact === undefined
            ? "(statement not projected at this cut)"
            : `${field(fact.statement)} (source: ${field(fact.evidenceSource, 120)})`),
        required: false,
      });
    }
  }
  return renderWithinBudget(lines, taskId);
}

/**
 * Greedy fit in render order: required structure always lands; optional detail
 * joins only while the byte ceiling plus room for the truncation note holds.
 * Required lines alone can still overflow (two fully populated decisions), so
 * the final check hard-truncates at the ceiling — the cap is a promise, not a
 * hope.
 */
function renderWithinBudget(lines: readonly ContextLine[], taskId: string): string {
  const note = `  … truncated for budget; run \`ha graph ${taskId}\` for the full causal tree.`,
    noteCost = byteLength(note) + 1,
    kept: string[] = [];
  let dropped = false;
  for (const line of lines) {
    if (line.required) {
      kept.push(line.text);
      continue;
    }
    if (byteLength(kept.concat(line.text).join("\n")) + noteCost > CAUSAL_CONTEXT_MAX_BYTES) {
      dropped = true;
      continue;
    }
    kept.push(line.text);
  }
  const fitted = kept.join("\n");
  if (byteLength(fitted) > CAUSAL_CONTEXT_MAX_BYTES) {
    const room = CAUSAL_CONTEXT_MAX_BYTES - byteLength(`\n${note}`);
    let out = "",
      used = 0;
    for (const char of fitted) {
      const size = byteLength(char);
      if (used + size > room) break;
      out += char;
      used += size;
    }
    return `${out}\n${note}`;
  }
  return dropped ? `${fitted}\n${note}` : fitted;
}

/** Collapse whitespace and bound one free-text field so CJK prose cannot eat the block. */
function field(text: string, maxBytes = FIELD_MAX_BYTES): string {
  const compact = text.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();
  if (byteLength(compact) <= maxBytes) return compact;
  let out = "",
    used = 0;
  for (const char of compact) {
    const size = byteLength(char);
    if (used + size > maxBytes - byteLength("…")) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

/** The one-paragraph goal/mission statement of a task plan, if the plan declares one. */
function planGoalSummary(body: string): string | null {
  for (const heading of ["Goal", "Brief"]) {
    const section = new RegExp(`^## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$)`, "mu").exec(body)?.[1],
      text = section
        ?.split(/\r?\n/u)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
    if (text) return field(text, 280);
  }
  return null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
