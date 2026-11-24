import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  taskClasses,
  type ActorIdentity,
  type SettingsV1,
  type TaskClass,
  type WriteSource,
} from "@harness-anything/kernel";
import { taskCreateEnum } from "./preset-command-contract.ts";
import {
  compilePresetSnapshotUpgrade,
  compileTaskBootstrap,
  compileTaskPackage,
  type CompiledPresetSnapshotUpgrade,
  type CompiledTaskBootstrap,
  type CompiledTaskPackage,
} from "./preset-bootstrap.ts";
import {
  compileRepositoryScaffold,
  createRuntime,
  installPresetPackage,
  runVerticalDiscoveryAction,
  seedPresetPackages,
  uninstallPresetPackage,
  validateVerticalSource,
  validatePresetPackage,
  type InternalPresetResolution,
  type RepositoryScaffoldPlan,
} from "./preset-resolver.ts";
import { listVerticalCatalog, resolveVerticalAssetsRoot } from "./preset-assets.ts";
import { enumerateUser } from "./preset-catalog.ts";
import { catalogRecovery } from "./preset-discovery.ts";
import { resolveDefaultPresetSelection, resolveWorkPresetId } from "./preset-runtime.ts";
import {
  asFailure,
  presetFailure,
  presetRuntimeDefaults,
  type PresetRuntimeDefaults,
} from "./preset-resolver-common.ts";
export { presetRuntimeDefaults } from "./preset-resolver-common.ts";
import { scaffoldPresetPackage, scaffoldVerticalPackage } from "./vertical-scaffold.ts";
import { simulateVerticalPackage } from "./vertical-simulate.ts";

type TaskWorkKind = NonNullable<Parameters<typeof compileTaskPackage>[0]["workKind"]>;
type PriorityTier = NonNullable<Parameters<typeof compileTaskPackage>[0]["riskTier"]>;
const taskWorkKinds = taskCreateEnum("workKind") as readonly TaskWorkKind[],
  priorityTiers = taskCreateEnum("riskTier") as readonly PriorityTier[];

