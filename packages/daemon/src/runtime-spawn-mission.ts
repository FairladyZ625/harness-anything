import path from "node:path";
import type { AgentRole, TaskProjection } from "@harness-anything/kernel";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { agentRolePrompt } from "./agent-role-prompts.ts";
import { agentRuntimeTargetSummary, agentRuntimeKindMatches } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { type ResolvedAgentSkill } from "./agent-skills.ts";
import { resolveContainedPath } from "./contained-path.ts";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeDaemonRoute, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import { assertTaskTransitionDocumentReady, locateTaskTransitionDocument } from "./transition-document-access.ts";
import { workerLedgerPath } from "./worktree-setup.ts";

export function resolveRuntimeCwd(root: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw runtimeSpawnError("invalid_runtime_cwd", "cwd requires a closed scope object.");
  const cwd = value as Record<string, unknown>,
    allowed = cwd.scope === "repo-root" ? ["scope"] : ["scope", "path"];
  if (
    Object.keys(cwd).some((key) => !allowed.includes(key)) ||
    !["repo-root", "repo-relative"].includes(String(cwd.scope))
  )
    throw runtimeSpawnError("invalid_runtime_cwd", "Runtime cwd scope is invalid.");
  const requestedPath = cwd.scope === "repo-root" ? "." : requiredRuntimeSpawnText(cwd.path, "cwd.path"),
    resolved = resolveContainedPath(root, requestedPath);
  if (resolved === null) throw runtimeSpawnError("invalid_runtime_cwd", "Runtime cwd must stay inside the repository.");
  return resolved;
}

export function decisionReviewTarget(value: unknown): {
  readonly kind: "decision";
  readonly decisionId: string;
  readonly digest: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind !== "decision") return null;
  return {
    kind: "decision",
    decisionId: requiredRuntimeSpawnText(target.decisionId, "reviewTarget.decisionId"),
    digest: requiredRuntimeSpawnText(target.digest, "reviewTarget.digest"),
  };
}

