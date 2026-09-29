import type { CanonicalEventV1 } from "@harness-anything/kernel";

export type CanonicalEventSummary = Readonly<Record<string, unknown>> & {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId?: string;
  readonly factId?: string;
  readonly decisionId?: string;
  readonly actor?: { readonly executor?: { readonly id: string } };
  readonly payload: Readonly<Record<string, unknown>>;
};

const SUMMARY_TEXT_LIMIT = 280;

/** The list-row projection of a canonical event. Large event-specific payloads never cross the RPC boundary. */
export function canonicalEventSummary(event: CanonicalEventV1): CanonicalEventSummary {
  const source = event as unknown as Readonly<Record<string, unknown>>,
    payload = recordOf(source.payload),
    actor = recordOf(source.actor),
    executor = recordOf(actor?.executor),
    witness = recordOf(payload?.witness),
    review = recordOf(payload?.review),
    documentClaims = Array.isArray(payload?.documentClaims)
      ? payload.documentClaims.flatMap((claim) => {
          const path = textOf(recordOf(claim)?.path);
          return path === undefined ? [] : [{ path }];
        })
      : undefined;
  return {
    eventId: String(source.eventId),
    schema: String(source.schema),
    type: String(source.type),
    occurredAt: String(source.occurredAt),
    workspaceRevision: Number(source.workspaceRevision),
    ...optionalText("taskId", source.taskId),
    ...optionalText("factId", source.factId),
    ...optionalText("decisionId", source.decisionId),
    ...(executor && textOf(executor.id) ? { actor: { executor: { id: textOf(executor.id)! } } } : {}),
    payload: compact({
      taskId: textOf(payload?.taskId),
      statement: clippedText(payload?.statement),
      text: clippedText(payload?.text),
      title: clippedText(payload?.title),
      runtimeSessionId: textOf(payload?.runtimeSessionId),
      instanceId: textOf(payload?.instanceId),
      entityKind: textOf(payload?.entityKind),
      entityId: textOf(payload?.entityId),
      witness:
        witness === undefined ? undefined : compact({ gateId: textOf(witness.gateId), result: textOf(witness.result) }),
      review: review === undefined ? undefined : compact({ verdict: textOf(review.verdict) }),
      documentClaims,
    }),
  };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clippedText(value: unknown): string | undefined {
  const text = textOf(value);
  return text === undefined ? undefined : text.slice(0, SUMMARY_TEXT_LIMIT);
}

function optionalText<Key extends "taskId" | "factId" | "decisionId">(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const text = textOf(value);
  return text === undefined ? {} : ({ [key]: text } as Partial<Record<Key, string>>);
}

function compact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
