import {
  stableStringify,
  type CurrentSessionRef,
  type TaskHolderExecutor
} from "@harness-anything/kernel";
import {
  actorStampJson,
  type AuthenticatedActor,
  type CredentialKind
} from "../identity/types.ts";
import type { AuthorityConnectionContext } from "../protocol/connection-context.ts";
import {
  decodeRepoWriteBytes,
  encodeRepoWriteBytes,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject
} from "./repo-write-protocol.ts";
import { makeRepoWriteStrictCodec } from "./repo-write-strict-codec.ts";

const {
  record,
  exactKeys,
  text,
  nonNegativeInteger,
  invalid
} = makeRepoWriteStrictCodec("REPO_WRITE_PROGRESS_CONTEXT_INVALID");

export interface RepoWriteProgressCommandContext {
  readonly actor: AuthenticatedActor;
  readonly authorityConnection: AuthorityConnectionContext;
  readonly currentSession: CurrentSessionRef;
  readonly executor: TaskHolderExecutor | null;
}

export function encodeRepoWriteProgressCommand(input: {
  readonly command: Readonly<Record<string, unknown>>;
  readonly context: RepoWriteProgressCommandContext;
}): RepoWriteCommandDto {
  const authority = input.context.authorityConnection;
  if (authority.actor.personId !== input.context.actor.personId) {
    throw new Error("REPO_WRITE_PROGRESS_ACTOR_CONTEXT_MISMATCH");
  }
  return {
    commandName: "progress-append",
    actor: actorStampJson(input.context.actor),
    context: progressJsonObject({
      authorityConnection: {
        schema: authority.schema,
        connectionId: authority.connectionId,
        connectionGeneration: authority.connectionGeneration,
        actor: {
          personId: authority.actor.personId,
          displayName: authority.actor.displayName,
          ...(authority.actor.primaryEmail ? { primaryEmail: authority.actor.primaryEmail } : {}),
          resolvedCredential: authority.actor.resolvedCredential,
          providerId: authority.actor.providerId
        },
        repoId: authority.repoId,
        channelBinding: {
          digest: encodeRepoWriteBytes(authority.channelBinding.digest),
          source: authority.channelBinding.source
        },
        peerCredential: authority.peerCredential
      },
      currentSession: input.context.currentSession,
      executor: input.context.executor
    }),
    payload: progressJsonObject({
      command: input.command,
      session: input.context.currentSession
    })
  };
}

export function decodeRepoWriteProgressCommand(
  command: RepoWriteCommandDto
): RepoWriteProgressCommandContext {
  if (command.commandName !== "progress-append") {
    throw new Error(`REPO_WRITE_COMMAND_NOT_ALLOWLISTED:${command.commandName}`);
  }
  const context = record(command.context, "$.context");
  exactKeys(context, ["authorityConnection", "currentSession", "executor"], "$.context");
  const authority = record(context.authorityConnection, "$.context.authorityConnection");
  exactKeys(authority, [
    "schema", "connectionId", "connectionGeneration", "actor", "repoId",
    "channelBinding", "peerCredential"
  ], "$.context.authorityConnection");
  if (authority.schema !== "authority-connection-context/v1") {
    invalid("$.context.authorityConnection.schema");
  }
  const actor = authenticatedActor(authority.actor);
  const channel = record(
    authority.channelBinding,
    "$.context.authorityConnection.channelBinding"
  );
  exactKeys(channel, ["digest", "source"], "$.context.authorityConnection.channelBinding");
  if (channel.source !== "transport-observed") {
    invalid("$.context.authorityConnection.channelBinding.source");
  }
  const digest = decodeRepoWriteBytes(channel.digest);
  if (digest.byteLength !== 32) invalid("$.context.authorityConnection.channelBinding.digest");
  const currentSession = decodeCurrentSession(context.currentSession);
  const executor = decodeExecutor(context.executor);
  const decoded: RepoWriteProgressCommandContext = {
    actor,
    authorityConnection: {
      schema: "authority-connection-context/v1",
      connectionId: text(authority.connectionId, "$.context.authorityConnection.connectionId"),
      connectionGeneration: text(
        authority.connectionGeneration,
        "$.context.authorityConnection.connectionGeneration"
      ) as AuthorityConnectionContext["connectionGeneration"],
      actor,
      repoId: text(authority.repoId, "$.context.authorityConnection.repoId"),
      channelBinding: {
        digest: digest as AuthorityConnectionContext["channelBinding"]["digest"],
        source: "transport-observed"
      },
      peerCredential: decodePeerCredential(authority.peerCredential)
    },
    currentSession,
    executor
  };
  if (stableStringify(command.actor) !== stableStringify(actorStampJson(actor))) {
    throw new Error("REPO_WRITE_PROGRESS_ACTOR_STAMP_MISMATCH");
  }
  return decoded;
}