export function assembleAgentPrompt(
  agent: RuntimeAgent,
  mission: string,
  preset?: string,
  skills: readonly ResolvedAgentSkill[] = [],
): string {
  return [
    `# Agent Identity: ${agent.name} (${agent.id})`,
    agent.instructions.trim(),
    agentRolePrompt(agent.role),
    ...(agent.prompts ?? []).map((prompt) => prompt.trim()).filter(Boolean),
    ...(preset?.trim() ? [preset.trim()] : []),
    ...(skills.length
      ? [
          "# Required Skills",
          "Read and follow every selected skill before doing the mission:",
          ...skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`),
        ]
      : []),
    "# Mission",
    mission,
  ].join("\n\n");
}

/**
 * Without an agent declaration, task dispatches default to worker discipline; review dispatches
 * explicitly select reviewer discipline. Direct prompts with neither task nor role pass through verbatim.
 */
export function assembleUnboundPrompt(mission: string, role?: AgentRole): string {
  return [agentRolePrompt(role), "# Mission", mission].join("\n\n");
}

export function dispatchMissionForPermission(mission: string, permissionMode: string | undefined): string {
  if (permissionMode !== "read-only") return mission;
  return [
    mission,
    "",
    "# Read-only Dispatch Contract",
    "",
    "Repository writes and daemon-ledger commands are unavailable in this runtime.",
    "Do not call `ha task progress append`, `ha fact record`, or `ha doc sync --submit`;",
    "return the complete report in final stdout for the dispatcher to persist.",
  ].join("\n");
}

export function resolveRuntimeInstanceCandidates(input: {
  readonly requested?: string;
  readonly providerSessionId?: string;
  readonly agent: RuntimeAgent | null;
  readonly model?: string;
  /** The concrete kind selected for an unbound runtime dispatch. */
  readonly runtimeKind?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly sessions: readonly RuntimeSessionSelection[];
}): string[] {
  if (input.providerSessionId) {
    const session = input.sessions.find((row) => row.providerSessionId === input.providerSessionId);
    if (session) return [session.instanceId];
  }
  if (input.requested) return [input.requested];
  // input.model is the dispatch-level override (--model); the per-kind declared model lives
  // on the matching runtimes row and applies only when no override was given.
  const declaredModel = input.model,
    declaredType = input.runtimeKind,
    declaredTargets = input.agent?.runtimes;
  const typed = input.instances.filter(
    (instance) =>
      instance.enabled &&
      (declaredType === undefined || declaredType === instance.kindId) &&
      (declaredTargets === undefined || agentRuntimeKindMatches(declaredTargets, instance.kindId)),
  );
  const declared = declaredModel
    ? typed.filter((instance) => instance.models.includes(declaredModel))
    : typed.filter((instance) => {
        const target = declaredTargets?.find((row) => row.type === instance.kindId);
        return target?.model === undefined || instance.models.includes(target.model);
      });
  const targetSummary =
    declaredTargets === undefined ? (declaredType ?? "any") : agentRuntimeTargetSummary(declaredTargets);
  if (declared.length === 0) {
    const typeCandidates = typed.length > 0;
    if (input.agent && !typeCandidates)
      throw runtimeSpawnError(
        "agent_runtime_unavailable",
        `Agent ${input.agent.id} requires ${targetSummary}, ` +
          "but no enabled instance of those runtime kinds is available on this node.",
      );
    // A model constraint excluded every typed instance: name it whether it came from the
    // --model override or from the runtimes row binding each kind's model.
    const modelConstraint =
      declaredModel ??
      declaredTargets
        ?.filter((row) => row.model !== undefined && typed.some((instance) => instance.kindId === row.type))
        .map((row) => row.model)
        .join(", ");
    throw runtimeSpawnError(
      typeCandidates ? "agent_model_unavailable" : "agent_runtime_unavailable",
      typeCandidates
        ? [
            "No enabled runtime instance declares model ",
            `${modelConstraint}`,
            "; add it to an instance or remove the Agent model declaration.",
          ].join("")
        : declaredModel
          ? [
              "No enabled runtime instance declares model ",
              `${declaredModel}`,
              "; no instance is compatible with runtime type ",
              targetSummary,
              ".",
            ].join("")
          : `No enabled runtime instance is compatible with runtime type ${targetSummary}.`,
    );
  }
  const ready = declared.filter(
    (instance) =>
      instance.authReadiness.status === "ready" || instance.authReadiness.code === "runtime_auth_not_checked",
  );
  if (ready.length === 0)
    throw runtimeSpawnError(
      "runtime_model_not_ready",
      declaredModel
        ? `Runtime instances declare model ${declaredModel}, but none are authentication-ready.`
        : `Compatible runtime instances exist for ${targetSummary}, but none are authentication-ready.`,
    );
  const active = new Map<string, number>(ready.map((instance) => [instance.instanceId, 0]));
  for (const session of input.sessions)
    if (session.liveness === "live" && active.has(session.instanceId))
      active.set(session.instanceId, (active.get(session.instanceId) ?? 0) + 1);
  const providerPriority = input.agent?.fallback?.providerPriority,
    providerRank = new Map(providerPriority?.map((provider, index) => [provider, index])),
    runtimeRank = new Map(declaredTargets?.map((target, index) => [target.type, index]));
  return [...ready]
    .sort(
      (a, b) =>
        (providerPriority === undefined
          ? (runtimeRank.get(a.kindId) ?? runtimeRank.size) - (runtimeRank.get(b.kindId) ?? runtimeRank.size)
          : (providerRank.get(a.providerId) ?? providerPriority.length) -
            (providerRank.get(b.providerId) ?? providerPriority.length)) ||
        (active.get(a.instanceId) ?? 0) - (active.get(b.instanceId) ?? 0) ||
        a.instanceId.localeCompare(b.instanceId),
    )
    .map((instance) => instance.instanceId);
}

export async function resolveRuntimeInstanceId(input: {
  readonly requested?: string;
  readonly providerSessionId?: string;
  readonly agent: RuntimeAgent | null;
  readonly model?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly sessions: readonly RuntimeSessionSelection[];
}): Promise<string> {
  const [selected] = resolveRuntimeInstanceCandidates(input);
  if (!selected)
    throw runtimeSpawnError("agent_runtime_unavailable", "No enabled runtime instance is available for this dispatch.");
  return selected;
}

/** Task-bound dispatches use injected context and reads admitted by their execution credential. */
export function taskQueryGuidance(taskId: string): string {
  return [
    "# 台账查询引导",
    "- 动手前先读任务包 task_plan.md 与已注入的 <task-context> 因果上下文；其中 work、parent、decision、fact 和 refs " +
      "提供本任务的关系背景，不要求先查询全仓图。",
    `- 本任务阅读集合用 ha task read-set ${taskId} 查；按任务契约、read-set 和注入上下文点名的路径读取资料。`,
    `- 需要核对本任务状态时用 ha task show ${taskId}；其他命令仅按本次 dispatch 已授权范围调用。`,
    "- 受限执行凭据绑定本 task/execution，不授予 graph、Work 全貌、跨任务查询或创建任务的权限；" +
      "不得清除凭据、切换身份或申请扩大权限来执行这些查询。",
    "- 未注入因果块不表示查询故障，也不要求补查图。资料不足或需要跨任务背景时，向 owner 报告具体缺项，" +
      "由 owner 按已授权范围提供；不要猜测。",
  ].join("\n");
}

/**
 * The standing Living Deliverable contract a non-lightweight task-bound dispatch carries: the task's
 * explainer page is the owner's live window into a running task — they do not read the worker
 * session and the task plan is a static cut from kickoff. The worker writes a first version right
 * after reading in, rewrites `#now` and appends to `#timeline` on every material change, and
 * freezes the page at closeout. Fixed text the daemon injects on every qualifying task mission
 * (derived, explicit-prompt, and fleet-edge alike); the task-explainer-html template carries the
 * authoring instructions. Lightweight-profile tasks owe no explainer page — their creation
 * materializes none, so their missions carry no protocol (dec_64C2E7741F1827DADC27941FCA CH2).
 * Non-task dispatches never see it.
 */
export function livingDeliverableProtocol(profileId: string | null | undefined): string | null {
  if (profileId === "lightweight") return null;
  return [
    "# Living Deliverable Protocol",
    "- `artifacts/explainer.html` 是业主在任务进行中看的实时说明页：业主不读你的 session，task_plan 只是开工时的计划，" +
      "这页是业主了解进展的唯一窗口。",
    "- 开工读完材料后先写第一版；之后每有实质进展、发现、方向变化或红转绿，就更新 `#now` 并在 `#timeline` 追加一条。" +
      "不要攒到收尾一次写。",
    "- 多用图说明（结构、流程、时序、前后对比、数据），写法见该文件顶部注释；章节除 `#now`/`#timeline` 外自由组织。",
    "- closeout 时冻结：结论与 closeout.md 一致，之后不再改动。",
  ].join("\n");
}

/** PR delivery is owed by the declared document slot, independently of the task profile. */
export function prBodyDeliveryProtocol(documentPath: string | null): string | null {
  if (documentPath === null) return null;
  return [
    "# PR Body Delivery Protocol",
    `- 本任务持有 task.pr-body 文档槽：\`${documentPath}\`（任务包内路径）。`,
    "- 在 closeout 与 ha task submit 之前，按 .github/pull_request_template.md 完整填写该正文；" +
      "保留全部模板标题与 English / 中文 两块，填写真实交付事实，包括 Architectural Justification / 架构辩护。",
    "- 涉及写入路径时，在同一隔离环境分别对 base 与 head 运行 node tools/gates/cost-budget.mjs，" +
      "将实测 200/2000 的 G1 全操作、五指标前后计数填入 Per-Write Cost 表；不得用预算值或猜测值代替。",
    "- Production-Delta 用 node tools/gates/production-delta.mjs --base origin/main 实算；" +
      "机读声明只写真实适用项。未运行的验证、CI 与现场验收明确标为 unverified。",
    `- 运行 node tools/check-pr-body-bilingual.mjs --file <任务包根>/${documentPath}，` +
      "并逐项比对模板标题，确认没有遗漏、占位内容或未填写骨架。",
    "- 随 ha doc sync --submit --task 同步正文，在 closeout Summary 写正文 Artifact-Anchor: " +
      `artifact:${documentPath}（需要固定 revision 时使用该正文被接受的 revision）。再同步 closeout 并执行 ha task submit。`,
    "- submit 回执中的 prBody 指向已冻结正文；CEO 开 PR 直接使用该正文。worker 不 push、不开 PR。",
  ].join("\n");
}

export function taskPrBodyPath(projection: TaskProjection, taskId: string): string | null {
  const document = locateTaskTransitionDocument({ projection, taskId, slot: "task.pr-body" });
  return document.path === null ? null : path.posix.relative(document.packagePath, document.path);
}

/** An explicit prompt on a task-bound dispatch still owes the worker the same lookup guidance and living-deliverable contract as a derived mission. */
export function explicitPromptMission(
  taskId: string | null,
  causalContext: string | null,
  prompt: string,
  profileId: string | null | undefined = undefined,
  prBodyPath: string | null = null,
): string {
  const protocol = taskId === null ? null : livingDeliverableProtocol(profileId),
    prProtocol = taskId === null ? null : prBodyDeliveryProtocol(prBodyPath);
  return [
    ...(taskId === null ? [] : [taskQueryGuidance(taskId), ...(protocol === null ? [] : [protocol])]),
    ...(prProtocol === null ? [] : [prProtocol]),
    ...(causalContext === null ? [] : [causalContext]),
    prompt,
  ].join("\n\n");
}

/** The package root is named as the worker reaches it from `cwd`, the root it runs in. */
export function deriveTaskMission(
  rootDir: string,
  cwd: string,
  projection: TaskProjection,
  taskId: string,
  transition: "runtime.run" | "squad.run",
  missionName?: string,
  causalContext?: string | null,
): {
  readonly mission: string;
  readonly packageRoot: string;
} {
  const planDocument = assertTaskTransitionDocumentReady({
      rootDir,
      projection,
      taskId,
      slot: "task.plan",
      transition,
    }),
    packageRoot = workerLedgerPath(
      rootDir,
      cwd,
      path.resolve(resolveHarnessLayout(rootDir).authoredRoot, ...planDocument.packagePath.split("/")),
    ),
    planPath = path.join(packageRoot, ...path.posix.relative(planDocument.packagePath, planDocument.path).split("/")),
    missionDocument = missionName
      ? readMissionDocument(projection, planDocument.packagePath, taskId, missionName)
      : null,
    causalContextResolved =
      causalContext === undefined ? assembleTaskCausalContext({ projection, taskId }) : causalContext,
    snapshot = projection.read(taskId).snapshot,
    livingProtocol = livingDeliverableProtocol(snapshot.task?.metadata?.profileId),
    prProtocol = prBodyDeliveryProtocol(taskPrBodyPath(projection, taskId)),
    priorIteration = snapshot.task && snapshot.task.iteration > 0 ? snapshot.task.iteration - 1 : null,
    returnDocument =
      priorIteration === null
        ? null
        : projection.readDocument(`${planDocument.packagePath}/returns/iteration-${String(priorIteration)}.md`)
            .document,
    mission = [
      `Your task package is ${packageRoot}.\nRead ${path.basename(planPath)} in that package and complete the task.`,
      ...(returnDocument ? [`# Owner rework instruction\n\n${returnDocument.body.trim()}`] : []),
      taskQueryGuidance(taskId),
      ...(livingProtocol === null ? [] : [livingProtocol]),
      ...(prProtocol === null ? [] : [prProtocol]),
      ...(causalContextResolved === null ? [] : [causalContextResolved]),
      ...(missionDocument ? [`# Mission: ${missionName}\n\n${missionDocument.trim()}`] : []),
    ].join("\n\n");
  return {
    packageRoot,
    mission,
  };
}

/**
 * A dispatched task's mission and package root as the worker reaches them from `cwd`: an edge's come from its
 * mirrored package, a node that holds the ledger derives them from its projection.
 */
export function missionAt(
  rootDir: string,
  cwd: string,
  source:
    | { readonly packageRoot: string; readonly mission: (packageRoot: string) => string }
    | {
        readonly projection: TaskProjection;
        readonly taskId: string;
        readonly missionName: string | undefined;
        readonly causalContext: string | null;
      },
): { readonly mission: string; readonly packageRoot: string } {
  if ("projection" in source)
    return deriveTaskMission(
      rootDir,
      cwd,
      source.projection,
      source.taskId,
      "runtime.run",
      source.missionName,
      source.causalContext,
    );
  const packageRoot = workerLedgerPath(rootDir, cwd, source.packageRoot);
  return { packageRoot, mission: source.mission(packageRoot) };
}

export function runtimeMissionName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value))
    throw runtimeSpawnError(
      "invalid_runtime_mission",
      "Use --mission <name> with 1..64 lowercase letters, digits, or hyphens; path separators are forbidden.",
      {
        kind: "validation",
        entity: "runtime mission",
        field: "mission",
        actual: typeof value === "string" && /[/\\]/u.test(value) ? "path-like value" : "invalid mission id",
        expectation:
          "Expected a bare mission id; the daemon resolves harness/<task-package>/artifacts/missions/<name>.md " +
          "and did not look up this file. Retry ha agent run <agent-id> --task <task-id> --mission <name>",
      },
    );
  return value;
}

function readMissionDocument(
  projection: TaskProjection,
  packagePath: string,
  taskId: string,
  missionName: string,
): string {
  const name = runtimeMissionName(missionName),
    logicalPath = `${packagePath}/artifacts/missions/${name}.md`,
    read = projection.readDocument(logicalPath);
  if (read.watermark < read.sourceRevision || !read.document || !read.document.body.trim())
    throw runtimeSpawnError(
      "runtime_mission_unavailable",
      [
        `Task ${taskId} has no ready non-empty mission in the canonical projection at harness/${logicalPath}. `,
        `If the file exists on disk, run ha doc sync --submit --path ${logicalPath}, then retry.`,
      ].join(""),
    );
  return read.document.body;
}

export function assembleTaskMission(input: {
  readonly mission: string;
  readonly repoId: string;
  readonly workerRoot: string;
  /** How the task worktree was checked out and prepared for this dispatch; null when it runs elsewhere. */
  readonly worktreeNote?: string | null;
  readonly taskId: string;
  readonly taskPackageRoot: string;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly runtimeActor: string;
}): string {
  return [
    "# Dispatch Preconditions",
    `Repository id: ${input.repoId}`,
    "Repository registration: enabled",
    `Worker repository root: ${input.workerRoot}`,
    ...(input.worktreeNote ? [input.worktreeNote] : []),
    `Canonical Task ID: ${input.taskId}`,
    `Task package root: ${input.taskPackageRoot}`,
    ...(input.daemonRoute.userRoot
      ? [`Daemon user root: ${input.daemonRoute.userRoot}`, `Daemon id: ${input.daemonRoute.daemonId}`]
      : []),
    `Daemon endpoint: ${input.daemonRoute.endpoint}`,
    `Runtime actor: ${input.runtimeActor}`,
    "The daemon route, repository selection, and runtime actor are already injected into the process environment.",
    "# Assigned Mission",
    input.mission,
  ].join("\n");
}

export function assembleScheduledMission(input: {
  readonly mission: string;
  readonly repoId: string;
  readonly workerRoot: string;
  readonly scheduleId: string;
  readonly mode: "detect" | "remediate";
  readonly claimFence: string;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly runtimeActor: string;
}): string {
  return [
    "# Dispatch Preconditions",
    `Repository id: ${input.repoId}`,
    "Repository registration: enabled",
    `Worker repository root: ${input.workerRoot}`,
    `Schedule id: ${input.scheduleId}`,
    `Schedule claim fence: ${input.claimFence}`,
    ...(input.daemonRoute.userRoot
      ? [`Daemon user root: ${input.daemonRoute.userRoot}`, `Daemon id: ${input.daemonRoute.daemonId}`]
      : []),
    `Daemon endpoint: ${input.daemonRoute.endpoint}`,
    `Runtime actor: ${input.runtimeActor}`,
    "The daemon route, repository selection, runtime actor, and Schedule claim are sealed into this launch.",
    // A detect occurrence runs with full command access in the canonical checkout: observing is what
    // it is for, so the boundary is stated here rather than enforced by a mode that also forbids reading.
    ...(input.mode === "detect"
      ? [
          "This is a detect occurrence: observe and report only. Run any command you need to read state, but do not modify, create or delete files in the repository, do not commit, and do not write to the ledger. Your report is your final message.",
        ]
      : []),
    "# Assigned Mission",
    input.mission,
  ].join("\n");
}
