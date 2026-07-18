import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { moduleEntityId } from "../../../../kernel/src/index.ts";
import type { WriteOp } from "../../../../kernel/src/index.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import {
  moduleNotFound,
  readModules
} from "./state.ts";

type ModuleAction = Extract<ParsedCommand["action"], {
  readonly kind:
    | "module-list"
    | "module-inspect"
    | "module-register"
    | "module-scaffold"
    | "module-unregister"
    | "module-step"
}>;

export function runModuleCommand(rootInput: HarnessLayoutInput, action: ModuleAction, pendingOps: WriteOp[]): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  if (action.kind === "module-list") {
    return {
      ok: true,
      command: "module-list",
      modules: readModules(rootInput).modules.filter((module) => module.status !== "unregistered")
    };
  }

  if (action.kind === "module-inspect") {
    const module = readModules(rootInput).modules.find((candidate) => candidate.key === action.moduleKey);
    if (!module || module.status === "unregistered") return moduleNotFound("module-inspect", action.moduleKey);
    return { ok: true, command: "module-inspect", module };
  }

  if (action.kind === "module-register") {
    const registry = readModules(rootInput);
    const existing = registry.modules.find((module) => module.key === action.moduleKey);
    const module = {
      key: action.moduleKey,
      title: action.title,
      ...(action.prefix ? { prefix: action.prefix } : {}),
      status: action.status ?? "active",
      ...(action.branch ? { branch: action.branch } : {}),
      ...(action.owner ? { owner: action.owner } : {}),
      ...(action.currentStep ? { currentStep: action.currentStep } : {}),
      scopes: [action.scope],
      shared: action.shared,
      dependsOn: action.dependsOn,
      steps: [] as Array<{ readonly id: string; readonly state: string }>
    };
    const modules = existing
      ? registry.modules.map((candidate) => candidate.key === action.moduleKey ? module : candidate)
      : [...registry.modules, module];
    pendingOps.push(moduleRegistryWrite(action.moduleKey, "register", { modules }));
    return { ok: true, command: "module-register", module };
  }

  if (action.kind === "module-scaffold") {
    const registry = readModules(rootInput);
    const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
    if (!module || module.status === "unregistered") return moduleNotFound("module-scaffold", action.moduleKey);
    const moduleRoot = path.join(layout.authoredRoot, "modules", module.key);
    const writes = [
      { path: "brief.md", body: `# ${module.title}\n\nModule key: ${module.key}\n` },
      { path: "module_plan.md", body: `# ${module.title} Module Plan\n\n| Step | State |\n| --- | --- |\n` }
    ].filter((write) => !existsSync(path.join(moduleRoot, write.path)));
    if (writes.length > 0) {
      pendingOps.push({
        opId: moduleOpId("scaffold"),
        entityId: moduleEntityId(module.key),
        kind: "module_scaffold_write",
        payload: { writes }
      });
    }
    return {
      ok: true,
      command: "module-scaffold",
      module,
      path: path.relative(rootDir, path.join(moduleRoot, "module_plan.md")).split(path.sep).join("/")
    };
  }

  if (action.kind === "module-unregister") {
    const registry = readModules(rootInput);
    const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
    if (!module || module.status === "unregistered") return moduleNotFound("module-unregister", action.moduleKey);
    const next = { ...module, status: "unregistered" };
    pendingOps.push(moduleRegistryWrite(module.key, "unregister", {
      modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
    }));
    return { ok: true, command: "module-unregister", module: next };
  }

  const registry = readModules(rootInput);
  const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
  if (!module || module.status === "unregistered") return moduleNotFound("module-step", action.moduleKey);
  const step = { id: action.stepId, state: action.state };
  const steps = module.steps.some((candidate) => candidate.id === step.id)
    ? module.steps.map((candidate) => candidate.id === step.id ? step : candidate)
    : [...module.steps, step];
  const next = { ...module, steps };
  pendingOps.push(moduleRegistryWrite(module.key, "step", {
      modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
  }));
  return { ok: true, command: "module-step", module: next };
}

function moduleRegistryWrite(
  moduleKey: string,
  operation: "register" | "unregister" | "step",
  registry: { readonly modules: ReadonlyArray<unknown> }
): WriteOp {
  return {
    opId: moduleOpId(operation),
    entityId: moduleEntityId(moduleKey),
    kind: "module_registry_write",
    payload: { operation, registry: { schema: "module-registry/v1", modules: registry.modules } }
  };
}

function moduleOpId(operation: string): string {
  return `module-${operation}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}
