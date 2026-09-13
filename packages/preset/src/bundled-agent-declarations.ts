import { existsSync, lstatSync, readFileSync } from "node:fs";
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
