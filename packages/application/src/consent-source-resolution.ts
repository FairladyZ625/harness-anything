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

export function isTranscriptConsentAnchoredToSession(
  source: ConsentSource,
  expectedSessionRef: string
): boolean {
  return source.strength !== "transcript-verified"
    || source.transcript_anchor.session_ref === expectedSessionRef;
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
  return execution.session_bindings.flatMap((binding) => {
    if (!binding.session_ref || !binding.session) return [];
    const expectedSessionRef = `session/${binding.session.sessionId}`;
    if (binding.session_ref !== expectedSessionRef) {
      throw new Error(`execution binding session_ref must equal session/<sessionId>; expected ${expectedSessionRef}`);
    }
    return [{ source: "execution-bound", sessionRef: binding.session_ref, session: binding.session }];
  });
}

export function reviewCurrentConsentTranscriptCandidate(input: {
  readonly execution: ExecutionRecord;
  readonly session: CurrentSessionRef;
  readonly reviewedAt: string;
  readonly ttlMs: number;
}): ConsentTranscriptCandidate {
  const submittedAt = Date.parse(input.execution.submitted_at ?? "");
  const reviewedAt = Date.parse(input.reviewedAt);
  if (!Number.isFinite(submittedAt) || !Number.isFinite(reviewedAt)
    || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("review-current transcript verification has an invalid timestamp window");
  }
  const notBefore = Math.max(submittedAt, reviewedAt - input.ttlMs);
  if (!Number.isFinite(notBefore) || notBefore > reviewedAt) {
    throw new Error("review-current transcript verification has an invalid timestamp window");
  }
  return {
    source: "review-current",
    sessionRef: `session/${input.session.sessionId}`,
    session: input.session,
    timestampWindow: {
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(reviewedAt).toISOString()
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
  if (startsWithConsentDenial(utterance)) {
    // This is intentionally only defense in depth. Complete semantic protection
    // requires a server-issued challenge/nonce, which is a separate product decision.
    throw new Error([
      "transcript consent utterance starts with a denial phrase and cannot authorize this action.",
      "Ask the human to send a separate standalone confirmation message containing the target execution id, then pass that complete message."
    ].join(" "));
  }
  const candidates = prioritizedTranscriptCandidates(input.transcriptCandidates);
  if (candidates.length === 0) {
    throw new Error("transcript verification requires a bound execution session; choose standing-policy or asserted consent explicitly");
  }

  let hasTranscriptCapableRuntime = false;
  let hasReadableTranscript = false;
  let canonicalSessionRejection: { readonly requested: string; readonly canonical: string } | null = null;
  let timestampRejection: "missing" | "invalid-timestamp" | "invalid-window" | "outside-window" | "unreliable-compaction" | null = null;
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
    if (conversation.canonicalSessionId && conversation.canonicalSessionId !== session.sessionId) {
      canonicalSessionRejection = {
        requested: session.sessionId,
        canonical: conversation.canonicalSessionId
      };
      continue;
    }
    const messageIndex = conversation.messages.findIndex((message) => {
      if (message.role !== "user" || message.rawText.trim() !== utterance) return false;
      if (candidate.source === "execution-bound") return true;
      if (message.timestampReliability === "unreliable-compaction") {
        timestampRejection = "unreliable-compaction";
        return false;
      }
      if (!message.timestamp) {
        timestampRejection = "missing";
        return false;
      }
      const timestamp = Date.parse(message.timestamp);
      const notBefore = Date.parse(candidate.timestampWindow.notBefore);
      const notAfter = Date.parse(candidate.timestampWindow.notAfter);
      if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > notAfter) {
        timestampRejection = "invalid-window";
        return false;
      }
      if (!Number.isFinite(timestamp)) {
        timestampRejection = "invalid-timestamp";
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
          message_sha256: `sha256:${sha256Text(message.rawText.trim())}`,
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
  if (canonicalSessionRejection) {
    throw new Error(
      `bound session ref ${canonicalSessionRejection.requested} does not equal the transcript's canonical session identity ${canonicalSessionRejection.canonical}; rebind the exact canonical session before requesting consent`
    );
  }
  if (timestampRejection === "missing") {
    throw new Error("review-current consent utterance requires a reliable transcript timestamp; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "invalid-timestamp") {
    throw new Error("review-current consent utterance has an invalid transcript timestamp; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "invalid-window") {
    throw new Error("review-current consent utterance has an invalid timestamp window; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "unreliable-compaction") {
    throw new Error("review-current consent utterance uses a compaction-derived timestamp that is unreliable; choose standing-policy or asserted consent explicitly");
  }
  if (timestampRejection === "outside-window") {
    throw new Error("review-current consent utterance falls outside the execution submission and review window; choose standing-policy or asserted consent explicitly");
  }
  throw new Error([
    "consent utterance was not found in any bound session transcript user turn as a complete message.",
    "The utterance must equal the human's complete message after trimming; ask the human to send a separate standalone confirmation message containing the target execution id and pass that whole message.",
    "Choose standing-policy or asserted consent explicitly only when that source accurately describes the approval."
  ].join(" "));
}

function prioritizedTranscriptCandidates(
  candidates: ReadonlyArray<ConsentTranscriptCandidate>
): ReadonlyArray<ConsentTranscriptCandidate> {
  const selected = new Map<string, ConsentTranscriptCandidate>();
  for (const candidate of candidates) {
    const expectedSessionRef = `session/${candidate.session.sessionId}`;
    if (candidate.sessionRef !== expectedSessionRef) {
      throw new Error(`consent transcript candidate session_ref must equal session/<sessionId>; expected ${expectedSessionRef}`);
    }
    const key = `${candidate.session.runtime}\0${candidate.session.sessionId}`;
    const existing = selected.get(key);
    if (!existing || candidate.source === "review-current") selected.set(key, candidate);
  }
  return [...selected.values()];
}

function isRuntime(value: string): value is CurrentSessionRuntime {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}

function startsWithConsentDenial(utterance: string): boolean {
  return /^(?:do\s+not|don't|dont|never)\b/iu.test(utterance)
    || /^(?:不要|不同意|别|不批准|不授权|拒绝)/u.test(utterance);
}
