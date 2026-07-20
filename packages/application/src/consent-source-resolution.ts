import { Effect } from "effect";
import {
  sha256Text,
  type ConsentResponse,
  type ConsentSource,
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
  readonly execution: ExecutionRecord;
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
  const bindings = input.execution.session_bindings.filter((binding) => binding.session_ref && binding.session);
  if (bindings.length === 0) {
    throw new Error("transcript verification requires a bound execution session; choose standing-policy or asserted consent explicitly");
  }

  let hasTranscriptCapableRuntime = false;
  let hasReadableTranscript = false;
  const structuralRuntimes = new Set<string>();
  for (const binding of bindings) {
    const session = binding.session!;
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
    const messageIndex = conversation.messages.findIndex((message) => message.role === "user" && message.text.includes(utterance));
    if (messageIndex < 0) continue;
    const message = conversation.messages[messageIndex]!;
    const sessionRef = binding.session_ref!;
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
  throw new Error("consent utterance was not found in any bound session transcript user turn; choose standing-policy or asserted consent explicitly");
}

function isRuntime(value: string): value is CurrentSessionRuntime {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}