function decodePeerCredential(
  value: unknown
): AuthorityConnectionContext["peerCredential"] {
  const credential = record(
    value,
    "$.context.authorityConnection.peerCredential"
  );
  exactKeys(
    credential,
    ["schema", "platform", "source", "uid"],
    "$.context.authorityConnection.peerCredential",
    ["gid", "pid"]
  );
  if (credential.schema !== "os-observed-peer-credential/v1") {
    invalid("$.context.authorityConnection.peerCredential.schema");
  }
  if (credential.source !== "getpeereid"
    && credential.source !== "LOCAL_PEERCRED"
    && credential.source !== "SO_PEERCRED") {
    invalid("$.context.authorityConnection.peerCredential.source");
  }
  return {
    schema: "os-observed-peer-credential/v1",
    platform: text(
      credential.platform,
      "$.context.authorityConnection.peerCredential.platform"
    ) as NodeJS.Platform,
    source: credential.source as AuthorityConnectionContext["peerCredential"]["source"],
    uid: nonNegativeInteger(
      credential.uid,
      "$.context.authorityConnection.peerCredential.uid"
    ),
    ...(credential.gid === undefined ? {} : {
      gid: nonNegativeInteger(
        credential.gid,
        "$.context.authorityConnection.peerCredential.gid"
      )
    }),
    ...(credential.pid === undefined ? {} : {
      pid: nonNegativeInteger(
        credential.pid,
        "$.context.authorityConnection.peerCredential.pid"
      )
    })
  };
}

function authenticatedActor(value: unknown): AuthenticatedActor {
  const actor = record(value, "$.context.authorityConnection.actor");
  exactKeys(
    actor,
    ["personId", "displayName", "resolvedCredential", "providerId"],
    "$.context.authorityConnection.actor",
    ["primaryEmail"]
  );
  const credential = record(
    actor.resolvedCredential,
    "$.context.authorityConnection.actor.resolvedCredential"
  );
  exactKeys(
    credential,
    ["kind", "issuer", "subject"],
    "$.context.authorityConnection.actor.resolvedCredential"
  );
  const credentialKind = text(
    credential.kind,
    "$.context.authorityConnection.actor.resolvedCredential.kind"
  );
  if (!credentialKinds.has(credentialKind as CredentialKind)) {
    invalid("$.context.authorityConnection.actor.resolvedCredential.kind");
  }
  return {
    personId: text(actor.personId, "$.context.authorityConnection.actor.personId"),
    displayName: text(actor.displayName, "$.context.authorityConnection.actor.displayName"),
    ...(actor.primaryEmail === undefined ? {} : {
      primaryEmail: text(actor.primaryEmail, "$.context.authorityConnection.actor.primaryEmail")
    }),
    resolvedCredential: {
      kind: credentialKind as CredentialKind,
      issuer: text(credential.issuer, "$.context.authorityConnection.actor.resolvedCredential.issuer"),
      subject: text(credential.subject, "$.context.authorityConnection.actor.resolvedCredential.subject")
    },
    providerId: text(actor.providerId, "$.context.authorityConnection.actor.providerId")
  };
}

const credentialKinds = new Set<CredentialKind>([
  "unix-socket-owner-boundary",
  "windows-named-pipe-client",
  "ssh-username",
  "ssh-forced-command-person",
  "ssh-tunnel-token-subject",
  "email-address",
  "password-account",
  "oauth-subject",
  "api-token"
]);

function decodeCurrentSession(value: unknown): CurrentSessionRef {
  const session = record(value, "$.context.currentSession");
  exactKeys(
    session,
    ["runtime", "sessionId", "source", "detectedAt"],
    "$.context.currentSession",
    ["user"]
  );
  const runtimes = new Set(["human", "claude-code", "codex", "zcode", "antigravity"]);
  if (typeof session.runtime !== "string" || !runtimes.has(session.runtime)) {
    invalid("$.context.currentSession.runtime");
  }
  if (session.source !== "runtime" && session.source !== "manual") {
    invalid("$.context.currentSession.source");
  }
  return {
    runtime: session.runtime as CurrentSessionRef["runtime"],
    sessionId: text(session.sessionId, "$.context.currentSession.sessionId"),
    source: session.source as CurrentSessionRef["source"],
    detectedAt: text(session.detectedAt, "$.context.currentSession.detectedAt"),
    ...(session.user === undefined ? {} : {
      user: text(session.user, "$.context.currentSession.user")
    })
  };
}

function decodeExecutor(value: unknown): TaskHolderExecutor | null {
  if (value === null) return null;
  const executor = record(value, "$.context.executor");
  exactKeys(executor, ["kind", "id"], "$.context.executor");
  if (executor.kind !== "agent") invalid("$.context.executor.kind");
  return { kind: "agent", id: text(executor.id, "$.context.executor.id") };
}

function progressJsonObject(value: unknown): RepoWriteJsonObject {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return record(normalized, "$") as RepoWriteJsonObject;
}
