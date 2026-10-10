import type { DecisionProjectionRow, TaskIndexProjectionRow, TaskProjectionQueries } from "@harness-anything/kernel";
import { requireSameProjectionCut, type ProjectionCut } from "./task-query-read.ts";

/**
 * Dispatch-time causal context: the bounded slice of the causal graph a freshly
 * spawned worker needs before it can query anything itself — the goal of the
 * work it belongs to, the decision whose chosen anchor derives the task, and the
 * facts that evidence that decision's load-bearing claims.
 *
 * The block is a `<task-context>` XML fragment whose grammar the
 * task-explainer-html skill documents for consumers: every element is complete
 * on one line, so any subset of detail lines the byte budget sheds still parses.
 * Text and attribute values are XML-escaped; the canonical ids ride `ref`
 * attributes and the final `<refs>` line. Every field is read from the canonical
 * projection at one verified cut; the block is task data for the worker, never
 * an override of its role or safety instructions. An execution-surface section follows
 * the XML for active derives edges from in-effect chosen decisions; it is outside
 * the background byte budget so truncation cannot shed authorization conditions.
 * Fleet-edge dispatch fetches
 * the same block from the center's canonical read — a stale mirrored markdown
 * is never summarized as fact.
 *
 * Token budget: no tokenizer ships in this dependency set, so the block is
 * capped at 2,048 UTF-8 bytes — a provable hard bound the tests assert on real
 * dispatch captures; byte↔token ratios are deliberately not claimed. The size
 * is measured, not guessed: over the production ledger's 1,541 parented tasks
 * (2026-09-18) a full block is 351 B mean, 776 B p90, 1,709 B max, while the
 * old 500 B cap dropped at least one line in 16% of blocks — usually the
 * evidence Facts or the work Goal under CJK text. 2 KiB covers the
 * observed maximum with headroom. Canonical refs are never truncated away —
 * the fixed lookup guidance every task-bound mission carries (see
 * taskQueryGuidance) directs the worker to task-scoped reads and the owner for
 * any missing cross-task details; the block does not grant query permissions.
 */
export const CAUSAL_CONTEXT_MAX_BYTES = 2048;

const MAX_DECISIONS = 2,
  MAX_FACTS = 5,
  MAX_EVIDENCE_ANCHORS = 6,
  ROOT_OPEN = "<task-context>",
  ROOT_CLOSE = "</task-context>";

