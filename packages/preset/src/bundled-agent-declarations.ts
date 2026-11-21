import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { entitySlug, parseAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";
import { findLocalVerticalRoot } from "./preset-assets.ts";
import { builtinVerticalRoots, defaultAssets } from "./preset-resolver-common.ts";

function bundledAgentRootForVertical(verticalId: string, repoRoot?: string): string {
  // Local repository vertical overrides only shadow vertical assets (templates/presets/gates).
  // Agent overrides always come from installed canonical Agent entities, never raw workspace files,
  // so a pre-existing local custom vertical with the same id as a newly bundled vertical preserves
  // pre-upgrade core bundled agent resolution.
  if (findLocalVerticalRoot(verticalId, repoRoot) !== null) return path.join(defaultAssets, "agents");
  const root = builtinVerticalRoots.get(verticalId) ?? defaultAssets;
  return path.join(root, "agents");
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
  return readRegularAgentFile(bundledAgentRootForVertical(verticalId, repoRoot), agentId);
}

/** Enumerate the bundled agent ids — the bundled layer of a reviewer picker's
 * value face (the installed layer comes from the entity store). Shipped
 * `.json` basenames of the same root `readBundledAgentDeclaration` resolves
 * against, sorted for stable selector ordering and catalog digests. */
export function listBundledAgentDeclarationIds(verticalId = "software/coding", repoRoot?: string): readonly string[] {
  const root = bundledAgentRootForVertical(verticalId, repoRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => entitySlug(id))
    .sort((left, right) => left.localeCompare(right));
}
