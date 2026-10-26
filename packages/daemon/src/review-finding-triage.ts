import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  reviewFindingDispositions,
  reviewFindingThresholdsFor,
  reviewFindingTriageQuestion,
  reviewFindingTriageQuestionVersion,
  settleReviewFindings,
  stableStringify,
  type AdvisoryDecision,
  type DecisionPortFailureCode,
  type DecisionProviderRecord,
  type DecisionRequest,
  type ReviewFindingSettlement,
  type ReviewFindingThresholds,
  type ReviewFindingTriageV1,
  type SettleableReviewFinding,
} from "@harness-anything/kernel";
import { writeFileDurably } from "./durable-file.ts";

/**
 * The center's per-finding triage and settlement (dec_6A77D43B8523823ABA1F5E4D3C CH3/CH6).
 *
 * One implementation asks the Decisions API about one finding at a time, buys at most one Critic on
 * a different canonical model, then settles the whole cut with the shared `settleReviewFindings`
 * rule. Task review and Decision review both call it; neither carries a second judgment.
 *
 * Multiple edge nodes may submit the same finding's evidence at once. The claim is
 * `(targetDigest, targetType, targetId, reviewId, findingId)`-keyed: the first arrival runs the
 * query, every later arrival reads that record instead of paying for or double-counting a second
 * answer. A different digest is a different cut and mints its own claim, so an old answer can never
 * settle a new one.
 */

const storeSchema = "review-finding-triage-store/v1" as const;

export type ReviewTargetKind = "task" | "decision";

export interface ReviewTriageTarget {
  readonly kind: ReviewTargetKind;
  readonly id: string;
  /** The cut's content digest; a settled record only ever answers for the digest it names. */
  readonly digest: `sha256:${string}`;
}

export type ReviewTriageStoreRecord = ReviewFindingTriageV1 & {
  readonly target: ReviewTriageTarget;
  readonly thresholds: ReviewFindingThresholds;
  readonly rulesVersion: string;
  /** The frozen input digest the answer was computed from, so a reused claim is visible as reused. */
  readonly inputDigest: `sha256:${string}`;
};

interface TriageFile {
  readonly schema: typeof storeSchema;
  readonly records: readonly ReviewTriageStoreRecord[];
}

type DecisionPort = {
  readonly decide: (request: DecisionRequest) => Promise<AdvisoryDecision>;
};

const reviewFindingTriageQuestionFor = reviewFindingTriageQuestion;

/** Absolute path of the center's triage journal for one repository. */
export function reviewTriageStorePath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "review-finding-triage.json");
}

/**
 * Every triage record the center has minted for this repository, without opening the writer.
 *
 * The closeout judgment is a read: it must not need a Decisions provider, and it must not create the
 * journal as a side effect of being asked. A missing or unreadable file is therefore "no records
 * yet" — the same answer a fresh repository gives — never an implicit pass (a finding with no
 * record escalates in `settleReviewFindings`).
 */