export function assembleTaskCausalContext(input: {
  readonly projection: TaskProjectionQueries;
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
    work = ancestors.find((row) => row.taskClass === "work") ?? ancestors.at(-1) ?? null,
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
  const decisionRead = decisionIds.length === 0 ? null : projection.readDecisions(decisionIds);
  if (decisionRead !== null) reads.push(decisionRead);
  const decisions = new Map((decisionRead?.decisions ?? []).map((row) => [row.decisionId, row] as const)),
    factRefs: string[] = [];
  for (const decisionId of decisionIds.slice(0, MAX_DECISIONS)) {
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
  // Archived Facts stay in the ledger but leave the agent-facing retrieval surface: neither
  // their statements nor their refs belong in the injected block.
  const servedFactRefs = factRefs.filter((ref) => facts.get(ref)?.archived !== true);
  let workGoal: string | null = null;
  if (work?.packagePath) {
    const plan = projection.readDocument(`${work.packagePath}/task_plan.md`);
    reads.push(plan);
    if (plan.document !== null && plan.watermark >= plan.sourceRevision) workGoal = planGoalSummary(plan.document.body);
  }
  requireSameProjectionCut("dispatch causal context", reads);
  if (work === null && parent === null && decisionIds.length === 0) return null;
  // Priority order: identity lines first, then each decision's header, chosen
  // anchor and load-bearing claims, then the evidence layer — a fat work
  // title can never starve the facts of all budget. Goal, question and any
  // second decision are detail tails the greedy fit may drop.
  const details: string[] = [],
    tails: string[] = [];
  // The refs line already carries every canonical id, so identity lines stay
  // title-only — repeating the id in an attribute would spend budget twice.
  if (work !== null) details.push(`<work ref="task/${work.taskId}">${xmlField(work.title, 48)}</work>`);
  if (parent !== null && parent.taskId !== work?.taskId)
    details.push(`<parent ref="task/${parent.taskId}">${xmlField(parent.title, 48)}</parent>`);
  const decisionBlocks: string[][] = [];
  for (const decisionId of decisionIds.slice(0, MAX_DECISIONS)) {
    const decision = decisions.get(decisionId);
    if (decision === undefined) continue;
    const block = [`<decision ref="decision/${decisionId}" title="${xmlField(decision.title, 48)}"/>`],
      anchorId = derivingAnchor.get(decisionId),
      chosen = decision.chosen.find((entry) => entry.id === anchorId) ?? decision.chosen[0],
      claims = decision.claims.filter((claim) => claim.loadBearing);
    if (chosen !== undefined) {
      const summary = chosen.rationale ? `${chosen.text} — ${chosen.rationale}` : chosen.text;
      block.push(`<chosen ref="decision/${decisionId}" anchor="${chosen.id}">${xmlField(summary, 96)}</chosen>`);
    }
    if (claims.length > 0)
      block.push(
        `<claims ref="decision/${decisionId}">${xmlField(claims.map((claim) => `${claim.id} ${claim.text}`).join("; "), 96)}</claims>`,
      );
    if (decision.question.trim())
      tails.push(`<question ref="decision/${decisionId}">${xmlField(decision.question, 64)}</question>`);
    decisionBlocks.push(block);
  }
  details.push(...(decisionBlocks[0] ?? []));
  const factLines = servedFactRefs.slice(0, MAX_FACTS).map((ref) => {
    const fact = facts.get(ref);
    return `<fact ref="${ref}">${
      fact === undefined
        ? "(statement not projected at this cut)"
        : `${xmlField(fact.statement, 64)} (src:${xmlField(fact.evidenceSource, 35)})`
    }</fact>`;
  });
  details.push(...factLines);
  if (workGoal !== null && work !== null)
    tails.unshift(`<goal ref="task/${work.taskId}">${xmlField(workGoal, 64)}</goal>`);
  details.push(...(decisionBlocks[1] ?? []), ...tails);
  const refs = [
    ...(work === null ? [] : [`task/${work.taskId}`]),
    ...(parent === null || parent.taskId === work?.taskId ? [] : [`task/${parent.taskId}`]),
    ...decisionIds.slice(0, MAX_DECISIONS).map((decisionId) => `decision/${decisionId}`),
    ...servedFactRefs,
  ];
  const authorization = decisionExecutionSurface(decisionRead?.decisions ?? [], derives.rows);
  return [renderWithinBudget(details, refs), ...(authorization === null ? [] : [authorization])].join("\n\n");
}

/** The center's current chosen decision grants only replacement of its superseded contract. */
function decisionExecutionSurface(
  decisions: readonly DecisionProjectionRow[],
  derives: ReturnType<TaskProjectionQueries["readTaskRelationsByTargets"]>["rows"],
): string | null {
  const sources: string[] = [];
  for (const decision of decisions) {
    if (decision.state !== "in_effect") continue;
    const chosen = decision.chosen.filter((entry) =>
      derives.some(
        (edge) =>
          edge.state === "active" &&
          edge.direction === "directed" &&
          edge.sourceRef === `decision/${decision.decisionId}/${entry.id}`,
      ),
    );
    if (chosen.length === 0) continue;
    sources.push(
      ...chosen.map(
        (entry) =>
          `来源 / Source: decision/${decision.decisionId}/${entry.id}; state=${decision.state}\n` +
          `标题 / Title: ${plainField(decision.title, 240)}\n` +
          `Chosen: ${plainField(entry.rationale ? `${entry.text} — ${entry.rationale}` : entry.text, 600)}`,
      ),
      `Claims: ${plainField(
        decision.claims
          .filter((claim) => claim.loadBearing)
          .map((claim) => `${claim.id} ${claim.text}`)
          .join("; "),
        600,
      )}`,
    );
  }
  if (sources.length === 0) return null;
  return [
    "# 本任务授权范围 / Decision-Derived Execution Surface",
    ...sources,
    "决策授权范围 / Authorized surface: 可把编码被上述决策取代的旧契约的门禁 / 测试断言更新为新契约；" +
      "仅限该决策覆盖的本任务执行面，摘要不是完整范围，具体边界以源决策为准。 " +
      "Update gates and test assertions encoding contracts replaced by these decisions, within this task's decision-covered surface.",
    "条件 / Conditions: 保留并补齐负例、引用决策 id、closeout 列出改动的门禁文件。 " +
      "Preserve and complete negative cases, cite the decision id, and list changed gate files in closeout.",
    "硬红线 / Hard prohibitions: CI workflow、阈值与预算、required checks、凭据与宿主服务、删除断言、allowlist 计数变化。 " +
      "CI workflows, thresholds and budgets, required checks, credentials and host services, assertion deletion, and allowlist count changes remain prohibited.",
    "范围内直接执行并报备；范围外或硬红线停手，列出精确请求。 " +
      "Proceed and report within scope; stop with an exact request outside scope or at a hard prohibition. " +
      "This section grants no additional daemon command or ledger permissions.",
  ].join("\n\n");
}

/**
 * Greedy fit in priority order under a reserved refs line: `<refs>` keeps every
 * layer's canonical id queryable even when the detail lines must drop. The
 * byte cap is a promise, not a hope — if the root plus refs alone exceed it
 * (only a pathological id set can do that), refs are shed from the tail and
 * the output is hard-clamped to the ceiling on a character boundary. A shed
 * detail marks the root `truncated="yes"` instead of breaking the grammar.
 */
function renderWithinBudget(details: readonly string[], refs: readonly string[]): string {
  const kept: string[] = [],
    mutable = [...refs];
  let refsLine = `<refs>${mutable.join(" ")}</refs>`;
  while (mutable.length > 0 && byteLength(`${ROOT_OPEN}\n${refsLine}\n${ROOT_CLOSE}`) > CAUSAL_CONTEXT_MAX_BYTES) {
    mutable.pop();
    refsLine = `<refs>${mutable.join(" ")} …</refs>`;
  }
  const usedBase = byteLength(ROOT_OPEN) + 1 + byteLength(refsLine) + 1 + byteLength(ROOT_CLOSE);
  let used = usedBase,
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
  const open = dropped ? `<task-context truncated="yes">` : ROOT_OPEN;
  const out = `${open}\n${[...kept, refsLine].join("\n")}\n${ROOT_CLOSE}`;
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

/** Collapse whitespace, XML-escape, and bound one free-text field so CJK prose cannot eat the block. */
function xmlField(text: string, maxBytes = 96): string {
  const compact = text.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();
  if (byteLength(escapeXml(compact)) <= maxBytes) return escapeXml(compact);
  let out = "",
    used = 0;
  for (const char of compact) {
    const size = byteLength(escapeXml(char));
    if (used + size > maxBytes - byteLength("…")) break;
    out += escapeXml(char);
    used += size;
  }
  return `${out}…`;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/gu, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * The one-paragraph goal/mission statement of a task plan, if the plan declares one. Returns plain
 * compacted text — the caller's render line is the single XML-escape point, so this must not pre-escape.
 */
export function planGoalSummary(body: string): string | null {
  // The create-work plan states its goal under Mission.
  for (const heading of ["Goal", "Brief", "Mission"]) {
    const section = new RegExp(`^## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$)`, "mu").exec(body)?.[1],
      text = section
        ?.split(/\r?\n/u)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
    if (text) return plainField(text, 120);
  }
  return null;
}

/** Collapse whitespace and bound one plain-text field; the render path escapes it exactly once. */
function plainField(text: string, maxBytes: number): string {
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

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
