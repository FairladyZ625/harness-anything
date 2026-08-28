type TransitionDocumentKind = "task.plan" | "task.closeout" | "decision.body" | "agent.instructions" | "squad.roster";
type TransitionDocumentPlaceholderCode =
  | "plan_placeholder"
  | "closeout_placeholder"
  | "body_placeholder"
  | "instructions_placeholder"
  | "roster_placeholder";

interface TransitionDocumentBinding {
  readonly transition: string;
  readonly documentKind: TransitionDocumentKind;
}

const transitionDocumentBindings: readonly TransitionDocumentBinding[] = Object.freeze([
  { transition: "task.start", documentKind: "task.plan" },
  { transition: "lease.claim", documentKind: "task.plan" },
  { transition: "runtime.run", documentKind: "task.plan" },
  { transition: "squad.run", documentKind: "task.plan" },
  { transition: "task.complete", documentKind: "task.closeout" },
  { transition: "decision.accept", documentKind: "decision.body" },
  { transition: "agent.install", documentKind: "agent.instructions" },
  { transition: "squad.install", documentKind: "squad.roster" },
]);

interface TransitionDocumentReadiness {
  readonly ready: boolean;
  readonly code: TransitionDocumentPlaceholderCode;
  readonly missingSections: readonly string[];
}

type MarkdownDocumentContract = {
  readonly requiredSections: readonly string[];
  readonly scaffoldBySection: Readonly<Record<string, readonly string[]>>;
};

const taskPlan: MarkdownDocumentContract = {
  requiredSections: [
    "Brief",
    "Goal",
    "Con\u0074ext",
    "Required Reading",
    "Entry Conditions",
    "Dependencies",
    "Execution Surface",
    "Constraints",
    "Checkpoint",
    "CI/Gate Authority Stop Condition",
    "Implementation Plan",
    "Deliverable Contract",
    "Evidence Protocol",
    "Verification",
  ],
  scaffoldBySection: {
    Brief: ["One-line statement of the task objective and scope.", "一句话说明任务目标与范围。"],
    Goal: [
      "Describe the verifiable result this task must produce, plus the deliverable's form and destination:",
      "说明本任务要完成的可验证结果，以及交付物的形态与落点：",
    ],
    ["Con\u0074ext"]: ["Record the input context and established facts.", "记录输入背景与已知事实。"],
    "Required Reading": [
      "List concrete code, document, and contract paths in reading order",
      "按读取顺序列出代码、文档与契约的具体路径",
    ],
    "Entry Conditions": [
      "List everything that must already be true before work starts.",
      "列出开工前必须已经成立的条件。",
    ],
    Dependencies: [
      "List upstream dependencies, handoff inputs, concurrent ownership, and downstream recipients",
      "列出上游依赖、交接输入、并发 ownership 与下游接收方",
    ],
    "Execution Surface": [
      "Declare the repository, worktree, branch, base, and allowed write scope.",
      "声明执行所在的仓库、worktree、分支与 base，以及允许写入的范围。",
    ],
    Constraints: [
      "List the assumptions that must not be made and the boundaries that must not be crossed",
      "列出不能假设的前提与不能越界的范围",
    ],
    Checkpoint: ["State when to stop and report or request a ruling:", "写明什么时候必须停下来上报或求裁决："],
    "CI/Gate Authority Stop Condition": [
      "If this task is not a CI/gate/governance task but requires modifying CI/gate authority surfaces to pass",
      "如果本任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过",
    ],
    "Implementation Plan": ["Inspect existing code, documents, and contracts.", "确认现有代码、文档和契约。"],
    "Deliverable Contract": [
      "State the deliverable shape, destination, recipient, first consumer",
      "写明交付物的形态、落点、接收者与第一个使用方",
    ],
    "Evidence Protocol": [
      "State the required evidence granularity, negative controls or mutation checks",
      "写明证据粒度、需要的阴性对照或变异检查",
    ],
    Verification: [
      "Stop point = targeted tests for the surface you touched, green, plus a local commit.",
      "停止点 = 本次改动面的定向测试全绿 + 本地 commit。",
    ],
  },
};