export function readReviewTriageRecords(rootDir: string): readonly ReviewTriageStoreRecord[] {
  const target = reviewTriageStorePath(rootDir);
  if (!existsSync(target)) return [];
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<TriageFile>;
    return parsed.schema === storeSchema && Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

/** The model identity a Critic must differ from; null when the provider names no model. */
export interface CriticCandidate {
  readonly providerId: string;
  readonly model: string;
}

export function openReviewFindingTriage(input: {
  readonly rootDir: string;
  readonly providers: { readonly list: () => readonly DecisionProviderRecord[]; readonly port: DecisionPort };
  readonly now: () => string;
  /** Providers the Critic may use, already filtered to a different canonical model. */
  readonly critics?: readonly CriticCandidate[];
  readonly rulesVersion: string;
}) {
  const target = path.join(resolveHarnessLayout(input.rootDir).localRoot, "review-finding-triage.json");
  const read = (): TriageFile =>
    existsSync(target)
      ? (JSON.parse(readFileSync(target, "utf8")) as TriageFile)
      : { schema: storeSchema, records: [] };
  const write = (records: readonly ReviewTriageStoreRecord[]): void =>
    writeFileDurably(target, `${JSON.stringify({ schema: storeSchema, records }, null, 2)}\n`, 0o600);
  let tail = Promise.resolve();
  const enqueue = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const claimKey = (
    finding: { readonly reviewId: string; readonly findingId: string },
    target: ReviewTriageTarget,
  ): string =>
    createHash("sha256")
      .update(
        stableStringify({
          digest: target.digest,
          kind: target.kind,
          id: target.id,
          reviewId: finding.reviewId,
          findingId: finding.findingId,
        }),
        "utf8",
      )
      .digest("hex");

  const findingInput = (finding: SettleableReviewFinding, target: ReviewTriageTarget): string =>
    stableStringify({
      target: { kind: target.kind, id: target.id, digest: target.digest },
      finding: {
        reviewId: finding.reviewId,
        findingId: finding.findingId,
        category: finding.category,
        label: finding.label,
        text: finding.text,
        reviewerBlocking: finding.reviewerBlocking,
        evidence: finding.evidence ?? null,
        priorFindingRefs: finding.priorFindingRefs ?? [],
      },
      rulesVersion: input.rulesVersion,
    });

  const ask = async (
    finding: SettleableReviewFinding,
    target: ReviewTriageTarget,
    provider: DecisionProviderRecord,
    state: string,
  ): Promise<ReviewFindingTriageV1> => {
    const answer = await input.providers.port.decide({
      subjectRef: `${target.kind}/${target.id}/finding/${finding.reviewId}/${finding.findingId}`,
      providerId: provider.providerId,
      questionSetVersion: reviewFindingTriageQuestionVersion,
      state: [state],
      question: reviewFindingTriageQuestionFor as never,
    });
    if (
      answer.questionType !== "choice" ||
      !(reviewFindingDispositions as readonly string[]).includes(answer.result.selected)
    )
      throw Object.assign(new Error("The Decisions provider did not return one of the five finding dispositions."), {
        code: "decision_protocol_invalid" satisfies DecisionPortFailureCode,
      });
    return {
      schema: "review-finding-triage/v1",
      reviewId: finding.reviewId,
      findingId: finding.findingId,
      targetDigest: target.digest,
      selected: answer.result.selected as ReviewFindingTriageV1["selected"],
      probabilities: {
        blocker: answer.distribution.blocker ?? 0,
        non_blocking: answer.distribution.non_blocking ?? 0,
        nit: answer.distribution.nit ?? 0,
        pre_existing: answer.distribution.pre_existing ?? 0,
        false_positive: answer.distribution.false_positive ?? 0,
      },
      model: answer.provider.resolvedModel,
      bindingDigest: target.digest,
      decidedAt: input.now(),
    };
  };

  return {
    async settle(cut: {
      readonly target: ReviewTriageTarget;
      readonly findings: readonly SettleableReviewFinding[];
      readonly thresholds?: ReviewFindingThresholds | undefined;
    }): Promise<{
      readonly settlement: ReviewFindingSettlement;
      readonly records: readonly ReviewTriageStoreRecord[];
      readonly reused: readonly string[];
    }> {
      const provider = input.providers.list().find((candidate) => candidate.enabled);
      const thresholds = reviewFindingThresholdsFor(cut.thresholds),
        settled: ReviewTriageStoreRecord[] = [],
        reused: string[] = [];
      for (const finding of cut.findings) {
        const key = claimKey(finding, cut.target),
          existing = read().records.find(
            (record) => claimKey(record, record.target) === key && record.target.digest === cut.target.digest,
          );
        if (existing !== undefined) {
          settled.push(existing);
          reused.push(existing.findingId);
          continue;
        }
        if (provider === undefined)
          throw Object.assign(
            new Error(
              "No enabled Decisions provider is configured, so review findings cannot be triaged; " +
                "settlement would have to guess.",
            ),
            { code: "provider_not_found" satisfies DecisionPortFailureCode },
          );
        const record = await enqueue(async () => {
          // Re-read inside the queue: two nodes can arrive here together for the same claim.
          const current = read().records.find((candidate) => claimKey(candidate, candidate.target) === key);
          if (current !== undefined) return current;
          let triage = await ask(finding, cut.target, provider, findingInput(finding, cut.target));
          const maximum = Math.max(...reviewFindingDispositions.map((value) => triage.probabilities[value] ?? 0)),
            floor = thresholds[finding.category as keyof typeof thresholds] ?? 1,
            contested =
              maximum < floor ||
              (triage.selected !== "blocker" && (finding.reviewerBlocking || finding.category === "data-loss"));
          const critic = contested ? input.critics?.find(({ model }) => model !== triage.model) : undefined;
          if (critic !== undefined) {
            const providerForCritic =
              input.providers.list().find((candidate) => candidate.providerId === critic.providerId) ?? provider;
            const second = await ask(finding, cut.target, providerForCritic, findingInput(finding, cut.target));
            triage = {
              ...triage,
              critic: {
                selected: second.selected,
                probabilities: second.probabilities,
                model: second.model,
                bindingDigest: second.bindingDigest,
                decidedAt: second.decidedAt,
              },
            };
          }
          const stored: ReviewTriageStoreRecord = {
            ...triage,
            target: cut.target,
            thresholds: cut.thresholds ?? {},
            rulesVersion: input.rulesVersion,
            inputDigest: `sha256:${createHash("sha256").update(findingInput(finding, cut.target), "utf8").digest("hex")}`,
          };
          write([...read().records, stored]);
          return stored;
        });
        settled.push(record);
      }
      return {
        settlement: settleReviewFindings({ findings: cut.findings, triages: settled, thresholds: cut.thresholds }),
        records: settled,
        reused,
      };
    },
    async read(target: ReviewTriageTarget): Promise<readonly ReviewTriageStoreRecord[]> {
      return read().records.filter(
        (record) =>
          record.target.kind === target.kind &&
          record.target.id === target.id &&
          record.target.digest === target.digest,
      );
    },
    target,
  };
}
