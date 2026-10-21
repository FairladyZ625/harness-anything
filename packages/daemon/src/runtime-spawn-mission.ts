import path from "node:path";
import type { AgentRole, TaskLifecycleSnapshot, TaskProjection } from "@harness-anything/kernel";
import { consumeKnownError, resolveHarnessLayout } from "@harness-anything/kernel";
import { agentRolePrompt } from "./agent-role-prompts.ts";
import { agentRuntimeTargetSummary, agentRuntimeKindMatches } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { RuntimeProviderHealth } from "./runtime-provider-health.ts";
import { type ResolvedAgentSkill } from "./agent-skills.ts";
import { resolveContainedPath } from "./contained-path.ts";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type {
  RemoteRuntimePersistence,
  RuntimeAgent,
  RuntimeDaemonRoute,
  RuntimeSessionSelection,
} from "./runtime-spawn-types.ts";
import { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";
import { workerLedgerPath } from "./worktree-setup.ts";
import {
  continuationContext,
  continuationContextPrompt,
  currentWorktreeHead,
  latestRuntimeContinuationSeed,
} from "./runtime-continuation-context.ts";

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
  readonly unavailableReasons?: string[];
  readonly agent: RuntimeAgent | null;
  readonly model?: string;
  /** The concrete kind selected for an unbound runtime dispatch. */
  readonly runtimeKind?: string;
  /** Repository-scoped allowlist; undefined means the repository has not been initialized yet. */
  readonly allowedInstanceIds?: readonly string[];
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly sessions: readonly RuntimeSessionSelection[];
  readonly health?: readonly RuntimeProviderHealth[];
  readonly now?: string;
}): string[] {
  const configured = input.allowedInstanceIds !== undefined,
    allowed = input.allowedInstanceIds ?? [],
    allowedNames = allowed.length ? allowed.join(", ") : "none",
    enableCommand = (instanceId: string): string =>
      [...allowed, instanceId]
        .filter((value, index, values) => values.indexOf(value) === index)
        .map((value) => `--runtime-allowed-instance ${value}`)
        .join(" ");
  const assertAllowed = (instanceId: string): void => {
    if (configured && allowed.includes(instanceId)) return;
    if (!input.instances.some((instance) => instance.instanceId === instanceId))
      throw runtimeSpawnError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    if (!configured)
      throw runtimeSpawnError(
        "runtime_instance_allowlist_uninitialized",
        "This repository has no runtime instance allowlist. Run ha init or enable the instance in repository settings before dispatching.",
      );
    if (allowed.includes(instanceId)) return;
    throw runtimeSpawnError(
      "runtime_instance_not_allowed",
      `Runtime instance ${instanceId} is not allowed for this repository. ` +
        `Allowed instances: ${allowedNames}. Enable it without replacing the existing allowlist with ` +
        `ha settings update ${enableCommand(instanceId)}.`,
    );
  };
  // An explicit instance pin and a resumed provider session both bypass the declaration filter
  // below, so they owe the same rule here: an Agent that declares runtimes never selects an
  // instance of another kind, whatever lane carried the choice in.
  const assertDeclarationServes = (instanceId: string): void => {
    if (input.agent === null) return;
    const instance = input.instances.find((row) => row.instanceId === instanceId);
    if (instance === undefined || agentRuntimeKindMatches(input.agent.runtimes, instance.kindId)) return;
    throw runtimeSpawnError(
      "agent_runtime_unavailable",
      `Agent ${input.agent.id} declares ${agentRuntimeTargetSummary(input.agent.runtimes)}, but ${instanceId} ` +
        `is a ${instance.kindId} instance. Dispatch it without the instance pin, resume a session served by a ` +
        `declared runtime, or add the runtime kind to the Agent declaration.`,
    );
  };
  if (input.providerSessionId) {
    const session = input.sessions.find((row) => row.providerSessionId === input.providerSessionId);
    if (session) {
      assertAllowed(session.instanceId);
      assertDeclarationServes(session.instanceId);
      return [session.instanceId];
    }
  }
  if (input.requested) {
    assertAllowed(input.requested);
    assertDeclarationServes(input.requested);
    return [input.requested];
  }
  // input.model is the dispatch-level override (--model); the per-kind declared model lives
  // on the matching runtimes row and applies only when no override was given.
  const declaredModel = input.model,
    declaredType = input.runtimeKind,
    declaredTargets = input.agent?.runtimes;
  if (!configured && input.instances.length > 0)
    throw runtimeSpawnError(
      "runtime_instance_allowlist_uninitialized",
      "This repository has no runtime instance allowlist. Run ha init or enable an instance in repository settings before dispatching.",
    );
  const unavailable = input.unavailableReasons ?? [],
    instances = input.instances.filter((instance) => allowed.includes(instance.instanceId));
  for (const instance of input.instances)
    if (!allowed.includes(instance.instanceId))
      unavailable.push(
        `${instance.kindId}/${instance.instanceId}: runtime_instance_not_allowed (enable with ha settings update ${enableCommand(instance.instanceId)})`,
      );
  for (const target of declaredTargets ?? (declaredType ? [{ type: declaredType }] : []))
    if (!instances.some((instance) => instance.kindId === target.type))
      unavailable.push(`${target.type}: runtime_instance_not_found (no local instance)`);
  for (const instance of instances) {
    if (
      (declaredType !== undefined && declaredType !== instance.kindId) ||
      (declaredTargets !== undefined && !agentRuntimeKindMatches(declaredTargets, instance.kindId))
    )
      continue;
    const model = declaredModel ?? declaredTargets?.find((row) => row.type === instance.kindId)?.model;
    const providerHealth = input.health?.find((row) => row.instanceId === instance.instanceId),
      healthUntil = providerHealth?.frozen ? null : (providerHealth?.frozenUntil ?? providerHealth?.cooldownUntil),
      healthBlocked =
        providerHealth?.frozen === true ||
        (healthUntil !== null &&
          healthUntil !== undefined &&
          Date.parse(healthUntil) > Date.parse(input.now ?? new Date().toISOString())),
      reason = !instance.enabled
        ? "runtime_instance_disabled"
        : healthBlocked
          ? `runtime_provider_unavailable (${providerHealth?.reason ?? "cooldown"}; recover at ${healthUntil})`
          : model !== undefined && !instance.models.includes(model)
            ? `agent_model_unavailable (${model})`
            : instance.authReadiness.status !== "ready" && instance.authReadiness.code !== "runtime_auth_not_checked"
              ? `${instance.authReadiness.code}: ${instance.authReadiness.hint}`
              : undefined;
    if (reason) unavailable.push(`${instance.kindId}/${instance.instanceId}: ${reason}`);
  }
  const detail = unavailable.length ? ` Candidates: ${unavailable.join("; ")}` : "";
  const typed = instances.filter(
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
    if (instances.length === 0)
      throw runtimeSpawnError(
        "runtime_instance_not_allowed",
        `No runtime instance is allowed for this repository. Allowed instances: ${allowedNames}. ` +
          "Enable one with ha settings update --runtime-allowed-instance <instance-id>." +
          detail,
      );
    if (input.agent && !typeCandidates)
      throw runtimeSpawnError(
        "agent_runtime_unavailable",
        `Agent ${input.agent.id} requires ${targetSummary}, ` +
          "but no enabled instance of those runtime kinds is available on this node." +
          detail,
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
      (typeCandidates
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
          : `No enabled runtime instance is compatible with runtime type ${targetSummary}.`) + detail,
    );
  }
  const ready = declared
    .filter(
      (instance) =>
        instance.authReadiness.status === "ready" || instance.authReadiness.code === "runtime_auth_not_checked",
    )
    .filter((instance) => {
      const health = input.health?.find((row) => row.instanceId === instance.instanceId),
        blockedUntil = health?.frozenUntil ?? health?.cooldownUntil;
      return !(
        health?.frozen ||
        (blockedUntil && Date.parse(blockedUntil) > Date.parse(input.now ?? new Date().toISOString()))
      );
    });
  if (ready.length === 0)
    throw runtimeSpawnError(
      "runtime_model_not_ready",
      (declaredModel
        ? `Runtime instances declare model ${declaredModel}, but none are authentication-ready.`
        : `Compatible runtime instances exist for ${targetSummary}, but none are authentication-ready.`) + detail,
    );
  const allowedRank = new Map(allowed.map((instanceId, index) => [instanceId, index])),
    runtimeRank = new Map(declaredTargets?.map((target, index) => [target.type, index]));
  return [...ready]
    .sort(
      (a, b) =>
        (runtimeRank.get(a.kindId) ?? runtimeRank.size) - (runtimeRank.get(b.kindId) ?? runtimeRank.size) ||
        (allowedRank.get(a.instanceId) ?? allowed.length) - (allowedRank.get(b.instanceId) ?? allowed.length),
    )
    .map((instance) => instance.instanceId);
}

