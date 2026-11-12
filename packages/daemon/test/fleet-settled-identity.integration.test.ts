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
    assert.equal(before.evidenceSidecar, "stored");
    assert.equal(before.evidenceSummary, "stored");
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
  "terminal scope refusal precedes local identity retirement and the strict entry refusal",
  { timeout: 120_000 },
  async (t) => {
    assert.equal(legalControlPassed, true, "the archived control must pass before the held-terminal case");
    const f = await settledIdentityFixture(t, "terminal-live");
    assert.equal((await f.direct()).outcome, "applied");
    await f.finish();
    const before = f.state();
    f.observe("controlled-live-input", before);
    assert.equal(before.liveExists, true);
    assert.equal(before.archiveExists, false);
    assert.equal(before.principalReadable, true);
    assert.equal(before.unexpired, true);
    assert.equal(before.evidenceSidecar, "stored");
    assert.equal(before.evidenceSummary, "stored");
    // Start the same wait consumed by the logout probe while the accepted response is held.
    // The completed call sequence below proves the consumer enters only after release/archive.
    const archivedProbe = (async () => {
      await f.awaitArchive();
      const after = f.state(),
        entered = f.observe("retired-consumer-entered", after);
      return { after, entered, receipt: await f.direct() };
    })();
    const liveReceipt = await f.direct();
    assert.equal(liveReceipt.code, "execution_credential_rejected", JSON.stringify(liveReceipt));
    assert.match(String(liveReceipt.rejectionExplanation), /^Execution request is outside its dispatch scope\./u);
    assert.equal((liveReceipt.authorizationDecision as { outcome: string }).outcome, "allowed");
    const released = f.releaseTerminal();
    const { after, entered, receipt: archivedReceipt } = await archivedProbe;
    assert.equal(archivedReceipt.code, "authorization_denied", JSON.stringify(archivedReceipt));
    assert.match(String(archivedReceipt.rejectionExplanation), /unknown or expired on this edge runtime/u);
    assert.ok(entered.sequence > released.sequence, "the consumer must enter after the held response is released");
    assert.equal(after.liveExists, false);
    assert.equal(after.archiveExists, true);
    assert.equal(after.principalReadable, false);
    assert.equal(after.unexpired, true);
  },
);
