import { Effect } from "effect";
import {
  sha256Text,
  type ConsentResponse,
  type ConsentSource,
  type CurrentSessionRef,
  type CurrentSessionRuntime,
  type ExecutionRecord,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import { readDecisionDocument } from "./decision-document-reader.ts";
import {
  resolveRuntimeConversation,
  type RuntimeLogOptions
} from "./runtime-session-logs.ts";

export type ConsentSourceRequest =
  | { readonly kind: "utterance"; readonly utterance: string }
  | { readonly kind: "standing-policy"; readonly decisionId: string }
  | { readonly kind: "asserted"; readonly rationale: string };

export interface ResolvedConsentAuthorization {
  readonly source: Exclude<ConsentSource, { readonly strength: "legacy-unrecorded" }>;
  readonly response: ConsentResponse;
}

interface ConsentTranscriptSession {
  readonly runtime: string;
  readonly sessionId: string;
  readonly source: string;
  readonly detectedAt: string;
  readonly user?: string;
}

export type ConsentTranscriptCandidate =
  | {
      readonly source: "execution-bound";
      readonly sessionRef: string;
      readonly session: ConsentTranscriptSession;
    }
  | {
      readonly source: "review-current";
      readonly sessionRef: string;
      readonly session: ConsentTranscriptSession;
      readonly timestampWindow: {
        readonly notBefore: string;
        readonly notAfter: string;
      };
    };

export function executionBoundConsentTranscriptCandidates(
  execution: ExecutionRecord
): ReadonlyArray<ConsentTranscriptCandidate> {
  return execution.session_bindings.flatMap((binding) =>
    binding.session_ref && binding.session
      ? [{ source: "execution-bound", sessionRef: binding.session_ref, session: binding.session }]
      : []);
}

export function reviewCurrentConsentTranscriptCandidate(input: {
  readonly execution: ExecutionRecord;
  readonly session: CurrentSessionRef;
  readonly reviewedAt: string;
}): ConsentTranscriptCandidate {
  if (!input.execution.submitted_at) {
    throw new Error("review-current transcript verification requires an execution submission timestamp");
  }
  return {
    source: "review-current",
    sessionRef: `session/${input.session.sessionId}`,
    session: input.session,
    timestampWindow: {
      notBefore: input.execution.submitted_at,
      notAfter: input.reviewedAt
    }
  };
}

export function consentSourceRequest(input: {
  readonly utterance?: string | null;
  readonly standingPolicyDecisionId?: string | null;
  readonly assertedRationale?: string | null;
}): ConsentSourceRequest {
  const requests: ConsentSourceRequest[] = [
    ...(input.utterance ? [{ kind: "utterance" as const, utterance: input.utterance }] : []),
    ...(input.standingPolicyDecisionId ? [{ kind: "standing-policy" as const, decisionId: input.standingPolicyDecisionId }] : []),
    ...(input.assertedRationale ? [{ kind: "asserted" as const, rationale: input.assertedRationale }] : [])
  ];
  if (requests.length !== 1) {
    throw new Error("consent requires exactly one source: transcript utterance, standing-policy decision, or asserted rationale");
  }
  return requests[0]!;
}

export async function resolveConsentAuthorization(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly transcriptCandidates: ReadonlyArray<ConsentTranscriptCandidate>;
  readonly request: ConsentSourceRequest;
  readonly runtimeLogOptions?: RuntimeLogOptions;
}): Promise<ResolvedConsentAuthorization> {
  if (input.request.kind === "standing-policy") {
    const decisionId = input.request.decisionId.trim();
    if (!decisionId) throw new Error("standing-policy consent requires a decision id");
    let decision;
    try {
      decision = (await Effect.runPromise(readDecisionDocument(input.rootInput, decisionId))).decision;
    } catch {
      throw new Error(`standing-policy consent decision not found: ${decisionId}`);
    }
    if (decision.state !== "active") {
      throw new Error(`standing-policy consent requires an active decision; ${decisionId} is ${decision.state}`);
    }
    return {
      source: { strength: "standing-policy", decision_ref: `decision/${decisionId}` },
      response: { kind: "authorization-declaration", source: "standing-policy" }
    };
  }

  if (input.request.kind === "asserted") {
    const rationale = input.request.rationale.trim();
    if (!rationale) throw new Error("asserted consent requires an explicit rationale");
    return {
      source: { strength: "asserted", rationale },
      response: { kind: "authorization-declaration", source: "asserted" }
    };
  }

  const utterance = input.request.utterance.trim();
  if (!utterance) throw new Error("transcript consent requires a non-empty utterance");
  const candidates = prioritizedTranscriptCandidates(input.transcriptCandidates);
  if (candidates.length === 0) {
    throw new Error("transcript verification requires a bound execution session; choose standing-policy or asserted consent explicitly");
  }

  let hasTranscriptCapableRuntime = false;
  let hasReadableTranscript = false;
  let timestampRejection: "missing" | "outside-window" | null = null;
  const structuralRuntimes = new Set<string>();
  for (const candidate of candidates) {
    const session = candidate.session;
    if (!isRuntime(session.runtime) || session.runtime === "human" || session.runtime === "antigravity") {
      structuralRuntimes.add(session.runtime);
      continue;
    }
    hasTranscriptCapableRuntime = true;
    const conversation = await Effect.runPromise(resolveRuntimeConversation({
      schema: "provenance-session/v1",
      sessionId: session.sessionId,
      runtime: session.runtime,
      source: session.source === "manual" ? "manual" : "runtime",
      detectedAt: session.detectedAt,
      exportedAt: session.detectedAt,
      ...(session.user ? { user: session.user } : {})
    }, input.runtimeLogOptions ?? {}));
    if (conversation.messages.length > 0) hasReadableTranscript = true;
    const messageIndex = conversation.messages.findIndex((message) => {
      if (message.role !== "user" || !message.text.includes(utterance)) return false;
      if (candidate.source === "execution-bound") return true;
      if (!message.timestamp) {
        timestampRejection = "missing";
        return false;
      }
      const timestamp = Date.parse(message.timestamp);
      const notBefore = Date.parse(candidate.timestampWindow.notBefore);
      const notAfter = Date.parse(candidate.timestampWindow.notAfter);
      if (!Number.isFinite(timestamp) || !Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
        timestampRejection = "missing";
        return false;
      }
      if (timestamp < notBefore || timestamp > notAfter) {
        timestampRejection = "outside-window";
        return false;
      }
      return true;
    });
    if (messageIndex < 0) continue;
    const message = conversation.messages[messageIndex]!;
    const sessionRef = candidate.sessionRef;
    return {
      source: {
        strength: "transcript-verified",
        transcript_anchor: {
          session_ref: sessionRef,
          message_index: messageIndex,
          role: "user",
          message_sha256: `sha256:${sha256Text(message.text)}`,
          ...(message.timestamp ? { timestamp: message.timestamp } : {})
        }
      },
      response: { kind: "utterance", text: utterance, session_ref: sessionRef }
    };
  }

  if (!hasTranscriptCapableRuntime) {
    const runtimes = [...structuralRuntimes].sort().join(", ") || "unknown";
    throw new Error(`bound runtime (${runtimes}) structurally does not produce a verifiable transcript; choose standing-policy or asserted consent explicitly`);
  }
  if (!hasReadableTranscript) {
    throw new Error("bound session transcript is unavailable; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "missing") {
    throw new Error("review-current consent utterance requires a reliable transcript timestamp; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "outside-window") {
    throw new Error("review-current consent utterance falls outside the execution submission and review window; choose standing-policy or asserted consent explicitly");
  }
  throw new Error("consent utterance was not found in any bound session transcript user turn; choose standing-policy or asserted consent explicitly");
}

function prioritizedTranscriptCandidates(
  candidates: ReadonlyArray<ConsentTranscriptCandidate>
): ReadonlyArray<ConsentTranscriptCandidate> {
  const reviewCurrentRefs = new Set(candidates
    .filter((candidate) => candidate.source === "review-current")
    .map((candidate) => candidate.sessionRef));
  return candidates.filter((candidate) =>
    candidate.source === "review-current" || !reviewCurrentRefs.has(candidate.sessionRef));
}

function isRuntime(value: string): value is CurrentSessionRuntime {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}
