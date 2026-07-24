export type RepoWriteSendDelivery =
  "definitely-not-sent" | "possibly-sent";

export class RepoWriteSendDeliveryError extends Error {
  readonly delivery: RepoWriteSendDelivery;

  constructor(
    delivery: RepoWriteSendDelivery,
    message: string,
    options: { readonly cause?: unknown } = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "RepoWriteSendDeliveryError";
    this.delivery = delivery;
  }
}

export class RepoWriteClientCapacityError extends Error {
  readonly code = "REPO_WRITE_PENDING_LIMIT" as const;

  constructor() {
    super("Repo writer pending request limit reached.");
    this.name = "RepoWriteClientCapacityError";
  }
}

export class RepoWriteClientClosedError extends Error {
  readonly code = "REPO_WRITE_CLIENT_CLOSED" as const;

  constructor() {
    super("Repo writer client is draining or closed.");
    this.name = "RepoWriteClientClosedError";
  }
}

export class RepoWriteProtocolViolationError extends Error {
  readonly code = "REPO_WRITE_PROTOCOL_VIOLATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteProtocolViolationError";
  }
}

export class RepoWriteDrainError extends Error {
  readonly code: string;
  readonly outcome = "not-started" as const;
  readonly replay = "forbidden" as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepoWriteDrainError";
    this.code = code;
  }
}

export class RepoWriteShutdownTimeoutError extends RepoWriteDrainError {
  constructor() {
    super(
      "REPO_WRITE_DRAIN_TIMEOUT",
      "Repo writer drain timed out; the generation was not replaced."
    );
    this.name = "RepoWriteShutdownTimeoutError";
  }
}

export class RepoWriteNotStartedError extends Error {
  readonly code: string;
  readonly opId: string | undefined;
  readonly outcome = "not-started" as const;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, opId?: string) {
    super(message);
    this.name = "RepoWriteNotStartedError";
    this.code = code;
    this.opId = opId;
  }
}

export class RepoWriteOutcomeUnknownError extends Error {
  readonly code: string;
  readonly opId: string;
  readonly outcome = "unknown" as const;
  readonly replay = "forbidden" as const;

  constructor(code: string, message: string, opId: string) {
    super(message);
    this.name = "RepoWriteOutcomeUnknownError";
    this.code = code;
    this.opId = opId;
  }
}

/**
 * A volatile child-direct command may have crossed its mutation boundary but
 * intentionally has no durable opId or reconnect lookup contract.
 */
export class RepoWriteDirectOutcomeUnknownError extends Error {
  readonly code: string;
  readonly outcome = "unknown" as const;
  readonly replay = "forbidden" as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepoWriteDirectOutcomeUnknownError";
    this.code = code;
  }
}

export class RepoWriteReadyTimeoutError extends RepoWriteNotStartedError {
  constructor(timeoutMs: number) {
    super(
      "REPO_WRITE_READY_TIMEOUT",
      `Repo writer did not announce READY within ${timeoutMs}ms.`
    );
    this.name = "RepoWriteReadyTimeoutError";
  }
}

export class RepoWriteLookupError extends Error {
  readonly code: string;
  readonly opId: string;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, opId: string) {
    super(message);
    this.name = "RepoWriteLookupError";
    this.code = code;
    this.opId = opId;
  }
}
