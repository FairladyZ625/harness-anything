import { randomBytes, randomUUID } from "node:crypto";

export type EdgeJoinInviteStatus = "pending" | "consumed" | "expired";
export interface EdgeJoinInviteLink {
  readonly version: 1;
  readonly centerUrl: string;
  readonly inviteId: string;
  readonly personId: string;
  readonly nodeId: string;
  readonly spkiSha256: string;
  readonly expiresAt: string;
  readonly token: string;
}
export interface EdgeJoinInviteRecord extends EdgeJoinInviteLink {
  readonly createdAt: string;
  readonly consumedAt: string | null;
}
export interface EdgeJoinInviteStatusResult {
  readonly inviteId: string;
  readonly status: EdgeJoinInviteStatus;
  readonly personId: string;
  readonly nodeId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}
export interface EdgeJoinStoreOptions {
  readonly now?: () => string;
  readonly randomToken?: () => string;
}
export interface ConsumeEdgeJoinOptions {
  readonly link: string | EdgeJoinInviteLink;
  readonly loginPersonId: string;
  readonly observedSpkiSha256: string;
}

const LINK_PREFIX = "harness-edge://join/";
const TOKEN_BYTES = 32;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class EdgeJoinError extends Error {
  readonly code: "invalid_link" | "pin_mismatch" | "person_mismatch" | "expired" | "already_consumed";
  constructor(code: EdgeJoinError["code"], message: string) {
    super(message);
    this.name = "EdgeJoinError";
    this.code = code;
  }
}

export function encodeEdgeJoinLink(link: EdgeJoinInviteLink): string {
  return `${LINK_PREFIX}${Buffer.from(JSON.stringify(link), "utf8").toString("base64url")}`;
}

export function decodeEdgeJoinLink(value: string): EdgeJoinInviteLink {
  try {
    if (!value.startsWith(LINK_PREFIX)) throw new Error("prefix");
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(LINK_PREFIX.length), "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      (decoded as { version?: unknown }).version !== 1 ||
      !["centerUrl", "inviteId", "personId", "nodeId", "spkiSha256", "expiresAt", "token"].every((key) =>
        isText((decoded as Record<string, unknown>)[key]),
      )
    )
      throw new Error("shape");
    return decoded as EdgeJoinInviteLink;
  } catch {
    throw new EdgeJoinError("invalid_link", "The edge join link is invalid.");
  }
}

export function createEdgeJoinStore(options: EdgeJoinStoreOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const token = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const records = new Map<string, EdgeJoinInviteRecord>();
  const status = (record: EdgeJoinInviteRecord): EdgeJoinInviteStatus =>
    record.consumedAt ? "consumed" : Date.parse(now()) >= Date.parse(record.expiresAt) ? "expired" : "pending";
  return {
    create(
      input: Omit<EdgeJoinInviteLink, "version" | "inviteId" | "token" | "expiresAt"> & { readonly ttlMs: number },
    ): EdgeJoinInviteLink {
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new RangeError("ttlMs must be positive");
      const createdAt = now();
      const link: EdgeJoinInviteLink = {
        version: 1,
        centerUrl: input.centerUrl,
        inviteId: randomUUID(),
        personId: input.personId,
        nodeId: input.nodeId,
        spkiSha256: input.spkiSha256,
        expiresAt: new Date(Date.parse(createdAt) + input.ttlMs).toISOString(),
        token: token(),
      };
      records.set(link.inviteId, { ...link, createdAt, consumedAt: null });
      return clone(link);
    },
    consume(input: ConsumeEdgeJoinOptions): EdgeJoinInviteRecord {
      const link = typeof input.link === "string" ? decodeEdgeJoinLink(input.link) : input.link;
      const record = records.get(link.inviteId);
      if (!record || record.token !== link.token)
        throw new EdgeJoinError("invalid_link", "The edge join link is invalid.");
      if (record.spkiSha256 !== input.observedSpkiSha256)
        throw new EdgeJoinError("pin_mismatch", "The center certificate fingerprint does not match the invitation.");
      if (status(record) === "expired") throw new EdgeJoinError("expired", "The edge join invitation has expired.");
      if (status(record) === "consumed")
        throw new EdgeJoinError("already_consumed", "The edge join invitation was already consumed.");
      if (record.personId !== input.loginPersonId)
        throw new EdgeJoinError("person_mismatch", "The signed-in person does not match the invitation.");
      const consumed = { ...record, consumedAt: now() };
      records.set(record.inviteId, consumed);
      return clone(consumed);
    },
    status(inviteId: string): EdgeJoinInviteStatusResult {
      const record = records.get(inviteId);
      if (!record) throw new EdgeJoinError("invalid_link", "The edge join invitation is invalid.");
      return {
        inviteId,
        status: status(record),
        personId: record.personId,
        nodeId: record.nodeId,
        expiresAt: record.expiresAt,
        consumedAt: record.consumedAt,
      };
    },
  };
}
