// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { signInAt, signOutAt, spawnKeycloak } from "../../daemon/test/keycloak.fixtures.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { runDaemonControl } from "../src/daemon/control.ts";
import { cliDaemonServeLaunch, daemonServeEntry } from "../src/daemon/client.ts";

const cli = path.resolve("packages/cli/src/index.ts"),
  quotaBytes = 64 * 1024 * 1024;

test(
  "fleet center start and edge sync mirror the authoritative ledger through the CLI",
  { timeout: 180_000 },
  async () => {
    const fixture = setup(),
      realm = await spawnKeycloak();
    try {
      // The center's node registry lives in Keycloak: the node is registered to a person who holds the
      // sync action on this repository, and Keycloak mints the machine credential.
      realm.bind(fixture.centerUser);
      await realm.control({ op: "account", personId: "edge-operator" });
      await realm.control({
        op: "permit",
        personId: "edge-operator",
        resource: "fleet-demo",
        actions: ["daemon-fleet-edge-sync"],
      });
      const machineCredential = await realm.control<string>({
        op: "node",
        nodeId: "edge-one",
        personId: "edge-operator",
      });
      const capabilities = JSON.parse(
        spawnSync(process.execPath, [cli, "capabilities", "--json"], { encoding: "utf8" }).stdout,
      ) as Record<string, string[]>;
      assert.deepEqual(
        capabilities.daemon?.filter((id) => id.startsWith("daemon-fleet")),
        ["daemon-fleet-center-start", "daemon-fleet-edge-sync"],
      );
      assert.equal(run(fixture, "center", ["daemon", "start", "--service"]).ok, true);
      register(fixture);
      const created = run(fixture, "center", ["task", "create", "--id", "task-fleet", "--admin", "--title", "Fleet"]);
      assert.equal(created.outcome, "applied");
      published(fixture, "center", created);
      const planPath = `${String(created.packagePath)}/task_plan.md`;
      writeFileSync(path.join(fixture.repo, "harness", planPath), realizedTaskPlan("Fleet"));
      assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--path", planPath]).outcome, "applied");
      assert.equal(
        run(fixture, "center", ["task", "start", "task-fleet", "--execution-id", "exec-fleet"]).outcome,
        "applied",
      );
      const docPath = "tasks/task-fleet-fleet/notes.md",
        docBody = "# Fleet mirror note\n\nfirst cut\n";
      writeFileSync(path.join(fixture.repo, "harness", docPath), docBody);
      assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--task", "task-fleet"]).outcome, "applied");
      const missing = maybeRun(fixture, "center", ["daemon", "fleet", "center", "start"]);
      assert.equal(missing.status, 2);
      assert.equal(missing.receipt.code, "missing_field");
      const rejected = maybeRun(fixture, "center", [
        "daemon",
        "fleet",
        "center",
        "start",
        "--port",
        "0",
        "--key",
        fixture.key,
        "--cert",
        fixture.cert,
        "--roster",
        fixture.badRoster,
        "--quota-bytes",
        String(quotaBytes),
      ]);
      assert.equal(rejected.receipt.code, "roster_invalid");
      const center = run(fixture, "center", [
        "daemon",
        "fleet",
        "center",
        "start",
        "--port",
        "0",
        "--key",
        fixture.key,
        "--cert",
        fixture.cert,
        "--roster",
        fixture.roster,
        "--quota-bytes",
        String(quotaBytes),
      ]);
      assert.equal(center.ok, true);
      assert.equal(center.bind, "127.0.0.1");
      assert.equal(center.stateRoot, path.join(fixture.centerUser, "fleet"));
      assert.equal(center.assignments, 1);
      const port = center.port as number;
      writeFileSync(
        path.join(fixture.edgeRepo, "fleet-edge.json"),
        JSON.stringify({
          schema: "fleet-edge-config/v1",
          repoId: "fleet-demo",
          host: "127.0.0.1",
          port,
          caPath: fixture.ca,
          nodeId: "edge-one",
          credential: machineCredential,
          assignmentId: "assignment-edge-one",
          viewRoot: fixture.viewRoot,
          quotaBytes,
        }),
      );
      assert.equal(run(fixture, "edge", ["daemon", "start", "--service"]).ok, true);
      assert.equal(
        run(fixture, "edge", [
          "daemon",
          "repo",
          "register",
          "--repo-id",
          "fleet-demo",
          "--root",
          fixture.edgeRepo,
          "--mode",
          "remote-edge",
        ]).ok,
        true,
      );
      const initialStatus = run(fixture, "edge", ["daemon", "status"]);
      assert.equal(initialStatus.ok, true, "an unsynced edge has no canonical Git publication to fail");
      assert.equal(
        (initialStatus.repos as { repoId: string; materialization: unknown }[]).find(
          ({ repoId }) => repoId === "fleet-demo",
        )?.materialization,
        null,
      );
      const syncArgs = [
        "daemon",
        "fleet",
        "edge",
        "sync",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--ca",
        fixture.ca,
        "--node-id",
        "edge-one",
        "--assignment",
        "assignment-edge-one",
        "--view-root",
        fixture.viewRoot,
        "--quota-bytes",
        String(quotaBytes),
      ] as const;
      const edgeGitHead = readFileSync(path.join(fixture.edgeRepo, ".git", "HEAD"), "utf8");
      const observed = await spawnedRun(fixture, "edge", syncArgs),
        exposed = JSON.stringify({ argv: observed.argv, stdout: observed.stdout, stderr: observed.stderr });
      assert.equal(exposed.includes(machineCredential), false, "the machine credential stays off argv and output");
      assert.equal(observed.status, 0, observed.stderr);
      const first = JSON.parse(observed.stdout) as Record<string, unknown>,
        sync = (extra: readonly string[] = []) => run(fixture, "edge", [...syncArgs, ...extra]);
      const pulled = first.ok === false && first.code === "replica_pending" ? retryReplicaPending(sync) : first;
      assert.equal(pulled.status, "fleet.ack.result/v1");
      assert.equal(pulled.viewId, "edge-one-view");
      const syncedStatus = run(fixture, "edge", ["daemon", "status"]);
      assert.equal(
        syncedStatus.ok,
        true,
        "a synced edge reports its host status without claiming a local canonical publisher",
      );
      assert.equal(
        (syncedStatus.repos as { repoId: string; materialization: unknown }[]).find(
          ({ repoId }) => repoId === "fleet-demo",
        )?.materialization,
        null,
      );
      assert.equal((pulled.cut as { revision: number }).revision, pulled.ackCut);
      const viewRoot = path.join(fixture.viewRoot, "repos", "fleet-demo", "views", "edge-one-view");
      assert.equal(readCutFile(viewRoot, pulled.ackCut as number, docPath), docBody);
      assert.equal(
        readFileSync(path.join(fixture.edgeRepo, "harness", docPath), "utf8"),
        docBody,
        "sync materializes the registered workspace path",
      );
      assert.equal(
        existsSync(path.join(viewRoot, "worktree")),
        false,
        "the daemon-internal view worktree no longer exists",
      );
      assert.equal(
        readFileSync(path.join(fixture.edgeRepo, ".git", "HEAD"), "utf8"),
        edgeGitHead,
        "materialization leaves workspace Git metadata untouched",
      );
      const shown = run(fixture, "edge", ["task", "show", "task-fleet"]);
      assert.equal(shown.revision, pulled.ackCut);
      assert.doesNotMatch(String(shown.summary), /task=null/u);
      const status = run(fixture, "edge", ["doc", "status", "--path", docPath]);
      assert.equal((status.cut as { revision: number }).revision, pulled.ackCut);
      assert.deepEqual(status.rows, []);
      const current = JSON.parse(readFileSync(path.join(viewRoot, "current.json"), "utf8")) as {
        cut: { revision: number };
      };
      assert.equal(current.cut.revision, pulled.ackCut);
      stop(fixture, "edge");
      assert.equal(run(fixture, "edge", ["daemon", "start", "--service"]).ok, true);
      const again = sync();
      assert.equal(again.status, "fleet.replica.current/v1");
      assert.deepEqual(again.cut, pulled.cut);
      assert.equal(
        readFileSync(path.join(fixture.edgeRepo, "harness", docPath), "utf8"),
        docBody,
        "restart replay is idempotent at the registered path",
      );
      const refused = maybeRun(fixture, "edge", [
        "daemon",
        "fleet",
        "edge",
        "sync",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--ca",
        fixture.ca,
        "--node-id",
        "edge-one",
        "--credential",
        "wrong-secret",
        "--assignment",
        "assignment-edge-one",
        "--view-root",
        fixture.viewRoot,
        "--quota-bytes",
        String(quotaBytes),
      ]);
      assert.equal(refused.status, 1);
      assert.equal(refused.receipt.code, "authentication_failed");
      assert.equal(JSON.stringify(refused).includes(machineCredential), false);
      const deltaBody = "# Fleet mirror note\n\nsecond cut\n";
      writeFileSync(path.join(fixture.repo, "harness", docPath), deltaBody);
      assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--task", "task-fleet"]).outcome, "applied");
      const delta = retryReplicaPending(sync);
      assert.equal(delta.status, "fleet.ack.result/v1");
      assert.ok((delta.ackCut as number) > (pulled.ackCut as number));
      assert.equal(
        readFileSync(path.join(viewRoot, "cuts", String(delta.ackCut), "files", docPath), "utf8"),
        deltaBody,
      );
      assert.equal(
        readFileSync(path.join(fixture.edgeRepo, "harness", docPath), "utf8"),
        deltaBody,
        "incremental sync updates the original registered path byte-for-byte",
      );
      assert.equal(
        existsSync(path.join(fixture.centerUser, "fleet", "replica", "repos", "fleet-demo", "ack.sqlite")),
        true,
      );
    } finally {
      stop(fixture, "center");
      stop(fixture, "edge");
      realm.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

// dec_D60FAA451F24160E970323B6F3 CH1: the center, not the edge, decides who a machine acts for. The edge
// here holds no people document and no roster copy; its node owner has no entry in the center's people
// document either, so nothing about the local uid can explain the outcome.
test(
  "a clean edge node completes its first sync on the machine credential the center issued",
  { timeout: 180_000 },
  async () => {
    const fixture = setup({ cleanEdge: true }),
      realm = await spawnKeycloak();
    try {
      realm.bind(fixture.centerUser);
      assert.equal(existsSync(path.join(fixture.edgeRepo, "harness", "people.yaml")), false);
      assert.equal(run(fixture, "center", ["daemon", "start", "--service"]).ok, true);
      register(fixture);
      const created = run(fixture, "center", ["task", "create", "--id", "task-fleet", "--admin", "--title", "Fleet"]);
      published(fixture, "center", created);
      const planPath = `${String(created.packagePath)}/task_plan.md`;
      writeFileSync(path.join(fixture.repo, "harness", planPath), realizedTaskPlan("Fleet"));
      assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--path", planPath]).outcome, "applied");
      const center = run(fixture, "center", [
          "daemon",
          "fleet",
          "center",
          "start",
          "--port",
          "0",
          "--key",
          fixture.key,
          "--cert",
          fixture.cert,
          "--roster",
          fixture.roster,
          "--quota-bytes",
          String(quotaBytes),
        ]),
        port = center.port as number;
      assert.equal(run(fixture, "edge", ["daemon", "start", "--service"]).ok, true);
      assert.equal(
        run(fixture, "edge", [
          "daemon",
          "repo",
          "register",
          "--repo-id",
          "fleet-demo",
          "--root",
          fixture.edgeRepo,
          "--mode",
          "remote-edge",
        ]).ok,
        true,
      );
      const sync = (credential: string) =>
          maybeRun(fixture, "edge", [
            "daemon",
            "fleet",
            "edge",
            "sync",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--ca",
            fixture.ca,
            "--node-id",
            "edge-one",
            "--credential",
            credential,
            "--assignment",
            "assignment-edge-one",
            "--view-root",
            fixture.viewRoot,
            "--quota-bytes",
            String(quotaBytes),
          ]),
        logins = () => realm.control<{ clientId: string; ok: boolean }[]>({ op: "nodeLogins" });

      // 1. Before the node is registered, the request still reaches the center and the center refuses the
      //    credential. The edge did not answer for it: nobody is signed in there, yet the code is not the
      //    not-signed-in one.
      const unregistered = sync("any-credential");
      assert.equal(unregistered.status, 1);
      assert.equal(unregistered.receipt.code, "authentication_failed");
      assert.notEqual(unregistered.receipt.code, "authentication_required");
      assert.match(String(unregistered.receipt.rejectionExplanation), /Register the node at the center/u);
      assert.deepEqual(await logins(), [{ clientId: "harness-node-edge-one", ok: false }]);

      // 2. Registration is written while the center keeps running, through the registry write path, and
      //    returns the machine credential once.
      await realm.control({ op: "account", personId: "edge-operator" });
      const credentialFile = path.join(fixture.root, "edge-one.credential"),
        registration = ["bootstrap", "--operation", "node-register", "--node-id", "edge-one"],
        registerArgs = [...registration, "--person-id", "edge-operator", "--operation-id", "register-edge-one"],
        nodes = () => run(fixture, "center", ["bootstrap", "--operation", "node-list"]).nodes;
      signInAt(fixture.centerUser, "person-admin");
      //    The credential is minted once, so a registration with no file to receive it is refused before
      //    Keycloak is written, and so is one whose file is already somebody's.
      const fileless = maybeRun(fixture, "center", registerArgs);
      assert.equal(fileless.status, 2);
      assert.equal(fileless.receipt.code, "missing_field", JSON.stringify(fileless.receipt));
      assert.deepEqual(nodes(), []);
      writeFileSync(credentialFile, "somebody else's credential");
      const taken = maybeRun(fixture, "center", [...registerArgs, "--credential-file", credentialFile]);
      assert.equal(taken.status, 1);
      assert.equal(taken.receipt.code, "credential_file_unavailable", JSON.stringify(taken.receipt));
      assert.equal(readFileSync(credentialFile, "utf8"), "somebody else's credential");
      assert.deepEqual(nodes(), []);
      rmSync(credentialFile);
      //    The receipt names the file and nothing the CLI printed carries what is in it.
      const registered = maybeRun(fixture, "center", [...registerArgs, "--credential-file", credentialFile]);
      assert.equal(registered.status, 0, JSON.stringify(registered));
      assert.equal(registered.receipt.credentialFile, credentialFile);
      assert.equal("credential" in registered.receipt, false);
      const credential = readFileSync(credentialFile, "utf8");
      assert.ok(credential.length > 0);
      assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
      assert.equal(JSON.stringify(registered).includes(credential), false);
      assert.equal((nodes() as { nodeId: string }[])[0]?.nodeId, "edge-one");
      signOutAt(fixture.centerUser);

      // 3. The right credential authenticates the machine; its owner holds no grant yet, so the center
      //    denies the action. Three different answers for three different conditions.
      const ungranted = sync(credential);
      assert.equal(ungranted.status, 1);
      assert.equal(ungranted.receipt.code, "authorization_denied", JSON.stringify(ungranted.receipt));
      // What the operator is told to do differs with the cause: a grant, not another credential.
      assert.match(String(ungranted.receipt.rejectionExplanation), /grant the node's owner/u);
      assert.doesNotMatch(String(ungranted.receipt.rejectionExplanation), /credential/u);
      assert.equal(existsSync(path.join(fixture.edgeRepo, "harness", planPath)), false, "nothing was mirrored");

      // 4. With the grant in place the same command completes the first sync, no center restart in between.
      await realm.control({
        op: "permit",
        personId: "edge-operator",
        resource: "fleet-demo",
        actions: ["daemon-fleet-edge-sync"],
      });
      let first = sync(credential);
      for (let attempt = 0; attempt < 40 && first.receipt.code === "replica_pending"; attempt += 1)
        first = sync(credential);
      assert.equal(first.status, 0, JSON.stringify(first.receipt));
      assert.equal(first.receipt.viewId, "edge-one-view");
      assert.equal(
        readFileSync(path.join(fixture.edgeRepo, "harness", planPath), "utf8"),
        readFileSync(path.join(fixture.repo, "harness", planPath), "utf8"),
        "the first sync materializes the center ledger in the clean workspace",
      );

      // 5. A wrong credential for the now-registered node is refused by the center with the credential code.
      const wrong = sync(`${credential}-wrong`);
      assert.equal(wrong.status, 1);
      assert.equal(wrong.receipt.code, "authentication_failed");
      assert.equal(JSON.stringify(wrong).includes(credential), false);
      assert.deepEqual((await logins()).at(-1), { clientId: "harness-node-edge-one", ok: false });
    } finally {
      stop(fixture, "center");
      stop(fixture, "edge");
      realm.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

function retryReplicaPending(sync: () => Record<string, unknown>): Record<string, unknown> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = sync();
    if (last.ok !== false || last.code !== "replica_pending") return last;
  }
  return last;
}
// Snapshot cuts address their blobs through the verified edge CAS instead of
// materializing cuts/<revision>/files/, so a cut document is read through its
// manifest entry (delta cuts materialize changed files, snapshots do not).
function readCutFile(viewRoot: string, revision: number, logical: string): string {
  const manifest = JSON.parse(readFileSync(path.join(viewRoot, "cuts", String(revision), "manifest.json"), "utf8")) as {
    entries: readonly { readonly path: string; readonly blob: { readonly sha256: string } }[];
  };
  const entry = manifest.entries.find((row) => row.path === logical);
  if (entry === undefined) throw new Error(`cut ${revision} manifest has no entry for ${logical}`);
  return readFileSync(
    path.join(path.resolve(viewRoot, "..", ".."), "cas", "sha256", entry.blob.sha256.slice(0, 2), entry.blob.sha256),
    "utf8",
  );
}
function setup(options: { readonly cleanEdge?: boolean } = {}): {
  root: string;
  repo: string;
  edgeRepo: string;
  centerUser: string;
  edgeUser: string;
  viewRoot: string;
  key: string;
  cert: string;
  ca: string;
  roster: string;
  badRoster: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-cli-")),
    repo = path.join(root, "repo"),
    edgeRepo = path.join(root, "edge-repo"),
    centerUser = path.join(root, "center-user"),
    edgeUser = path.join(root, "edge-user"),
    viewRoot = path.join(root, "edge-view"),
    tls = path.join(root, "tls");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(path.join(edgeRepo, "harness"), { recursive: true });
  mkdirSync(tls, { recursive: true });
  mkdirSync(centerUser);
  mkdirSync(edgeUser);
  writeFileSync(path.join(repo, "harness", "harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(edgeRepo, "harness", "harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(
    path.join(repo, "harness", "people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Fleet Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
    "utf8",
  );
  if (!options.cleanEdge)
    writeFileSync(
      path.join(edgeRepo, "harness", "people.yaml"),
      readFileSync(path.join(repo, "harness", "people.yaml")),
    );
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Fleet CLI Test");
  git(repo, "config", "user.email", "fleet-cli@example.test");
  git(repo, "add", "harness");
  git(repo, "commit", "--quiet", "-m", "fixture");
  git(edgeRepo, "init", "--quiet");
  git(edgeRepo, "config", "user.name", "Fleet Edge Test");
  git(edgeRepo, "config", "user.email", "fleet-edge@example.test");
  git(edgeRepo, "add", "harness");
  git(edgeRepo, "commit", "--quiet", "-m", "edge fixture");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(tls, "ca.key"),
      "-out",
      path.join(tls, "ca.pem"),
      "-subj",
      "/CN=ha-fleet-cli-ca",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(tls, "server.key"),
      "-out",
      path.join(tls, "server.csr"),
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(path.join(tls, "san.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n", "utf8");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      path.join(tls, "server.csr"),
      "-CA",
      path.join(tls, "ca.pem"),
      "-CAkey",
      path.join(tls, "ca.key"),
      "-CAcreateserial",
      "-out",
      path.join(tls, "server.pem"),
      "-days",
      "1",
      "-extfile",
      path.join(tls, "san.ext"),
    ],
    { stdio: "ignore" },
  );
  const roster = path.join(root, "roster.json");
  writeFileSync(
    roster,
    JSON.stringify({
      schema: "fleet-roster/v3",
      assignments: [
        {
          assignmentId: "assignment-edge-one",
          nodeId: "edge-one",
          repoId: "fleet-demo",
          viewId: "edge-one-view",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scope: {
            kind: "task",
            taskId: "task-fleet",
            executionId: "exec-fleet",
            paths: ["tasks/task-fleet-fleet/notes.md"],
          },
        },
      ],
    }),
    "utf8",
  );
  const badRoster = path.join(root, "bad-roster.json");
  writeFileSync(badRoster, JSON.stringify({ schema: "fleet-roster/v3", assignments: [] }), "utf8");
  return {
    root,
    repo,
    edgeRepo,
    centerUser,
    edgeUser,
    viewRoot,
    key: path.join(tls, "server.key"),
    cert: path.join(tls, "server.pem"),
    ca: path.join(tls, "ca.pem"),
    roster,
    badRoster,
  };
}
function register(fixture: ReturnType<typeof setup>): void {
  seedSettingsEvent({ rootDir: fixture.repo, repoId: "fleet-demo" });
  assert.equal(
    run(fixture, "center", ["daemon", "repo", "register", "--repo-id", "fleet-demo", "--root", fixture.repo]).ok,
    true,
  );
}
function run(
  fixture: ReturnType<typeof setup>,
  machine: "center" | "edge",
  args: readonly string[],
): Record<string, unknown> {
  const result = maybeRun(fixture, machine, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}
// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
function published(fixture: ReturnType<typeof setup>, machine: "center" | "edge", receipt: Record<string, unknown>) {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(fixture, machine, ["receipt", "show", String(receipt.opId), ...wait]);
}
function maybeRun(
  fixture: ReturnType<typeof setup>,
  machine: "center" | "edge",
  args: readonly string[],
): { status: number | null; receipt: Record<string, unknown>; stderr: string } {
  const userRoot = machine === "center" ? fixture.centerUser : fixture.edgeUser,
    home = path.join(userRoot, "home");
  const commandRoot = machine === "center" ? fixture.repo : fixture.edgeRepo;
  const result = spawnSync(process.execPath, [cli, "--root", commandRoot, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot },
  });
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as Record<string, unknown>,
    stderr: result.stderr,
  };
}
function spawnedRun(
  fixture: ReturnType<typeof setup>,
  machine: "center" | "edge",
  args: readonly string[],
): Promise<{ status: number | null; argv: readonly string[]; stdout: string; stderr: string }> {
  const userRoot = machine === "center" ? fixture.centerUser : fixture.edgeUser,
    home = path.join(userRoot, "home"),
    commandRoot = machine === "center" ? fixture.repo : fixture.edgeRepo,
    child = spawn(process.execPath, [cli, "--root", commandRoot, "--json", ...args], {
      env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const argv = [...child.spawnargs];
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, argv, stdout, stderr }));
  });
}
function stop(fixture: ReturnType<typeof setup>, machine: "center" | "edge"): void {
  spawnSync(process.execPath, [cli, "--json", "daemon", "stop"], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_DAEMON_USER_ROOT: machine === "center" ? fixture.centerUser : fixture.edgeUser },
  });
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("daemon remote-proxy registration validates root and endpoint ownership before dialing", async () => {
  const cases = [
    {
      argv: [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        "remote",
        "--mode",
        "remote-proxy",
        "--root",
        "/tmp/repo",
        "--endpoint",
        "tcp://127.0.0.1:9911",
      ],
      code: "invalid_field",
      hint: /omits --root/u,
    },
    {
      argv: ["daemon", "repo", "register", "--repo-id", "local"],
      code: "invalid_field",
      hint: /requires --root/u,
    },
    {
      argv: [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        "remote",
        "--mode",
        "remote-proxy",
        "--endpoint",
        "tcp://127.0.0.1:9911",
        "--connection",
        "server",
      ],
      code: "invalid_field",
      hint: /exactly one/u,
    },
  ] as const;
  for (const expected of cases) {
    const receipts: Record<string, unknown>[] = [],
      exit = await runDaemonControl(expected.argv, (receipt) => receipts.push(receipt));
    assert.equal(exit, 2);
    assert.equal(receipts[0]?.code, expected.code);
    assert.match(String(receipts[0]?.nextAction), expected.hint);
  }
});

test("daemon connection and repo update options reject missing or invalid fields before dialing", async () => {
  for (const argv of [
    ["daemon", "connection", "add"],
    ["daemon", "connection", "update"],
    ["daemon", "connection", "remove"],
    ["daemon", "connection", "probe"],
    ["daemon", "connection", "update", "--connection", "server", "--state", "paused"],
    ["daemon", "repo", "update", "--repo-id", "remote", "--mode", "unknown"],
  ]) {
    const receipts: Record<string, unknown>[] = [],
      exit = await runDaemonControl(argv, (receipt) => receipts.push(receipt));
    assert.equal(exit, 2, argv.join(" "));
    assert.ok(receipts[0]?.code === "missing_field" || receipts[0]?.code === "invalid_field");
  }
});

test("CLI resident modes resolve the installed daemon manifest and launch its absolute bin", () => {
  const manifestPath = createRequire(import.meta.url).resolve("@harness-anything/daemon/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = path.resolve(path.dirname(manifestPath), manifest.bin["harness-anything-daemon"]);
  assert.equal(manifest.version, "0.0.1");
  assert.equal(daemonServeEntry(), entry);
  for (const mode of ["serve", "--service"] as const) {
    const launch = cliDaemonServeLaunch("/daemon-user", "blue", process.execPath, undefined, mode);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [entry, mode, "--user-root", "/daemon-user", "--daemon-id", "blue"]);
    assert.equal(launch.env.HARNESS_ACTOR, undefined);
    assert.equal(launch.env.HARNESS_DAEMON_RELAY, undefined);
  }
});

test("stale-build state remains structured in JSON and visible in human receipts", () => {
  const receipt = {
    ok: true,
    command: "task-create",
    outcome: "applied",
    summary: "task created",
    daemonBuild: {
      code: "daemon_build_stale",
      loadedBuildId: "build-a",
      diskBuildId: "build-b",
      liveRuntimeSessions: 3,
      pendingWrites: 1,
      attachingRepositories: 0,
      message:
        "Daemon loaded old build build-a; disk has build-b. It is serving 3 live runtime session(s) and will exit after drain.",
    },
  };
  const json = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  assert.deepEqual(json.daemonBuild, receipt.daemonBuild);
  const human = renderCliReceipt(receipt);
  assert.equal(human.stream, "stdout");
  assert.match(human.text, /task created.*warning:.*old build build-a.*3 live runtime session/su);
});

test("daemon control reports Git follower failure while SQLite keeps accepting commands", () => {
  const fixture = receiptSetup();
  let refLock: string | null = null;
  const indexLock = path.join(fixture.repo, ".git", "index.lock");
  try {
    assert.equal(runJson(fixture, ["daemon", "start", "--service"]).ok, true);

    const registered = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(registered.status, 0, registered.stderr);
    assert.match(registered.stdout, /repoId=receipt/u);
    assert.match(
      registered.stdout,
      new RegExp(`canonicalRoot=${escapeRegExp(realpathSync.native(fixture.repo))}`, "u"),
    );
    assert.match(registered.stdout, /changed=true/u);

    const unchanged = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /repoId=receipt/u);
    assert.match(unchanged.stdout, /changed=false/u);

    const status = runText(fixture, ["daemon", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /pid=\d+/u);
    assert.match(status.stdout, /repos=1/u);
    const healthyStatus = runJson(fixture, ["daemon", "status"]),
      healthyRepo = (healthyStatus.repos as readonly Record<string, unknown>[])[0]!;
    assert.deepEqual((healthyRepo.materialization as Record<string, unknown>).state, "ok");

    writeFileSync(indexLock, "held by CLI contract test\n");
    const indexAccepted = runJson(fixture, ["task", "create", "--title", "SQLite accepts with caller index locked"]);
    assert.equal(indexAccepted.outcome, "applied", JSON.stringify(indexAccepted));
    assert.equal((gitSettled(fixture, indexAccepted).git as Record<string, unknown>).state, "verified");
    assert.equal(readFileSync(indexLock, "utf8"), "held by CLI contract test\n");
    rmSync(indexLock);
    const branchRef = receiptGit(fixture.repo, "symbolic-ref", "HEAD");
    refLock = path.join(fixture.repo, ".git", `${branchRef}.lock`);
    writeFileSync(refLock, "hold follower ref\n");
    const pending = runJson(fixture, ["task", "create", "--title", "Accepted before Git failure"]);
    assert.equal(pending.status, "accepted_durable");
    assert.ok(pending.acceptance);
    const observed = runJson(fixture, [
      "receipt",
      "show",
      String(pending.opId),
      "--wait",
      "git_verified",
      "--timeout-ms",
      "200",
    ]);
    assert.equal(observed.status, "accepted_durable");
    assert.equal((observed.git as Record<string, unknown>).state, "pending");
    const failedStatus = runJsonResult(fixture, ["daemon", "status"]);
    const failedRepo = (failedStatus.receipt.repos as readonly Record<string, unknown>[])[0]!;
    assert.equal((failedRepo.materialization as Record<string, unknown>).state, "failed");
    const next = runJson(fixture, ["task", "create", "--title", "SQLite remains accepting"]);
    assert.equal(next.status, "accepted_durable");
    rmSync(refLock);
    refLock = null;
    const recoveredWrite = runJson(fixture, ["task", "create", "--title", "Accepted after follower repair"]);
    assert.equal(recoveredWrite.status, "accepted_durable");
    assert.equal((gitSettled(fixture, recoveredWrite).git as Record<string, unknown>).state, "verified");
    const recovered = runJson(fixture, ["receipt", "show", String(pending.opId)]);
    assert.equal((recovered.git as Record<string, unknown>).state, "verified");

    const rebuilt = runText(fixture, ["daemon", "projection", "rebuild"]);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.match(rebuilt.stdout, /stateDigest=sha256:[0-9a-f]{64}/u);

    const removed = runText(fixture, ["repo", "unbind", "receipt"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Repository receipt is unbound/u);
    assert.match(removed.stdout, /run ha init there to bind it again/u);

    const gone = runText(fixture, ["repo", "unbind", "receipt"]);
    assert.notEqual(gone.status, 0);
    // The daemon route refuses an unknown repoId as repo_namespace_unknown; the kernel path says "not registered".
    assert.match(`${gone.stdout}${gone.stderr}`, /not registered|repo_namespace_unknown/u);
  } finally {
    rmSync(indexLock, { force: true });
    if (refLock !== null) rmSync(refLock, { force: true });
    runJsonResult(fixture, ["daemon", "stop"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function receiptSetup(): { readonly root: string; readonly repo: string; readonly userRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-receipt-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(userRoot);
  writeFileSync(
    path.join(repo, "harness", "harness.yaml"),
    [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "settings:",
      "  defaultPreset: standard-task",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(repo, "harness", "people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  receiptGit(repo, "init", "--quiet");
  receiptGit(repo, "add", "harness");
  receiptGit(repo, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ rootDir: repo, repoId: "receipt" });
  return { root, repo, userRoot };
}

function runJson(fixture: ReturnType<typeof receiptSetup>, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
  const daemonLog = path.join(fixture.userRoot, "logs", "daemon-default.log"),
    log = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "daemon log absent";
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${log}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
// Writes return their acceptance receipt; Git follower progress is observed through the explicit receipt wait.
function gitSettled(
  fixture: ReturnType<typeof receiptSetup>,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  return runJson(fixture, ["receipt", "show", String(receipt.opId), "--wait", "git_verified", "--timeout-ms", "5000"]);
}
function runText(fixture: ReturnType<typeof receiptSetup>, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, "--root", fixture.repo, ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
}
function runJsonResult(fixture: ReturnType<typeof receiptSetup>, args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
  };
}
function environment(fixture: ReturnType<typeof receiptSetup>): NodeJS.ProcessEnv {
  const {
    HARNESS_CANONICAL_ROOT: _canonicalRoot,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_TASK_BOUND: _taskBound,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_ACTOR: "agent:harness-test",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    TMPDIR: "/tmp",
  };
}
function receiptGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Daemon Receipt Test",
      GIT_AUTHOR_EMAIL: "receipt@example.test",
      GIT_COMMITTER_NAME: "Daemon Receipt Test",
      GIT_COMMITTER_EMAIL: "receipt@example.test",
    },
  }).trim();
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
