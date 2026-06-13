import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  TemplateCatalogSchema,
  VerticalDefinitionSchema,
  planTemplateMaterialization,
  validateExtensionInputShape,
  validatePresetManifests,
  validateTemplateCatalog,
  validateVerticalDefinition
} from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import {
  bundledPresetManifests,
  discoverPresets,
  moduleNotFound,
  presetManifestPath,
  presetNotFound,
  publicPresetSummary,
  readModules,
  readPresetManifestFromSource,
  resolvePreset,
  runPresetEntrypoint,
  writeModules
} from "./state.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { bundledTemplateCatalog, bundledVerticalDefinition } from "./bundled.ts";

export function isExtensionAction(action: ParsedCommand["action"]): action is Extract<ParsedCommand["action"], {
  readonly kind:
    | "template-list"
    | "template-render"
    | "preset-validate"
    | "preset-list"
    | "preset-inspect"
    | "preset-check"
    | "preset-install"
    | "preset-seed"
    | "preset-audit"
    | "preset-uninstall"
    | "preset-run"
    | "preset-action"
    | "module-list"
    | "module-inspect"
    | "module-register"
    | "module-scaffold"
    | "module-unregister"
    | "module-step"
    | "vertical-validate"
}> {
  return [
    "template-list",
    "template-render",
    "preset-validate",
    "preset-list",
    "preset-inspect",
    "preset-check",
    "preset-install",
    "preset-seed",
    "preset-audit",
    "preset-uninstall",
    "preset-run",
    "preset-action",
    "module-list",
    "module-inspect",
    "module-register",
    "module-scaffold",
    "module-unregister",
    "module-step",
    "vertical-validate"
  ].includes(action.kind);
}

