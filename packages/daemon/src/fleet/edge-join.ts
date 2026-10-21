import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeRootCaCertificate } from "../tls-ca-certificate.ts";

export type EdgeJoinState = "pending" | "consumed" | "expired" | "revoked";
/** The operating systems a fleet edge node can register from. */
export const edgeJoinPlatforms = ["darwin", "linux", "win32"] as const;
export type EdgeJoinPlatform = (typeof edgeJoinPlatforms)[number];
export const isEdgeJoinPlatform = (value: string): value is EdgeJoinPlatform =>
  edgeJoinPlatforms.some((platform) => platform === value);
export interface EdgeJoinLink {
  readonly version: 2;
  readonly joinId: string;
  readonly centerOrigin: string;
  readonly repoIds: readonly string[];
  readonly spkiSha256: string;
  readonly token?: string;
  readonly loginUrl: string;
  readonly loginRealm: string;
  readonly loginClientId: string;
  readonly loginCertificate?: string;
}
export interface EdgeJoinPermissionSnapshot {
  readonly groupId: string;
  readonly version: string;
}
export interface EdgeJoinRecord {
  readonly joinId: string;
  readonly mode: "invitation";
  readonly personId: string;
  readonly repoIds: readonly string[];
  readonly permissionSnapshot: readonly EdgeJoinPermissionSnapshot[];
  readonly tokenDigest: string;
  readonly nodeLabel?: string;
  readonly platform?: EdgeJoinPlatform;
  readonly centerOrigin: string;
  readonly spkiSha256: string;
  readonly loginUrl: string;
  readonly loginRealm: string;
  readonly loginClientId: string;
  readonly loginCertificate?: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy?: string;
  readonly nodeId?: string;
}
export interface EdgeJoinStatusResult {
  readonly joinId: string;
  readonly state: EdgeJoinState;
  readonly nodeId?: string;
}
export interface EdgeJoinSummary extends EdgeJoinStatusResult {
  readonly personId: string;
  readonly repoIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface EdgeJoinStoreOptions {
  readonly records?: readonly EdgeJoinRecord[];
  readonly onChange?: (record: EdgeJoinRecord) => void;
  readonly now?: () => string;
  readonly randomToken?: () => string;
}

const LINK_PREFIX = "harness-edge://join/";
const TOKEN_BYTES = 32;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tokenDigest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export class EdgeJoinError extends Error {
  readonly code:
    | "edge_join_invalid"
    | "pin_mismatch"
    | "person_mismatch"
    | "join_token_expired"
    | "already_consumed"
    | "join_revoked";
  constructor(code: EdgeJoinError["code"], message: string) {
    super(message);
    this.name = "EdgeJoinError";
    this.code = code;
  }
}

export function encodeEdgeJoinLink(link: EdgeJoinLink): string {
  return `${LINK_PREFIX}${Buffer.from(JSON.stringify(link), "utf8").toString("base64url")}`;
}

export function decodeEdgeJoinLink(value: string): EdgeJoinLink {
  try {
    if (!value.startsWith(LINK_PREFIX)) throw new Error("prefix");
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(LINK_PREFIX.length), "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("shape");
    const candidate = decoded as Record<string, unknown>,
      centerOrigin = candidate.centerOrigin,
      repoIds = candidate.repoIds,
      loginUrl = candidate.loginUrl,
      loginCertificate = candidate.loginCertificate;
    if (
      candidate.version !== 2 ||
      !isText(candidate.joinId) ||
      !isText(centerOrigin) ||
      !Array.isArray(repoIds) ||
      repoIds.length === 0 ||
      repoIds.some((repoId) => typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)) ||
      new Set(repoIds).size !== repoIds.length ||
      !/^[0-9a-f]{64}$/u.test(String(candidate.spkiSha256)) ||
      (candidate.token !== undefined && !isText(candidate.token)) ||
      !isText(loginUrl) ||
      !isText(candidate.loginRealm) ||
      !isText(candidate.loginClientId) ||
      (loginCertificate !== undefined && !isText(loginCertificate)) ||
      Object.keys(candidate).some(
        (key) =>
          ![
            "version",
            "joinId",
            "centerOrigin",
            "repoIds",
            "spkiSha256",
            "token",
            "loginUrl",
            "loginRealm",
            "loginClientId",
            "loginCertificate",
          ].includes(key),
      )
    )
      throw new Error("shape");
    const center = new URL(centerOrigin),
      login = new URL(loginUrl);
    if (
      center.protocol !== "https:" ||
      center.origin !== centerOrigin ||
      center.username !== "" ||
      center.password !== "" ||
      login.protocol !== "https:" ||
      login.username !== "" ||
      login.password !== ""
    )
      throw new Error("login URL");
    return {
      version: 2,
      joinId: candidate.joinId as string,
      centerOrigin,
      repoIds: repoIds as string[],
      spkiSha256: candidate.spkiSha256 as string,
      ...(candidate.token ? { token: candidate.token as string } : {}),
      loginUrl: login.toString().replace(/\/$/u, ""),
      loginRealm: candidate.loginRealm as string,
      loginClientId: candidate.loginClientId as string,
      ...(loginCertificate === undefined
        ? {}
        : { loginCertificate: normalizeRootCaCertificate(loginCertificate as string) }),
    };
  } catch {
    throw new EdgeJoinError("edge_join_invalid", "The edge join link is invalid.");
  }
}

