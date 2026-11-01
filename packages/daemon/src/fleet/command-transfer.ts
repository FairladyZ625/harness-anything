import { createHash, randomUUID } from "node:crypto";
import {
  FLEET_FRAME_BYTES,
  FLEET_TRANSFER_CHUNK_BYTES,
  FleetContractError,
  parseFleetTransferPayload,
  serializeFleetTransferPayload,
  type FleetFrameV1,
} from "./command-protocol.ts";

export async function* encodeFleetFrames(
  value: FleetFrameV1,
  direction: "request" | "response" = "request",
  repoId: string = "transport",
  reserve?: (repoId: string, bytes: number) => { readonly release: () => void },
): AsyncGenerator<FleetFrameV1> {
  const logical = serializeFleetTransferPayload(value);
  if (logical.byteLength <= FLEET_FRAME_BYTES) {
    yield value;
    return;
  }
  const transferId = randomUUID().replaceAll("-", ""),
    sha256 = createHash("sha256").update(logical).digest("hex"),
    reservation = reserve?.(repoId, logical.byteLength);
  try {
    yield {
      schema: "fleet.transfer.begin/v1",
      messageId: transferId,
      correlationId:
        direction === "request" ? value.messageId : "inReplyTo" in value ? value.inReplyTo : value.messageId,
      direction,
      repoId,
      totalBytes: logical.byteLength,
      sha256,
    };
    let offset = 0;
    for (let sequence = 0; offset < logical.byteLength; sequence += 1) {
      const bytes = logical.subarray(offset, offset + FLEET_TRANSFER_CHUNK_BYTES);
      yield {
        schema: "fleet.transfer.chunk/v1",
        messageId: `${transferId}_${sequence}`,
        transferId,
        sequence,
        offset,
        dataBase64: bytes.toString("base64"),
      };
      offset += bytes.byteLength;
    }
    yield {
      schema: "fleet.transfer.end/v1",
      messageId: `${transferId}_end`,
      transferId,
      totalBytes: logical.byteLength,
      sha256,
    };
  } finally {
    reservation?.release();
  }
}

export interface FleetTransferTimeout {
  readonly correlationId: string;
  readonly direction: "request" | "response";
  readonly repoId: string;
  readonly totalBytes: number;
}

