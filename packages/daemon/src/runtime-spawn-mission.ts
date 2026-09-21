import { existsSync, globSync } from "node:fs";
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
import { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";

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
  const providerPriority = input.agent?.fallback?.providerPriority ?? [];
  const providerRank = new Map(providerPriority.map((provider, index) => [provider, index]));
  return [...ready]
    .sort(
      (a, b) =>
        (providerRank.get(a.providerId) ?? providerPriority.length) -
          (providerRank.get(b.providerId) ?? providerPriority.length) ||
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

/**
 * The fixed how-to-look-up guidance every task-bound dispatch carries, filled
 * with the dispatch's own task id so the first `ha graph` line is executable
 * verbatim. It is plain text assembled with the mission — fleet-edge dispatches
 * walk the same assembly — and deliberately not configurable: the causal-context
 * block is empty for tasks without a deriving decision or parent chain, and
 * those are exactly the tasks that must query the graph themselves.
 */
export function taskQueryGuidance(taskId: string): string {
  return [
    "# 台账查询引导",
    "- Fact/Decision 正文直接读文件：harness/facts/F-*.md、harness/decisions/decision-dec_*/decision.md，" +
      "grep 即可（Markdown 与数据库同步）。",
    `- 这个任务/决策/事实连着什么、由什么推出、被什么证据支撑，用 ha graph 查：先执行 ha graph ${taskId}，` +
      "再按需 ha graph <ref> --depth 2。没有语义边时它只显示父子结构，孤任务只有自己一行——那不是命令坏了。",
    "- 动手改代码前先看一眼图。",
  ].join("\n");
}

/** An explicit prompt on a task-bound dispatch still owes the worker the same lookup guidance as a derived mission. */
export function explicitPromptMission(taskId: string | null, causalContext: string | null, prompt: string): string {
  return [
    ...(taskId === null ? [] : [taskQueryGuidance(taskId)]),
    ...(causalContext === null ? [] : [causalContext]),
    prompt,
  ].join("\n\n");
}

export function deriveTaskMission(
  rootDir: string,
  projection: TaskProjection,
  taskId: string,
  transition: "runtime.run" | "squad.run",
  missionName?: string,
  causalContext?: string | null,
): {
  readonly mission: string;
  readonly packageRoot: string;
  readonly planPath: string;
  readonly plan: string;
  readonly missionPath: string | null;
  readonly missionBody: string | null;
} {
  const planDocument = assertTaskTransitionDocumentReady({
      rootDir,
      projection,
      taskId,
      slot: "task.plan",
      transition,
    }),
    packageRoot = path.resolve(resolveHarnessLayout(rootDir).authoredRoot, ...planDocument.packagePath.split("/")),
    planPath = path.join(packageRoot, ...path.posix.relative(planDocument.packagePath, planDocument.path).split("/")),
    missionDocument = missionName
      ? readMissionDocument(projection, planDocument.packagePath, taskId, missionName, packageRoot)
      : null,
    causalContextResolved =
      causalContext === undefined ? assembleTaskCausalContext({ projection, taskId }) : causalContext,
    snapshot = projection.read(taskId).snapshot,
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
      ...(causalContextResolved === null ? [] : [causalContextResolved]),
      ...(missionDocument ? [`# Mission: ${missionName}\n\n${missionDocument.body.trim()}`] : []),
    ].join("\n\n");
  return {
    packageRoot,
    planPath,
    plan: planDocument.body,
    mission,
    missionPath: missionDocument?.path ?? null,
    missionBody: missionDocument?.body ?? null,
  };
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
  packageRoot: string,
): { readonly path: string; readonly body: string } {
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
  return { path: path.join(packageRoot, "artifacts", "missions", `${name}.md`), body: read.document.body };
}

export function assembleTaskMission(input: {
  readonly mission: string;
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly workerRoot: string;
  readonly taskId: string;
  readonly taskPackageRoot: string;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly runtimeActor: string;
}): string {
  return [
    "# Dispatch Preconditions",
    `Repository id: ${input.repoId}`,
    "Repository registration: enabled",
    `Canonical repository root: ${input.canonicalRoot}`,
    `Worker repository root: ${input.workerRoot}`,
    `Canonical Task ID: ${input.taskId}`,
    `Task package root: ${input.taskPackageRoot}`,
    ...(input.daemonRoute.userRoot
      ? [`Daemon user root: ${input.daemonRoute.userRoot}`, `Daemon id: ${input.daemonRoute.daemonId}`]
      : []),
    `Daemon endpoint: ${input.daemonRoute.endpoint}`,
    `Runtime actor: ${input.runtimeActor}`,
    [
      "Use the worker repository root for public code and the canonical ",
      "repository root for authored harness context. The daemon route, ",
      "repository selection, and runtime actor are already injected into the ",
      "process environment.",
    ].join(""),
    "# Assigned Mission",
    input.mission,
  ].join("\n");
}

export function assembleScheduledMission(input: {
  readonly mission: string;
  readonly repoId: string;
  readonly canonicalRoot: string;
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
    `Canonical repository root: ${input.canonicalRoot}`,
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

export function validateMissionCommands(mission: string, workerRoot: string, source: string): void {
  for (const block of mission.matchAll(/(?:^|\r?\n)```(?:sh|bash|zsh|shell)[^\r\n]*\r?\n([\s\S]*?)(?:^|\r?\n)```/giu))
    for (const line of (block[1] ?? "").split(/\r?\n/u))
      for (const tokens of shellSegments(line)) {
        const command = path.basename(tokens[0] ?? ""),
          args = tokens.slice(1),
          candidates = new Set<string>();
        if (!command || command.startsWith("#")) continue;
        if (command === "node") for (const value of args) if (looksLikeMissionPath(value)) candidates.add(value);
        if (command === "rg") {
          const last = args.at(-1);
          if (last && looksLikeMissionPath(last)) candidates.add(last);
        }
        if (["cat", "cd", "head", "tail", "test", "wc", "ls", "stat", "sed"].includes(command))
          for (const value of args) if (!value.startsWith("-") && looksLikeMissionPath(value)) candidates.add(value);
        if (tokens[0]?.includes("/") && looksLikeMissionPath(tokens[0])) candidates.add(tokens[0]);
        for (const candidate of candidates)
          if (!missionPathExists(workerRoot, candidate))
            throw runtimeSpawnError(
              "runtime_mission_invalid",
              [
                "",
                `${source}`,
                " shell command references unavailable path ",
                `${JSON.stringify(candidate)}`,
                " from worker root ",
                `${workerRoot}`,
                ".",
              ].join(""),
            );
      }
}

export function shellSegments(line: string): string[][] {
  const segments: string[][] = [[]];
  for (const [raw] of line.matchAll(/"(?:\\.|[^"])*"|'[^']*'|&&|[|;]|(?:<[^<>\r\n]+>|[^\s|&;<>])+/gu)) {
    if (["&&", "|", ";"].includes(raw)) {
      if (segments.at(-1)?.length) segments.push([]);
      continue;
    }
    const token =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
    if (token === "#") {
      segments.push([]);
      break;
    }
    segments.at(-1)!.push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

export function looksLikeMissionPath(value: string): boolean {
  return (
    !value.includes("$") &&
    !/[<>]/u.test(value) &&
    !/^https?:\/\//u.test(value) &&
    (path.isAbsolute(value) ||
      value.startsWith(".") ||
      value.includes("/") ||
      /\.(?:[cm]?[jt]s|json|md|sh|ya?ml)$/iu.test(value))
  );
}

export function missionPathExists(workerRoot: string, value: string): boolean {
  if (/[*?[\]{}]/u.test(value)) return globSync(value, { cwd: workerRoot }).length > 0;
  return existsSync(path.isAbsolute(value) ? value : path.resolve(workerRoot, value));
}
