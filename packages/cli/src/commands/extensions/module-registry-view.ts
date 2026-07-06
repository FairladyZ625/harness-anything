import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import type { ModuleRegistry } from "./state.ts";

export function writeModuleRegistryView(rootInput: HarnessLayoutInput, registry: ModuleRegistry): void {
  const outputPath = path.join(resolveHarnessLayout(rootInput).generatedRoot, "Module-Registry.md");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = registry.modules
    .map((module) => `| ${module.key} | ${module.title} | ${module.status} | ${module.scopes.join("<br>")} | ${module.owner ?? ""} | ${module.currentStep ?? ""} | ${module.steps.map((step) => `${step.id}:${step.state}`).join(", ")} |`)
    .join("\n");
  writeFileSync(outputPath, [
    "# Module Registry",
    "",
    "| Key | Title | Status | Scopes | Owner | Current Step | Steps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    rows,
    ""
  ].join("\n"), "utf8");
}
