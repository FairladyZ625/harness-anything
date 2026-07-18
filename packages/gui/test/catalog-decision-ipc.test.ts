// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonIdFromEnv, localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { createGuiServiceBridgeForDaemon, createLocalGuiServiceBridge } from "../src/index.ts";

test("GUI daemon bridge maps all catalog and decision mutation methods to declared routes", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, decisionId: "dec_bridge", state: "proposed" } } };
  });
  const proposal = {
    title: "Bridge route",
    question: "Are mutation routes connected?",
    chosen: [{ text: "Use declared routes" }],
    rejected: [{ text: "Bypass the registry", why_not: "It would drift" }],
    riskTier: "low",
    urgency: "low"
  };

  await bridge.invoke("getCatalogSnapshot", null);
  await bridge.invoke("proposeDecision", proposal);
  await bridge.invoke("acceptDecision", { decisionId: "dec_bridge" });
  await bridge.invoke("rejectDecision", { decisionId: "dec_bridge" });
  await bridge.invoke("deferDecision", { decisionId: "dec_bridge" });

  assert.deepEqual(routeIds, [
    "catalog.snapshot",
    "decisions.propose",
    "decisions.accept",
    "decisions.reject",
    "decisions.defer"
  ]);
});

test("GUI service bridge returns the daemon-resolved catalog snapshot", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-catalog-"));
  try {
    writeHarnessConfig(rootDir);
    writeCatalogPreset(rootDir, "standard-task", "GUI Project Standard");
    const snapshot = await withGuiDaemonEnv(rootDir, () =>
      createLocalGuiServiceBridge(rootDir).invoke("getCatalogSnapshot", null)
    ) as {
      readonly ok: boolean;
      readonly activeVerticalId?: string;
      readonly presets?: ReadonlyArray<{ readonly id: string; readonly source: string; readonly title?: string }>;
      readonly verticals?: ReadonlyArray<{ readonly id: string }>;
      readonly adapters?: ReadonlyArray<{ readonly id: string }>;
    };

    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.activeVerticalId, "software/coding");
    assert.deepEqual(snapshot.verticals?.map((vertical) => vertical.id), ["software/coding"]);
    assert.deepEqual(snapshot.adapters?.map((adapter) => adapter.id), ["local", "multica"]);
    const standard = snapshot.presets?.find((preset) => preset.id === "standard-task");
    assert.equal(standard?.source, "project");
    assert.equal(standard?.title, "GUI Project Standard");
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI decision propose performs a real authenticated write through daemon IPC", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-decision-write-"));
  try {
    initializeGuiWriteRepository(rootDir);
    const result = await withGuiDaemonEnv(rootDir, () =>
      createLocalGuiServiceBridge(rootDir).invoke("proposeDecision", {
        decisionId: "dec_GUI_IPC_WRITE",
        title: "GUI decision IPC",
        question: "Should the GUI write decisions through authenticated daemon IPC?",
        chosen: [{ text: "Use the daemon decision mutation port" }],
        rejected: [{ text: "Write decision markdown in the renderer", why_not: "That bypasses identity and coordination" }],
        riskTier: "medium",
        urgency: "medium",
        modules: ["gui"]
      })
    ) as { readonly ok: boolean; readonly decisionId?: string; readonly state?: string };

    assert.deepEqual(result, { ok: true, decisionId: "dec_GUI_IPC_WRITE", state: "proposed" });
    const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_GUI_IPC_WRITE/decision.md");
    assert.equal(existsSync(decisionPath), true);
    const body = readFileSync(decisionPath, "utf8");
    assert.match(body, /decision_id: dec_GUI_IPC_WRITE/u);
    assert.match(body, /state: proposed/u);
    assert.match(body, /_coordinatorWatermark:/u);
    const attributionRoot = path.join(rootDir, "harness/attribution-events");
    const attribution = readdirSync(attributionRoot)
      .map((entry) => readFileSync(path.join(attributionRoot, entry), "utf8"))
      .join("\n");
    assert.match(attribution, /"personId":"person_gui"/u);
    assert.match(attribution, /"kind":"daemon-authenticated"/u);
    assert.equal(
      execFileSync("git", ["-C", path.join(rootDir, "harness"), "log", "-1", "--pretty=%an <%ae>"], { encoding: "utf8" }).trim(),
      "GUI Test <gui@example.test>"
    );
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function withGuiDaemonEnv<T>(rootDir: string, run: () => Promise<T>): Promise<T> {
  const previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT;
  const previousIdleMs = process.env.HARNESS_DAEMON_IDLE_MS;
  const previousAutostartTimeout = process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS;
  process.env.HARNESS_DAEMON_USER_ROOT = path.join(rootDir, "user-daemon");
  process.env.HARNESS_DAEMON_IDLE_MS = "250";
  // Cold daemon spawn on a loaded CI runner regularly exceeds the 6s
  // interactive default; the hermetic tests care about correctness, not
  // interactive latency.
  process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS ||= "30000";
  try {
    return await run();
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousUserRoot);
    restoreEnv("HARNESS_DAEMON_IDLE_MS", previousIdleMs);
    restoreEnv("HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS", previousAutostartTimeout);
  }
}

function writeHarnessConfig(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "name: gui-catalog-decision-test",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    ""
  ].join("\n"), "utf8");
}

function writeCatalogPreset(rootDir: string, id: string, title: string): void {
  const presetPath = path.join(rootDir, ".harness/presets", id, "preset.json");
  mkdirSync(path.dirname(presetPath), { recursive: true });
  writeFileSync(presetPath, JSON.stringify({
    schema: "preset-manifest/v1",
    id,
    title,
    vertical: "software/coding",
    version: "2.0.0",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", templateSelections: [] }],
    defaultProfile: "baseline"
  }, null, 2), "utf8");
}

function initializeGuiWriteRepository(rootDir: string): void {
  writeHarnessConfig(rootDir);
  const harnessRoot = path.join(rootDir, "harness");
  const namedPipeEndpoint = localUserDaemonEndpoint(
    path.join(rootDir, "user-daemon"),
    daemonIdFromEnv(),
    "win32"
  );
  writeFileSync(path.join(harnessRoot, "people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_gui",
    "    displayName: GUI Test",
    "    primaryEmail: gui@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "      - kind: windows-named-pipe-client",
    `        issuer: host:${hostname()}:named-pipe`,
    `        subject: ${namedPipeEndpoint}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n"), "utf8");
  execFileSync("git", ["-C", harnessRoot, "init", "-q"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "gui@example.test"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "GUI Test"]);
  execFileSync("git", ["-C", harnessRoot, "add", "harness.yaml", "people.yaml"]);
  execFileSync("git", ["-C", harnessRoot, "commit", "-q", "-m", "seed GUI write fixture"]);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function waitForDaemonIdle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 700));
}
