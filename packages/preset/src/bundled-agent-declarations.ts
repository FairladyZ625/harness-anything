import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { entitySlug, parseAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";
import { findLocalVerticalRoot } from "./preset-assets.ts";
import { builtinVerticalRoots, defaultAssets } from "./preset-resolver-common.ts";

function bundledAgentRootsForVertical(verticalId: string, repoRoot?: string): readonly string[] {
  const localRoot = findLocalVerticalRoot(verticalId, repoRoot);
  if (localRoot !== null) {
    const localAgents = path.join(localRoot, "agents");
    const coreAgents = path.join(defaultAssets, "agents");
    return path.resolve(localAgents) === path.resolve(coreAgents) ? [coreAgents] : [localAgents, coreAgents];
  }
  const root = builtinVerticalRoots.get(verticalId) ?? defaultAssets;
  return [path.join(root, "agents")];
}

function readRegularAgentFile(agentsRoot: string, agentId: string): AgentDeclarationV1 | null {
  if (!existsSync(agentsRoot) || lstatSync(agentsRoot).isSymbolicLink()) return null;
  const source = path.join(agentsRoot, `${agentId}.json`);
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) return null;
  const declaration = parseAgentDeclarationV1(JSON.parse(readFileSync(source, "utf8")));
  if (declaration.id !== agentId) throw new Error(`Bundled Agent file ${agentId}.json declares id ${declaration.id}.`);
  return declaration;
}

export function readBundledAgentDeclaration(
  agentId: string,
  verticalId = "software/coding",
  repoRoot?: string,
): AgentDeclarationV1 | null {
  if (!entitySlug(agentId)) return null;
  for (const root of bundledAgentRootsForVertical(verticalId, repoRoot)) {
    const declaration = readRegularAgentFile(root, agentId);
    if (declaration !== null) return declaration;
  }
  return null;
}

/** Enumerate the bundled agent ids — the bundled layer of a reviewer picker's
 * value face (the installed layer comes from the entity store). Shipped
 * `.json` basenames of the same root `readBundledAgentDeclaration` resolves
 * against, sorted for stable selector ordering and catalog digests. */
export function listBundledAgentDeclarationIds(verticalId = "software/coding", repoRoot?: string): readonly string[] {
  const ids = new Set<string>();
  for (const root of bundledAgentRootsForVertical(verticalId, repoRoot)) {
    if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (entitySlug(id)) ids.add(id);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}
