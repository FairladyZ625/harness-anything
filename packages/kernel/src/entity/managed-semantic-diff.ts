import { parseDecisionDocument } from "../domain/decision-document.ts";
import { deriveRelationId, type EntityRelationRecord } from "../domain/entity-relation.ts";
import { parseFactFlowRecords, type FactRecord } from "../domain/fact-record.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { extractMarkdownSection, markdownHeadingSections } from "../markdown/section.ts";
import { parseRelationFlowRecords } from "../projection/relation-flow-frontmatter.ts";
import type {
  ReadySemanticDiffFacet,
  SemanticDiffCandidateDocument,
  SemanticDiffCandidateTree,
  SemanticDiffCompileContext,
  SemanticDiffDocumentPolicy,
  SemanticDiffMutationIntent,
  SemanticDiffSectionPolicy
} from "./registry-contract.ts";

type TransparentSemanticKind = "task" | "decision" | "fact" | "relation";
export type ManagedSemanticDiffErrorCode = "SEMANTIC_DIFF_REQUIRED" | "SEMANTIC_DIFF_AMBIGUOUS";

export class ManagedSemanticDiffError extends Error {
  readonly code: ManagedSemanticDiffErrorCode;

  constructor(code: ManagedSemanticDiffErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.code = code;
    this.name = "ManagedSemanticDiffError";
  }
}

interface ChangedRegion {
  readonly document: SemanticDiffCandidateDocument;
  readonly baseBody: string;
  readonly candidateBody: string;
  readonly policy: SemanticDiffDocumentPolicy;
  readonly section: SemanticDiffSectionPolicy;
  readonly baseSection: string;
  readonly candidateSection: string;
}

export function readyManagedSemanticDiff(kind: TransparentSemanticKind): ReadySemanticDiffFacet {
  return {
    status: "ready",
    compile: (base, candidate, context) => compileManagedSemanticDiff(kind, base, candidate, context)
  };
}

export function assertManagedSemanticRegions(
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree,
  context: SemanticDiffCompileContext
): void {
  changedRegions(base, candidate, context);
}

function compileManagedSemanticDiff(
  kind: TransparentSemanticKind,
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree,
  context: SemanticDiffCompileContext
): ReadonlyArray<SemanticDiffMutationIntent> {
  const regions = changedRegions(base, candidate, context);
  switch (kind) {
    case "task": return compileTaskRegions(regions, base, candidate);
    case "decision": return compileDecisionRegions(regions);
    case "fact": return compileFactRegions(regions, base, candidate);
    case "relation": return compileRelationRegions(regions, base, candidate);
  }
}

function changedRegions(
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree,
  context: SemanticDiffCompileContext
): ReadonlyArray<ChangedRegion> {
  const baseByPath = documentMap(base);
  const candidateByPath = documentMap(candidate);
  const policyByPath = new Map(context.documentPolicies.map((policy) => [policy.path, policy]));
  const changed: ChangedRegion[] = [];
  for (const filePath of [...new Set([...baseByPath.keys(), ...candidateByPath.keys()])].sort(compareUtf8)) {
    const before = baseByPath.get(filePath)?.body ?? null;
    const after = candidateByPath.get(filePath)?.body ?? null;
    if (before === after) continue;
    if (after === null) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `deletion is not registered: ${filePath}`);
    const policy = policyByPath.get(filePath);
    if (!policy) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `unregistered document: ${filePath}`);
    const baseBody = before ?? "";
    const candidateBody = after!;
    assertUniqueHeadings(baseBody, filePath);
    assertUniqueHeadings(candidateBody, filePath);
    const declared = new Map(policy!.sections.map((section) => [section.anchor, section]));
    const actualAnchors = new Set([
      ...markdownHeadingSections(baseBody).map((section) => section.anchor),
      ...markdownHeadingSections(candidateBody).map((section) => section.anchor)
    ]);
    for (const anchor of actualAnchors) {
      if (!declared.has(anchor)) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `undeclared section ${anchor} in ${filePath}`);
    }
    for (const section of policy!.sections) {
      const baseHas = hasHeading(baseBody, section.anchor);
      const candidateHas = hasHeading(candidateBody, section.anchor);
      if (baseHas !== candidateHas) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `section identity changed: ${filePath} ${section.anchor}`);
      const baseSection = extractMarkdownSection(baseBody, section.anchor);
      const candidateSection = extractMarkdownSection(candidateBody, section.anchor);
      if (baseSection === candidateSection) continue;
      if (section.writeMode === "machine-written") {
        semanticDiffError("SEMANTIC_DIFF_REQUIRED", `machine-written section requires typed command: ${filePath} ${section.anchor}`);
      }
      if (section.writeMode === "forbidden") {
        semanticDiffError("SEMANTIC_DIFF_REQUIRED", `forbidden section changed: ${filePath} ${section.anchor}`);
      }
      if (!section.semanticClass) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `section classification missing: ${filePath} ${section.anchor}`);
      changed.push({
        document: candidateByPath.get(filePath)!,
        baseBody,
        candidateBody,
        policy: policy!,
        section,
        baseSection,
        candidateSection
      });
    }
    if (maskDeclaredSections(baseBody, policy!.sections) !== maskDeclaredSections(candidateBody, policy!.sections)) {
      semanticDiffError("SEMANTIC_DIFF_REQUIRED", `bytes outside declared sections changed: ${filePath}`);
    }
  }
  return changed;
}

