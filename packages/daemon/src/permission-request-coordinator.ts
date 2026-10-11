import {
  beginPermissionApproval,
  createPermissionRequest,
  rejectPermissionRequest,
  settlePermissionApproval,
  withdrawPermissionRequest,
  PermissionRequestError,
  type PermissionRequestDecision,
  type PermissionRequestStatus,
  type PermissionRequestV1,
} from "@harness-anything/kernel";

/** Center writer coordinator. The queue is deliberately outside kernel domain code. */
export type { PermissionRequestStatus };

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
      const request = this.#require(requestId);
      if (request.revision !== expectedVersion) return { outcome: "version_conflict", request };
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
    const request = this.#require(requestId),
      decision = rejectPermissionRequest(request, expectedVersion, approverPersonId, reason);
    this.#requests.set(requestId, decision.request);
    return decision;
  }

  withdraw(requestId: string, expectedVersion: number): PermissionRequestV1 {
    const request = this.#require(requestId),
      withdrawn = withdrawPermissionRequest(request, expectedVersion);
    this.#requests.set(requestId, withdrawn);
    return withdrawn;
  }

  #require(requestId: string): PermissionRequestV1 {
    const request = this.#requests.get(requestId);
    if (!request) throw new PermissionRequestError("invalid", `Permission request ${requestId} does not exist.`);
    return request;
  }

  #enqueue<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(requestId) ?? Promise.resolve(),
      current = previous.then(operation, operation);
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