export function runExtensionCommand(command: ParsedCommand): CliResult {
  try {
    if (command.action.kind === "template-list") {
      const decoded = decodeTemplateCatalog(command.action.catalogPath);
      if (!decoded.ok) {
        return invalidExtensionResult("template-list", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
      }
      const catalog = decoded.value;
      const validation = validateTemplateCatalog(catalog);
      return {
        ok: validation.ok,
        command: "template-list",
        templates: catalog.documents.map((document) => ({
          templateRef: `template://${document.id}@${document.version}`,
          documentKind: document.documentKind,
          slot: document.slot,
          materializeAs: document.materializeAs,
          locales: document.locales.map((variant) => variant.locale)
        })),
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "template_catalog_invalid",
          hint: "Template catalog failed validation."
        }
      };
    }

    if (command.action.kind === "template-render") {
      const decoded = decodeTemplateCatalog(command.action.catalogPath);
      if (!decoded.ok) {
        return invalidExtensionResult("template-render", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
      }
      const catalog = decoded.value;
      const materialized = planTemplateMaterialization({
        catalog,
        locale: command.action.locale,
        selections: [{
          slot: "cli.render",
          templateRef: command.action.templateRef,
          materializeAs: "stdout.md",
          localePolicy: {
            prefer: "explicit",
            fallback: "en-US"
          }
        }]
      });
      return {
        ok: materialized.ok,
        command: "template-render",
        document: materialized.documents[0],
        issues: materialized.issues,
        error: materialized.ok ? undefined : {
          code: "template_render_failed",
          hint: "Template selection could not be materialized."
        }
      };
    }

    if (command.action.kind === "preset-validate") {
      const decoded = decodeExtensionJsonFile("preset-manifest", command.action.manifestPath, PresetManifestSchema);
      if (!decoded.ok) {
        return invalidExtensionResult("preset-validate", "preset_manifest_invalid", "Preset manifest failed validation.", decoded.issues);
      }
      const manifest = decoded.value;
      const validation = validatePresetManifests([manifest], { kernelVersion: command.action.kernelVersion });
      return {
        ok: validation.ok,
        command: "preset-validate",
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "preset_manifest_invalid",
          hint: "Preset manifest failed validation."
        }
      };
    }

    if (command.action.kind === "preset-list") {
      return {
        ok: true,
        command: "preset-list",
        presets: discoverPresets(command.rootDir).map(publicPresetSummary)
      };
    }

    if (command.action.kind === "preset-inspect") {
      const preset = resolvePreset(command.rootDir, command.action.presetId);
      if (!preset) return presetNotFound("preset-inspect", command.action.presetId);
      return {
        ok: true,
        command: "preset-inspect",
        preset: {
          ...publicPresetSummary(preset),
          manifest: preset.manifest
        }
      };
    }

    if (command.action.kind === "preset-check") {
      const preset = resolvePreset(command.rootDir, command.action.presetId);
      if (!preset) return presetNotFound("preset-check", command.action.presetId);
      const validation = validatePresetManifests([preset.manifest], { kernelVersion: "1.0.0" });
      return {
        ok: validation.ok,
        command: "preset-check",
        preset: publicPresetSummary(preset),
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "preset_manifest_invalid",
          hint: "Preset manifest failed validation."
        }
      };
    }

    if (command.action.kind === "preset-install") {
      const manifest = readPresetManifestFromSource(command.action.sourcePath);
      const validation = validatePresetManifests([manifest], { kernelVersion: "1.0.0" });
      if (!validation.ok) {
        return {
          ok: false,
          command: "preset-install",
          preset: { id: manifest.id },
          issues: validation.issues,
          error: { code: "preset_manifest_invalid", hint: "Preset manifest failed validation." }
        };
      }
      const target = presetManifestPath(command.rootDir, command.action.layer, manifest.id);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
      return {
        ok: true,
        command: "preset-install",
        preset: publicPresetSummary({ manifest, layer: command.action.layer, sourcePath: target })
      };
    }

    if (command.action.kind === "preset-seed") {
      for (const manifest of bundledPresetManifests()) {
        const target = presetManifestPath(command.rootDir, "user", manifest.id);
        if (!existsSync(target)) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
        }
      }
      return {
        ok: true,
        command: "preset-seed",
        presets: discoverPresets(command.rootDir).filter((preset) => preset.layer === "user").map(publicPresetSummary)
      };
    }

    if (command.action.kind === "preset-audit") {
      const resolved = discoverPresets(command.rootDir);
      const bundledById = new Map(bundledPresetManifests().map((manifest) => [manifest.id, manifest.version]));
      const drift = resolved
        .filter((preset) => preset.layer !== "builtin" && bundledById.has(preset.manifest.id) && bundledById.get(preset.manifest.id) !== preset.manifest.version)
        .map((preset) => ({
          id: preset.manifest.id,
          layer: preset.layer,
          installedVersion: preset.manifest.version,
          bundledVersion: bundledById.get(preset.manifest.id)
        }));
      return {
        ok: true,
        command: "preset-audit",
        presets: resolved.map(publicPresetSummary),
        report: {
          totalResolved: resolved.length,
          drift
        }
      };
    }

    if (command.action.kind === "preset-uninstall") {
      const target = presetManifestPath(command.rootDir, command.action.layer, command.action.presetId);
      if (!existsSync(target)) return presetNotFound("preset-uninstall", command.action.presetId);
      rmSync(path.dirname(target), { recursive: true, force: true });
      return {
        ok: true,
        command: "preset-uninstall",
        preset: {
          id: command.action.presetId,
          layer: command.action.layer
        }
      };
    }

    if (command.action.kind === "preset-run") {
      return runPresetEntrypoint(command.rootDir, command.action.presetId, command.action.entrypoint, command.action.taskId, "preset-run");
    }

    if (command.action.kind === "preset-action") {
      if (command.action.actionName !== "plan" && command.action.actionName !== "scaffold" && command.action.actionName !== "check") {
        return {
          ok: false,
          command: "preset-action",
          preset: { id: command.action.presetId },
          error: { code: "preset_action_forbidden", hint: `Preset action ${command.action.actionName} is not declared.` }
        };
      }
      return runPresetEntrypoint(command.rootDir, command.action.presetId, command.action.actionName, command.action.taskId, "preset-action");
    }

    if (command.action.kind === "module-list") {
      return {
        ok: true,
        command: "module-list",
        modules: readModules(command.rootDir).modules.filter((module) => module.status !== "unregistered")
      };
    }

    if (command.action.kind === "module-inspect") {
      const action = command.action;
      const module = readModules(command.rootDir).modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-inspect", action.moduleKey);
      return { ok: true, command: "module-inspect", module };
    }

    if (command.action.kind === "module-register") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const existing = registry.modules.find((module) => module.key === action.moduleKey);
      const module = {
        key: action.moduleKey,
        title: action.title,
        status: "active",
        scopes: [action.scope],
        steps: [] as Array<{ readonly id: string; readonly state: string }>
      };
      const modules = existing
        ? registry.modules.map((candidate) => candidate.key === action.moduleKey ? module : candidate)
        : [...registry.modules, module];
      writeModules(command.rootDir, { modules });
      return { ok: true, command: "module-register", module };
    }

    if (command.action.kind === "module-scaffold") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-scaffold", action.moduleKey);
      const moduleRoot = path.join(resolveHarnessLayout(command.rootDir).planningRoot, "modules", module.key);
      mkdirSync(moduleRoot, { recursive: true });
      writeIfMissing(path.join(moduleRoot, "brief.md"), `# ${module.title}\n\nModule key: ${module.key}\n`);
      writeIfMissing(path.join(moduleRoot, "module_plan.md"), `# ${module.title} Module Plan\n\n| Step | State |\n| --- | --- |\n`);
      return {
        ok: true,
        command: "module-scaffold",
        module,
        path: path.relative(command.rootDir, path.join(moduleRoot, "module_plan.md")).split(path.sep).join("/")
      };
    }

    if (command.action.kind === "module-unregister") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-unregister", action.moduleKey);
      const next = { ...module, status: "unregistered" };
      writeModules(command.rootDir, {
        modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
      });
      return { ok: true, command: "module-unregister", module: next };
    }

    if (command.action.kind === "module-step") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-step", action.moduleKey);
      const step = { id: action.stepId, state: action.state };
      const steps = module.steps.some((candidate) => candidate.id === step.id)
        ? module.steps.map((candidate) => candidate.id === step.id ? step : candidate)
        : [...module.steps, step];
      const next = { ...module, steps };
      writeModules(command.rootDir, {
        modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
      });
      return { ok: true, command: "module-step", module: next };
    }

    if (command.action.kind === "vertical-validate") {
      const decoded = decodeVerticalDefinition(command.action.definitionPath);
      if (!decoded.ok) {
        return invalidExtensionResult("vertical-validate", "vertical_definition_invalid", "Vertical definition failed validation.", decoded.issues);
      }
      const vertical = decoded.value;
      const validation = validateVerticalDefinition(vertical);
      return {
        ok: validation.ok,
        command: "vertical-validate",
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "vertical_definition_invalid",
          hint: "Vertical definition failed validation."
        }
      };
    }

    return {
      ok: false,
      command: command.action.kind,
      error: {
        code: "unknown_command",
        hint: "Unsupported extension command."
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_registry_key:")) {
      const label = error.message.split(":")[1] ?? "registry";
      return {
        ok: false,
        command: command.action.kind,
        error: {
          code: "invalid_registry_key",
          hint: `Invalid ${label} key.`
        }
      };
    }
    return {
      ok: false,
      command: command.action.kind,
      error: {
        code: "decode_failed",
        hint: "Input JSON failed to decode or could not be read."
      }
    };
  }
}

