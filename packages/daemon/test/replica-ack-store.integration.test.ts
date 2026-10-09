// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { READ_MODEL_SCHEMA_GENERATION } from "@harness-anything/kernel";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";

const cut = (revision: number, byte: string) => ({
  revision,
  headDigest: `sha256:${byte.repeat(64)}`,
  schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
});

test("durable ACK store isolates view keys and commits exact proof with its L1-era registration floor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-ack-")),
    key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" },
    // 一节点一 view 是协议不变量(ACK 落定即退役其他 view,见下个测试);键隔离用另一节点验证。
    other = { nodeId: "node-b", viewId: "view-b", repoId: "repo-a" },
    toCut = cut(8, "a"),
    digest = "b".repeat(64);
  try {
    let store = openReplicaAckStore(root);
    assert.equal(store.register(key, 5), 5);
    assert.equal(store.register(key, 9), 5);
    assert.equal(store.register(other, 7), 7);
    const lease = store.delivery.claim(key, "holder-a", Date.parse("2026-08-14T00:00:00.000Z"), 30_000)!;
    const offer = store.offer(key, {
      transferId: "transfer-a",
      fromCut: null,
      toCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-08-14T00:00:00.000Z",
    });
    assert.deepEqual(store.offer(key, { ...offer, transferId: "replacement-denied" }), offer);
    assert.equal(
      store.ack(key, "transfer-a", toCut, "c".repeat(64), "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "op_rejected",
    );
    assert.equal(
      store.ack(
        { ...key, nodeId: "node-b" },
        "transfer-a",
        toCut,
        digest,
        "2026-08-14T00:00:01.000Z",
        "2026-08-13T00:00:00.000Z",
        lease,
      ).outcome,
      "op_rejected",
    );
    assert.equal(
      store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "applied",
    );
    assert.equal(store.proof(key, 8)?.manifestDigest, digest);
    assert.equal(store.cursor(key)?.revision, 8);
    assert.equal(store.offerFor(key), null);
    store.close();
    store = openReplicaAckStore(root);
    assert.equal(store.registrationRevision(key), 5);
    assert.equal(store.registrationRevision(other), 7);
    assert.equal(store.proof(key, 8)?.transferId, "transfer-a");
    assert.equal(
      store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:02.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "current",
    );
    assert.equal(store.proof(other, 8), null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-revision re-delivery under a new transfer converges to current without touching the recorded proof", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-ack-retransfer-")),
    key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" },
    toCut = cut(8, "a"),
    digest = "b".repeat(64);
  try {
    const store = openReplicaAckStore(root);
    store.register(key, 5);
    const lease = store.delivery.claim(key, "holder-a", Date.parse("2026-10-08T00:00:00.000Z"), 30_000)!;
    store.offer(key, {
      transferId: "transfer-delta",
      fromCut: cut(5, "f"),
      toCut,
      manifestDigest: digest,
      kind: "delta",
      issuedAt: "2026-10-08T00:00:00.000Z",
    });
    assert.equal(
      store.ack(key, "transfer-delta", toCut, digest, "2026-10-08T00:00:01.000Z", "2026-10-07T00:00:00.000Z", lease)
        .outcome,
      "applied",
    );
    // The delta base slid out of retention, so the center re-offers the same revision
    // as a fresh snapshot under a new transfer id; its ACK must converge, not collide.
    store.offer(key, {
      transferId: "transfer-snapshot",
      fromCut: null,
      toCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-10-08T00:00:02.000Z",
    });
    const converged = store.ack(
      key,
      "transfer-snapshot",
      toCut,
      digest,
      "2026-10-08T00:00:03.000Z",
      "2026-10-07T00:00:00.000Z",
      lease,
    );
    assert.equal(converged.outcome, "current");
    assert.equal(converged.cursor?.revision, 8);
    assert.equal(store.proof(key, 8)?.transferId, "transfer-delta");
    assert.equal(store.offerFor(key), null);
    // A re-offered cut that disagrees with the recorded proof at the same revision is rejected, not merged.
    const divergentCut = cut(8, "c"),
      divergentDigest = "d".repeat(64);
    store.offer(key, {
      transferId: "transfer-divergent",
      fromCut: null,
      toCut: divergentCut,
      manifestDigest: divergentDigest,
      kind: "snapshot",
      issuedAt: "2026-10-08T00:00:04.000Z",
    });
    assert.equal(
      store.ack(
        key,
        "transfer-divergent",
        divergentCut,
        divergentDigest,
        "2026-10-08T00:00:05.000Z",
        "2026-10-07T00:00:00.000Z",
        lease,
      ).outcome,
      "op_rejected",
    );
    assert.equal(store.proof(key, 8)?.transferId, "transfer-delta");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settled ACK retires the node's frozen other views for that repository and no one else's", () => {
  // 测试床 B2:静态 assignment 时代的旧 view 行 ack 永不前进,若不回收就永久留在
  // status()/概览里。一节点一仓库一 view 是当前协议不变量(pull 的 viewId 由中心按
  // nodeId 命名);节点只对正在拉取的 view 推进 ACK,所以退役挂在 ACK 落地上——
  // 确认新 view 可用后才回收,被拒的 ACK 与 register 都不清扫。
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-retire-")),
    retired = { nodeId: "cc90-ubuntu", viewId: "cc90-ubuntu-schedule-view", repoId: "repo-a" },
    active = { nodeId: "cc90-ubuntu", viewId: "cc90-ubuntu", repoId: "repo-a" },
    neighbor = { nodeId: "macos-user", viewId: "macos-user-view", repoId: "repo-a" },
    retiredCut = cut(26, "a"),
    digest = "b".repeat(64);
  try {
    const store = openReplicaAckStore(root);
    store.register(retired, 5);
    store.register(neighbor, 7);
    const lease = store.delivery.claim(retired, "holder-old", Date.parse("2026-10-05T00:00:00.000Z"), 30_000)!;
    store.offer(retired, {
      transferId: "transfer-old",
      fromCut: null,
      toCut: retiredCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-10-05T00:00:00.000Z",
    });
    assert.equal(
      store.ack(
        retired,
        "transfer-old",
        retiredCut,
        digest,
        "2026-10-05T00:00:01.000Z",
        "2026-10-04T00:00:00.000Z",
        lease,
      ).outcome,
      "applied",
    );
    store.delivery.record(retired, { bytes: 4096, started: "snapshot" });
    // 升级前夜掉线的残迹:未 ack 的悬空 offer + 未过期的 delivery lease。
    store.offer(retired, {
      transferId: "transfer-dangling",
      fromCut: retiredCut,
      toCut: cut(30, "c"),
      manifestDigest: digest,
      kind: "delta",
      issuedAt: "2026-10-05T00:00:20.000Z",
    });
    store.close();

    // Persist old generations and the original unversioned deployment tables. Retirement
    // must sweep representations, while retaining the active view's old proof and neighbors.
    const inspect = new DatabaseSync(path.join(root, "replica/repos/repo-a/ack.sqlite"));
    const historicalTables: string[] = [];
    for (const family of ["ack_proof", "ack_cursor", "active_offer"]) {
      for (const suffix of ["", "_g0", `_g${READ_MODEL_SCHEMA_GENERATION - 1}`]) {
        const table = `${family}${suffix}`;
        historicalTables.push(table);
        inspect.exec(`CREATE TABLE ${table} AS SELECT * FROM ${family}_wire_g${READ_MODEL_SCHEMA_GENERATION}`);
        inspect.exec(`INSERT INTO ${table} SELECT * FROM ${family}_wire_g${READ_MODEL_SCHEMA_GENERATION}`);
        inspect.prepare(`UPDATE ${table} SET view_id=? WHERE rowid=2`).run(active.viewId);
        inspect.exec(`INSERT INTO ${table} SELECT * FROM ${family}_wire_g${READ_MODEL_SCHEMA_GENERATION}`);
        inspect.prepare(`UPDATE ${table} SET node_id=?,view_id=? WHERE rowid=3`).run(neighbor.nodeId, neighbor.viewId);
      }
    }
    const historicalRows = () =>
      historicalTables.map((table) =>
        inspect.prepare(`SELECT node_id,view_id,transfer_id FROM ${table} ORDER BY rowid`).all(),
      );
    const before = historicalRows();
    const otherRepo = { ...retired, repoId: "repo-b" };
    const separate = openReplicaAckStore(root);
    separate.register(otherRepo, 9);
    separate.close();

    // 中心重启后节点带着新 view 首次 pull:register 只登记,退役行原样保留。
    const reopened = openReplicaAckStore(root);
    const byKey = (keys: readonly { nodeId: string; viewId: string }[]) =>
      [...keys].sort(
        (left, right) => left.nodeId.localeCompare(right.nodeId) || left.viewId.localeCompare(right.viewId),
      );
    assert.equal(reopened.register(active, 411), 411);
    assert.deepEqual(byKey(reopened.keys().filter((key) => key.repoId === active.repoId)), [active, retired, neighbor]);
    const activeCut = cut(411, "d"),
      nextLease = reopened.delivery.claim(active, "holder-new", Date.parse("2026-10-06T00:00:00.000Z"), 30_000)!;
    reopened.offer(active, {
      transferId: "transfer-new",
      fromCut: null,
      toCut: activeCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-10-06T00:00:00.000Z",
    });
    // 被拒的 ACK(manifest 不匹配活跃 offer)不证明新 view 可用,不清扫。
    assert.equal(
      reopened.ack(
        active,
        "transfer-new",
        activeCut,
        "9".repeat(64),
        "2026-10-06T00:00:01.000Z",
        "2026-10-05T00:00:00.000Z",
        nextLease,
      ).outcome,
      "op_rejected",
    );
    assert.deepEqual(byKey(reopened.keys().filter((key) => key.repoId === active.repoId)), [active, retired, neighbor]);
    assert.deepEqual(historicalRows(), before, "rejected ACK retains every historical row");
    // ACK 落定:同节点其他 view 的 registration/ack_proof/ack_cursor/悬空 active_offer/
    // delivery metrics 全部回收,邻居节点不受影响。
    assert.equal(
      reopened.ack(
        active,
        "transfer-new",
        activeCut,
        digest,
        "2026-10-06T00:00:02.000Z",
        "2026-10-05T00:00:00.000Z",
        nextLease,
      ).outcome,
      "applied",
    );
    assert.deepEqual(byKey(reopened.keys().filter((key) => key.repoId === active.repoId)), [active, neighbor]);
    assert.equal(reopened.registrationRevision(retired), null);
    assert.equal(reopened.cursor(retired), null);
    assert.equal(reopened.proof(retired, 26), null);
    assert.equal(reopened.offerFor(retired), null);
    assert.deepEqual(reopened.delivery.metrics(retired), {
      transferBytes: 0,
      snapshotStarts: 0,
      deltaStarts: 0,
      errors: 0,
      lastFailureCode: null,
    });
    const retained = before.map((rows) => rows.filter((row) => row.view_id !== retired.viewId));
    assert.deepEqual(historicalRows(), retained, "all generations retire only this node's other views");
    assert.equal(reopened.registrationRevision(otherRepo), 9, "another repository is untouched");
    // Re-register a frozen view, then replay the settled ACK: current also retires it.
    reopened.register(retired, 5);
    // 重复 ACK(current)幂等:退役行不复活。
    assert.equal(
      reopened.ack(
        active,
        "transfer-new",
        activeCut,
        digest,
        "2026-10-06T00:00:03.000Z",
        "2026-10-05T00:00:00.000Z",
        nextLease,
      ).outcome,
      "current",
    );
    assert.deepEqual(byKey(reopened.keys().filter((key) => key.repoId === active.repoId)), [active, neighbor]);
    assert.equal(reopened.registrationRevision(retired), null);
    assert.deepEqual(historicalRows(), retained);
    inspect.close();
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery leases fence expiry across workers and isolate node/repo/view metrics", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-delivery-lease-"));
  const key = { nodeId: "node-a", repoId: "repo-a", viewId: "view-a" };
  const first = openReplicaAckStore(root),
    second = openReplicaAckStore(root);
  try {
    const lease = first.delivery.claim(key, "worker-one", 1000, 100)!;
    assert.equal(lease.claimFence, 1);
    assert.equal(second.delivery.claim(key, "worker-two", 1050, 100), null);
    assert.equal(second.delivery.claim({ ...key, viewId: "view-other" }, "worker-two", 1050, 100), null);
    assert.ok(second.delivery.claim({ ...key, nodeId: "node-b" }, "worker-two", 1050, 100));
    assert.ok(second.delivery.claim({ ...key, repoId: "repo-b" }, "worker-two", 1050, 100));
    const replacement = second.delivery.claim(key, "worker-two", 1100, 100)!;
    assert.equal(replacement.claimFence, 2);
    assert.equal(first.delivery.renew(lease, 1101, 100), false);
    first.delivery.release(lease);
    assert.equal(second.delivery.active(key, 1101)?.holderId, "worker-two");
    const target = cut(8, "a"),
      digest = "b".repeat(64);
    first.offer(key, {
      transferId: "fenced",
      fromCut: null,
      toCut: target,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: new Date(1100).toISOString(),
    });
    assert.equal(
      first.ack(key, "fenced", target, digest, new Date(1101).toISOString(), new Date(900).toISOString(), lease)
        .outcome,
      "op_rejected",
    );
    assert.equal(first.cursor(key), null);
    assert.equal(
      second.ack(key, "fenced", target, digest, new Date(1102).toISOString(), new Date(900).toISOString(), replacement)
        .outcome,
      "applied",
    );
    second.delivery.record(key, { bytes: 17, started: "delta" });
    second.delivery.record(key, { failureCode: "cut_missing" });
    assert.deepEqual(first.delivery.metrics(key), {
      transferBytes: 17,
      snapshotStarts: 0,
      deltaStarts: 1,
      errors: 1,
      lastFailureCode: "cut_missing",
    });
    assert.equal(first.delivery.metrics({ ...key, nodeId: "node-b" }).transferBytes, 0);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same generation ACK replay converges, rejects changed bytes, and a new generation preserves old proof", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ack-generation-"));
  const key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" };
  const target = cut(8, "a"),
    digest = "b".repeat(64),
    now = "2026-10-08T00:00:00Z";
  let store = openReplicaAckStore(root);
  try {
    store.register(key, 5);
    const lease = store.delivery.claim(key, "holder", Date.parse(now), 30_000)!;
    const offer = (transferId: string, manifestDigest = digest) =>
      store.offer(key, { transferId, fromCut: null, toCut: target, manifestDigest, kind: "snapshot", issuedAt: now });
    offer("first");
    assert.equal(store.ack(key, "first", target, digest, now, now, lease).outcome, "applied");
    offer("repeat");
    assert.equal(store.ack(key, "repeat", target, digest, now, now, lease).outcome, "current");
    assert.equal(store.offerFor(key), null);
    assert.equal(store.proof(key, 8)?.transferId, "first", "immutable proof survives another transfer");
    offer("conflict", "c".repeat(64));
    assert.equal(store.ack(key, "conflict", target, "c".repeat(64), now, now, lease).outcome, "op_rejected");
    assert.equal(store.cursor(key)?.manifestDigest, digest);
    store.clearOffer(lease);
    offer("old-pending", "d".repeat(64));
    store.close();
    const database = new DatabaseSync(path.join(root, "replica/repos/repo-a/ack.sqlite"));
    for (const table of ["ack_proof", "ack_cursor", "active_offer"])
      database.exec(
        `ALTER TABLE ${table}_wire_g${READ_MODEL_SCHEMA_GENERATION} RENAME TO ${table}_wire_g${READ_MODEL_SCHEMA_GENERATION - 1}`,
      );
    database.exec(`DROP INDEX ack_transfer_wire_g${READ_MODEL_SCHEMA_GENERATION}`);
    database.close();
    store = openReplicaAckStore(root);
    assert.equal(store.registrationRevision(key), 5, "upgrade retains the L1 registration floor");
    assert.equal(store.cursor(key), null, "old generation cannot claim current representation");
    assert.equal(store.offerFor(key), null, "old generation pending offer cannot shadow the new representation");
    offer("new-generation", "c".repeat(64));
    assert.equal(store.ack(key, "new-generation", target, "c".repeat(64), now, now, lease).outcome, "applied");
    assert.equal(store.cursor(key)?.manifestDigest, "c".repeat(64));
    const inspect = new DatabaseSync(path.join(root, "replica/repos/repo-a/ack.sqlite"));
    assert.equal(
      (
        inspect.prepare(`SELECT manifest_digest FROM ack_proof_wire_g${READ_MODEL_SCHEMA_GENERATION - 1}`).get() as {
          manifest_digest: string;
        }
      ).manifest_digest,
      digest,
    );
    assert.equal(
      (
        inspect.prepare(`SELECT transfer_id FROM active_offer_wire_g${READ_MODEL_SCHEMA_GENERATION - 1}`).get() as {
          transfer_id: string;
        }
      ).transfer_id,
      "old-pending",
    );
    inspect.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired owner release cannot clear the replacement owner's offer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-offer-fence-"));
  const store = openReplicaAckStore(root);
  const key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" };
  const now = Date.now();
  try {
    const a = store.delivery.claim(key, "session-a", now, 10)!;
    const b = store.delivery.claim(key, "session-b", now + 11, 30_000)!;
    assert.ok(b.claimFence > a.claimFence);
    const offer = store.offer(key, {
      transferId: "transfer-b",
      fromCut: null,
      toCut: cut(8, "a"),
      manifestDigest: "b".repeat(64),
      kind: "snapshot",
      issuedAt: new Date(now + 11).toISOString(),
    });
    store.clearOffer(a);
    store.delivery.release(a);
    assert.equal(
      store.ack(
        key,
        offer.transferId,
        offer.toCut,
        offer.manifestDigest,
        new Date(now + 12).toISOString(),
        new Date(now).toISOString(),
        b,
      ).outcome,
      "applied",
    );
    store.offer(key, { ...offer, transferId: "transfer-b-next" });
    store.clearOffer(b);
    store.delivery.release(b);
    assert.equal(store.offerFor(key), null, "current owner still clears its own offer");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder retention reads do not block lease renewal or offer release", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ack-reader-"));
  const store = openReplicaAckStore(root);
  const key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" };
  const now = Date.now();
  const lease = store.delivery.claim(key, "session", now, 30_000)!;
  store.offer(key, {
    transferId: "transfer",
    fromCut: null,
    toCut: cut(8, "a"),
    manifestDigest: "b".repeat(64),
    kind: "snapshot",
    issuedAt: new Date(now).toISOString(),
  });
  const reader = new DatabaseSync(path.join(root, "replica/repos/repo-a/ack.sqlite"), { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM delivery_lease").all();
    store.delivery.record(key, { bytes: 1 });
    assert.equal(store.delivery.renew(lease, now + 1, 30_000), true);
    store.clearOffer(lease);
    store.delivery.release(lease);
    assert.equal(store.offerFor(key), null);
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