/** Select before launch: machine availability can change after the instance definition was written. */
export async function prepareRuntimeInstance<T>(
  input: Parameters<typeof resolveRuntimeInstanceCandidates>[0],
  prepare: (instanceId: string) => Promise<T>,
): Promise<{ readonly instanceId: string; readonly launch: T }> {
  const reasons: string[] = [],
    candidates = resolveRuntimeInstanceCandidates({ ...input, unavailableReasons: reasons }),
    runtimeRank = new Map(input.agent?.runtimes.map((target, index) => [target.type, index])),
    kindById = new Map(input.instances.map((instance) => [instance.instanceId, instance.kindId])),
    liveLoad = new Map<string, number>(),
    // The declaration's row is the primary key; kinds outside it (an unbound dispatch declares
    // none) share one trailing row so they keep the previous cross-kind load spreading.
    rankOf = (instanceId: string): number => runtimeRank.get(kindById.get(instanceId) ?? "") ?? runtimeRank.size;
  for (const session of input.sessions)
    if (session.liveness === "live") liveLoad.set(session.instanceId, (liveLoad.get(session.instanceId) ?? 0) + 1);
  // Load is a secondary key only inside one declared row. Ties keep the resolver's order (a stable
  // sort), which is the configured order the resolver already ranked; an instance-id tiebreak here
  // would silently re-rank an unbound dispatch whose candidates all share the trailing row.
  // Sorting the whole list by load let an idle later row outrank a busy first row, undoing the
  // priority the Agent author declared.
  candidates.sort((a, b) => rankOf(a) - rankOf(b) || (liveLoad.get(a) ?? 0) - (liveLoad.get(b) ?? 0));
  for (const instanceId of candidates) {
    try {
      return { instanceId, launch: await prepare(instanceId) };
    } catch (error) {
      const code = (error as { readonly code?: string }).code;
      if (
        input.requested ||
        input.providerSessionId ||
        !code ||
        ![
          "runtime_instance_disabled",
          "runtime_instance_not_found",
          "runtime_installation_not_found",
          "runtime_credential_unavailable",
          "runtime_subscription_required",
          "runtime_auth_in_progress",
          "runtime_auth_probe_failed",
          "invalid_runtime_model",
          // A machine can host several installations of one kind; an old build is a
          // per-installation unavailability, so automatic selection may try the next one.
          "minimum_version_not_met",
        ].includes(code)
      )
        throw error;
      consumeKnownError(error);
      reasons.push(`${instanceId}: ${code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw runtimeSpawnError(
    "agent_runtime_unavailable",
    `No runtime launch is available. Candidates: ${reasons.join("; ")}`,
  );
}

/** Task-bound dispatches use injected context and reads admitted by their execution credential. */
export function taskQueryGuidance(taskId: string): string {
  return [
    "# 台账查询引导",
    `- 本任务的 task_plan.md 全文与 <task-context> 已注入上面的 mission，不必再读文件；` +
      `ha task read-set ${taskId} 点名的资料与 ha task show ${taskId} 的任务状态，信息不够时再查。` +
      `资料不足时向 owner 报告具体缺项。`,
  ].join("\n");
}

/**
 * The unattended-session constraint every dispatch carries: a dispatched session has no one
 * reading its turn, so a provider question tool either blocks the run or (measured on Codex
 * 2026-10-21, task_936005e1) fails the turn outright. The ruling request has one channel — an
 * artifact plus a stop — because a free-form final message is not a machine-readable ask.
 * The `__HARNESS_DISPATCH_ID__` token is rendered per dispatch, so the artifact path is concrete.
 */
export const unattendedRulingContract = [
  "# 无人值守会话：不能提问",
  "- 本会话没有应答方。不要调用任何提问/等待用户输入的 provider 工具：没人会回答，turn 会空转或直接失败。",
  "- 需要业主裁决时：把问题、可选项与你的建议写进任务包的 " +
    "`artifacts/rulings/__HARNESS_DISPATCH_ID__.md`，然后在交付报告里引用它并停下。" +
    "写不清楚的裁决请求等于没有提出问题。",
  "- 不需要裁决的取舍自己做完并在报告里说明理由；只有收不回或越权的动作才留给业主。",
].join("\n");

/**
 * The plan-first opening every task-bound mission carries: the task's own task_plan.md injected
 * verbatim, so the worker starts from the contract instead of spending its first calls reading
 * the package (the measured waste this replaces: ~1,685 package-flipping calls across 206 worker
 * sessions over two days, 2026-10-19). Bodies are measured, not capped — over the production
 * ledger's 4,235 plans they run 4.3 KiB median, 8.8 KiB p90, 148 KiB max, and even the outlier
 * sits orders of magnitude below every dispatch provider's context window.
 */
export function taskPlanSection(planBody: string, packageRoot?: string): string {
  const lead =
    packageRoot === undefined
      ? "本任务的 task_plan.md 全文如下（已内嵌，不必再读文件）："
      : `Your task package is ${packageRoot}.\n本任务的 task_plan.md 全文如下（已内嵌，不必再读文件），按其完成本任务：`;
  return `${lead}\n\n${planBody.trim()}`;
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
export function livingDeliverableProtocol(profileId: string | null | undefined, taskClass?: string): string | null {
  if (taskClass === "work") return null;
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

/** The whole PR-body contract a task mission still carries (dec_BB2BCE9F CH2): the framework
 * owns the credentialed channel, the body convention is the delivered repository's own. */
export const taskPrPublicationNote = "推送后用 `gh pr create --head <task-id>` 开 PR，正文遵循本仓库的 PR 规范。";

/**
 * The managed rework record of the iteration a re-dispatched worker must answer: the rendered
 * `returns/iteration-N.md` body when the task has advanced past iteration N, null on a first
 * dispatch (iteration 0). The rendered document stays the single storage of the instruction;
 * missions embed it verbatim instead of carrying a second copy.
 */
export function priorOwnerReturnBody(projection: TaskProjection, taskId: string): string | null {
  const read = projection.read(taskId),
    priorIteration = read.snapshot.task && read.snapshot.task.iteration > 0 ? read.snapshot.task.iteration - 1 : null;
  if (priorIteration === null || read.packagePath === null) return null;
  const body = projection
    .readDocument(`${read.packagePath}/returns/iteration-${String(priorIteration)}.md`)
    .document?.body.trim();
  return body ? body : null;
}

/** Dynamic sections follow the dispatch action: review, delivery, or rework.
 * reviewerBinding is the spawner's existing review judgment; workers owe the delivery contracts. */
export function taskMissionSections(
  taskId: string,
  causalContext: string | null,
  profileId: string | null | undefined,
  taskClass: string | undefined,
  ownerReturnBody: string | null,
  reviewerBinding: boolean,
): string[] {
  const living = reviewerBinding ? null : livingDeliverableProtocol(profileId, taskClass);
  return [
    taskQueryGuidance(taskId),
    unattendedRulingContract,
    ...(living === null ? [] : [living]),
    ...(reviewerBinding ? [] : [taskPrPublicationNote]),
    ...(causalContext === null ? [] : [causalContext]),
    ...(reviewerBinding || ownerReturnBody === null
      ? []
      : [
          `# Owner rework instruction

${ownerReturnBody}`,
        ]),
  ];
}

/** An explicit task prompt carries the same action-specific sections as a derived mission, led by
 * the inlined plan when the caller supplies its body. */
export function explicitPromptMission(
  taskId: string | null,
  causalContext: string | null,
  prompt: string,
  profileId: string | null | undefined = undefined,
  taskClass?: string,
  ownerReturnBody: string | null = null,
  reviewerBinding: boolean = false,
  planBody: string | null = null,
): string {
  return [
    ...(planBody === null ? [] : [taskPlanSection(planBody)]),
    ...(taskId === null
      ? causalContext === null
        ? []
        : [causalContext]
      : taskMissionSections(taskId, causalContext, profileId, taskClass, ownerReturnBody, reviewerBinding)),
    prompt,
  ].join("\n\n");
}

/** The package root is named as the worker reaches it from `cwd`, the root it runs in; the plan
 * rides verbatim ahead of the sections. Reviewer bindings keep the task guidance but carry no
 * worker delivery contract. */
export function deriveTaskMission(
  rootDir: string,
  cwd: string,
  projection: TaskProjection,
  taskId: string,
  transition: "runtime.run" | "squad.run",
  missionName?: string,
  causalContext?: string | null,
  reviewerBinding: boolean = false,
): {
  readonly mission: string;
  readonly packageRoot: string;
  /** The plan body the mission inlines, handed to explicit-prompt assembly over the same projection. */
  readonly planBody: string;
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
    missionDocument = missionName
      ? readMissionDocument(projection, planDocument.packagePath, taskId, missionName)
      : null,
    causalContextResolved =
      causalContext === undefined ? assembleTaskCausalContext({ projection, taskId }) : causalContext,
    snapshot = projection.read(taskId).snapshot,
    mission = [
      taskPlanSection(planDocument.body, packageRoot),
      ...taskMissionSections(
        taskId,
        causalContextResolved,
        snapshot.task?.metadata?.profileId,
        snapshot.task?.taskClass,
        reviewerBinding ? null : priorOwnerReturnBody(projection, taskId),
        reviewerBinding,
      ),
      ...(missionDocument ? [`# Mission: ${missionName}\n\n${missionDocument.trim()}`] : []),
    ].join("\n\n");
  return {
    packageRoot,
    mission,
    planBody: planDocument.body,
  };
}

/**
 * A dispatched task's mission and package root as the worker reaches them from `cwd`: an edge's come from its
 * mirrored package, a node that holds the ledger derives them from its projection. Remote sources
 * carry no plan body here — the caller reads it from the remote task context directly.
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
  reviewerBinding: boolean = false,
): { readonly mission: string; readonly packageRoot: string; readonly planBody: string | null } {
  if ("projection" in source) {
    const derived = deriveTaskMission(
      rootDir,
      cwd,
      source.projection,
      source.taskId,
      "runtime.run",
      source.missionName,
      source.causalContext,
      reviewerBinding,
    );
    return { mission: derived.mission, packageRoot: derived.packageRoot, planBody: derived.planBody };
  }
  const packageRoot = workerLedgerPath(rootDir, cwd, source.packageRoot);
  return { packageRoot, mission: source.mission(packageRoot), planBody: null };
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

/** The mission a dispatch carries: derived from the task package, or an explicit prompt wrapped in the
 * same task guidance. Remote dispatches read every input from the center's serving cut, local ones from
 * the projection. */
export async function resolveRuntimeMission(input: {
  readonly rootDir: string;
  readonly cwd: string;
  readonly taskId: string | null;
  readonly projection: TaskProjection | null;
  readonly remoteTask: Awaited<ReturnType<RemoteRuntimePersistence["taskContext"]>> | null;
  readonly taskSnapshot: TaskLifecycleSnapshot | null;
  readonly missionName: string | undefined;
  readonly explicitMission: string | undefined;
  readonly reviewerBinding: boolean;
}): Promise<{
  readonly taskMission: { readonly mission: string; readonly packageRoot: string } | null;
  readonly mission: string;
}> {
  const { rootDir, cwd, taskId, remoteTask, taskSnapshot, missionName, explicitMission } = input,
    projection = input.projection!,
    causalContext =
      remoteTask === null
        ? taskId === null
          ? null
          : assembleTaskCausalContext({ projection, taskId })
        : remoteTask.causalContext,
    // The profile is frozen at creation: locally from the projection, remotely from the center's
    // serving read. It gates the Living Deliverable Protocol on every task-bound path.
    missionProfileId = remoteTask?.profileId ?? taskSnapshot?.task?.metadata?.profileId ?? null,
    // A re-dispatched worker answers the latest owner return, so its mission carries the managed
    // rework record verbatim — from the center's serving read remotely, from the projection
    // locally. Reviewers bind to a submitted cut instead, so their missions never carry it, and
    // the same binding omits the worker delivery contracts (living deliverable, PR publication)
    // from every task-bound assembly path.
    ownerReturnBody =
      taskId === null || input.reviewerBinding
        ? null
        : remoteTask !== null
          ? remoteTask.ownerReturnBody
          : priorOwnerReturnBody(projection, taskId),
    continuation =
      taskId === null
        ? null
        : continuationContext(
            remoteTask?.continuationContext ??
              (projection
                ? latestRuntimeContinuationSeed(
                    projection,
                    taskId,
                    taskSnapshot?.executions.map(({ executionId }) => executionId) ?? [],
                  )
                : null),
            await currentWorktreeHead(cwd),
          ),
    taskMission = taskId
      ? missionAt(rootDir, cwd, remoteTask ?? { projection, taskId, missionName, causalContext }, input.reviewerBinding)
      : null;
  // Every task-bound assembly path inlines the plan (derived missions through deriveTaskMission,
  // explicit prompts through this body), so the guidance's "已注入" claim holds on each of them.
  const planBody = taskId === null ? null : (remoteTask?.planBody ?? taskMission?.planBody ?? null);
  const continuationSection = continuation === null ? null : continuationContextPrompt(continuation),
    baseMission =
      explicitMission === undefined
        ? (taskMission?.mission ?? requiredRuntimeSpawnText(undefined, "prompt"))
        : explicitPromptMission(
            taskId,
            causalContext,
            explicitMission,
            missionProfileId,
            remoteTask?.taskClass ?? taskSnapshot?.task?.taskClass,
            ownerReturnBody,
            input.reviewerBinding,
            planBody,
          ),
    mission = continuationSection === null ? baseMission : `${baseMission}\n\n${continuationSection}`;
  return {
    taskMission: taskMission === null ? null : { ...taskMission, mission },
    mission: mission,
  };
}