function compileTaskRegions(
  regions: ReadonlyArray<ChangedRegion>,
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree
): ReadonlyArray<SemanticDiffMutationIntent> {
  const pathsByTask = new Map<string, string[]>();
  for (const region of regions) {
    if (region.section.semanticClass !== "host-prose-only" || !region.document.path.startsWith("tasks/")) continue;
    const identity = taskIdentityForDocument(region.document.path, base, candidate);
    const paths = pathsByTask.get(identity.taskId) ?? [];
    paths.push(region.document.path);
    pathsByTask.set(identity.taskId, paths);
  }
  return [...pathsByTask.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([taskId, paths]) => {
    const contexts = [...new Set(paths)].sort(compareUtf8).map((documentPath) => taskStorageContext(taskId, documentPath));
    return {
      entityKind: "task",
      identity: { taskId },
      action: "document",
      storageContext: contexts[0],
      ...(contexts.length > 1 ? { additionalStorageContexts: contexts.slice(1) } : {})
    };
  });
}

function compileDecisionRegions(regions: ReadonlyArray<ChangedRegion>): ReadonlyArray<SemanticDiffMutationIntent> {
  const pathsByDecision = new Map<string, string>();
  for (const region of regions) {
    if (region.section.semanticClass !== "host-prose-only" || !region.document.path.startsWith("decisions/")) continue;
    const before = parseDecisionDocument(region.baseBody).decision;
    const after = parseDecisionDocument(region.candidateBody).decision;
    if (JSON.stringify(before) !== JSON.stringify(after) || before.decision_id !== after.decision_id) {
      semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `decision structured fields changed: ${region.document.path}`);
    }
    pathsByDecision.set(after.decision_id, region.document.path);
  }
  return [...pathsByDecision].sort(([left], [right]) => compareUtf8(left, right)).map(([decisionId]) => ({
    entityKind: "decision",
    identity: { decisionId },
    action: "amend"
  }));
}

function compileFactRegions(
  regions: ReadonlyArray<ChangedRegion>,
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree
): ReadonlyArray<SemanticDiffMutationIntent> {
  const mutations: SemanticDiffMutationIntent[] = [];
  for (const region of entityBearingFactRegions(regions)) {
    const { taskId } = taskIdentityForDocument(region.document.path, base, candidate);
    const beforeFacts = strictFacts(region.baseSection, region.document.path);
    const afterFacts = strictFacts(region.candidateSection, region.document.path);
    const beforeById = uniqueBy(beforeFacts, (fact) => fact.fact_id, region.document.path);
    const afterById = uniqueBy(afterFacts, (fact) => fact.fact_id, region.document.path);
    for (const [factId, fact] of beforeById) {
      const next = afterById.get(factId);
      if (!next || JSON.stringify(fact) !== JSON.stringify(next)) {
        semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `fact records are immutable: ${region.document.path} ${factId}`);
      }
    }
    for (const factId of [...afterById.keys()].filter((id) => !beforeById.has(id)).sort(compareUtf8)) {
      mutations.push({
        entityKind: "fact",
        identity: { taskId, factId },
        action: "create",
        storageContext: { documentPath: region.document.path }
      });
    }
    const beforeRelations = uniqueBy(strictFactHostedRelations(region.baseSection, region.document.path, taskId), (relation) => relation.relation_id, region.document.path);
    const afterRelations = uniqueBy(strictFactHostedRelations(region.candidateSection, region.document.path, taskId), (relation) => relation.relation_id, region.document.path);
    for (const [relationId, relation] of afterRelations) {
      if (beforeRelations.has(relationId) || relation.type !== "supersedes-fact" || relation.state !== "active") continue;
      const source = factIdentity(relation.source);
      const target = factIdentity(relation.target);
      if (!source || source.taskId !== taskId || !target || target.taskId !== taskId) {
        semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `invalid fact invalidation relation: ${relationId}`);
      }
      mutations.push({
        entityKind: "fact",
        identity: target,
        action: "invalidate",
        storageContext: { documentPath: region.document.path }
      });
    }
  }
  return uniqueMutations(mutations);
}

