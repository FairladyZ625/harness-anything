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
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
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

const portablePathCollisionTestPath = path.join(root, "packages/kernel/test/store/portable-path-collision.test.ts");
if (!existsSync(portablePathCollisionTestPath)) {
  record("authored document reads require a portable path collision test");
} else {
  const collisionTestText = readFileSync(portablePathCollisionTestPath, "utf8");
  if (!/readTaskPackage[\s\S]*assertNoPortablePathCollisions[\s\S]*portable path collision/.test(collisionTestText)) {
    record("portable path collision test must prove store read and helper coverage for case-insensitive collisions");
  }
}

const hasGuiImplementation = files.some((file) => /packages\/gui\/src\/(?:main|preload|renderer|api|terminal|doc-renderer)\//.test(relative(file)));
const hasDaemonImplementation = files.some((file) => relative(file).startsWith("packages/daemon/src/"));
const hasStoreImplementation = files.some((file) => /packages\/kernel\/src\/store\//.test(relative(file)));
const hasPublishImplementation = files.some((file) => /packages\/(?:kernel|cli|gui)\/src\/.*publish/i.test(relative(file)));
const hasLocalLifecycleImplementation = files.some((file) => relative(file) === "packages/adapters/local/src/index.ts")
  && !readFileSync(path.join(root, "packages/adapters/local/src/index.ts"), "utf8").trim().startsWith("export {}");
const hasTaskProjectionImplementation = files.some((file) => relative(file) === "packages/kernel/src/projection/sqlite-task-projection.ts");
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
  const serviceInterface = applicationText.match(/export interface LocalControllerService \{[\s\S]*?\n\}/)?.[0] ?? "";
  if (/\([^)]*:\s*unknown\b/.test(serviceInterface)) {
    record("LocalControllerService methods must use typed payloads; unknown belongs only in transport-boundary readers");
  }
  if (
    !cliText.includes("command: \"gui\"")
    || !cliText.includes("@harness-anything/gui")
    || !cliText.includes("spawn(command[0]")
    || !cliText.includes("HARNESS_GUI_ROOT")
    || /from\s+["'][^"']*(?:packages\/gui|@harness-anything\/gui)/.test(cliText)
  ) {
    record("CLI must delegate a gui launch command without importing the GUI package");
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

  const payloadHashTest = readFileSync(path.join(root, "packages/kernel/test/store/payload-hash.test.ts"), "utf8");
  if (!/tamper|mismatch|reject/i.test(payloadHashTest)) record("payload-hash.test.ts must prove tampered payloadRef blocks recovery");

  const lockTest = readFileSync(path.join(root, "packages/kernel/test/store/global-committer-lock.test.ts"), "utf8");
  if (!/two coordinators|stale lock|lock already held|live process locks|takeover claim|dead takeover claim|quarantined stale lock|double stale lock takeover|ownerToken/i.test(lockTest)) {
    record("global-committer-lock.test.ts must prove contention, stale lock, live-lock, takeover claim recovery, quarantine recovery, double stale takeover, or owner token behavior, not only file presence");
  }

  const fifoTest = readFileSync(path.join(root, "packages/kernel/test/store/same-task-fifo.test.ts"), "utf8");
  if (!/two coordinators|firstCoordinator|secondCoordinator/.test(fifoTest)) {
    record("same-task-fifo.test.ts must prove durable journal FIFO across two coordinators");
  }
}

if (hasLocalLifecycleImplementation) {
  const localAdapterText = readFileSync(path.join(root, "packages/adapters/local/src/index.ts"), "utf8");
  const cliText = localLifecycleCliTextFiles.map((relativePath) => readFileSync(path.join(root, relativePath), "utf8")).join("\n");
  const cliTestPath = "packages/cli/test/local-lifecycle-cli.test.ts";
  if (!existsSync(path.join(root, cliTestPath))) record(`local lifecycle CLI requires contract test: ${cliTestPath}`);
  for (const requiredSnippet of localLifecycleRequiredSnippets) {
    if (!`${localAdapterText}\n${cliText}`.includes(requiredSnippet)) {
      record(`local lifecycle CLI implementation must include ${requiredSnippet}`);
    }
  }
  if (/writeFileSync\s*\([^)]*tasks\//s.test(localAdapterText) || /renameSync\s*\([^)]*tasks\//s.test(localAdapterText)) {
    record("local lifecycle adapter must mutate task documents through WriteCoordinator, not direct filesystem writes");
  }
  const cliTestText = existsSync(path.join(root, cliTestPath)) ? readFileSync(path.join(root, cliTestPath), "utf8") : "";
  if (!/missing task errors do not leak local root paths|includes\(rootDir\)/.test(cliTestText)) {
    record("local lifecycle CLI tests must prove missing task errors do not leak local root paths");
  }
}

if (hasTaskProjectionImplementation) {
  const projectionText = files
    .filter((file) => relative(file).startsWith("packages/kernel/src/projection/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const rebuildTestText = readFileSync(path.join(root, "packages/kernel/test/store/sqlite-rebuild.test.ts"), "utf8");
  const cliTestText = readFileSync(path.join(root, "packages/cli/test/local-lifecycle-cli.test.ts"), "utf8");
  for (const requiredSnippet of taskProjectionRequiredSnippets) {
    if (!projectionText.includes(requiredSnippet)) {
      record(`task projection implementation must include ${requiredSnippet}`);
    }
  }
  if (!/SQLite task projection rebuild is deterministic after cache deletion|rmSync\(path\.join\(rootDir, "\.projection\.sqlite"\)/.test(rebuildTestText)) {
    record("task projection tests must prove deleting SQLite and rebuilding preserves read output");
  }
  if (!/generated SQLite edits are reported and rebuilt from markdown truth|projection_tampered/.test(rebuildTestText)) {
    record("task projection tests must prove hand-edited generated projection is reported");
  }
  if (!/CLI task list reads from rebuildable SQLite projection|CLI check reports projection tampering|CLI task list does not emit tampered SQLite row content as task truth/.test(cliTestText)) {
    record("CLI tests must cover task list and check over the SQLite projection");
  }
  if (/writeFileSync\s*\([^)]*tasks\//s.test(projectionText) || /renameSync\s*\([^)]*tasks\//s.test(projectionText)) {
    record("task projection must not write authored task documents");
  }
}

if (hasMulticaAdapterImplementation) {
  const multicaText = readFileSync(path.join(root, "packages/adapters/multica/src/index.ts"), "utf8");
  const multicaTestPath = "packages/adapters/multica/test/multica-readonly-adopt.test.ts";
  const multicaTestText = existsSync(path.join(root, multicaTestPath)) ? readFileSync(path.join(root, multicaTestPath), "utf8") : "";
  if (!existsSync(path.join(root, multicaTestPath))) record(`Multica readonly adapter requires contract test: ${multicaTestPath}`);
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
  if (!/does not write external status into frontmatter|^  status:/m.test(multicaTestText)) {
    record("Multica adopt tests must prove external status is not written to authored frontmatter");
  }
  if (!/rejects duplicate external bindings|external ref already bound/.test(multicaTestText)) {
    record("Multica adopt tests must prove duplicate binding rejection");
  }
  if (!/adopt claim rejects duplicate refs|adopt claim already held/.test(`${multicaTestText}\n${multicaText}`)) {
    record("Multica adopt tests must prove concurrent duplicate binding rejection through an adopt claim");
  }
  if (!/order-insensitive|stableMulticaBindingFingerprint/.test(multicaTestText)) {
    record("Multica tests must prove binding fingerprint canonicalization");
  }
  if (!/stale cache|unavailable-no-cache|refuses stale snapshots/.test(multicaTestText)) {
    record("Multica tests must prove stale cache and no-cache behavior");
  }
  if (/writeFileSync\s*\([^)]*tasks\//s.test(multicaText) || /renameSync\s*\([^)]*tasks\//s.test(multicaText)) {
    record("Multica adopt must not write authored task documents outside WriteCoordinator");
  }
}

if (hasExtensionModelImplementation) {
  const extensionModelText = readFileSync(path.join(root, "packages/kernel/src/domain/extension-model.ts"), "utf8");
  const cliText = readFileSync(path.join(root, "packages/cli/src/index.ts"), "utf8");
  const extensionTestPath = "packages/kernel/test/contracts/extension-model.test.ts";
  const cliExtensionTestPath = "packages/cli/test/extension-cli.test.ts";
  if (!existsSync(path.join(root, extensionTestPath))) record(`extension model implementation requires contract test: ${extensionTestPath}`);
  if (!existsSync(path.join(root, cliExtensionTestPath))) record(`extension model CLI surface requires contract test: ${cliExtensionTestPath}`);
  for (const requiredSnippet of extensionRequiredSnippets) {
    if (!`${extensionModelText}\n${cliText}`.includes(requiredSnippet)) {
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
    (rel === "packages/application/src/index.ts" || rel === "packages/gui/src/api/service-bridge.ts") &&
    /function\s+validateRelativeDocumentPath|path\.isAbsolute\s*\(\s*documentPath|path\.normalize\s*\(\s*documentPath/.test(text)
  ) {
    record(`${rel}: controller document paths must use kernel normalizeRelativeDocumentPath instead of a local validator`);
  }

  if (
    (rel === "packages/application/src/index.ts" || rel === "packages/gui/src/api/service-bridge.ts") &&
    !text.includes("normalizeRelativeDocumentPath")
  ) {
    record(`${rel}: controller document paths must import kernel normalizeRelativeDocumentPath`);
  }

  if (!rel.startsWith("packages/kernel/src/store/") && !isTestOrFixture && /\.(?:writeDocument|archivePackage)\s*\(/.test(text)) {
    record(`${rel}: authored writes must go through WriteCoordinator.enqueue; the ArtifactStoreWriter seam is flusher-only inside kernel/src/store/`);
  }

  if (rel.startsWith("packages/kernel/src/store/") && /\bfrom\s+["'][^"']*(?:packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
    record(`${rel}: store must not import engine adapter implementations`);
  }
  if (
    rel.startsWith("packages/kernel/src/store/") &&
    rel !== "packages/kernel/src/store/write-journal-git.ts" &&
    (/\bfrom\s+["']node:child_process["']/.test(text) || /\brunGit\s*\(/.test(text))
  ) {
    record(`${rel}: WriteCoordinator git process calls must stay isolated in write-journal-git.ts`);
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
