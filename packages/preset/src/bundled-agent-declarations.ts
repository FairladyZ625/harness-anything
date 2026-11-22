import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { entitySlug, parseAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";
import { findLocalVerticalRoot } from "./preset-assets.ts";
import { builtinVerticalRoots } from "./preset-resolver-common.ts";

function bundledAgentRootForVertical(verticalId: string, repoRoot?: string): string | null {
  if (!verticalId.trim()) return null;
  const localRoot = findLocalVerticalRoot(verticalId, repoRoot);
  if (localRoot !== null) {
    const localAgents = path.join(localRoot, "agents");
    if (
      existsSync(localAgents) &&
      !lstatSync(localAgents).isSymbolicLink() &&
      lstatSync(localAgents).isDirectory() &&
      readdirSync(localAgents, { withFileTypes: true }).some(
        (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"),
      )
    )
      return localAgents;
    const shadowedBuiltin = builtinVerticalRoots.get(verticalId);
    return shadowedBuiltin ? path.join(shadowedBuiltin, "agents") : null;
  }
  const builtinRoot = builtinVerticalRoots.get(verticalId);
  return builtinRoot ? path.join(builtinRoot, "agents") : null;
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
  verticalId: string,
  repoRoot?: string,
): AgentDeclarationV1 | null {
  if (!entitySlug(agentId)) return null;
  const agentsRoot = bundledAgentRootForVertical(verticalId, repoRoot);
  return agentsRoot === null ? null : readRegularAgentFile(agentsRoot, agentId);
}

/** Read a system-bundled agent declaration across any active built-in vertical in `repoRoot`. */
export function readAnyBundledAgentDeclaration(agentId: string, repoRoot?: string): AgentDeclarationV1 | null {
  if (!entitySlug(agentId)) return null;
  const checkedRoots = new Set<string>();
  for (const [verticalId, builtinRoot] of builtinVerticalRoots.entries()) {
    const builtinAgentsRoot = path.join(builtinRoot, "agents");
    const activeRoot = bundledAgentRootForVertical(verticalId, repoRoot);
    if (activeRoot !== builtinAgentsRoot || checkedRoots.has(activeRoot)) continue;
    checkedRoots.add(activeRoot);
    const declaration = readRegularAgentFile(activeRoot, agentId);
    if (declaration !== null) return declaration;
  }
  return null;
}

/** Enumerate the vertical-bundled agent ids — the bundled layer of a reviewer picker's
 * value face (the installed layer comes from the entity store). Shipped or local-vertical
 * `.json` basenames of the same root `readBundledAgentDeclaration` resolves against,
 * sorted for stable selector ordering and catalog digests. */
export function listBundledAgentDeclarationIds(verticalId: string, repoRoot?: string): readonly string[] {
  const root = bundledAgentRootForVertical(verticalId, repoRoot);
  if (root === null || !existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => entitySlug(id))
    .sort((left, right) => left.localeCompare(right));
}
