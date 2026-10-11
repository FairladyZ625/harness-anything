import type { AuthorizationResource } from "./policy-groups.ts";

export type PermissionRequestStatus = "pending" | "applying" | "effective" | "rejected" | "failed" | "withdrawn";
export interface PermissionRequestV1 {
  readonly schema: "permission-request/v1";
  readonly requestId: string;
  readonly requesterPersonId: string;
  readonly resource: AuthorizationResource;
  readonly actions: readonly string[];
  readonly reason: string;
  readonly expectedVersion: number;
  readonly revision: number;
  readonly status: PermissionRequestStatus;
  readonly decidedBy?: string;
  readonly error?: string;
}

export type PermissionRequestDecision =
  | { readonly outcome: "effective"; readonly request: PermissionRequestV1 }
  | { readonly outcome: "rejected" | "failed"; readonly request: PermissionRequestV1; readonly error: string }
  | { readonly outcome: "version_conflict"; readonly request: PermissionRequestV1 };

export class PermissionRequestError extends Error {
  readonly code: "invalid" | "closed" | "version_conflict" | "self_approval";
  constructor(code: "invalid" | "closed" | "version_conflict" | "self_approval", message: string) {
    super(message);
    this.name = "PermissionRequestError";
    this.code = code;
  }
}

/** Serialize approval mutations at the center writer turn. */
export class PermissionRequestCoordinator {
  readonly #requests = new Map<string, PermissionRequestV1>();
  readonly #queues = new Map<string, Promise<void>>();

  create(input: Parameters<typeof createPermissionRequest>[0]): PermissionRequestV1 {
    const request = createPermissionRequest(input);
    if (this.#requests.has(request.requestId))
      throw new PermissionRequestError("invalid", `Permission request ${request.requestId} already exists.`);
    this.#requests.set(request.requestId, request);
    return request;
  }

  read(requestId: string): PermissionRequestV1 | null {
    return this.#requests.get(requestId) ?? null;
  }

  async approve(
    requestId: string,
    expectedVersion: number,
    approverPersonId: string,
    settle: () => Promise<{ readonly ok: boolean; readonly error?: string }>,
  ): Promise<PermissionRequestDecision> {
    return this.#enqueue(requestId, async () => {
      const request = this.#requests.get(requestId);
      if (!request) throw new PermissionRequestError("invalid", `Permission request ${requestId} does not exist.`);
      if (request.revision !== version(expectedVersion)) return { outcome: "version_conflict", request };
      const applying = beginPermissionApproval(request, expectedVersion, approverPersonId);
      this.#requests.set(requestId, applying);
      const decision = settlePermissionApproval(applying, await settle());
      this.#requests.set(requestId, decision.request);
      return decision;
    });
  }

  reject(
    requestId: string,
    expectedVersion: number,
    approverPersonId: string,
    reason: string,
  ): PermissionRequestDecision {
    const request = this.#requests.get(requestId);
    if (!request) throw new PermissionRequestError("invalid", `Permission request ${requestId} does not exist.`);
    const decision = rejectPermissionRequest(request, expectedVersion, approverPersonId, reason);
    this.#requests.set(requestId, decision.request);
    return decision;
  }

  withdraw(requestId: string, expectedVersion: number): PermissionRequestV1 {
    const request = this.#requests.get(requestId);
    if (!request) throw new PermissionRequestError("invalid", `Permission request ${requestId} does not exist.`);
    const withdrawn = withdrawPermissionRequest(request, expectedVersion);
    this.#requests.set(requestId, withdrawn);
    return withdrawn;
  }

  #enqueue<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(requestId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.#queues.set(
      requestId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PermissionRequestError("invalid", `${field} is required.`);
  return value.trim();
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new PermissionRequestError("invalid", "expectedVersion must be non-negative.");
  return Number(value);
}
function current(request: PermissionRequestV1, expectedVersion: unknown): void {
  if (request.revision !== version(expectedVersion))
    throw new PermissionRequestError("version_conflict", "Permission request changed; refresh before deciding.");
  if (request.status !== "pending")
    throw new PermissionRequestError("closed", `Permission request is already ${request.status}.`);
}
export function createPermissionRequest(input: {
  readonly requestId: string;
  readonly requesterPersonId: string;
  readonly resource: AuthorizationResource;
  readonly actions: readonly string[];
  readonly reason: string;
  readonly expectedVersion?: number;
}): PermissionRequestV1 {
  const actions = [...new Set(input.actions.map((item) => text(item, "action")))].sort();
  if (!actions.length) throw new PermissionRequestError("invalid", "At least one action is required.");
  return Object.freeze({
    schema: "permission-request/v1",
    requestId: text(input.requestId, "requestId"),
    requesterPersonId: text(input.requesterPersonId, "requesterPersonId"),
    resource: input.resource,
    actions: Object.freeze(actions),
    reason: text(input.reason, "reason"),
    expectedVersion: version(input.expectedVersion ?? 0),
    revision: 0,
    status: "pending",
  });
}
export function beginPermissionApproval(
  request: PermissionRequestV1,
  expectedVersion: number,
  approverPersonId: string,
): PermissionRequestV1 {
  current(request, expectedVersion);
  const approver = text(approverPersonId, "approverPersonId");
  if (approver === request.requesterPersonId)
    throw new PermissionRequestError("self_approval", "A requester cannot approve its own request.");
  return Object.freeze({ ...request, revision: request.revision + 1, status: "applying", decidedBy: approver });
}
export function settlePermissionApproval(
  request: PermissionRequestV1,
  input: { readonly ok: boolean; readonly error?: string },
): PermissionRequestDecision {
  if (request.status !== "applying")
    throw new PermissionRequestError("closed", `Permission request is ${request.status}.`);
  if (input.ok)
    return {
      outcome: "effective",
      request: Object.freeze({ ...request, revision: request.revision + 1, status: "effective" }),
    };
  const error = text(input.error, "error");
  return {
    outcome: "failed",
    error,
    request: Object.freeze({ ...request, revision: request.revision + 1, status: "failed", error }),
  };
}
export function rejectPermissionRequest(
  request: PermissionRequestV1,
  expectedVersion: number,
  approverPersonId: string,
  reason: string,
): PermissionRequestDecision {
  current(request, expectedVersion);
  return {
    outcome: "rejected",
    error: text(reason, "reason"),
    request: Object.freeze({
      ...request,
      revision: request.revision + 1,
      status: "rejected",
      decidedBy: text(approverPersonId, "approverPersonId"),
      error: text(reason, "reason"),
    }),
  };
}
export function withdrawPermissionRequest(request: PermissionRequestV1, expectedVersion: number): PermissionRequestV1 {
  current(request, expectedVersion);
  return Object.freeze({ ...request, revision: request.revision + 1, status: "withdrawn" });
}
