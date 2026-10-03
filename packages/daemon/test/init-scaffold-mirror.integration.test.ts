// harness-test-tier: integration
import { signInAt } from "./keycloak.fixtures.ts";
// The scaffold documents `init` writes under the authored root are ledger documents: they are
// in the document projection, so the replica cut carries them and an edge node can read every
// ledger path the generated agent entry names. Driven through the real product entry points —
// host.bootstrap for init, a live fleet TLS center, and runFleetEdgeDocSync on the edge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { runFleetEdgeDocSync } from "../src/fleet-edge-doc-sync.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";

const repoId = "scaffold-mirror",
  nodeId = "node-one",
  replicaQuota = 64 * 1024 * 1024,
  standard = "governance/standards/decision-writing.md";

async function initializedCenterWithEdge() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-init-scaffold-mirror-"))),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    viewRoot = path.join(root, "edge-view"),
    workspace = path.join(root, "edge-workspace"),
    auth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
    };
  mkdirSync(repo);
  mkdirSync(workspace);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Scaffold Mirror Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "scaffold-mirror@example.invalid"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "project base"]);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const owners = await fleetNodeOwners({ userRoot, owners: { [nodeId]: "person-node-one" }, repoIds: [repoId] });
  signInAt(userRoot, "person-node-one");
  const host = await openDaemonHost({ daemonId: "scaffold-mirror-center", userRoot });
  // The full `ha init` shape: nothing but the bootstrap command touches the ledger.
  const initialized = await host.bootstrap({ rootDir: repo, repoId, personId: "owner", displayName: "Owner" }, auth);
  assert.equal(initialized.outcome, "applied", JSON.stringify(initialized));
  // Bootstrap accepts the builtin schedules in SQLite before its Git follower publishes them.
  // Sample Git only after that accepted cut is materialized, matching the replica's read cut.
  await host.settleMaterialization(repoId, "scaffold mirror baseline");
  const writerEpochStateRoot = path.join(userRoot, "fleet"),
    writerAuthority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot }),
    hostLease = writerAuthority.current(repoId);
  writerAuthority.close();
  assert.ok(hostLease);
  const center = await listenFleetTls({
    host,
    stateRoot: path.join(root, "state"),
    writerEpochStateRoot,
    writerEpochLease: () => hostLease,
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    replicaDiskQuotaBytes: replicaQuota,
    authenticate: (candidate, credential) => candidate === nodeId && credential === "secret-node-one",
    nodeOwner: owners.nodeOwner,
  });
  const edgeSync = (): Promise<Record<string, unknown>> =>
    runFleetEdgeDocSync({
      payload: {
        host: "127.0.0.1",
        port: center.port,
        caPath: certFile,
        servername: "localhost",
        nodeId,
        credential: "secret-node-one",
        repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: workspace,
      } as never,
    });
  const centerSubmit = async (logical: string, body: string): Promise<void> => {
    writeFileSync(path.join(repo, "harness", ...logical.split("/")), body);
    const submitted = await host.run(repoId, { kind: "doc-submit", paths: [logical] } as never, auth);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  };
  return {
    repo,
    workspace,
    edgeSync,
    centerSubmit,
    edgeRevision: () => locateFleetMirrorView(viewRoot, repoId)?.revision ?? null,
    mirroredPaths: () => [...(locateFleetMirrorView(viewRoot, repoId)?.entries.keys() ?? [])].sort(),
    close: async () => {
      await center.close();
      await host.close();
      await owners.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function ledgerFiles(repo: string): string[] {
  return execFileSync("git", ["-C", path.join(repo, "harness"), "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "" && !file.startsWith("events/"))
    .sort();
}

test("init publishes every scaffold document it writes under the authored root", { timeout: 60_000 }, async (t) => {
  const fixture = await initializedCenterWithEdge();
  t.after(() => fixture.close());
  const written = ledgerFiles(fixture.repo);
  assert.ok(written.includes(standard), `init must scaffold ${standard}; saw ${written.join(",")}`);
  assert.ok(written.includes("context/architecture/README.md"));
  assert.ok(written.includes("schedules/builtin-ledger-backup.json"));
  assert.ok(written.includes("schedules/builtin-nightly-reckoning.json"));
  assert.equal((await fixture.edgeSync()).ok, true);
  // Whatever init committed to the ledger repository is a ledger document the replica cut carries:
  // no file is on the center's disk only.
  assert.deepEqual(fixture.mirroredPaths(), written);
});

test(
  "an edge node reaches every ledger path the generated agent entry names once it has synced",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await initializedCenterWithEdge();
    t.after(() => fixture.close());
    const named = [
      ...new Set(
        [...readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8").matchAll(/`(harness\/[^`\s]*)`/gu)].map(
          (match) => match[1]!,
        ),
      ),
    ]
      // The entry also names entity directories (tasks, decisions, facts) that exist only once
      // the ledger holds such an entity; a fresh init has none on either side.
      .filter((ledgerPath) => existsSync(path.join(fixture.repo, ledgerPath)));
    for (const expected of [
      "harness/context/",
      "harness/context/architecture/",
      "harness/governance/standards/",
      "harness/governance/standards/repository-governance.md",
      "harness/governance/standards/decision-writing.md",
    ])
      assert.ok(named.includes(expected), `the agent entry must name ${expected}; named ${named.join(",")}`);
    const synced = await fixture.edgeSync();
    assert.equal(synced.ok, true, JSON.stringify(synced).slice(0, 500));
    assert.deepEqual(
      named.filter((ledgerPath) => !existsSync(path.join(fixture.workspace, ledgerPath))),
      [],
      "every named ledger path the center has must exist on the edge",
    );
    assert.equal(
      readFileSync(path.join(fixture.workspace, "harness", standard), "utf8"),
      readFileSync(path.join(fixture.repo, "harness", standard), "utf8"),
    );
  },
);

test(
  "a standard the center revises reaches the edge on its next sync, and a local edit stages a conflict",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await initializedCenterWithEdge();
    t.after(() => fixture.close());
    assert.equal((await fixture.edgeSync()).ok, true);
    const baseline = readFileSync(path.join(fixture.repo, "harness", standard), "utf8"),
      baseRevision = fixture.edgeRevision(),
      revised = `${baseline.trimEnd()}\n\nRevised at the center.\n`;
    await fixture.centerSubmit(standard, revised);
    assert.equal(readFileSync(path.join(fixture.workspace, "harness", standard), "utf8"), baseline);
    const synced = await fixture.edgeSync();
    assert.equal(synced.ok, true, JSON.stringify(synced).slice(0, 500));
    assert.equal(readFileSync(path.join(fixture.workspace, "harness", standard), "utf8"), revised);
    assert.ok((fixture.edgeRevision() ?? 0) > (baseRevision ?? 0), "the mirror revision names the newer version");
    // The standards are outside this edge's write scope, so a local edit is never pushed; when the
    // center moves the same document the existing conflict staging applies, nothing is overwritten.
    const local = `${revised.trimEnd()}\n\nEdited on the edge.\n`;
    writeFileSync(path.join(fixture.workspace, "harness", standard), local);
    await fixture.centerSubmit(standard, `${revised.trimEnd()}\n\nRevised at the center again.\n`);
    const blocked = await fixture.edgeSync();
    assert.equal(blocked.ok, false, JSON.stringify(blocked).slice(0, 500));
    assert.equal((blocked as { readonly code?: string }).code, "pull_blocked");
    assert.equal(readFileSync(path.join(fixture.workspace, "harness", standard), "utf8"), local);
    const conflictsRoot = path.join(fixture.workspace, ".harness", "conflicts"),
      conflicts = readdirSync(conflictsRoot).filter((entry) => entry.startsWith("cflt-"));
    assert.equal(conflicts.length, 1);
    assert.equal(readFileSync(path.join(conflictsRoot, conflicts[0]!, "base", standard), "utf8"), revised);
    assert.equal(readFileSync(path.join(conflictsRoot, conflicts[0]!, "local", standard), "utf8"), local);
    assert.match(
      readFileSync(path.join(conflictsRoot, conflicts[0]!, "center", standard), "utf8"),
      /Revised at the center again/u,
    );
  },
);
