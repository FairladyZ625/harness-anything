import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type EdgeJoinState = "pending" | "consumed" | "expired" | "revoked";
export interface EdgeJoinLink {
  readonly version: 1;
  readonly joinId: string;
  readonly centerOrigin: string;
  readonly repoIds: readonly string[];
  readonly spkiSha256: string;
  readonly token?: string;
  readonly loginUrl: string;
  readonly loginRealm: string;
  readonly loginClientId: string;
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
  readonly platform?: "darwin" | "linux";
  readonly centerOrigin: string;
  readonly spkiSha256: string;
  readonly loginUrl: string;
  readonly loginRealm: string;
  readonly loginClientId: string;
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

const LINK_PATH = "/join";
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
  const url = new URL(LINK_PATH, link.centerOrigin),
    fields: [string, string][] = [
      ["v", "1"],
      ["join", link.joinId],
      ["center", link.centerOrigin],
      ["repo", link.repoIds.join(",")],
      ["spki_sha256", link.spkiSha256],
      ...(link.token ? ([["token", link.token]] as [string, string][]) : []),
      ["login_url", link.loginUrl],
      ["login_realm", link.loginRealm],
      ["login_client_id", link.loginClientId],
    ];
  url.hash = new URLSearchParams(fields).toString();
  return url.toString();
}

export function decodeEdgeJoinLink(value: string): EdgeJoinLink {
  try {
    const url = new URL(value),
      params = new URLSearchParams(url.hash.slice(1)),
      centerOrigin = params.get("center"),
      repoIds = params.get("repo")?.split(","),
      keys = [...params.keys()];
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== LINK_PATH ||
      url.search !== "" ||
      !centerOrigin ||
      url.origin !== centerOrigin ||
      params.get("v") !== "1" ||
      new Set(keys).size !== keys.length ||
      !isText(params.get("join")) ||
      !repoIds?.length ||
      repoIds.some((repoId) => !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)) ||
      new Set(repoIds).size !== repoIds.length ||
      !/^[0-9a-f]{64}$/u.test(params.get("spki_sha256") ?? "") ||
      !isText(params.get("login_url")) ||
      !isText(params.get("login_realm")) ||
      !isText(params.get("login_client_id")) ||
      [...params.keys()].some(
        (key) =>
          ![
            "v",
            "join",
            "center",
            "repo",
            "spki_sha256",
            "token",
            "login_url",
            "login_realm",
            "login_client_id",
          ].includes(key),
      )
    )
      throw new Error("shape");
    const loginUrl = new URL(params.get("login_url")!);
    if (loginUrl.protocol !== "https:" || loginUrl.username !== "" || loginUrl.password !== "")
      throw new Error("login URL");
    const token = params.get("token");
    if (token !== null && !isText(token)) throw new Error("token");
    return {
      version: 1,
      joinId: params.get("join")!,
      centerOrigin,
      repoIds,
      spkiSha256: params.get("spki_sha256")!,
      ...(token ? { token } : {}),
      loginUrl: loginUrl.toString().replace(/\/$/u, ""),
      loginRealm: params.get("login_realm")!,
      loginClientId: params.get("login_client_id")!,
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
        readonly platform?: "darwin" | "linux";
        readonly createdBy: string;
        readonly ttlMs: number;
      },
    ): { readonly record: EdgeJoinRecord; readonly link: EdgeJoinLink } {
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new RangeError("ttlMs must be positive");
      const createdAt = now(),
        rawToken = token(),
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
          expiresAt: new Date(Date.parse(createdAt) + input.ttlMs).toISOString(),
          createdAt,
          createdBy: input.createdBy,
          consumedAt: null,
          revokedAt: null,
        },
        link: EdgeJoinLink = {
          version: 1,
          joinId: record.joinId,
          centerOrigin: record.centerOrigin,
          repoIds: record.repoIds,
          spkiSha256: record.spkiSha256,
          token: rawToken,
          loginUrl: record.loginUrl,
          loginRealm: record.loginRealm,
          loginClientId: record.loginClientId,
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
    consume(joinId: string, suppliedToken: string, nodeId: string): EdgeJoinRecord {
      const record = this.assertConsumable(joinId, suppliedToken),
        consumed = { ...record, consumedAt: now(), nodeId };
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