export class FleetTransferError extends FleetContractError {
  readonly correlationId: string;
  readonly code: string;
  readonly retryable: boolean;
  constructor(input: {
    readonly correlationId: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(input.message);
    this.correlationId = input.correlationId;
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export class FleetTransferAssembler {
  readonly #expectedDirection: "request" | "response" | undefined;
  readonly #reserve: ((repoId: string, bytes: number) => { readonly release: () => void }) | undefined;
  readonly #maxConcurrent: number;
  readonly #timeoutMs: number;
  readonly #onTimeout: ((transfer: FleetTransferTimeout) => void) | undefined;
  readonly #rejected = new Map<string, NodeJS.Timeout>();
  readonly #active = new Map<
    string,
    {
      readonly transferId: string;
      readonly correlationId: string;
      readonly direction: "request" | "response";
      readonly repoId: string;
      readonly totalBytes: number;
      readonly sha256: string;
      readonly buffer: Buffer;
      readonly release?: () => void;
      timer: NodeJS.Timeout;
      offset: number;
      sequence: number;
    }
  >();

  constructor(
    options: {
      readonly direction?: "request" | "response";
      readonly maxConcurrent?: number;
      readonly timeoutMs?: number;
      readonly reserve?: (repoId: string, bytes: number) => { readonly release: () => void };
      readonly onTimeout?: (transfer: FleetTransferTimeout) => void;
    } = {},
  ) {
    this.#expectedDirection = options.direction;
    this.#maxConcurrent = options.maxConcurrent ?? 1;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#reserve = options.reserve;
    this.#onTimeout = options.onTimeout;
  }

  #armTimeout(transferId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const active = this.#active.get(transferId);
      if (!active) return;
      this.#active.delete(transferId);
      this.#rememberRejected(transferId);
      clearTimeout(active.timer);
      active.release?.();
      this.#onTimeout?.({
        correlationId: active.correlationId,
        direction: active.direction,
        repoId: active.repoId,
        totalBytes: active.totalBytes,
      });
    }, this.#timeoutMs);
    timer.unref();
    return timer;
  }

  #rememberRejected(transferId: string): void {
    const prior = this.#rejected.get(transferId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => this.#rejected.delete(transferId), this.#timeoutMs);
    timer.unref();
    this.#rejected.set(transferId, timer);
  }

  #forgetRejected(transferId: string): boolean {
    const timer = this.#rejected.get(transferId);
    if (!timer) return false;
    clearTimeout(timer);
    this.#rejected.delete(transferId);
    return true;
  }

  #releaseActive(transferId: string, remember = true): void {
    const active = this.#active.get(transferId);
    if (!active) return;
    this.#active.delete(transferId);
    clearTimeout(active.timer);
    active.release?.();
    if (remember) this.#rememberRejected(transferId);
  }

  push(frame: FleetFrameV1): FleetFrameV1 | null {
    if (frame.schema === "fleet.transfer.begin/v1") {
      if (this.#expectedDirection && frame.direction !== this.#expectedDirection)
        throw new FleetContractError("Fleet transfer direction differs");
      if (this.#active.has(frame.messageId)) throw new FleetContractError("Fleet transfer id is already active");
      if (this.#active.size >= this.#maxConcurrent) throw new FleetContractError("Fleet transfer concurrency exceeded");
      if (this.#rejected.size >= this.#maxConcurrent)
        throw new FleetContractError("Fleet rejected-transfer drain limit exceeded");
      let reservation: { readonly release: () => void } | undefined;
      try {
        reservation = this.#reserve?.(frame.repoId, frame.totalBytes);
      } catch (error) {
        this.#rememberRejected(frame.messageId);
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          "message" in error &&
          typeof error.message === "string"
        )
          throw new FleetTransferError({
            correlationId: frame.correlationId,
            code: error.code,
            message: error.message,
            retryable: "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : true,
          });
        throw error;
      }
      try {
        const state = {
          transferId: frame.messageId,
          correlationId: frame.correlationId,
          direction: frame.direction,
          repoId: frame.repoId,
          totalBytes: frame.totalBytes,
          sha256: frame.sha256,
          buffer: Buffer.allocUnsafe(frame.totalBytes),
          ...(reservation ? { release: () => reservation.release() } : {}),
          offset: 0,
          sequence: 0,
          timer: this.#armTimeout(frame.messageId),
        };
        this.#active.set(frame.messageId, state);
      } catch (error) {
        reservation?.release();
        throw error;
      }
      return null;
    }
    if (frame.schema === "fleet.transfer.chunk/v1") {
      if (this.#rejected.has(frame.transferId)) return null;
      const active = this.#active.get(frame.transferId),
        bytes = Buffer.from(frame.dataBase64, "base64");
      try {
        if (
          !active ||
          frame.transferId !== active.transferId ||
          frame.sequence !== active.sequence ||
          frame.offset !== active.offset
        )
          throw new FleetContractError("Fleet transfer sequence or offset differs");
        if (active.offset + bytes.byteLength > active.totalBytes)
          throw new FleetContractError("Fleet transfer exceeds declared size");
        bytes.copy(active.buffer, active.offset);
        active.offset += bytes.byteLength;
        active.sequence += 1;
        clearTimeout(active.timer);
        active.timer = this.#armTimeout(active.transferId);
      } catch (error) {
        if (active) this.#releaseActive(active.transferId);
        throw error;
      }
      return null;
    }
    if (frame.schema === "fleet.transfer.end/v1") {
      if (this.#forgetRejected(frame.transferId)) return null;
      const active = this.#active.get(frame.transferId);
      if (!active || frame.transferId !== active.transferId)
        throw new FleetContractError("Fleet transfer completion differs");
      this.#active.delete(frame.transferId);
      try {
        if (frame.totalBytes !== active.totalBytes || frame.sha256 !== active.sha256)
          throw new FleetContractError("Fleet transfer completion differs");
        if (active.offset !== active.totalBytes)
          throw new FleetContractError("Fleet transfer ended before declared size");
        if (createHash("sha256").update(active.buffer).digest("hex") !== active.sha256)
          throw new FleetContractError("Fleet transfer digest mismatch");
        const logical = parseFleetTransferPayload(active.buffer),
          correlationId =
            active.direction === "request" ? logical.messageId : "inReplyTo" in logical ? logical.inReplyTo : null;
        if (
          correlationId !== active.correlationId ||
          logical.schema.startsWith("fleet.transfer.") ||
          ("repoId" in logical && logical.repoId !== active.repoId)
        )
          throw new FleetContractError("Fleet transfer correlation differs");
        return logical;
      } catch (error) {
        this.#rememberRejected(frame.transferId);
        throw error;
      } finally {
        clearTimeout(active.timer);
        active.release?.();
      }
    }
    return frame;
  }

  reset(): void {
    for (const active of this.#active.values()) {
      clearTimeout(active.timer);
      active.release?.();
    }
    this.#active.clear();
    for (const timer of this.#rejected.values()) clearTimeout(timer);
    this.#rejected.clear();
  }
}
