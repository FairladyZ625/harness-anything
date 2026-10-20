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
 * A fixed `<note>` line opens the block whenever facts are served: it is
 * guidance, not sheddable detail, so it never falls to the budget.
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
 * Byte budget: no tokenizer ships in this dependency set, so the block is capped
 * in UTF-8 bytes — a provable hard bound the tests assert on real dispatch
 * captures; byte↔token ratios are deliberately not claimed. Fields render at
 * full length (a truncated clause is worse than an absent one), so the bound
 * falls on whole entries: a greedy fit in relation-distance order (identity,
 * first deriving decision, its evidence facts, remaining decisions, tails) sheds
 * entries from the far end and names every dropped ref in a closing `<omitted>`
 * line, and the root is marked `truncated="yes"`. The size is measured, not
 * guessed: over the production ledger's 3,053 causal-neighborhood blocks
 * (2026-10-19) the full-length render is 850 B mean, 2,299 B p90, 5,441 B p99,
 * 17,229 B max — 8 KiB keeps 3,051 of them intact and bounds the two outliers
 * with an omission note. Canonical refs are never truncated away — the fixed
 * lookup guidance every task-bound mission carries (see taskQueryGuidance)
 * directs the worker to task-scoped reads and the owner for any missing
 * cross-task details; the block does not grant query permissions.
 */
export const CAUSAL_CONTEXT_MAX_BYTES = 8192;

const MAX_DECISIONS = 2,
  MAX_FACTS = 5,
  MAX_EVIDENCE_ANCHORS = 6,
  ROOT_OPEN = "<task-context>",
  TRUNCATED_OPEN = '<task-context truncated="yes">',
  ROOT_CLOSE = "</task-context>",
  /** dec_BB2BCE9F995CD3A126E2918734 CH4: facts arrive named with the commit and time they
   * were recorded against, so the reader is told up front they are historical observations. */
  FACTS_NOTE = "<note>fact 是历史观察，涉及代码时以现场为准。</note>";

/** One detail line and the entity whose content it renders, so budget shedding can name what it dropped. */
interface DetailLine {
  readonly line: string;
  readonly ref: string;
}

/** The fit for one candidate open tag: kept detail lines, the omission note, and whether anything was shed. */
interface BudgetFit {
  readonly kept: readonly string[];
  readonly omittedLine: string | null;
  readonly dropped: boolean;
}

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
  // Priority order is relation distance from the dispatched task: identity lines first,
  // then the first deriving decision's header, chosen anchor and load-bearing claims,
  // then the evidence layer — a fat work title can never starve the facts of all
  // budget. The remaining decisions, the work goal and the framing question are detail
  // tails the greedy fit sheds first.
  const details: DetailLine[] = [],
    tails: DetailLine[] = [];
  // The refs line already carries every canonical id, so identity lines stay
  // title-only — repeating the id in an attribute would spend budget twice.
  if (work !== null)
    details.push(detail(`task/${work.taskId}`, `<work ref="task/${work.taskId}">${xmlText(work.title)}</work>`));
  if (parent !== null && parent.taskId !== work?.taskId)
    details.push(
      detail(`task/${parent.taskId}`, `<parent ref="task/${parent.taskId}">${xmlText(parent.title)}</parent>`),
    );
  const decisionBlocks: DetailLine[][] = [];
  for (const decisionId of decisionIds.slice(0, MAX_DECISIONS)) {
    const decision = decisions.get(decisionId);
    if (decision === undefined) continue;
    const block = [
        detail(`decision/${decisionId}`, `<decision ref="decision/${decisionId}" title="${xmlText(decision.title)}"/>`),
      ],
      anchorId = derivingAnchor.get(decisionId),
      chosen = decision.chosen.find((entry) => entry.id === anchorId) ?? decision.chosen[0],
      claims = decision.claims.filter((claim) => claim.loadBearing);
    if (chosen !== undefined) {
      const summary = chosen.rationale ? `${chosen.text} — ${chosen.rationale}` : chosen.text;
      block.push(
        detail(
          `decision/${decisionId}`,
          `<chosen ref="decision/${decisionId}" anchor="${chosen.id}">${xmlText(summary)}</chosen>`,
        ),
      );
    }
    if (claims.length > 0)
      block.push(
        detail(
          `decision/${decisionId}`,
          `<claims ref="decision/${decisionId}">${xmlText(claims.map((claim) => `${claim.id} ${claim.text}`).join("; "))}</claims>`,
        ),
      );
    if (decision.question.trim())
      tails.push(
        detail(
          `decision/${decisionId}`,
          `<question ref="decision/${decisionId}">${xmlText(decision.question)}</question>`,
        ),
      );
    decisionBlocks.push(block);
  }
  details.push(...(decisionBlocks[0] ?? []));
  const factLines = servedFactRefs.slice(0, MAX_FACTS).map((ref) => {
    const fact = facts.get(ref);
    return detail(
      ref,
      `<fact ref="${ref}">${
        fact === undefined
          ? "(statement not projected at this cut)"
          : `${xmlText(fact.statement)} (src:${xmlText(fact.evidenceSource)}${
              fact.observedCommit === undefined
                ? ""
                : `; recorded ${fact.occurredAt} @ ${fact.observedCommit.slice(0, 8)}`
            })`
      }</fact>`,
    );
  });
  details.push(...factLines);
  if (workGoal !== null && work !== null)
    tails.unshift(detail(`task/${work.taskId}`, `<goal ref="task/${work.taskId}">${xmlText(workGoal)}</goal>`));
  details.push(...(decisionBlocks[1] ?? []), ...tails);
  const refs = [
    ...(work === null ? [] : [`task/${work.taskId}`]),
    ...(parent === null || parent.taskId === work?.taskId ? [] : [`task/${parent.taskId}`]),
    ...decisionIds.slice(0, MAX_DECISIONS).map((decisionId) => `decision/${decisionId}`),
    ...servedFactRefs,
  ];
  const authorization = decisionExecutionSurface(decisionRead?.decisions ?? [], derives.rows),
    factsNote = servedFactRefs.length > 0 ? FACTS_NOTE : null;
  return [renderWithinBudget(details, refs, factsNote), ...(authorization === null ? [] : [authorization])].join(
    "\n\n",
  );
}

