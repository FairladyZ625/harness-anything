import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import type { AgentSkillDeclarationV1 } from "../../kernel/src/index.ts";

export interface ResolvedAgentSkill {
  readonly id: string;
  readonly sourceDir: string;
  readonly skillFile: string;
}
export interface AgentSkillCatalogRow {
  readonly id: string;
  readonly path: string;
  readonly source: "user" | "project";
}

export function resolveAgentSkillRoot(rootDir: string): string {
  return resolveHarnessLayout(rootDir).authoredRoot;
}
export function discoverAgentSkills(input: {
  readonly rootDir: string;
  readonly userHome?: string;
}): readonly AgentSkillCatalogRow[] {
  const projectRoot = path.resolve(input.rootDir),
    userHome = input.userHome ?? homedir(),
    roots: readonly {
      readonly root: string;
      readonly source: AgentSkillCatalogRow["source"];
      readonly followSkillLinks?: boolean;
    }[] = [
      { root: path.join(userHome, ".claude", "skills"), source: "user" },
      { root: path.join(userHome, ".agents", "skills"), source: "user" },
      { root: path.join(userHome, ".codex", "skills"), source: "user" },
      { root: path.join(projectRoot, ".claude", "skills"), source: "project" },
      { root: path.join(projectRoot, "skills"), source: "project" },
      { root: path.join(projectRoot, ".agents", "skills"), source: "project", followSkillLinks: true },
      { root: path.join(resolveHarnessLayout(projectRoot).authoredRoot, "skills"), source: "project" },
    ];
  const rows = new Map<string, AgentSkillCatalogRow>(),
    visitedRoots = new Set<string>();
  for (const candidate of roots)
    discoverSkillRoot(candidate.root, candidate.source, rows, visitedRoots, candidate.followSkillLinks === true);
  return [...rows.values()].sort(
    (left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path),
  );
}
export function resolveAgentSkills(input: {
  readonly rootDir: string;
  readonly skills?: readonly AgentSkillDeclarationV1[];
}): readonly ResolvedAgentSkill[] {
  const lexicalRoot = path.resolve(resolveAgentSkillRoot(input.rootDir)),
    rootDir = existsSync(lexicalRoot) ? realpathSync(lexicalRoot) : lexicalRoot,
    skills = input.skills ?? [];
  return skills.map((skill) => resolveAgentSkill(rootDir, skill));
}
function resolveAgentSkill(rootDir: string, skill: AgentSkillDeclarationV1): ResolvedAgentSkill {
  const candidate = path.isAbsolute(skill.path) ? path.resolve(skill.path) : path.resolve(rootDir, skill.path);
  if (!existsSync(candidate))
    throw skillError(
      "agent_skill_not_found",
      `Agent skill "${skill.id}" was not found at "${candidate}"; select an available skill directory containing SKILL.md, or correct the declaration path.`,
    );
  const stat = lstatSync(candidate),
    resolved = realpathSync(candidate);
  if (!stat.isDirectory())
    throw skillError(
      "agent_skill_not_found",
      `Agent skill "${skill.id}" is not a directory at "${candidate}"; select a directory containing SKILL.md and update the declaration path.`,
    );
  const skillFile = regularSkillManifest(resolved);
  if (!skillFile)
    throw skillError(
      "agent_skill_manifest_missing",
      `Agent skill "${skill.id}" directory "${resolved}" has no regular SKILL.md; add SKILL.md there or point the declaration at a complete skill directory.`,
    );
  return { id: skill.id, sourceDir: resolved, skillFile };
}
function discoverSkillRoot(
  root: string,
  source: AgentSkillCatalogRow["source"],
  rows: Map<string, AgentSkillCatalogRow>,
  visitedRoots: Set<string>,
  followSkillLinks: boolean,
): void {
  if (!existsSync(root)) return;
  const resolved = realpathSync(root),
    stat = lstatSync(resolved);
  if (!stat.isDirectory() || visitedRoots.has(resolved)) return;
  visitedRoots.add(resolved);
  if (catalogSkillDirectory(resolved, source, rows)) return;
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory() && !(followSkillLinks && entry.isSymbolicLink())) continue;
    const candidate = path.join(resolved, entry.name);
    if (!existsSync(candidate)) continue;
    const skillDir = realpathSync(candidate);
    if (!lstatSync(skillDir).isDirectory()) continue;
    catalogSkillDirectory(skillDir, source, rows);
  }
}
function catalogSkillDirectory(
  skillDir: string,
  source: AgentSkillCatalogRow["source"],
  rows: Map<string, AgentSkillCatalogRow>,
): boolean {
  if (!regularSkillManifest(skillDir)) return false;
  if (!rows.has(skillDir)) rows.set(skillDir, { id: path.basename(skillDir), path: skillDir, source });
  return true;
}
function regularSkillManifest(skillDir: string): string | null {
  if (!readdirSync(skillDir).includes("SKILL.md")) return null;
  const manifest = path.join(skillDir, "SKILL.md"),
    stat = lstatSync(manifest);
  return stat.isFile() && !stat.isSymbolicLink() ? manifest : null;
}
function skillError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
