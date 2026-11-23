import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StorageBackendConfig } from "@harness-anything/storage";
import { decodeVerticalDefinition } from "@harness-anything/kernel/schemas";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import { initRepo } from "../../../storage/test/store/task-event-store.fixtures.ts";
import { canonicalRoot, workspaceId } from "../../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "../keycloak-policy.fixtures.ts";
import { fixtureFence, openBootstrappedRepoCell, settleSettingsEvent } from "../repo-settings.fixture.ts";

const slotId = "project-atlas";
const verticalDefinition = decodeVerticalDefinition({
  ...JSON.parse(readFileSync(`${defaultAssets}/vertical.json`, "utf8")),
  livingDossier: {
    slots: [
      {
        id: slotId,
        path: "project-atlas.html",
        kind: "html",
        title: "Project atlas",
        summary: "Decisions governing this project.",
        entityKinds: ["decision"],
        requiredAnchors: ["decision-log"],
        watermarkMetadata: "required",
        triggers: [{ kind: "event-watermark", minimumDelta: 1 }],
      },
      {
        id: "narrative",
        path: "context.md",
        kind: "markdown",
        title: "Context",
        summary: "Current project context.",
        entityKinds: ["task"],
        requiredAnchors: ["context"],
        watermarkMetadata: "required",
        triggers: [{ kind: "periodic", everyMs: 60_000 }],
      },
    ],
  },
});

function html(watermark: number, body: string): string {
  return `<!doctype html><html><head><meta name="dossier-watermark" content="${watermark}"></head><body>${body}</body></html>`;
}

export async function assertDossierRepoCell(root: string, storage: StorageBackendConfig): Promise<void> {
  const repository = path.join(root, "dossier-repository");
  mkdirSync(repository, { recursive: true });
  const rootDir = canonicalRoot(repository),
    repoId = workspaceId("living-dossier-fixture"),
    binding = withPolicyGroup(
      { actor: { principal: { personId: "dossier-maintainer" }, executor: null }, source: "local" as const },
      "maintainer",
    ),
    contributor = withPolicyGroup(
      { actor: { principal: { personId: "dossier-contributor" }, executor: null }, source: "local" as const },
      "contributor",
    );
  if (storage.backend === "sqlite") initRepo(rootDir);
  const defaultWriterEpochFence = fixtureFence(repoId, rootDir, path.join(root, "dossier-writer"), storage);
  await settleSettingsEvent({
    repoId,
    rootDir,
    storage,
    verticalDefinition,
    writerEpochFence: defaultWriterEpochFence,
  });
  const open = () =>
    openBootstrappedRepoCell({ repoId, rootDir, storage, ownerId: "dossier-test", defaultWriterEpochFence });
  let cell = await open();
  try {
    const empty = await cell.read("repo.dossier.read", { slotId }, binding);
    assert.equal(empty.body, null);
    const initial = await cell.read("repo.dossier.status", {}, binding);
    assert.equal(initial.slots.length, 2);
    assert.equal(initial.slots[0]?.lastSynthesizedWatermark, 0);
    assert.deepEqual(initial.slots[0]?.dueTriggers, [{ kind: "event-watermark", minimumDelta: 1 }]);
    const page = await cell.read("repo.dossier.context.read", { slotId }, binding);
    assert.equal(page.expectedWatermark, 0);
    assert.equal(page.nextWatermark, initial.currentWatermark);
    assert.equal(page.done, true);

    const operation = {
      kind: "dossier-synthesize",
      slotId,
      expectedWatermark: 0,
      watermark: page.nextWatermark,
    };
    const good = (content: string) => html(page.nextWatermark, `<main id="decision-log"><p>${content}</p></main>`);
    const body = good("The repository records accepted decisions here.");
    for (const [idempotencyKey, invalid] of [
      ["missing-anchor", html(page.nextWatermark, "<p>Describe organization decisions here.</p>")],
      ["external-image", good('<img src="https://cdn.example.invalid/image.png">')],
      ["external-css", good('<span style="background: &#117;rl(https://cdn.example.invalid/a)">Chart</span>')],
      ["placeholder", good("TODO")],
      ["claimed-watermark", html(page.nextWatermark + 1, '<p id="decision-log">An existing decision.</p>')],
    ] as const) {
      const rejected = await cell.run({ ...operation, body: invalid, idempotencyKey }, binding);
      assert.equal(rejected.code, "invalid_dossier_content", JSON.stringify(rejected));
    }
    const unauthorized = await cell.run({ ...operation, body, idempotencyKey: "no-writer" }, contributor);
    assert.equal(unauthorized.code, "authorization_denied", JSON.stringify(unauthorized));
    const beyondCut = await cell.run(
      {
        ...operation,
        watermark: page.nextWatermark + 1,
        body: html(page.nextWatermark + 1, '<main id="decision-log"><p>Future cut.</p></main>'),
        idempotencyKey: "beyond-cut",
      },
      binding,
    );
    assert.equal(beyondCut.code, "invalid_command", JSON.stringify(beyondCut));
    const staleClaim = await cell.run(
      {
        ...operation,
        body,
        idempotencyKey: "wrong-claim",
        scheduleId: "stale-schedule",
        claimFence: "stale",
      },
      binding,
    );
    assert.equal(staleClaim.code, "schedule_claim_stale", JSON.stringify(staleClaim));

    const writes = [
      { ...operation, body, idempotencyKey: "draft-a" },
      { ...operation, body: good("A competing draft changes the explanation."), idempotencyKey: "draft-b" },
    ];
    const results = await Promise.all(writes.map((action) => cell.run(action, binding)));
    assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["applied", "op_rejected"]);
    assert.equal(results.find(({ outcome }) => outcome === "op_rejected")?.code, "dossier_watermark_conflict");
    const winningIndex = results.findIndex(({ outcome }) => outcome === "applied");
    const replay = await cell.run(writes[winningIndex]!, binding);
    assert.equal(replay.opId, results[winningIndex]?.opId);
    const final = await cell.read("repo.dossier.status", {}, binding);
    assert.equal(final.slots[0]?.stalenessDelta, 0, "a synthesis does not stale itself");
    assert.equal(final.slots[1]?.lastSynthesizedWatermark, 0, "slot fences are independent");
    assert.equal(final.currentWatermark, page.nextWatermark);
    assert.deepEqual(final.slots[0]?.dueTriggers, []);
    const published = await cell.read("repo.dossier.read", { slotId }, binding);
    assert.equal(published.mediaType, "text/html");
    assert.equal(published.body, writes[winningIndex]?.body);
    assert.equal(published.state?.lastSynthesizedWatermark, page.nextWatermark);
    await cell.close();
    cell = await open();
    assert.deepEqual(await cell.read("repo.dossier.read", { slotId }, binding), published);
    console.log(
      `DOSSIER_PARITY backend=${storage.backend} initial=${page.expectedWatermark} accepted=${page.nextWatermark} stale=dossier_watermark_conflict restart=identical`,
    );
  } finally {
    await cell.close();
  }
}