function compileRelationRegions(
  regions: ReadonlyArray<ChangedRegion>,
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree
): ReadonlyArray<SemanticDiffMutationIntent> {
  const mutations: SemanticDiffMutationIntent[] = [];
  for (const region of entityBearingFactRegions(regions)) {
    const { taskId } = taskIdentityForDocument(region.document.path, base, candidate);
    const before = uniqueBy(strictFactHostedRelations(region.baseSection, region.document.path, taskId), (relation) => relation.relation_id, region.document.path);
    const after = uniqueBy(strictFactHostedRelations(region.candidateSection, region.document.path, taskId), (relation) => relation.relation_id, region.document.path);
    for (const [relationId, relation] of before) {
      const next = after.get(relationId);
      if (!next) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `relation removal is not registered: ${relationId}`);
      if (JSON.stringify(relation) === JSON.stringify(next)) continue;
      if (relation.state === "active" && next!.state === "retired" && sameExceptState(relation, next!)) {
        mutations.push(relationMutation(next!, "retire", region.document.path));
        continue;
      }
      semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `relation rewrite is ambiguous: ${relationId}`);
    }
    for (const [relationId, relation] of after) {
      if (before.has(relationId)) continue;
      if (relation.state !== "active" || deriveRelationId(relation) !== relation.relation_id) {
        semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `invalid relation create: ${relationId}`);
      }
      mutations.push(relationMutation(relation, "create", region.document.path));
    }
  }
  return uniqueMutations(mutations);
}

function entityBearingFactRegions(regions: ReadonlyArray<ChangedRegion>): ReadonlyArray<ChangedRegion> {
  return regions.filter((region) => region.section.semanticClass === "entity-bearing" && /\/facts\.md$/u.test(region.document.path));
}

function taskIdentityForDocument(
  documentPath: string,
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree
): { readonly taskId: string } {
  const match = /^(tasks\/[^/]+)\//u.exec(documentPath);
  if (!match?.[1]) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `task identity context missing: ${documentPath}`);
  const indexPath = `${match![1]}/INDEX.md`;
  const index = documentMap(candidate).get(indexPath)?.body ?? documentMap(base).get(indexPath)?.body;
  const frontmatter = index ? readFrontmatter(index) : null;
  const taskId = frontmatter ? readScalar(frontmatter, "task_id") : "";
  if (!taskId) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `task identity must come from INDEX.md: ${documentPath}`);
  return { taskId };
}

function taskStorageContext(taskId: string, documentPath: string): Readonly<Record<string, string>> {
  const match = /^(tasks\/[^/]+)\/(.+)$/u.exec(documentPath);
  if (!match?.[1] || !match[2]) semanticDiffError("SEMANTIC_DIFF_REQUIRED", `invalid task document path: ${documentPath}`);
  return { packagePath: match![1], documentPath: match![2], taskId };
}

