// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const fixtureEvidence = {
  "lifecycle-initial-two-repos": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "lifecycle-dynamic-bind-unbind": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "lifecycle-one-repo-start-fails": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "lifecycle-daemon-shutdown": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "connection-getpeereid-valid": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "connection-local-peercred-valid": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "connection-so-peercred-valid": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "client-channel-self-report-ignored": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "client-peer-self-report-ignored": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "os-peer-mismatch": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "cross-connection-splice": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "stale-generation-reuse": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "socket-owner-only-i1": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "digest-with-unavailable-credential": "packages/daemon/test/accepted-connection-evidence.test.ts",
  "missing-server-binding-axis": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "non-active-signing-key": "packages/daemon/test/authority-key-store.test.ts",
  "publication-event-persist-fails": "packages/application/test/fact-relation-authority-positive-v2.test.ts",
  "publication-tree-mismatch": "packages/cli/test/authority-lifecycle-seam.test.ts",
  "restart-durable-recovery": "packages/cli/test/authority-lifecycle-seam.test.ts"
} as const;

test("approved authority lifecycle seam keeps all 19 fixture and production-composition gates", () => {
  assert.equal(Object.keys(fixtureEvidence).length, 19);
  for (const [fixture, relativePath] of Object.entries(fixtureEvidence)) {
    const source = read(relativePath);
    if (fixture === "non-active-signing-key") {
      assert.match(source, /signingProfile\(prepublishedRegistry/u);
      assert.match(source, /ACTIVE_SIGNER_REQUIRED/u);
      const keyStore = read("packages/daemon/src/authority/local-key-store.ts");
      assert.match(keyStore, /entry\.purpose === authoritySigningPurpose/u);
      assert.match(keyStore, /entry\.state === "ACTIVE_SIGNING"/u);
      assert.match(keyStore, /candidates\.length !== 1/u);
      continue;
    }
    if (fixture === "publication-event-persist-fails") {
      assert.match(source, /submitV2!/u);
      assert.match(source, /V2_EVENT_PUBLICATION_FAILED/u);
      assert.match(source, /unpublishedReceipt\.tag, "INDETERMINATE"/u);
      assert.match(source, /typeof unpublishedReceipt\.commitSha === "string"/u);
      continue;
    }
    assert.equal(source.includes(fixture), true, `missing fixture evidence: ${fixture}`);
  }

  const acceptedEvidence = read("packages/daemon/src/transport/accepted-connection-evidence.ts");
  assert.match(acceptedEvidence, /harness-daemon-channel\/v1\\0/u);
  assert.match(acceptedEvidence, /harness-peer-credential\/available\/v1/u);
  assert.match(acceptedEvidence, /harness-peer-credential\/unavailable\/v1/u);
  assert.match(acceptedEvidence, /server random must be 32 bytes/u);
  assert.match(acceptedEvidence, /channel digest must be 32 bytes/u);

  const authContext = read("packages/daemon/src/transport/auth-context.ts");
  assert.match(authContext, /unix-socket-filesystem-owner-boundary/u);
  const connectionContext = read("packages/daemon/src/protocol/connection-context.ts");
  assert.match(connectionContext, /channelBinding\.digest\.byteLength === 32/u);
  const protocol = read("packages/daemon/src/protocol/json-rpc-server.ts");
  assert.match(protocol, /resolveAuthorityConnectionForRequest/u);
  assert.match(protocol, /authorityConnection/u);

  const serviceHost = read("packages/cli/src/daemon/service-host.ts");
  assert.match(serviceHost, /authorityPeerPolicy: localAuthorityPeerPolicy/u);
  const submissionDispatch = read("packages/cli/src/daemon/authority-submission-dispatch.ts");
  assert.match(submissionDispatch, /component\.bindConnection\(dispatch\.context\)/u);
  assert.match(submissionDispatch, /dispatch\.assertActive\(\)/u);
  const commandService = read("packages/cli/src/daemon/command-service.ts");
  assert.match(commandService, /resolveAuthoritySubmissionV2\?\.\(context\?\.authorityConnection\)/u);

  const lifecycle = read("packages/cli/src/daemon/authority-lifecycle.ts");
  assert.ok(
    lifecycle.indexOf("state = openDurableAuthorityServiceState")
      < lifecycle.indexOf("input.resolveCompositionData(repo, state)"),
    "durable state must replay before production composition resolves"
  );
  assert.match(lifecycle, /makeHeldLockAttributedCoordinatorFactory\(runtime\)/u);
  assert.match(lifecycle, /resolveHarnessLayout\(repo\.canonicalRoot\)\.authoredRoot/u);

  const peerFixtures = read("packages/daemon/test/accepted-connection-evidence.test.ts");
  for (const fixture of [
    "os-peer-mismatch",
    "cross-connection-splice",
    "stale-generation-reuse",
    "socket-owner-only-i1",
    "digest-with-unavailable-credential"
  ]) {
    assert.match(testBlock(peerFixtures, fixture), /submitV2Calls, 0/u, `${fixture} must prove zero V2 submissions`);
  }
});

function read(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

function testBlock(source: string, fixture: string): string {
  const start = source.indexOf(`test("${fixture}`);
  const containingStart = start >= 0 ? start : source.lastIndexOf("test(\"", source.indexOf(fixture));
  assert.notEqual(containingStart, -1, `missing test block: ${fixture}`);
  const next = source.indexOf("\ntest(\"", containingStart + 6);
  return source.slice(containingStart, next < 0 ? undefined : next);
}
