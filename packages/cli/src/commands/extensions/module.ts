import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { moduleEntityId } from "../../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedPayload } from "../../../../kernel/src/write-coordination/write-helpers.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import {
  moduleNotFound,
  readModules,
  writeModulesCoordinated
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

export function runModuleCommand(rootInput: HarnessLayoutInput, action: ModuleAction, coordinator?: WriteCoordinator): CliResult {
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
    if (!coordinator) throw new Error("module register requires write coordinator");
    Effect.runSync(writeModulesCoordinated(rootInput, coordinator, {
      registry: { modules },
      moduleKey: action.moduleKey,
      operation: "register"
    }));
    return { ok: true, command: "module-register", module };
  }

  if (action.kind === "module-scaffold") {
    const registry = readModules(rootInput);
    const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
    if (!module || module.status === "unregistered") return moduleNotFound("module-scaffold", action.moduleKey);
    const moduleRoot = path.join(layout.authoredRoot, "modules", module.key);
    if (!coordinator) throw new Error("module scaffold requires write coordinator");
    const writes = [
      { path: "brief.md", body: `# ${module.title}\n\nModule key: ${module.key}\n` },
      { path: "module_plan.md", body: `# ${module.title} Module Plan\n\n| Step | State |\n| --- | --- |\n` }
    ].filter((write) => !existsSync(path.join(moduleRoot, write.path)));
    if (writes.length > 0) {
      Effect.runSync(writeCoordinatedPayload(coordinator, stablePayloadHash, {
        entityId: moduleEntityId(module.key),
        kind: "module_scaffold_write",
        payload: { writes }
      }));
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
    if (!coordinator) throw new Error("module unregister requires write coordinator");
    Effect.runSync(writeModulesCoordinated(rootInput, coordinator, {
      moduleKey: module.key,
      operation: "unregister",
      registry: {
      modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
      }
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
  if (!coordinator) throw new Error("module step requires write coordinator");
  Effect.runSync(writeModulesCoordinated(rootInput, coordinator, {
    moduleKey: module.key,
    operation: "step",
    registry: {
      modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
    }
  }));
  return { ok: true, command: "module-step", module: next };
}