function strictFacts(section: string, filePath: string): ReadonlyArray<FactRecord> {
  const facts = parseFactFlowRecords(section);
  const parsedIds = new Set(facts.map((fact) => fact.fact_id));
  for (const line of section.split(/\r?\n/u).map((entry) => entry.trim())) {
    if (line.startsWith("-") && !line.startsWith("- {")) {
      semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `unrecognized entity record in ${filePath}`);
    }
    if (/^-\s*\{\s*relation_id:/u.test(line)) continue;
    if (!/^-\s*\{\s*fact_id:/u.test(line)) {
      if (line.startsWith("- {")) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `unrecognized entity record in ${filePath}`);
      continue;
    }
    const id = /(?:^|[,\s{])fact_id:\s*([^,}\s]+)/u.exec(line)?.[1];
    if (!id || !parsedIds.has(id)) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `malformed fact record in ${filePath}`);
  }
  return facts;
}

function strictRelations(section: string, filePath: string): ReadonlyArray<EntityRelationRecord> {
  const relations = parseRelationFlowRecords(section);
  const parsedIds = new Set(relations.map((relation) => relation.relation_id));
  for (const line of section.split(/\r?\n/u).map((entry) => entry.trim())) {
    if (!/^-\s*\{\s*relation_id:/u.test(line)) continue;
    const id = /(?:^|[,\s{])relation_id:\s*([^,}\s]+)/u.exec(line)?.[1];
    if (!id || !parsedIds.has(id)) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `malformed relation record in ${filePath}`);
  }
  return relations;
}

function strictFactHostedRelations(section: string, filePath: string, taskId: string): ReadonlyArray<EntityRelationRecord> {
  const relations = strictRelations(section, filePath);
  for (const relation of relations) {
    const source = factIdentity(relation.source);
    if (!source || source.taskId !== taskId) {
      semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `relation host does not match fact source: ${relation.relation_id}`);
    }
  }
  return relations;
}

function relationMutation(relation: EntityRelationRecord, action: "create" | "retire", documentPath: string): SemanticDiffMutationIntent {
  return {
    entityKind: "relation",
    identity: { relationId: relation.relation_id },
    action,
    storageContext: { sourceRef: relation.source, documentPath }
  };
}

function factIdentity(ref: string): { readonly taskId: string; readonly factId: string } | null {
  const match = /^fact\/([^/]+)\/([^/]+)$/u.exec(ref);
  return match?.[1] && match[2] ? { taskId: match[1], factId: match[2] } : null;
}

function sameExceptState(left: EntityRelationRecord, right: EntityRelationRecord): boolean {
  return JSON.stringify({ ...left, state: undefined }) === JSON.stringify({ ...right, state: undefined });
}

function uniqueMutations(mutations: ReadonlyArray<SemanticDiffMutationIntent>): ReadonlyArray<SemanticDiffMutationIntent> {
  return [...new Map(mutations.map((mutation) => [
    `${mutation.entityKind}\0${JSON.stringify(mutation.identity)}\0${mutation.action}`,
    mutation
  ])).values()];
}

function uniqueBy<T>(values: ReadonlyArray<T>, keyOf: (value: T) => string, filePath: string): ReadonlyMap<string, T> {
  const output = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (output.has(key)) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `duplicate semantic identity ${key} in ${filePath}`);
    output.set(key, value);
  }
  return output;
}

function documentMap(tree: SemanticDiffCandidateTree): ReadonlyMap<string, SemanticDiffCandidateDocument> {
  const output = new Map<string, SemanticDiffCandidateDocument>();
  for (const document of tree.documents) {
    if (output.has(document.path)) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `duplicate candidate path: ${document.path}`);
    output.set(document.path, document);
  }
  return output;
}

function assertUniqueHeadings(body: string, filePath: string): void {
  const headings = body.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^##\s+\S/u.test(line));
  if (new Set(headings).size !== headings.length) semanticDiffError("SEMANTIC_DIFF_AMBIGUOUS", `duplicate heading in ${filePath}`);
}

function hasHeading(body: string, anchor: string): boolean {
  return body.split(/\r?\n/u).some((line) => line.trim() === anchor);
}

function maskDeclaredSections(body: string, sections: ReadonlyArray<SemanticDiffSectionPolicy>): string {
  const declared = new Set(sections.map((section) => section.anchor));
  const output: string[] = [];
  let masking = false;
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^##\s+/u.test(trimmed)) {
      masking = declared.has(trimmed);
      output.push(line);
      continue;
    }
    if (!masking) output.push(line);
  }
  return output.join("\n").trim();
}

function semanticDiffError(code: ManagedSemanticDiffErrorCode, detail: string): never {
  throw new ManagedSemanticDiffError(code, detail);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