function decodeTemplateCatalog(catalogPath?: string): { readonly ok: true; readonly value: Schema.Schema.Type<typeof TemplateCatalogSchema> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const bundled = catalogPath ? bundledTemplateCatalog(catalogPath) : bundledTemplateCatalog();
  if (bundled) return { ok: true, value: bundled };
  if (!catalogPath) return { ok: false, issues: [{ code: "template_catalog_not_found", path: "$", message: "Bundled template catalog was not found." }] };
  return decodeExtensionJsonFile("template-catalog", catalogPath, TemplateCatalogSchema);
}

function decodeVerticalDefinition(definitionPath?: string): { readonly ok: true; readonly value: Schema.Schema.Type<typeof VerticalDefinitionSchema> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const bundled = definitionPath ? bundledVerticalDefinition(definitionPath) : bundledVerticalDefinition();
  if (bundled) return { ok: true, value: bundled };
  if (!definitionPath) return { ok: false, issues: [{ code: "vertical_definition_not_found", path: "$", message: "Bundled vertical definition was not found." }] };
  return decodeExtensionJsonFile("vertical-definition", definitionPath, VerticalDefinitionSchema);
}

function decodeExtensionJsonFile<A, I>(
  kind: "template-catalog" | "preset-manifest" | "vertical-definition",
  filePath: string,
  schema: Schema.Schema<A, I, never>
): { readonly ok: true; readonly value: A } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const shape = validateExtensionInputShape(kind, raw);
  if (!shape.ok) {
    return { ok: false, issues: shape.issues };
  }
  return { ok: true, value: Schema.decodeUnknownSync(schema)(raw) };
}

function invalidExtensionResult(command: string, code: string, hint: string, issues: ReadonlyArray<unknown>): CliResult {
  return {
    ok: false,
    command,
    issues,
    error: {
      code,
      hint
    }
  };
}

function writeIfMissing(filePath: string, body: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}