export function createEdgeJoinStore(options: EdgeJoinStoreOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const token = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const records = new Map<string, EdgeJoinRecord>(
    options.records?.map((record) => [record.joinId, clone(record)]) ?? [],
  );
  const state = (record: EdgeJoinRecord): EdgeJoinState =>
    record.consumedAt
      ? "consumed"
      : record.revokedAt
        ? "revoked"
        : Date.parse(now()) >= Date.parse(record.expiresAt)
          ? "expired"
          : "pending";
  return {
    create(
      input: Omit<EdgeJoinLink, "version" | "joinId" | "token" | "expiresAt"> & {
        readonly personId: string;
        readonly repoIds: readonly string[];
        readonly permissionSnapshot: readonly EdgeJoinPermissionSnapshot[];
        readonly nodeLabel?: string;
        readonly platform?: EdgeJoinPlatform;
        readonly createdBy: string;
        readonly ttlMs: number;
      },
    ): { readonly record: EdgeJoinRecord; readonly link: EdgeJoinLink } {
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new RangeError("ttlMs must be positive");
      const createdAt = now(),
        rawToken = token(),
        loginCertificate =
          input.loginCertificate === undefined ? undefined : normalizeRootCaCertificate(input.loginCertificate),
        record: EdgeJoinRecord = {
          joinId: randomUUID(),
          mode: "invitation",
          personId: input.personId,
          repoIds: [...input.repoIds],
          permissionSnapshot: clone(input.permissionSnapshot),
          tokenDigest: tokenDigest(rawToken).toString("hex"),
          ...(input.nodeLabel ? { nodeLabel: input.nodeLabel } : {}),
          ...(input.platform ? { platform: input.platform } : {}),
          centerOrigin: input.centerOrigin,
          spkiSha256: input.spkiSha256,
          loginUrl: input.loginUrl,
          loginRealm: input.loginRealm,
          loginClientId: input.loginClientId,
          ...(loginCertificate === undefined ? {} : { loginCertificate }),
          expiresAt: new Date(Date.parse(createdAt) + input.ttlMs).toISOString(),
          createdAt,
          createdBy: input.createdBy,
          consumedAt: null,
          revokedAt: null,
        },
        link: EdgeJoinLink = {
          version: 2,
          joinId: record.joinId,
          centerOrigin: record.centerOrigin,
          repoIds: record.repoIds,
          spkiSha256: record.spkiSha256,
          token: rawToken,
          loginUrl: record.loginUrl,
          loginRealm: record.loginRealm,
          loginClientId: record.loginClientId,
          ...(record.loginCertificate === undefined ? {} : { loginCertificate: record.loginCertificate }),
        };
      records.set(record.joinId, record);
      options.onChange?.(clone(record));
      return { record: clone(record), link };
    },
    get(joinId: string): EdgeJoinRecord | undefined {
      const record = records.get(joinId);
      return record ? clone(record) : undefined;
    },
    assertConsumable(joinId: string, suppliedToken: string): EdgeJoinRecord {
      const record = records.get(joinId);
      if (!record || !isText(suppliedToken))
        throw new EdgeJoinError("edge_join_invalid", "The edge join invitation is invalid.");
      const expected = Buffer.from(record.tokenDigest, "hex"),
        actual = tokenDigest(suppliedToken);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new EdgeJoinError("edge_join_invalid", "The edge join invitation is invalid.");
      if (state(record) === "expired")
        throw new EdgeJoinError("join_token_expired", "The edge join invitation has expired.");
      if (state(record) === "revoked") throw new EdgeJoinError("join_revoked", "The edge join invitation was revoked.");
      if (state(record) === "consumed")
        throw new EdgeJoinError("already_consumed", "The edge join invitation was already consumed.");
      return clone(record);
    },
    /** Bare transition: the caller must have run assertConsumable for this same critical section. */
    consume(joinId: string, nodeId: string): EdgeJoinRecord {
      const record = records.get(joinId);
      if (!record) throw new EdgeJoinError("edge_join_invalid", "The edge join invitation is invalid.");
      const consumed = { ...record, consumedAt: now(), nodeId };
      records.set(joinId, consumed);
      options.onChange?.(clone(consumed));
      return clone(consumed);
    },
    revoke(joinId: string, actorPersonId: string): EdgeJoinRecord {
      const record = records.get(joinId);
      if (!record) throw new EdgeJoinError("edge_join_invalid", "The edge join invitation is invalid.");
      if (state(record) !== "pending")
        throw new EdgeJoinError(
          "edge_join_invalid",
          `Only pending invitations can be revoked (state: ${state(record)}).`,
        );
      const revoked = { ...record, revokedAt: now(), revokedBy: actorPersonId };
      records.set(joinId, revoked);
      options.onChange?.(clone(revoked));
      return clone(revoked);
    },
    status(joinId: string): EdgeJoinStatusResult {
      const record = records.get(joinId);
      if (!record) throw new EdgeJoinError("edge_join_invalid", "The edge join invitation is invalid.");
      return {
        joinId,
        state: state(record),
        ...(record.nodeId ? { nodeId: record.nodeId } : {}),
      };
    },
    list(): readonly EdgeJoinSummary[] {
      return [...records.values()].map(
        (record): EdgeJoinSummary => ({
          joinId: record.joinId,
          state: state(record),
          ...(record.nodeId ? { nodeId: record.nodeId } : {}),
          personId: record.personId,
          repoIds: [...record.repoIds],
          groupIds: record.permissionSnapshot.map(({ groupId }) => groupId),
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        }),
      );
    },
  };
}
