import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { entryPairs, entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs|html)$/;
const violations = [];

const allowlist = loadGateAllowlist("check-implementation-contracts", {
  requiredSections: [
    "expectedRuntimeTestFiles",
    "packageLockVersions",
    "forbiddenLockfiles",
    "expectedWorkspaceTsconfigs",
    "requiredCompilerOptions",
    "portablePathRequiredSnippets",
    "portablePathTestEvidence",
    "guiCliTextFiles",
    "guiImplementationSnippets",
    "applicationServiceSnippets",
    "guiSecurityEvidence",
    "storeRequiredSnippets",
    "localLifecycleCliTextFiles",
    "localLifecycleRequiredSnippets",
    "taskProjectionRequiredSnippets",
    "multicaRequiredSnippets",
    "multicaForbiddenVerbs",
    "extensionRequiredSnippets",
    "extensionSchemaPaths",
    "browserWindowRequiredPatterns"
  ]
});
const expectedRuntimeTestFiles = Object.fromEntries(
  Object.entries(allowlist.expectedRuntimeTestFiles).map(([kind, entries]) => [kind, entryValues(entries)])
);
const packageLockVersions = entryPairs(allowlist.packageLockVersions, "path", "version");
const forbiddenLockfiles = entryValues(allowlist.forbiddenLockfiles);
const expectedWorkspaceTsconfigs = entryValues(allowlist.expectedWorkspaceTsconfigs).sort();
const requiredCompilerOptions = Object.fromEntries(allowlist.requiredCompilerOptions.map((entry) => [entry.option, entry.value]));
const portablePathRequiredSnippets = entryValues(allowlist.portablePathRequiredSnippets);
const portablePathTestEvidence = entryValues(allowlist.portablePathTestEvidence);
const guiCliTextFiles = entryValues(allowlist.guiCliTextFiles);
const guiImplementationSnippets = entryValues(allowlist.guiImplementationSnippets);
const applicationServiceSnippets = entryValues(allowlist.applicationServiceSnippets);
const guiSecurityEvidence = entryValues(allowlist.guiSecurityEvidence);
const storeRequiredSnippets = entryValues(allowlist.storeRequiredSnippets);
const localLifecycleCliTextFiles = entryValues(allowlist.localLifecycleCliTextFiles);
const localLifecycleRequiredSnippets = entryValues(allowlist.localLifecycleRequiredSnippets);
const taskProjectionRequiredSnippets = entryValues(allowlist.taskProjectionRequiredSnippets);
const multicaRequiredSnippets = entryValues(allowlist.multicaRequiredSnippets);
const multicaForbiddenVerbs = entryValues(allowlist.multicaForbiddenVerbs);
const extensionRequiredSnippets = entryValues(allowlist.extensionRequiredSnippets);
const extensionSchemaPaths = entryValues(allowlist.extensionSchemaPaths);
const browserWindowRequiredPatterns = allowlist.browserWindowRequiredPatterns.map((entry) => new RegExp(entry.pattern));

