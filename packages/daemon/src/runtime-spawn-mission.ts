import { existsSync, globSync } from "node:fs";
import path from "node:path";
import type { TaskProjection } from "../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { agentRolePrompt } from "./agent-role-prompts.ts";
import { runtimeTypeMatchesKind } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { type ResolvedAgentSkill } from "./agent-skills.ts";
import { resolveContainedPath } from "./contained-path.ts";
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

export async function resolveRuntimeInstanceId(input: {
  readonly requested?: string;
  readonly providerSessionId?: string;
  readonly agent: RuntimeAgent | null;
  readonly model?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly sessions: readonly RuntimeSessionSelection[];
}): Promise<string> {
  if (input.providerSessionId) {
    const session = input.sessions.find((row) => row.providerSessionId === input.providerSessionId);
    if (session) return session.instanceId;
  }
  if (input.requested) return input.requested;
  const declaredModel = input.model ?? input.agent?.model;
  const declaredType = input.agent?.runtime_type;
  const typed = input.instances.filter(
    (instance) =>
      instance.enabled &&
      (declaredType === undefined || declaredType === "any" || runtimeTypeMatchesKind(declaredType, instance.kindId)),
  );
  const declared = declaredModel ? typed.filter((instance) => instance.models.includes(declaredModel)) : typed;
  if (declared.length === 0) {
    const typeCandidates = typed.length > 0;
    throw runtimeSpawnError(
      declaredModel && typeCandidates ? "agent_model_unavailable" : "agent_runtime_unavailable",
      declaredModel && typeCandidates
        ? [
            "No enabled runtime instance declares model ",
            `${declaredModel}`,
            "; add it to an instance or remove the Agent model declaration.",
          ].join("")
        : declaredModel
          ? [
              "No enabled runtime instance declares model ",
              `${declaredModel}`,
              "; no instance is compatible with runtime type ",
              `${declaredType ?? "any"}`,
              ".",
            ].join("")
          : `No enabled runtime instance is compatible with runtime type ${declaredType ?? "any"}.`,
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
        : `Compatible runtime instances exist for ${declaredType ?? "any"}, but none are authentication-ready.`,
    );
  const active = new Map<string, number>(ready.map((instance) => [instance.instanceId, 0]));
  for (const session of input.sessions)
    if (session.liveness === "live" && active.has(session.instanceId))
      active.set(session.instanceId, (active.get(session.instanceId) ?? 0) + 1);
  const selected = [...ready].sort(
    (a, b) =>
      (active.get(a.instanceId) ?? 0) - (active.get(b.instanceId) ?? 0) || a.instanceId.localeCompare(b.instanceId),
  )[0];
  if (!selected)
    throw runtimeSpawnError("agent_runtime_unavailable", "No enabled runtime instance is available for this dispatch.");
  return selected.instanceId;
}

export function deriveTaskMission(
  rootDir: string,
  projection: TaskProjection,
  taskId: string,
  transition: "runtime.run" | "squad.run",
  missionName?: string,
): {
  readonly mission: string;
  readonly packageRoot: string;
  readonly planPath: string;
  readonly plan: string;
  readonly missionPath: string | null;
  readonly missionBody: string | null;
} {
  const planDocument = assertTaskTransitionDocumentReady({
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
    mission = [
      `Your task package is ${packageRoot}.\nRead ${path.basename(planPath)} in that package and complete the task.`,
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
      `Task ${taskId} has no ready non-empty mission at harness/${logicalPath}.`,
    );
  return { path: path.join(packageRoot, "artifacts", "missions", `${name}.md`), body: read.document.body };
}

export function assembleTaskMission(input: {
  readonly mission: string;
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly workerRoot: string;
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
    `Task package root: ${input.taskPackageRoot}`,
    `Daemon user root: ${input.daemonRoute.userRoot}`,
    `Daemon id: ${input.daemonRoute.daemonId}`,
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
    `Daemon user root: ${input.daemonRoute.userRoot}`,
    `Daemon id: ${input.daemonRoute.daemonId}`,
    `Daemon endpoint: ${input.daemonRoute.endpoint}`,
    `Runtime actor: ${input.runtimeActor}`,
    "The daemon route, repository selection, runtime actor, and Schedule claim are sealed into this launch.",
    "# Assigned Mission",
    input.mission,
  ].join("\n");
}

export function validateMissionCommands(mission: string, workerRoot: string, source: string): void {
  for (const block of mission.matchAll(/```(?:sh|bash|zsh|shell)[^\n]*\n([\s\S]*?)```/giu))
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
  for (const [raw] of line.matchAll(/"(?:\\.|[^"])*"|'[^']*'|&&|[|;]|[^\s|&;<>]+/gu)) {
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
