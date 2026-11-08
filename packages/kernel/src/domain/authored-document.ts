import {
  assessAuthoredDocumentReadiness,
  type AuthoredDocumentReadiness,
  type MarkdownDocumentContract,
  type TransitionDocumentKind,
} from "./transition-document-readiness.ts";
import type { ActorIdentity, EventEnvelope, WriteSource } from "./write-chain.contract.ts";

/**
 * AuthoredDocument aggregate (dec_6B912A63D279A922FA1288536D CH1; design task_897787c1 §2, slice 2).
 *
 * The aggregate owns a document's identity, canonical revision, kind and owner, the claim of its
 * canonical content, the readiness outcome of that content, and its retirement. It does not own
 * markdown bytes, filesystem paths of a checkout, Task lifecycle, or edge transport: the
 * application reads the claimed blob and hands its body to `decideAuthoredDocument`, which judges
 * readiness through the single kernel judgment and returns the events to append. Replay folds those
 * events through `applyAuthoredDocumentEvent` without re-judging content.
 */
export const authoredDocumentEventTypes = [
  "authored_document_registered",
  "authored_document_revised",
  "authored_document_retired",
] as const;
export type AuthoredDocumentEventType = (typeof authoredDocumentEventTypes)[number];

/** The canonical blob the current revision's readiness was judged against. */
export interface AuthoredDocumentContentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface AuthoredDocumentRetirement {
  readonly revision: number;
  readonly opId: string;
}

export interface AuthoredDocumentState {
  readonly documentId: string;
  readonly kind: TransitionDocumentKind;
  /** Entity id of the owner the document belongs to, e.g. the task id of a `task.plan`. */
  readonly owner: string;
  /** Canonical document revision: 1 at registration, +1 per accepted event. */
  readonly revision: number;
  readonly content: AuthoredDocumentContentClaim | null;
  readonly readiness: AuthoredDocumentReadiness;
  readonly retirement: AuthoredDocumentRetirement | null;
  /** Idempotency keys: every accepted opId and the revision it produced. */
  readonly appliedOps: Readonly<Record<string, number>>;
}

interface AuthoredDocumentCommandMeta {
  readonly documentId: string;
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}

export type AuthoredDocumentCommand =
  | (AuthoredDocumentCommandMeta & {
      readonly type: "register";
      readonly kind: TransitionDocumentKind;
      readonly owner: string;
    })
  | (AuthoredDocumentCommandMeta & {
      readonly type: "revise";
      /** The canonical revision the author's change is based on. */
      readonly expectedRevision: number;
      readonly content: AuthoredDocumentContentClaim;
      /** The claimed blob's body, read by the application; never persisted in the event. */
      readonly body: string;
      readonly contract?: MarkdownDocumentContract;
    })
  | (AuthoredDocumentCommandMeta & {
      readonly type: "retire";
      readonly expectedRevision: number;
    });

interface RegisteredPayload {
  readonly documentId: string;
  readonly revision: number;
  readonly kind: TransitionDocumentKind;
  readonly owner: string;
  readonly readiness: AuthoredDocumentReadiness;
}
interface RevisedPayload {
  readonly documentId: string;
  readonly revision: number;
  readonly content: AuthoredDocumentContentClaim;
  readonly readiness: AuthoredDocumentReadiness;
}
interface RetiredPayload {
  readonly documentId: string;
  readonly revision: number;
  readonly readiness: AuthoredDocumentReadiness;
}
type AuthoredDocumentEnvelope<T extends AuthoredDocumentEventType, P> = EventEnvelope<
  "authored-document-event/v1",
  T,
  ActorIdentity,
  P
>;
export type AuthoredDocumentEventV1 =
  | AuthoredDocumentEnvelope<"authored_document_registered", RegisteredPayload>
  | AuthoredDocumentEnvelope<"authored_document_revised", RevisedPayload>
  | AuthoredDocumentEnvelope<"authored_document_retired", RetiredPayload>;

export type AuthoredDocumentRejectionCode = "not_registered" | "already_registered" | "stale_base" | "retired";

export type AuthoredDocumentDecision =
  | { readonly outcome: "accepted"; readonly events: readonly AuthoredDocumentEventV1[] }
  /** The opId was already accepted: a retry is a no-op that names the revision it produced. */
  | { readonly outcome: "duplicate"; readonly revision: number }
  | { readonly outcome: "rejected"; readonly code: AuthoredDocumentRejectionCode; readonly message: string };

