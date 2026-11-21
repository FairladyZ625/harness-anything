import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { entitySlug, parseAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";
import { builtinVerticalRoots, defaultAssets } from "./preset-resolver-common.ts";

function bundledAgentRootForVertical(verticalId: string): string {
  const root = builtinVerticalRoots.get(verticalId) ?? defaultAssets;
  return path.join(root, "agents");
}

export function readBundledAgentDeclaration(
  agentId: string,
  verticalId = "software/coding",
): AgentDeclarationV1 | null {
  if (!entitySlug(agentId)) return null;
  const root = bundledAgentRootForVertical(verticalId);
  const source = path.join(root, `${agentId}.json`);
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) return null;
  const declaration = parseAgentDeclarationV1(JSON.parse(readFileSync(source, "utf8")));
  if (declaration.id !== agentId) throw new Error(`Bundled Agent file ${agentId}.json declares id ${declaration.id}.`);
  return declaration;
}

/** Enumerate the bundled agent ids — the bundled layer of a reviewer picker's
 * value face (the installed layer comes from the entity store). Shipped
 * `.json` basenames of the same root `readBundledAgentDeclaration` resolves
 * against, sorted for stable selector ordering and catalog digests. */
export function listBundledAgentDeclarationIds(verticalId = "software/coding"): readonly string[] {
  const root = bundledAgentRootForVertical(verticalId);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => entitySlug(id))
    .sort((left, right) => left.localeCompare(right));
}