function record(message) {
  violations.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out" || entry.name === "build-resources") continue;
      files.push(...await walk(full));
    } else if (entry.name.endsWith(".d.ts")) {
      if (/\/src\//.test(relative(full))) {
        record(`${relative(full)}: declaration artifacts must be emitted to dist/ by tsc -b, never live in src/`);
      }
    } else if (sourceFile.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const rootPackage = readJson("package.json");
const cliPackage = readJson("packages/cli/package.json");
const rootTsconfig = readJson("tsconfig.json");
if (rootPackage.engines?.node !== ">=24") record("root engines.node must remain >=24");
if (rootPackage.dependencies?.effect !== "3.21.4") record("effect version must remain 3.21.4 after task_01KWNFNGG9H41724SADGFSMEZ3");
if (cliPackage.dependencies?.["@effect/platform"] !== "0.96.2") record("@effect/platform version must remain 0.96.2 after task_01KWNFNGG9H41724SADGFSMEZ3");
if (rootPackage.devDependencies?.typescript !== "5.9.3") record("typescript version must remain 5.9.3 until an explicit upgrade task");
if (rootPackage.devDependencies?.["@types/node"] !== "24.13.2") record("@types/node version must remain 24.13.2");
if (!existsSync(path.join(root, "package-lock.json"))) record("package-lock.json is required; npm is the package manager");
const packageLock = existsSync(path.join(root, "package-lock.json")) ? readJson("package-lock.json") : { packages: {} };
for (const [lockPath, expected] of packageLockVersions) {
  const actual = packageLock.packages?.[lockPath]?.version;
  if (actual !== expected) record(`package-lock ${lockPath} must be ${expected}, got ${actual ?? "missing"}`);
}
for (const forbiddenLockfile of forbiddenLockfiles) {
  if (existsSync(path.join(root, forbiddenLockfile))) record(`${forbiddenLockfile} is not allowed in this npm workspace`);
}

const workspaceTsconfigs = (rootTsconfig.references ?? [])
  .map((reference) => `${reference.path.replace(/^\.\//, "")}/tsconfig.json`)
  .sort();
if (JSON.stringify(workspaceTsconfigs) !== JSON.stringify(expectedWorkspaceTsconfigs)) {
  record(`tsconfig references must match expected workspaces: ${expectedWorkspaceTsconfigs.join(", ")}`);
}

for (const tsconfigPath of workspaceTsconfigs) {
  const tsconfig = readJson(tsconfigPath);
  const options = tsconfig.compilerOptions ?? {};
  for (const [key, expected] of Object.entries(requiredCompilerOptions)) {
    if (options[key] !== expected) record(`${tsconfigPath} compilerOptions.${key} must be ${JSON.stringify(expected)}`);
  }
}

const files = await walk(path.join(root, "packages"));
const portablePathPath = path.join(root, "packages/kernel/src/layout/portable-path.ts");
if (!existsSync(portablePathPath)) {
  record("kernel layout must expose a portable path contract at packages/kernel/src/layout/portable-path.ts");
} else {
  const portablePathText = readFileSync(portablePathPath, "utf8");
  for (const requiredSnippet of portablePathRequiredSnippets) {
    if (!portablePathText.includes(requiredSnippet)) record(`portable path contract must include ${requiredSnippet}`);
  }
}

const portablePathTestPath = path.join(root, "packages/kernel/test/layout/portable-path.test.ts");
if (!existsSync(portablePathTestPath)) {
  record("portable path contract requires packages/kernel/test/layout/portable-path.test.ts");
} else {
  const portablePathTestText = readFileSync(portablePathTestPath, "utf8");
  for (const requiredEvidence of portablePathTestEvidence) {
    if (!portablePathTestText.includes(requiredEvidence)) record(`portable path tests must prove: ${requiredEvidence}`);
  }
}

const retiredPortableStoreTest = "packages/kernel/test/store/portable-path-collision.test.ts";
if (existsSync(path.join(root, retiredPortableStoreTest))) record(`${retiredPortableStoreTest}: W3-retired journal/store test must not return`);

const hasGuiImplementation = files.some((file) => /packages\/gui\/src\/(?:main|preload|renderer|api|terminal|doc-renderer)\//.test(relative(file)));
const hasDaemonImplementation = files.some((file) => relative(file).startsWith("packages/daemon/src/"));
const hasStoreImplementation = files.some((file) => /packages\/kernel\/src\/store\//.test(relative(file)));
const hasPublishImplementation = files.some((file) => /packages\/(?:kernel|cli|gui)\/src\/.*publish/i.test(relative(file)));
const hasLocalLifecycleImplementation = files.some((file) => relative(file) === "packages/daemon/src/repo-cell.ts")
  && files.some((file) => relative(file) === "packages/cli/src/cli/thin-command.ts");
const hasTaskProjectionImplementation = files.some((file) => relative(file) === "packages/kernel/src/projection/rebuildable-task-projection.ts");
const hasMulticaAdapterImplementation = files.some((file) => relative(file) === "packages/adapters/multica/src/index.ts")
  && !readFileSync(path.join(root, "packages/adapters/multica/src/index.ts"), "utf8").trim().startsWith("export {}");
const hasExtensionModelImplementation = files.some((file) => relative(file) === "packages/kernel/src/domain/extension-model.ts");
for (const [kind, active] of Object.entries({ gui: hasGuiImplementation, store: hasStoreImplementation, publish: hasPublishImplementation })) {
  if (!active) continue;
  for (const requiredPath of expectedRuntimeTestFiles[kind]) {
    if (!existsSync(path.join(root, requiredPath))) record(`${kind} implementation requires contract test: ${requiredPath}`);
  }
}

if (hasGuiImplementation) {
  const guiText = files
    .filter((file) => relative(file).startsWith("packages/gui/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const applicationText = files
    .filter((file) => relative(file).startsWith("packages/application/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const cliText = guiCliTextFiles.map((relativePath) => readFileSync(path.join(root, relativePath), "utf8")).join("\n");
  for (const requiredSnippet of guiImplementationSnippets) {
    if (!guiText.includes(requiredSnippet)) record(`GUI implementation must include ${requiredSnippet}`);
  }
  for (const requiredSnippet of applicationServiceSnippets) {
    if (!applicationText.includes(requiredSnippet)) record(`application service must include ${requiredSnippet}`);
  }
  if (
    !cliText.includes("runCommandThroughDaemon")
    || /\bha gui\b|from\s+["'][^"']*(?:packages\/gui|@harness-anything\/gui|kernel\/src|application\/src)/.test(cliText)
  ) {
    record("thin CLI must transport through the daemon without restoring GUI launch or domain imports");
  }
  const guiSecurityTests = expectedRuntimeTestFiles.gui.map((testPath) => readFileSync(path.join(root, testPath), "utf8")).join("\n");
  for (const requiredEvidence of guiSecurityEvidence) {
    if (!guiSecurityTests.includes(requiredEvidence)) record(`GUI security tests must prove: ${requiredEvidence}`);
  }
}

if (hasDaemonImplementation) {
  const daemonProtocolTestPath = "packages/daemon/test/json-rpc-protocol.test.ts";
  if (!existsSync(path.join(root, daemonProtocolTestPath))) record(`daemon protocol implementation requires contract test: ${daemonProtocolTestPath}`);
}

if (hasStoreImplementation) {
  const coordinatorText = files
    .filter((file) => relative(file).startsWith("packages/kernel/src/store/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  for (const requiredSnippet of storeRequiredSnippets) {
    if (!coordinatorText.includes(requiredSnippet)) {
      record(`store implementation must include ${requiredSnippet}`);
    }
  }

  const storeIndexExported = readFileSync(path.join(root, "packages/kernel/src/index.ts"), "utf8").includes("./store/");
  if (storeIndexExported) record("kernel public index must not export internal store implementations");

  const storeTest = readFileSync(path.join(root, "packages/kernel/test/store/task-event-store.test.ts"), "utf8");
  const daemonTest = readFileSync(path.join(root, "packages/daemon/test/json-rpc-protocol.test.ts"), "utf8");
  for (const evidence of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit", "fsync count", "without scanning 10,000 old events"]) {
    if (!storeTest.includes(evidence) && !daemonTest.includes(evidence)) record(`W3 event-store tests must prove ${evidence}`);
  }
  if (!daemonTest.includes("without a duplicate publication")) record("RepoCell crash recovery must prove publish-once behavior");
}

if (hasLocalLifecycleImplementation) {
  const lifecycleText = ["packages/daemon/src/repo-cell.ts", ...localLifecycleCliTextFiles]
    .map((relativePath) => readFileSync(path.join(root, relativePath), "utf8")).join("\n");
  const cliTestPath = "packages/cli/test/daemon-thin-client-cli.test.ts";
  if (!existsSync(path.join(root, cliTestPath))) record(`local lifecycle CLI requires contract test: ${cliTestPath}`);
  for (const requiredSnippet of localLifecycleRequiredSnippets) {
    if (!lifecycleText.includes(requiredSnippet)) {
      record(`local lifecycle CLI implementation must include ${requiredSnippet}`);
    }
  }
  if (/WriteCoordinator|makeJournaledWriteCoordinator|HARNESS_DAEMON_MODE|local fallback/u.test(lifecycleText)) record("W3 local lifecycle must not restore coordinator, journal, daemon-mode, or local fallback paths");
  const cliTestText = existsSync(path.join(root, cliTestPath)) ? readFileSync(path.join(root, cliTestPath), "utf8") : "";
  if (!/without autostart or local fallback/.test(cliTestText)) record("thin CLI tests must prove missing-daemon rejection without autostart or fallback");
}

if (hasTaskProjectionImplementation) {
  const projectionText = files
    .filter((file) => relative(file).startsWith("packages/kernel/src/projection/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const rebuildTestText = readFileSync(path.join(root, "packages/kernel/test/store/task-projection.test.ts"), "utf8");
  for (const requiredSnippet of taskProjectionRequiredSnippets) {
    if (!projectionText.includes(requiredSnippet)) {
      record(`task projection implementation must include ${requiredSnippet}`);
    }
  }
  if (!/steady apply and rebuild use the same reducer/.test(rebuildTestText)) record("task projection tests must prove deterministic event-stream rebuild");
  if (!/at most one 64-item\/100ms round and never reports stale data ready/.test(rebuildTestText)) record("task projection tests must prove bounded catch-up and no stale-ready result");
  if (!/lease CAS rejects stale renew\/release/.test(rebuildTestText)) record("task projection tests must prove lease CAS rejection");
  if (/writeFileSync\s*\([^)]*tasks\//s.test(projectionText) || /renameSync\s*\([^)]*tasks\//s.test(projectionText)) {
    record("task projection must not write authored task documents");
  }
}

if (hasMulticaAdapterImplementation) {
  const multicaText = readFileSync(path.join(root, "packages/adapters/multica/src/index.ts"), "utf8");
  for (const requiredSnippet of multicaRequiredSnippets) {
    if (!multicaText.includes(requiredSnippet)) record(`Multica readonly adapter implementation must include ${requiredSnippet}`);
  }
  for (const forbiddenVerb of multicaForbiddenVerbs) {
    const exposedVerb = new RegExp(`(?:readonly\\s+)?${forbiddenVerb}\\s*[?:=(:]`, "u");
    if (exposedVerb.test(multicaText)) record(`Multica readonly adapter must not expose external write verb: ${forbiddenVerb}`);
  }
  if (/publishNote\s*\??\s*:\s*(?:\(|async|Effect|function)/u.test(multicaText)) {
    record("Multica readonly adapter must not expose external write verb: publishNote");
  }
  if (/writeFileSync\s*\([^)]*tasks\//s.test(multicaText) || /renameSync\s*\([^)]*tasks\//s.test(multicaText)) {
    record("Multica placeholder must not write authored task documents");
  }
}

if (hasExtensionModelImplementation) {
  const extensionModelText = readFileSync(path.join(root, "packages/kernel/src/domain/extension-model.ts"), "utf8");
  const extensionTestPath = "packages/kernel/test/contracts/extension-model.test.ts";
  if (!existsSync(path.join(root, extensionTestPath))) record(`extension model implementation requires contract test: ${extensionTestPath}`);
  for (const requiredSnippet of extensionRequiredSnippets) {
    if (!extensionModelText.includes(requiredSnippet)) {
      record(`extension model implementation must include ${requiredSnippet}`);
    }
  }
  if (/from\s+["']effect["']/.test(extensionModelText) || /Effect\./.test(extensionModelText)) {
    record("extension model domain helpers must remain pure and must not import or run Effect");
  }
  for (const schemaPath of extensionSchemaPaths) {
    if (!readFileSync(path.join(root, schemaPath), "utf8").includes("\"additionalProperties\": false")) {
      record(`${schemaPath} must reject unknown extension fields`);
    }
  }
}

for (const file of files) {
  const rel = relative(file);
  const text = await readFile(file, "utf8");
  const isTestOrFixture = /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);

  if (/\/Users\/lizeyu\/Projects\/multica|from\s+["']@multica\//.test(text)) {
    record(`${rel}: Multica source may be referenced only from private design docs, never from public implementation`);
  }

  if (rel.startsWith("packages/") && rel.includes("/src/") && rel !== "packages/kernel/src/layout/index.ts") {
    if (/planning\/tasks|planningRoot|\{\{paths\.authoredRoot\}\}\/planning|path\.join\([^)]*["']planning["']/.test(text)) {
      record(`${rel}: authored planning roots must use layout root fields; planning/tasks, planningRoot, and authoredRoot/planning path concatenation are no longer valid production roots`);
    }
    if (
      /path\.join\([^)]*(?:authoredRoot|context\.paths\.authoredRoot)[^)]*["'](?:decisions|sessions|adr)["']/.test(text) ||
      /\{\{paths\.authoredRoot\}\}\/(?:decisions|sessions|adr)\b/.test(text)
    ) {
      record(`${rel}: decision/session/adr roots must come from HarnessLayout or ScriptHost context path tokens, not authoredRoot string concatenation`);
    }
    if (/path\.join\([^)]*["']facts\.md["']/.test(text)) {
      record(`${rel}: fact document paths must use layout.factDocumentName or layout.taskFactDocumentPath`);
    }
  }

  if (rel.startsWith("packages/kernel/src/domain/")) {
    if (/\bfrom\s+["']effect["']|\bimport\s*\(\s*["']effect["']\s*\)|\b(?:Effect|Context|Layer|Queue|Semaphore)\b/.test(text)) {
      record(`${rel}: domain must not use Effect runtime, Context, Layer, Queue, or Semaphore`);
    }
    if (/\bData\.TaggedError\b/.test(text)) {
      record(`${rel}: domain errors must be plain readonly _tag unions, not Data.TaggedError`);
    }
    if (/\b(?:async\s+function|Promise<|new\s+Promise|fetch\s*\(|Date\.now\s*\(|Math\.random\s*\()/m.test(text)) {
      record(`${rel}: domain must stay deterministic and synchronous`);
    }
  }

  if (!rel.startsWith("packages/cli/src/") && !rel.startsWith("packages/application/src/") && /\b(?:Effect|E|Fx)\.runPromise\w*\s*\(|\brunPromise\w*\s*\(/.test(text)) {
    record(`${rel}: Effect.runPromise* is only allowed at controller composition roots`);
  }

  if (
    rel === "packages/gui/src/api/service-bridge.ts" &&
    /function\s+validateRelativeDocumentPath|path\.isAbsolute\s*\(\s*documentPath|path\.normalize\s*\(\s*documentPath/.test(text)
  ) {
    record(`${rel}: controller document paths must use kernel normalizeRelativeDocumentPath instead of a local validator`);
  }

  if (
    rel === "packages/gui/src/api/service-bridge.ts" &&
    !text.includes("daemon")
  ) {
    record(`${rel}: GUI service bridge must delegate document validation through the daemon`);
  }

  if (!rel.startsWith("packages/kernel/src/store/") && !isTestOrFixture && /\.(?:writeDocument|archivePackage)\s*\(/.test(text)) {
    record(`${rel}: authored writes must go through the RepoCell-owned event store`);
  }

  if (rel.startsWith("packages/kernel/src/store/") && /\bfrom\s+["'][^"']*(?:packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
    record(`${rel}: store must not import engine adapter implementations`);
  }
  const allowedGitProcessImplementations = new Set([
    "packages/kernel/src/store/local-version-control-system.ts"
  ]);
  if (
    rel.startsWith("packages/kernel/src/store/") &&
    !allowedGitProcessImplementations.has(rel) &&
    (/\bfrom\s+["']node:child_process["']/.test(text) || /\brunGit\s*\(/.test(text))
  ) {
    record(`${rel}: WriteCoordinator git process calls must stay isolated in the governed VCS implementation`);
  }

  if (rel.startsWith("packages/adapters/") && !isTestOrFixture) {
    if (/\bcoordinator\.(?:enqueue|flush)\s*\(/.test(text)) {
      record(`${rel}: adapters must use kernel store write helpers instead of directly calling WriteCoordinator.enqueue/flush`);
    }
    if (/(^|[^\w])(:\s*any\b|as\s+(?:any|never|unknown|TaskSnapshot|PublishableProjection)\b|<any>)/.test(text)) {
      record(`${rel}: adapters must decode raw input instead of returning or casting any`);
    }
    if (/\bJSON\.parse\s*\(/.test(text) && !/\bSchema\.decodeUnknown/.test(text)) {
      record(`${rel}: adapter JSON.parse must be immediately paired with Effect Schema decode`);
    }
    if (/catchAll[\s\S]{0,240}StatusUnmapped[\s\S]{0,240}["']active["']/.test(text)) {
      record(`${rel}: adapters must not swallow StatusUnmapped as active`);
    }
  }

  if (rel.startsWith("packages/gui/src/renderer/")) {
    if (/\bfrom\s+["'](?:node:)?(?:fs|child_process|process|path|os|electron)["']/.test(text)) {
      record(`${rel}: renderer must not import Node/Electron privileged modules`);
    }
    if (/\.harness-private|token|raw project paths/i.test(text)) {
      record(`${rel}: renderer must not directly access private paths, tokens, or raw project paths`);
    }
  }

  if (rel.startsWith("packages/gui/")) {
    if (/nodeIntegration\s*:\s*true/.test(text)) record(`${rel}: Electron nodeIntegration must stay false`);
    if (/contextIsolation\s*:\s*false/.test(text)) record(`${rel}: Electron contextIsolation must stay true`);
    if (/webSecurity\s*:\s*false/.test(text)) record(`${rel}: Electron webSecurity must stay true`);
    if (/sandbox\s*:\s*false/.test(text) && !/ADR/.test(text)) record(`${rel}: Electron sandbox=false requires an ADR`);
    if (/loadURL\s*\(\s*["']https?:\/\//.test(text)) record(`${rel}: GUI V1 must not load remote content`);
    if (/cors\s*\([^)]*(?:origin\s*:\s*["']\*["']|\*)/s.test(text)) record(`${rel}: local API must not use wildcard CORS`);
    if (/\.listen\s*\(\s*["'](?:0\.0\.0\.0|::)["']/.test(text)) record(`${rel}: local API must bind to 127.0.0.1 only`);
    if (/\blisten\s*\([^)]*["']0\.0\.0\.0["']/.test(text) || /\blisten\s*\([^)]*host\s*:\s*["']0\.0\.0\.0["']/.test(text)) record(`${rel}: local API must bind to 127.0.0.1 only`);
    if (/\bcors\s*\(\s*\)/.test(text)) record(`${rel}: local API must not use default wildcard CORS`);
    if (/\bcontextBridge\.exposeInMainWorld\s*\(/.test(text) && !/allowedPreloadApi|preloadAllowlist|HARNESS_PRELOAD_API/.test(text)) {
      record(`${rel}: preload API must be exposed through an explicit allowlist`);
    }
    if (/from\s+["'][^"']*(?:@harness-anything\/adapter-|packages\/adapters)[^"']*["']/.test(text)) {
      record(`${rel}: GUI must read cached projections/application services, not call external adapter implementations`);
    }
    if (/terminal[\s\S]{0,120}(?:projection|mutate|ingest|parse output|appendProgress|saveEvidence|TaskService)/i.test(text)) {
      record(`${rel}: terminal output must not mutate projections or become implicit task state`);
    }
  }

  if (rel.startsWith("packages/daemon/src/")) {
    if (/from\s+["'][^"']*(?:packages\/kernel\/src\/store|packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
      record(`${rel}: daemon protocol handlers must not import store or adapter implementations`);
    }
    if (/\bWriteCoordinator\.(?:enqueue|flush)\s*\(|\bcoordinator\.(?:enqueue|flush)\s*\(|\.(?:writeDocument|archivePackage)\s*\(/.test(text)) {
      record(`${rel}: daemon protocol handlers must not perform write coordination or authored writes directly`);
    }
    if (/switch\s*\([^)]*status[^)]*\)|if\s*\([^)]*status[^)]*(?:===|!==|==|!=)/i.test(text)) {
      record(`${rel}: daemon protocol handlers must not infer business state from status values`);
    }
  }

  if (/new\s+BrowserWindow\s*\(/.test(text)) {
    for (const required of browserWindowRequiredPatterns) {
      if (!required.test(text)) record(`${rel}: BrowserWindow must set ${required.source}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Implementation contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Implementation contract check passed.");