type Action = Readonly<Record<string, unknown>> & { readonly kind: string };
type Defaults = PresetRuntimeDefaults;
export async function runPresetAction(input: {
  readonly rootDir: string;
  readonly action: Action;
  readonly settings?: SettingsV1;
}): Promise<unknown> {
  const action = input.action,
    dryRun = action.dryRun === true;
  if (action.kind === "vertical-list")
    return listVerticalCatalog({
      rootDir: input.rootDir,
      defaultVertical: input.settings?.defaultVertical,
    });
  if (action.kind === "vertical-validate")
    return validateVerticalSource({
      source: optionalActionText(action.verticalSource) ?? requiredSettings(input.settings).defaultVertical,
      rootDir: input.rootDir,
      presetId: optionalActionText(action.presetId),
      userRoot: presetUserRoot(input.rootDir),
    });
  if (action.kind === "vertical-init")
    return scaffoldVerticalPackage({
      rootDir: input.rootDir,
      verticalId: required(action.verticalId, "verticalId"),
      title: optionalActionText(action.title),
      slug: optionalActionText(action.slug),
      defaultPresetId: optionalActionText(action.defaultPresetId),
      overwrite: action.force === true || action.overwrite === true,
      dryRun,
    });
  if (action.kind === "vertical-simulate")
    return simulateVerticalPackage({
      rootDir: input.rootDir,
      source: optionalActionText(action.verticalSource) ?? requiredSettings(input.settings).defaultVertical,
      presetId: optionalActionText(action.presetId),
      profileId: optionalActionText(action.profileId),
      locale: optionalActionText(action.locale) ?? input.settings?.locale,
      userRoot: presetUserRoot(input.rootDir),
    });
  if (action.kind === "preset-init")
    return scaffoldPresetPackage({
      rootDir: input.rootDir,
      presetId: required(action.presetId, "presetId"),
      verticalId: optionalActionText(action.verticalId) ?? requiredSettings(input.settings).defaultVertical,
      title: optionalActionText(action.title),
      presetKind:
        action.presetKind === "process-action" || action.presetKind === "template-content"
          ? action.presetKind
          : undefined,
      outputShape: optionalActionText(action.outputShape),
      overwrite: action.force === true || action.overwrite === true,
      dryRun,
    });
  if (["template-list", "template-render", "script-list", "script-inspect"].includes(action.kind))
    return runVerticalDiscoveryAction(
      action,
      resolveVerticalAssetsRoot(
        optionalActionText(action.verticalId) ?? requiredSettings(input.settings).defaultVertical,
        input.rootDir,
      ),
    );
  if (action.kind === "preset-validate")
    return validatePresetPackage({
      source: path.resolve(input.rootDir, required(action.packageSource, "packageSource")),
    });
  if (action.kind === "preset-install")
    return installPresetPackage({
      source: path.resolve(input.rootDir, required(action.packageSource, "packageSource")),
      userRoot: presetUserRoot(input.rootDir),
      dryRun,
    });
  if (action.kind === "preset-seed") return seedPresetPackages({ userRoot: presetUserRoot(input.rootDir), dryRun });
  if (action.kind === "preset-uninstall") {
    const presetId = required(action.presetId, "presetId"),
      active = uninstallPresetPackage({ presetId, userRoot: presetUserRoot(input.rootDir), dryRun });
    return { presetId, mode: dryRun ? "dry-run" : "apply", active, removed: active && !dryRun };
  }
  const defaults = presetRuntimeDefaults(requiredSettings(input.settings)),
    runtime = createRuntime(presetResolverOptions(input.rootDir, defaults)),
    resolver = runtime.resolver;
  if (action.kind === "preset-list")
    return resolver.list({ verticalId: optionalActionText(action.verticalId) ?? defaults.verticalId });
  if (action.kind === "preset-audit") {
    const verticalId = optionalActionText(action.verticalId) ?? defaults.verticalId,
      entries = await resolver.list({ verticalId }),
      listedIds = new Set(entries.map((entry) => entry.id)),
      orphanedPointers = enumerateUser(presetUserRoot(input.rootDir)).filter(
        (candidate) => !candidate.decoded && candidate.verticalId === "*" && !listedIds.has(candidate.id),
      ),
      count = (validity: string) => entries.filter((entry) => entry.validity === validity).length;
    return {
      schema: "preset-audit-report/v1",
      total: entries.length + orphanedPointers.length,
      valid: count("valid"),
      unavailable: count("unavailable"),
      blocked: count("blocked") + orphanedPointers.length,
      issues: [
        ...entries.flatMap((entry) =>
          entry.issues.map((issue) => ({
            presetId: entry.id,
            layer: entry.layer,
            source: entry.source,
            ...issue,
            ...(entry.nextAction ? { remediation: entry.nextAction } : {}),
          })),
        ),
        ...orphanedPointers.map((candidate) => {
          const failure = candidate.error ?? presetFailure("invalid_pointer", "Active preset pointer is invalid.");
          return {
            presetId: candidate.id,
            layer: candidate.layer,
            source: candidate.source,
            code: failure.code,
            message: failure.message,
            remediation: catalogRecovery(candidate, failure).nextAction,
          };
        }),
      ],
    };
  }
  if (action.kind !== "preset-inspect" && action.kind !== "preset-check")
    throw presetActionError("unsupported_command", `No preset lifecycle contract exists for ${action.kind}.`);
  const profileId = optionalActionText(action.profileId) ?? defaults.profileId,
    request = {
      presetId: required(action.presetId, "presetId"),
      verticalId: optionalActionText(action.verticalId) ?? defaults.verticalId,
      ...(profileId ? { profileId } : {}),
      locale: optionalActionText(action.locale) ?? defaults.locale,
      purpose: "inspect" as const,
    };
  let resolved: InternalPresetResolution;
  try {
    resolved = runtime.resolveInternal(request);
  } catch (error) {
    const known = asFailure(error);
    throw presetActionError(known.code, known.message);
  }
  if (action.kind === "preset-check") {
    const actual = optionalActionText(action.snapshotDigest);
    return actual && actual !== resolved.snapshot.digest
      ? {
          valid: false,
          code: "snapshot_mismatch",
          actualDigest: actual,
          expectedDigest: resolved.snapshot.digest,
          nextAction: "Run ha preset upgrade <task-id>.",
        }
      : { valid: true, digest: resolved.snapshot.digest };
  }
  return {
    manifest: resolved.manifest,
    snapshot: resolved.snapshot,
    entrypoints: Object.keys(resolved.snapshot.entrypoints).sort(),
    documents: resolved.documents,
  };
}
export function compileRepoTaskBootstrap(input: {
  readonly rootDir: string;
  readonly action: Action;
  readonly taskId: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly workspaceRevision: number;
  readonly eventId: string;
  readonly opId: string;
  readonly occurredAt: string;
  readonly settings: SettingsV1;
  readonly riskTierFlowVersion?: 1 | null;
}): CompiledTaskBootstrap {
  const defaults = presetRuntimeDefaults(input.settings),
    resolverOptions = presetResolverOptions(input.rootDir, defaults),
    taskClass = optionalTaskClass(input.action.taskClass),
    verticalId = optionalActionText(input.action.verticalId) ?? defaults.verticalId,
    presetId =
      optionalActionText(input.action.presetId) ??
      (taskClass === "work" ? resolveWorkPresetId({ ...resolverOptions, verticalId }) : defaults.presetId),
    profileId =
      optionalActionText(input.action.profileId) ??
      (taskClass === "work" && presetId !== defaults.presetId ? undefined : defaults.profileId);
  return compileTaskBootstrap({
    ...resolverOptions,
    ...taskPackageFields(input.action),
    taskId: input.taskId,
    title: required(input.action.title, "title"),
    ...(taskClass ? { taskClass } : {}),
    presetId,
    verticalId,
    ...(profileId ? { profileId } : {}),
    ...(input.riskTierFlowVersion === undefined ? {} : { riskTierFlowVersion: input.riskTierFlowVersion }),
    locale: optionalActionText(input.action.locale) ?? defaults.locale,
    actor: input.actor,
    source: input.source,
    workspaceRevision: input.workspaceRevision,
    eventId: input.eventId,
    opId: input.opId,
    occurredAt: input.occurredAt,
  });
}
export function compileRepoTaskPackage(input: {
  readonly rootDir: string;
  readonly action: Action;
  readonly taskId: string;
  readonly settings: SettingsV1;
  readonly riskTierFlowVersion?: 1 | null;
}): CompiledTaskPackage {
  const defaults = presetRuntimeDefaults(input.settings),
    resolverOptions = presetResolverOptions(input.rootDir, defaults),
    taskClass = optionalTaskClass(input.action.taskClass),
    verticalId = optionalActionText(input.action.verticalId) ?? defaults.verticalId,
    presetId =
      optionalActionText(input.action.presetId) ??
      (taskClass === "work" ? resolveWorkPresetId({ ...resolverOptions, verticalId }) : defaults.presetId),
    profileId =
      optionalActionText(input.action.profileId) ??
      (taskClass === "work" && presetId !== defaults.presetId ? undefined : defaults.profileId);
  return compileTaskPackage({
    ...resolverOptions,
    ...taskPackageFields(input.action),
    taskId: input.taskId,
    title: required(input.action.title, "title"),
    ...(taskClass ? { taskClass } : {}),
    presetId,
    verticalId,
    ...(profileId ? { profileId } : {}),
    ...(input.riskTierFlowVersion === undefined ? {} : { riskTierFlowVersion: input.riskTierFlowVersion }),
    locale: optionalActionText(input.action.locale) ?? defaults.locale,
  });
}
export function resolveRepoBootstrapDefaults(input: {
  readonly rootDir: string;
  readonly verticalId: string;
  readonly presetId?: string;
  readonly preferredPresetId?: string;
}): {
  readonly verticalId: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly outputShape: string;
} {
  const selected = resolveDefaultPresetSelection({
    repoRoot: input.rootDir,
    userRoot: presetUserRoot(input.rootDir),
    verticalId: input.verticalId,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    ...(input.preferredPresetId ? { preferredPresetId: input.preferredPresetId } : {}),
  });
  return { verticalId: input.verticalId, ...selected };
}
export function compileRepoPresetSnapshotUpgrade(
  input: Omit<Parameters<typeof compilePresetSnapshotUpgrade>[0], keyof ReturnType<typeof presetResolverOptions>> & {
    readonly rootDir: string;
    readonly settings: SettingsV1;
  },
): CompiledPresetSnapshotUpgrade {
  const defaults = presetRuntimeDefaults(input.settings);
  return compilePresetSnapshotUpgrade({ ...input, ...presetResolverOptions(input.rootDir, defaults) });
}
export function compileRepoRepositoryScaffold(rootDir: string, settings: SettingsV1): RepositoryScaffoldPlan {
  const defaults = presetRuntimeDefaults(settings),
    projectRoot = resolveHarnessLayout(rootDir).authoredRoot,
    target = path.resolve(projectRoot, defaults.repositoryOverlay),
    relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw presetActionError(
      "invalid_repository_scaffold",
      "settings.scaffolds.repository must remain inside the authored root.",
    );
  return compileRepositoryScaffold({
    rootDir,
    verticalId: defaults.verticalId,
    locale: defaults.locale,
    ...(existsSync(target) ? { projectScaffold: target } : {}),
  });
}
export function presetUserRoot(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "presets");
}
function presetResolverOptions(rootDir: string, defaults: Defaults) {
  const layout = resolveHarnessLayout(rootDir),
    projectRoot = layout.authoredRoot,
    projectScaffold = path.resolve(projectRoot, defaults.taskOverlay),
    relative = path.relative(projectRoot, projectScaffold);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw presetActionError("invalid_task_scaffold", "settings.scaffolds.task must remain inside the authored root.");
  return {
    userRoot: presetUserRoot(rootDir),
    projectRoot,
    repoRoot: layout.rootDir,
    ...(existsSync(projectScaffold) ? { projectScaffold } : {}),
  };
}
function optionalActionText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function requiredSettings(settings: SettingsV1 | undefined): SettingsV1 {
  if (settings === undefined)
    throw presetActionError(
      "settings_projection_unavailable",
      "Repository Settings projection is required for preset defaults.",
    );
  return settings;
}
function required(value: unknown, field: string): string {
  const result = optionalActionText(value);
  if (!result) throw presetActionError("invalid_command", `${field} is required.`);
  return result;
}
function optionalTaskClass(value: unknown): TaskClass | undefined {
  if (value === undefined) return undefined;
  if ((taskClasses as readonly string[]).includes(value as string)) return value as TaskClass;
  throw presetActionError("invalid_task_class", "taskClass must be standard, work, or long_running.");
}
function presetActionError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
function taskPackageFields(
  action: Action,
): Pick<
  Parameters<typeof compileTaskPackage>[0],
  "idempotencyKey" | "parentTaskId" | "workKind" | "riskTier" | "urgency" | "slug" | "surfaces" | "requirePlan" | "plan"
> {
  return {
    ...(optionalActionText(action.idempotencyKey)
      ? { idempotencyKey: optionalActionText(action.idempotencyKey)! }
      : {}),
    ...(optionalActionText(action.parentTaskId) ? { parentTaskId: optionalActionText(action.parentTaskId)! } : {}),
    ...(oneOf(action.workKind, taskWorkKinds) ? { workKind: oneOf(action.workKind, taskWorkKinds)! } : {}),
    ...(oneOf(action.riskTier, priorityTiers) ? { riskTier: oneOf(action.riskTier, priorityTiers)! } : {}),
    ...(oneOf(action.urgency, priorityTiers) ? { urgency: oneOf(action.urgency, priorityTiers)! } : {}),
    ...(optionalActionText(action.slug) ? { slug: optionalActionText(action.slug)! } : {}),
    ...(Array.isArray(action.surfaces) ? { surfaces: action.surfaces.map((value) => required(value, "surface")) } : {}),
    ...(action.requirePlan === true ? { requirePlan: true } : {}),
    ...(optionalActionText(action.plan) ? { plan: optionalActionText(action.plan)! } : {}),
  };
}
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}