/** Current deriving decisions supply authority; gate-file changes are declared for merge review. */
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
    "决策条款写到的面按条款做；条款没写到的门禁文件改动照做，在 closeout 和 PR 治理声明里逐个列出，" +
      "引用决策 id、保留并补齐负例；没有决策依据的写明‘需要业主授权’。" +
      "凭据、宿主服务、对外发布这类收不回的动作，未经明确授权就停手并报告精确请求。" +
      " This section grants no additional daemon command or ledger permissions.",
  ].join("\n\n");
}

/**
 * Greedy fit in priority (relation-distance) order under a reserved refs line: `<refs>`
 * keeps every layer's canonical id queryable even when the detail entries must drop,
 * and a closing `<omitted>` line names the refs whose content was shed — in drop
 * order, deduplicated, and itself shrunk from the tail when pathological ids leave
 * no room to name them (an unnameable omission still marks the root truncated).
 * The byte cap is a promise, not a hope — if the root plus refs alone exceed it
 * (only a pathological id set can do that), refs are shed from the tail under the
 * widest root, so the refs line and every emitted line fit without a final clamp.
 */
function renderWithinBudget(details: readonly DetailLine[], refs: readonly string[], factsNote: string | null): string {
  const note = factsNote === null ? 0 : byteLength(factsNote) + 1;
  const mutable = [...refs];
  let refsLine = `<refs>${mutable.join(" ")}</refs>`;
  // Reserve the widest root the render can emit: shedding a detail — and so marking the
  // root truncated — is only known after the fit, so the refs line must fit under
  // `<task-context truncated="yes">` even when the final render keeps the short root.
  while (
    mutable.length > 0 &&
    byteLength(`${TRUNCATED_OPEN}\n${refsLine}\n${ROOT_CLOSE}`) + note > CAUSAL_CONTEXT_MAX_BYTES
  ) {
    mutable.pop();
    refsLine = `<refs>${mutable.join(" ")} …</refs>`;
  }
  // Measure against the root actually emitted. Any shed detail switches the root to the
  // 16-byte-longer truncated form; fitting the whole root while emitting the truncated one
  // would overshoot the cap and cut `</task-context>` off a details-only shed. A whole-root
  // fit that sheds nothing is emitted as measured.
  const whole = fitWithinBudget(details, refsLine, ROOT_OPEN, factsNote);
  if (!whole.dropped) return renderBlock(ROOT_OPEN, refsLine, whole.kept, whole.omittedLine, factsNote);
  const truncated = fitWithinBudget(details, refsLine, TRUNCATED_OPEN, factsNote);
  return renderBlock(TRUNCATED_OPEN, refsLine, truncated.kept, truncated.omittedLine, factsNote);
}

/** Greedy detail fit against one concrete open tag, including whether the omission note still fits. */
function fitWithinBudget(
  details: readonly DetailLine[],
  refsLine: string,
  open: string,
  factsNote: string | null,
): BudgetFit {
  let used =
    byteLength(open) +
    1 +
    (factsNote === null ? 0 : byteLength(factsNote) + 1) +
    byteLength(refsLine) +
    1 +
    byteLength(ROOT_CLOSE);
  const kept: string[] = [],
    omitted: string[] = [];
  let dropped = false;
  for (const entry of details) {
    const cost = byteLength(entry.line) + 1;
    if (used + cost > CAUSAL_CONTEXT_MAX_BYTES) {
      dropped = true;
      if (!omitted.includes(entry.ref)) omitted.push(entry.ref);
      continue;
    }
    kept.push(entry.line);
    used += cost;
  }
  const noteParts = [...omitted];
  let omittedLine: string | null = null;
  while (noteParts.length > 0) {
    const candidate = `<omitted>${noteParts.join(" ")}</omitted>`;
    if (used + byteLength(candidate) + 1 <= CAUSAL_CONTEXT_MAX_BYTES) {
      omittedLine = candidate;
      break;
    }
    noteParts.pop();
  }
  return { kept, omittedLine, dropped };
}

function renderBlock(
  open: string,
  refsLine: string,
  kept: readonly string[],
  omittedLine: string | null,
  factsNote: string | null,
): string {
  const tail = omittedLine === null ? [refsLine] : [refsLine, omittedLine],
    head = factsNote === null ? [] : [factsNote];
  return `${open}\n${[...head, ...kept, ...tail].join("\n")}\n${ROOT_CLOSE}`;
}

function detail(ref: string, line: string): DetailLine {
  return { ref, line };
}

/** Collapse whitespace and XML-escape one free-text field; length is bounded by the block budget, not per field. */
function xmlText(text: string): string {
  return escapeXml(text.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim());
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
    if (text) return text.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();
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
