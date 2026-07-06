import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFactFlowRecords, readFrontmatter, readScalar } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, resolveHarnessLayout } from "../../../kernel/src/index.ts";

export function buildResolvableEntityIndex(rootInput: HarnessLayoutInput): { readonly refs: ReadonlySet<string> } {
  const layout = resolveHarnessLayout(rootInput);
  const refs = new Set<string>();
  for (const indexPath of listTaskIndexPaths(rootInput)) {
    const taskDir = path.dirname(indexPath);
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    const taskId = frontmatter ? readScalar(frontmatter, "task_id") || path.basename(taskDir) : path.basename(taskDir);
    refs.add(`task/${taskId}`);
    const factsPath = path.join(taskDir, layout.factDocumentName);
    if (existsSync(factsPath)) {
      for (const fact of parseFactFlowRecords(readFileSync(factsPath, "utf8"))) {
        refs.add(`fact/${taskId}/${fact.fact_id}`);
      }
    }
  }

  for (const decisionPath of listDecisionDocuments(layout.decisionsRoot)) {
    const body = readFileSync(decisionPath, "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") continue;
    const decisionId = readScalar(frontmatter, "decision_id") || path.basename(path.dirname(decisionPath));
    refs.add(`decision/${decisionId}`);
    for (const anchor of readDecisionEndpointAnchors(frontmatter)) {
      refs.add(`decision/${decisionId}/${anchor}`);
    }
  }
  return { refs };
}

function listDecisionDocuments(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  return readdirSync(inputPath, { withFileTypes: true }).flatMap((entry): ReadonlyArray<string> => {
    const entryPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) return listDecisionDocuments(entryPath);
    if (entry.isFile() && entry.name === "decision.md") return [entryPath];
    return [];
  }).sort();
}

function readDecisionEndpointAnchors(frontmatter: string): ReadonlyArray<string> {
  return ["claims", "chosen", "rejected"].flatMap((key) => readDecisionAnchorBlock(frontmatter, key));
}

function readDecisionAnchorBlock(frontmatter: string, key: string): ReadonlyArray<string> {
  const lines = frontmatter.split(/\r?\n/u);
  const output: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === `${key}:`) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*-\s*\{/u.test(line)) {
      const match = /^\s*-\s*\{\s*id:\s*"?([A-Za-z][A-Za-z0-9_-]*)"?/u.exec(line);
      if (match?.[1]) output.push(match[1]);
      continue;
    }
    if (/^\S/u.test(line)) break;
  }
  return output;
}
