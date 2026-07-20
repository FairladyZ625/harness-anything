// harness-test-tier: integration
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  connectionGeneration,
  createAcceptedConnectionEvidence,
  type AuthorityConnectionContext,
  type DaemonRepoNamespace
} from "../src/index.ts";
import type {
  AuthorityRepoComponent,
  AuthorityRepoLifecycleController
} from "../src/index.ts";
import { createAuthorityWireIngressHandler } from "../src/index.ts";

test("authority-wire service binds the authenticated principal to the exact accepted connection", async () => {
  const repo: DaemonRepoNamespace = { repoId: "canonical", canonicalRoot: process.cwd() };
  const generation = connectionGeneration("wire-generation");
  const evidence = createAcceptedConnectionEvidence({
    connectionId: "wire-connection",
    connectionGeneration: generation,
    daemonInstanceId: "daemon-production",
    transportKind: "unix-socket",
    peerCredential: {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    },
    serverRandom: Buffer.alloc(32, 0x41)
  });
  let boundContext: AuthorityConnectionContext | undefined;
  let forcedSessionStarted = false;
  const component: AuthorityRepoComponent = {
    commandSubmissionV2: { submit: async () => { throw new Error("not used"); } },
    bindConnection: (context) => {
      boundContext = context;
      return {
        submit: async () => { throw new Error("not used"); },
        serveForcedCommand: () => {
          forcedSessionStarted = true;
          return { close: async () => {} };
        }
      };
    },
    stop: async () => {}
  };
  const lifecycle = lifecycleWith(component);
  const handler = createAuthorityWireIngressHandler({
    authorityLifecycle: lifecycle,
    repoBindings: () => [{
      repo,
      identity: {
        identityProvider: {
          providerId: "transport-derived/v1",
          authenticate: async () => ({
            ok: true,
            personId: "person_alice",
            primaryEmail: "alice@example.test",
            providerId: "transport-derived/v1",
            credential: {
              kind: "ssh-forced-command-person",
              issuer: "sshd:authorized_keys",
              subject: "person_alice"
            }
          }),
          authorize: async () => ({ ok: true })
        },
        personRegistry: {
          schema: "harness-persons/v1",
          people: [{ personId: "person_alice", displayName: "Alice" }],
          find: (personId) => personId === "person_alice"
            ? { personId, displayName: "Alice" }
            : undefined
        }
      }
    }]
  });
  const stream = new PassThrough();

  await handler({
    bootstrap: {
      type: "harness-daemon.ssh-forced-command/v2",
      streamProtocol: "harness-authority-wire/v1",
      personId: "person_alice",
      canonicalRoot: repo.canonicalRoot
    },
    authContext: {
      transportKind: "unix-socket",
      endpoint: "/tmp/authority-wire.sock",
      sshForcedCommand: {
        personId: "person_alice",
        canonicalRoot: repo.canonicalRoot,
        source: "sshd-authorized-keys-forced-command"
      }
    },
    input: stream,
    output: stream,
    acceptedConnection: {
      evidence,
      connectionId: evidence.connectionId,
      connectionGeneration: evidence.connectionGeneration,
      isActive: () => true,
      assertActive: () => {}
    },
    acceptedConnectionEvidence: evidence
  });

  assert.equal(forcedSessionStarted, true);
  assert.equal(boundContext?.actor.personId, "person_alice");
  assert.equal(boundContext?.actor.primaryEmail, "alice@example.test");
  assert.equal(boundContext?.connectionId, evidence.connectionId);
  assert.deepEqual(boundContext?.channelBinding.digest, evidence.channelBinding.digest);
  assert.deepEqual(boundContext?.peerCredential, evidence.peerCredential.value);
});

function lifecycleWith(component: AuthorityRepoComponent): AuthorityRepoLifecycleController {
  return {
    startRepo: async () => ({ ok: true, component }),
    unpublishRepo: () => component,
    stopRepo: async () => {},
    stopAll: async () => {},
    component: () => component,
    unavailableReason: () => undefined
  };
}