/** Decide one command against the current state (`null` before registration). Pure: no I/O. */
export function decideAuthoredDocument(
  state: AuthoredDocumentState | null,
  command: AuthoredDocumentCommand,
): AuthoredDocumentDecision {
  const applied =
    state !== null && Object.hasOwn(state.appliedOps, command.opId) ? state.appliedOps[command.opId] : undefined;
  if (applied !== undefined) return { outcome: "duplicate", revision: applied };
  if (command.type === "register") {
    if (state !== null)
      return rejected("already_registered", `Authored document ${command.documentId} is already registered.`);
    return accepted(
      authoredDocumentEnvelope(command, "authored_document_registered", {
        documentId: command.documentId,
        revision: 1,
        kind: command.kind,
        owner: command.owner,
        readiness: assessAuthoredDocumentReadiness(command.kind, null),
      }),
    );
  }
  if (state === null)
    return rejected("not_registered", `Authored document ${command.documentId} has not been registered.`);
  if (state.retirement !== null)
    return rejected(
      "retired",
      `Authored document ${state.documentId} was retired at revision ${state.retirement.revision}.`,
    );
  if (command.expectedRevision !== state.revision)
    return rejected(
      "stale_base",
      `Authored document ${state.documentId} is at revision ${state.revision}; the change is based on ${command.expectedRevision}.`,
    );
  const revision = state.revision + 1;
  return command.type === "revise"
    ? accepted(
        authoredDocumentEnvelope(command, "authored_document_revised", {
          documentId: state.documentId,
          revision,
          content: command.content,
          readiness: assessAuthoredDocumentReadiness(state.kind, command.body, command.contract),
        }),
      )
    : accepted(
        authoredDocumentEnvelope(command, "authored_document_retired", {
          documentId: state.documentId,
          revision,
          readiness: assessAuthoredDocumentReadiness(state.kind, null),
        }),
      );
}

/** The reducer: fold one accepted event. Fails closed on an event that does not follow the state. */
export function applyAuthoredDocumentEvent(
  state: AuthoredDocumentState | null,
  event: AuthoredDocumentEventV1,
): AuthoredDocumentState {
  const { payload } = event;
  if (event.type === "authored_document_registered") {
    if (state !== null || payload.revision !== 1)
      throw replayError(event, "registration must open the document at revision 1");
    return Object.freeze({
      documentId: payload.documentId,
      kind: event.payload.kind,
      owner: event.payload.owner,
      revision: 1,
      content: null,
      readiness: payload.readiness,
      retirement: null,
      appliedOps: Object.freeze({ [event.opId]: 1 }),
    });
  }
  if (
    state === null ||
    state.retirement !== null ||
    payload.documentId !== state.documentId ||
    payload.revision !== state.revision + 1
  )
    throw replayError(event, "event does not follow the document's current revision");
  const next = {
    ...state,
    revision: payload.revision,
    readiness: payload.readiness,
    appliedOps: Object.freeze({ ...state.appliedOps, [event.opId]: payload.revision }),
  };
  return Object.freeze(
    event.type === "authored_document_revised"
      ? { ...next, content: event.payload.content }
      : { ...next, content: null, retirement: Object.freeze({ revision: payload.revision, opId: event.opId }) },
  );
}

/** What consumers read: they never re-judge readiness from a local file. */
export interface AuthoredDocumentReadView {
  readonly documentId: string;
  readonly kind: TransitionDocumentKind;
  readonly owner: string;
  readonly revision: number;
  readonly content: AuthoredDocumentContentClaim | null;
  readonly readiness: AuthoredDocumentReadiness;
  readonly retired: boolean;
}

/** The typed read port Task, Dispatch and edge consumers depend on; the center implements it. */
export interface AuthoredDocumentReadPort {
  readAuthoredDocument(documentId: string, atRevision?: number): AuthoredDocumentReadView | null;
}

export function authoredDocumentReadView(state: AuthoredDocumentState): AuthoredDocumentReadView {
  return Object.freeze({
    documentId: state.documentId,
    kind: state.kind,
    owner: state.owner,
    revision: state.revision,
    content: state.content,
    readiness: state.readiness,
    retired: state.retirement !== null,
  });
}

/** The only constructor of authored-document events (aggregate-entry gate, dec_6B912A63D279A922FA1288536D). */
function authoredDocumentEnvelope<T extends AuthoredDocumentEventType>(
  command: AuthoredDocumentCommandMeta,
  type: T,
  payload: Extract<AuthoredDocumentEventV1, { readonly type: T }>["payload"],
): AuthoredDocumentEventV1 {
  return Object.freeze({
    schema: "authored-document-event/v1",
    eventId: command.eventId,
    workspaceRevision: command.workspaceRevision,
    opId: command.opId,
    type,
    actor: command.actor,
    source: command.source,
    occurredAt: command.occurredAt,
    payload: Object.freeze(payload),
  }) as AuthoredDocumentEventV1;
}

function accepted(event: AuthoredDocumentEventV1): AuthoredDocumentDecision {
  return { outcome: "accepted", events: Object.freeze([event]) };
}

function rejected(code: AuthoredDocumentRejectionCode, message: string): AuthoredDocumentDecision {
  return { outcome: "rejected", code, message };
}

function replayError(event: AuthoredDocumentEventV1, reason: string): Error {
  return Object.assign(new Error(`${event.type} ${event.eventId}: ${reason}`), { code: "authored_document_replay" });
}
