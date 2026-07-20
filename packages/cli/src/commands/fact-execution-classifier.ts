import { readFileSync } from "node:fs";
import path from "node:path";
import { relativePath } from "../cli/path.ts";
import {
  buildRelationGraphProjection,
  listTaskIndexPaths,
  parseFactFlowRecords,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  type FactRecord,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export const deliveryEvidenceTerms = [
  "pull-request", "merged", "ci", "test-pass", "check-pass", "commit-sha", "diff", "screenshot", "report"
] as const;

export type DeliveryEvidenceTerm = typeof deliveryEvidenceTerms[number];

export interface FactExecutionCandidate {
  readonly taskId: string;
  readonly taskStatus: string;
  readonly taskPath: string;
  readonly factsPath: string;
  readonly fact: FactRecord;
  readonly factRef: string;
  readonly signals: {
    readonly orphan: true;
    readonly episodic: boolean;
    readonly deliveryWording: boolean;
    readonly matchedTerms: ReadonlyArray<DeliveryEvidenceTerm>;
  };
  readonly classification: "automatic" | "manual" | "bearing_observation";
}

export interface FactExecutionClassification {
  readonly scannedFacts: number;
  readonly referencedFacts: number;
  readonly alreadyMigrated: number;
  readonly orphans: ReadonlyArray<FactExecutionCandidate>;
  readonly automatic: ReadonlyArray<FactExecutionCandidate>;
  readonly manual: ReadonlyArray<FactExecutionCandidate>;
  readonly bearingObservations: ReadonlyArray<FactExecutionCandidate>;
}

const deliveryPatterns: ReadonlyArray<readonly [DeliveryEvidenceTerm, RegExp]> = [
  ["pull-request", /(?:\bpr\s*#?\d+\b|pull[ -]?request|合并请求)/iu],
  ["merged", /(?:\bmerged?\b|\bmerge[ -]?commit\b|已合入|合入\s*main|合并完成)/iu],
  ["ci", /(?:\bci\b|rewrite-ci|github actions?|流水线)/iu],
  ["test-pass", /(?:\btests?\s+(?:all\s+)?pass(?:ed|ing)?\b|测试(?:已)?通过|测试全绿|验绿)/iu],
  ["check-pass", /(?:npm\s+run\s+check|\bcheck(?::local)?\s+(?:pass(?:ed)?|green)\b|(?:gate|checks?)\s+(?:all\s+)?green|全(?:量)?\s*(?:check|gate).*通过)/iu],
  ["commit-sha", /(?:\bcommit\b|\b(?:merge|work)=?[0-9a-f]{7,40}\b|\b[0-9a-f]{40}\b|提交(?:哈希|记录)?)/iu],
  ["diff", /(?:\bdiff\b|差异(?:文件|清单)?)/iu],
  ["screenshot", /(?:screenshots?|截图)/iu],
  ["report", /(?:\breports?\b|报告)/iu]
];

export function matchDeliveryEvidenceTerms(statement: string): ReadonlyArray<DeliveryEvidenceTerm> {
  return deliveryPatterns.filter(([, pattern]) => pattern.test(statement)).map(([term]) => term);
}

export function classifyFactExecutionCandidates(rootInput: HarnessLayoutInput): FactExecutionClassification {
  const layout = resolveHarnessLayout(rootInput);
  const referenced = new Set(buildRelationGraphProjection(rootInput).edges
    .filter((edge) => edge.state === "active" && edge.relationType === "evidenced-by" && edge.targetRef.startsWith("fact/"))
    .map((edge) => edge.targetRef));
  const orphans: FactExecutionCandidate[] = [];
  let scannedFacts = 0;
  let alreadyMigrated = 0;

  for (const indexPath of listTaskIndexPaths(rootInput)) {
    const taskDir = path.dirname(indexPath);
    const indexBody = readFileSync(indexPath, "utf8");
    const frontmatter = readFrontmatter(indexBody);
    const taskId = frontmatter ? readScalar(frontmatter, "task_id") : undefined;
    if (!taskId) continue;
    const factsPath = path.join(taskDir, layout.factDocumentName);
    let factsBody: string;
    try {
      factsBody = readFileSync(factsPath, "utf8");
    } catch {
      continue;
    }
    for (const fact of parseFactFlowRecords(factsBody)) {
      scannedFacts += 1;
      if (fact.migration?.state === "migrated") {
        alreadyMigrated += 1;
      }
      const factRef = `fact/${taskId}/${fact.fact_id}`;
      if (referenced.has(factRef)) continue;
      const matchedTerms = matchDeliveryEvidenceTerms(fact.statement);
      const episodic = fact.memoryClass === "episodic";
      const deliveryWording = matchedTerms.length > 0;
      const classification = episodic && deliveryWording
        ? "automatic"
        : episodic || deliveryWording ? "manual" : "bearing_observation";
      orphans.push({
        taskId,
        taskStatus: readTaskStatus(frontmatter),
        taskPath: relativePath(layout.rootDir, taskDir),
        factsPath: relativePath(layout.rootDir, factsPath),
        fact,
        factRef,
        signals: { orphan: true, episodic, deliveryWording, matchedTerms },
        classification
      });
    }
  }

  orphans.sort((left, right) => left.factRef.localeCompare(right.factRef));
  return {
    scannedFacts,
    referencedFacts: scannedFacts - orphans.length,
    alreadyMigrated,
    orphans,
    automatic: orphans.filter((candidate) => candidate.classification === "automatic"),
    manual: orphans.filter((candidate) => candidate.classification === "manual"),
    bearingObservations: orphans.filter((candidate) => candidate.classification === "bearing_observation")
  };
}

function readTaskStatus(frontmatter: string | null): string {
  return frontmatter?.match(/^\s+status:\s*(\S+)/mu)?.[1] ?? "unknown";
}
