// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { settledIdentityFixture } from "./fixtures/fleet-settled-identity/fixture.ts";

let legalControlPassed = false;

test(
  "legal control: an archived settled dispatch has no edge-local execution identity",
  { timeout: 120_000 },
  async (t) => {
    const f = await settledIdentityFixture(t, "legal-control");
    assert.equal(f.state().principalReadable, true);
    assert.equal((await f.direct()).outcome, "applied");
    await f.finish();
    const before = f.state();
    f.observe("archive-guard-input", before);
    assert.equal(before.liveExists, true);
    assert.equal(before.archiveExists, false);
    assert.notEqual(before.evidenceSidecar, "pending");
    assert.notEqual(before.evidenceSummary, "pending");
    assert.ok(before.evidenceTrackingVersion !== 1 || before.evidenceSidecar !== null);
    f.releaseTerminal();
    const after = await f.awaitArchive();
    f.observe("archive-complete", after);
    assert.equal(after.principalReadable, false);
    assert.equal(after.unexpired, true);
    const receipt = await f.direct();
    assert.equal(receipt.code, "authorization_denied", JSON.stringify(receipt));
    legalControlPassed = true;
  },
);

test(
  "reproducer: canonical terminal alone does not establish the original final probe premise",
  { timeout: 120_000 },
  async (t) => {
    assert.equal(legalControlPassed, true, "the legal side must pass before the controlled counterexample");
    const f = await settledIdentityFixture(t, "terminal-live");
    assert.equal((await f.direct()).outcome, "applied");
    await f.finish();
    const before = f.state();
    f.observe("controlled-live-input", before);
    assert.equal(before.liveExists, true);
    assert.equal(before.archiveExists, false);
    assert.equal(before.principalReadable, true);
    assert.equal(before.unexpired, true);
    assert.notEqual(before.evidenceSidecar, "pending");
    assert.notEqual(before.evidenceSummary, "pending");
    assert.ok(before.evidenceTrackingVersion !== 1 || before.evidenceSidecar !== null);
    const liveReceipt = await f.direct();
    assert.equal(liveReceipt.code, "execution_credential_rejected", JSON.stringify(liveReceipt));
    assert.match(String(liveReceipt.rejectionExplanation), /^Execution request is outside its dispatch scope\./u);
    assert.equal((liveReceipt.authorizationDecision as { outcome: string }).outcome, "allowed");
    f.releaseTerminal();
    const after = await f.awaitArchive();
    f.observe("controlled-archive-input", after);
    assert.equal(after.principalReadable, false);
    assert.equal(after.unexpired, true);
    const archivedReceipt = await f.direct();
    assert.equal(archivedReceipt.code, "authorization_denied", JSON.stringify(archivedReceipt));
    // Expected-red observation draft: preserve the original strict final assertion on its
    // terminal-only premise. This is not a permanent prevention gate or a semantic ruling.
    assert.equal(liveReceipt.code, "authorization_denied", JSON.stringify(liveReceipt));
  },
);
