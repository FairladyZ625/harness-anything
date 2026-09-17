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
 * instructions. Fleet-edge dispatch fetches the same block from the center's
 * canonical read — a stale mirrored markdown is never summarized as fact.
 *
 * Token budget: no tokenizer ships in this dependency set, so the block is
 * capped at 500 UTF-8 bytes — a provable hard bound the tests assert on real
 * dispatch captures; byte↔token ratios are deliberately not claimed. Canonical
 * refs are never truncated away — a worker can always re-query
 * `ha graph <task-id>`.
 */
const CAUSAL_CONTEXT_MAX_BYTES = 500,
  MAX_DECISIONS = 2,
  MAX_FACTS = 5,
  MAX_EVIDENCE_ANCHORS = 6,
  HEADER = "# Task Causal Context";

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
  // Priority order: identity lines first, then each decision's header, chosen
  // anchor and load-bearing claims, then the evidence layer — a fat milestone
  // title can never starve the facts of all budget. Goal, question and any
  // second decision are detail tails the greedy fit may drop.
  const details: string[] = [],
    tails: string[] = [];
  // The refs line already carries every canonical id, so identity lines stay
  // title-only — repeating `(${id})` here would spend budget twice.
  if (milestone !== null) details.push(`- Milestone: ${field(milestone.title, 48)}`);
  if (parent !== null && parent.taskId !== milestone?.taskId) details.push(`- Parent: ${field(parent.title, 48)}`);
  const decisionBlocks: string[][] = [];
  for (const decisionId of decisionIds) {
    const decision = decisions.get(decisionId);
    if (decision === undefined) continue;
    const block = [`- Decision: ${decisionId} "${field(decision.title, 48)}"`],
      anchorId = derivingAnchor.get(decisionId),
      chosen = decision.chosen.find((entry) => entry.id === anchorId) ?? decision.chosen[0],
      claims = decision.claims.filter((claim) => claim.loadBearing);
    if (chosen !== undefined)
      block.push(
        `  * Chosen ${chosen.id}: ${field(chosen.text, 48)}` +
          (chosen.rationale ? ` — ${field(chosen.rationale, 48)}` : ""),
      );
    if (claims.length > 0)
      block.push("  * Claims: " + field(claims.map((claim) => `${claim.id} ${claim.text}`).join("; "), 96));
    if (decision.question.trim()) tails.push(`  * Question: ${field(decision.question, 64)}`);
    decisionBlocks.push(block);
  }
  details.push(...(decisionBlocks[0] ?? []));
  const factLines = factRefs.slice(0, MAX_FACTS).map((ref) => {
    const fact = facts.get(ref);
    return `  * ${ref.replace(/^fact\//u, "")}: ${
      fact === undefined
        ? "(statement not projected at this cut)"
        : `${field(fact.statement, 64)} (src:${field(fact.evidenceSource, 35)})`
    }`;
  });
  if (factLines.length > 0) details.push(`- Facts:\n${factLines[0]!}`, ...factLines.slice(1));
  if (milestoneGoal !== null) tails.unshift(`  * Goal: ${field(milestoneGoal, 64)}`);
  details.push(...(decisionBlocks[1] ?? []), ...tails);
  const refs = [
    ...(milestone === null ? [] : [`task/${milestone.taskId}`]),
    ...(parent === null || parent.taskId === milestone?.taskId ? [] : [`task/${parent.taskId}`]),
    ...decisionIds.map((decisionId) => `decision/${decisionId}`),
    ...factRefs,
  ];
  return renderWithinBudget(details, refs, taskId);
}

/**
 * Greedy fit in priority order under a reserved Refs line: the refs keep every
 * layer's canonical id queryable even when the detail lines must drop. The
 * byte cap is a promise, not a hope — if the header plus refs alone exceed it
 * (only a pathological id set can do that), refs are shed from the tail and
 * the output is hard-clamped to the ceiling on a character boundary.
 */
function renderWithinBudget(details: readonly string[], refs: readonly string[], taskId: string): string {
  const kept: string[] = [],
    mutable = [...refs];
  let refsLine = `Refs: ${mutable.join(" ")} · ha graph ${taskId}`;
  while (mutable.length > 0 && byteLength(`${HEADER}\n${refsLine}`) > CAUSAL_CONTEXT_MAX_BYTES) {
    mutable.pop();
    refsLine = `Refs: ${mutable.join(" ")} … · ha graph ${taskId}`;
  }
  let used = byteLength(HEADER) + 1 + byteLength(refsLine),
    dropped = false;
  for (const line of details) {
    const cost = byteLength(line) + 1;
    if (used + cost > CAUSAL_CONTEXT_MAX_BYTES) {
      dropped = true;
      continue;
    }
    kept.push(line);
    used += cost;
  }
  let out = `${HEADER}\n${[...kept, refsLine].join("\n")}`;
  if (dropped && byteLength(out) + 4 <= CAUSAL_CONTEXT_MAX_BYTES) out += " …";
  if (byteLength(out) > CAUSAL_CONTEXT_MAX_BYTES) {
    let clamped = "",
      size = 0;
    for (const char of out) {
      const next = byteLength(char);
      if (size + next > CAUSAL_CONTEXT_MAX_BYTES) break;
      clamped += char;
      size += next;
    }
    return clamped;
  }
  return out;
}

/** Collapse whitespace and bound one free-text field so CJK prose cannot eat the block. */
function field(text: string, maxBytes = 96): string {
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
    if (text) return field(text, 120);
  }
  return null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