const taskCloseout: MarkdownDocumentContract = {
  requiredSections: ["Summary", "Verification", "Residual Risk", "Same Mechanism Elsewhere"],
  scaffoldBySection: {
    Summary: ["Summarize the completed behavior change.", "总结完成的行为变化。"],
    Verification: ["List passing applicable checks", "列出通过的适用检查"],
    "Residual Risk": ["Record accepted non-blocking risks", "记录已接受的非阻塞风险"],
    "Same Mechanism Elsewhere": [
      "State what this task found as one sentence about a **mechanism**",
      "把本任务的发现重写成一句关于**机制**的话",
    ],
  },
};

const placeholderCodes: Readonly<Record<TransitionDocumentKind, TransitionDocumentPlaceholderCode>> = {
  "task.plan": "plan_placeholder",
  "task.closeout": "closeout_placeholder",
  "decision.body": "body_placeholder",
  "agent.instructions": "instructions_placeholder",
  "squad.roster": "roster_placeholder",
};

const declarationScaffolds: Readonly<Record<"agent.instructions" | "squad.roster", readonly string[]>> = {
  "agent.instructions": [
    "(To be written: this text becomes the agent's system prompt verbatim.)",
    "（待补写:这段文字会原样成为该 Agent 的系统指令。）",
  ],
  "squad.roster": ["## Squad roster\n(to be written)", "## Squad Roster\n（待补写）"],
};

export function assessTransitionDocument(kind: TransitionDocumentKind, body: string): TransitionDocumentReadiness {
  const missingSections =
    kind === "task.plan"
      ? missingMarkdownSections(body, taskPlan)
      : kind === "task.closeout"
        ? missingMarkdownSections(body, taskCloseout)
        : kind === "decision.body"
          ? meaningfulMarkdown(body)
            ? []
            : ["body"]
          : declarationTextReady(kind, body)
            ? []
            : [kind === "agent.instructions" ? "instructions" : "roster"];
  return Object.freeze({
    ready: missingSections.length === 0,
    code: placeholderCodes[kind],
    missingSections: Object.freeze(missingSections),
  });
}

export function requireTransitionDocumentKind(transition: string): TransitionDocumentKind {
  const binding = transitionDocumentBindings.find((candidate) => candidate.transition === transition);
  if (!binding) throw new Error(`Transition ${transition} has no canonical document binding.`);
  return binding.documentKind;
}

export function assertTransitionDocumentReady(kind: TransitionDocumentKind, body: string): void {
  const assessment = assessTransitionDocument(kind, body);
  if (assessment.ready) return;
  const sections = assessment.missingSections.join(", "),
    error = new Error(
      `${assessment.code}: ${kind} has empty or scaffold-equivalent required content: ${sections}.`,
    ) as Error & { code: TransitionDocumentPlaceholderCode; missingSections: readonly string[] };
  error.code = assessment.code;
  error.missingSections = assessment.missingSections;
  throw error;
}

function missingMarkdownSections(body: string, contract: MarkdownDocumentContract): string[] {
  const sections = markdownSections(body);
  return contract.requiredSections.filter((heading) => {
    const content = sections.get(normalizeHeading(heading));
    if (!content?.trim()) return true;
    const normalized = normalizeText(content);
    return (contract.scaffoldBySection[heading] ?? []).some((scaffold) => normalized.includes(normalizeText(scaffold)));
  });
}

function markdownSections(body: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>(),
    headings = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index]!,
      start = (current.index ?? 0) + current[0].length,
      end = headings[index + 1]?.index ?? body.length;
    sections.set(normalizeHeading(current[1]!), body.slice(start, end).trim());
  }
  return sections;
}

function meaningfulMarkdown(body: string): boolean {
  const prose = stripFrontmatter(body)
    .replace(/^#{1,6}[ \t]+.*$/gmu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .trim();
  return prose.length > 0;
}

function declarationTextReady(kind: "agent.instructions" | "squad.roster", body: string): boolean {
  const normalized = normalizeText(body);
  return normalized.length > 0 && !declarationScaffolds[kind].some((value) => normalized === normalizeText(value));
}

function stripFrontmatter(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(body);
  return match ? body.slice(match[0].length) : body;
}

function normalizeHeading(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
