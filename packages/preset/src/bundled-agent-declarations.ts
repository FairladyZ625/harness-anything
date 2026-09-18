import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entitySlug, parseAgentDeclarationV1, type AgentDeclarationV1 } from "../../kernel/src/index.ts";

const bundledAgentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/software-coding/agents");

export function readBundledAgentDeclaration(agentId: string): AgentDeclarationV1 | null {
  if (!entitySlug(agentId)) return null;
  const source = path.join(bundledAgentRoot, `${agentId}.json`);
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) return null;
  const declaration = parseAgentDeclarationV1(JSON.parse(readFileSync(source, "utf8")));
  if (declaration.id !== agentId) throw new Error(`Bundled Agent file ${agentId}.json declares id ${declaration.id}.`);
  return declaration;
}

/** Enumerate the bundled agent ids — the bundled layer of a reviewer picker's
 * value face (the installed layer comes from the entity store). Shipped
 * `.json` basenames of the same root `readBundledAgentDeclaration` resolves
 * against, sorted for stable selector ordering and catalog digests. */
export function listBundledAgentDeclarationIds(): readonly string[] {
  if (!existsSync(bundledAgentRoot)) return [];
  return readdirSync(bundledAgentRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => entitySlug(id))
    .sort((left, right) => left.localeCompare(right));
}
