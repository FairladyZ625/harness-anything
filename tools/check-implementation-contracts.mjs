import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs|html)$/;
const violations = [];

const expectedRuntimeTestFiles = {
  gui: [
    "packages/gui/test/renderer-no-node.test.ts",
    "packages/gui/test/preload-allowlist.test.ts",
    "packages/gui/test/markdown-sanitize.test.ts",
    "packages/gui/test/local-api-auth.test.ts",
    "packages/gui/test/path-traversal.test.ts",
    "packages/gui/test/terminal-no-ingestion.test.ts"
  ],
  store: [
    "packages/kernel/test/store/journal-idempotency.test.ts",
    "packages/kernel/test/store/same-task-fifo.test.ts",
    "packages/kernel/test/store/global-committer-lock.test.ts",
    "packages/kernel/test/store/crash-before-watermark.test.ts",
    "packages/kernel/test/store/payload-hash.test.ts",
    "packages/kernel/test/store/sqlite-rebuild.test.ts"
  ],
  publish: [
    "packages/kernel/test/publish/redaction.test.ts",
    "packages/kernel/test/publish/idempotency.test.ts",
    "packages/kernel/test/publish/private-evidence-rejection.test.ts"
  ]
};

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
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...await walk(full));
    } else if (sourceFile.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const rootPackage = readJson("package.json");
const rootTsconfig = readJson("tsconfig.json");
if (rootPackage.engines?.node !== ">=24") record("root engines.node must remain >=24");
if (rootPackage.dependencies?.effect !== "3.21.2") record("effect version must remain 3.21.2 until an explicit upgrade task");
if (rootPackage.devDependencies?.typescript !== "5.9.3") record("typescript version must remain 5.9.3 until an explicit upgrade task");
if (rootPackage.devDependencies?.["@types/node"] !== "24.13.2") record("@types/node version must remain 24.13.2");
if (!existsSync(path.join(root, "package-lock.json"))) record("package-lock.json is required; npm is the package manager");
const packageLock = existsSync(path.join(root, "package-lock.json")) ? readJson("package-lock.json") : { packages: {} };
for (const [lockPath, expected] of [
  ["node_modules/effect", "3.21.2"],
  ["node_modules/typescript", "5.9.3"],
  ["node_modules/@types/node", "24.13.2"]
]) {
  const actual = packageLock.packages?.[lockPath]?.version;
  if (actual !== expected) record(`package-lock ${lockPath} must be ${expected}, got ${actual ?? "missing"}`);
}
for (const forbiddenLockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
  if (existsSync(path.join(root, forbiddenLockfile))) record(`${forbiddenLockfile} is not allowed in this npm workspace`);
}

const workspaceTsconfigs = (rootTsconfig.references ?? [])
  .map((reference) => `${reference.path.replace(/^\.\//, "")}/tsconfig.json`)
  .sort();
const expectedWorkspaceTsconfigs = [
  "packages/adapters/github-issues/tsconfig.json",
  "packages/adapters/linear/tsconfig.json",
  "packages/adapters/local/tsconfig.json",
  "packages/adapters/multica/tsconfig.json",
  "packages/cli/tsconfig.json",
  "packages/gui/tsconfig.json",
  "packages/kernel/tsconfig.json"
].sort();
if (JSON.stringify(workspaceTsconfigs) !== JSON.stringify(expectedWorkspaceTsconfigs)) {
  record(`tsconfig references must match expected workspaces: ${expectedWorkspaceTsconfigs.join(", ")}`);
}

for (const tsconfigPath of workspaceTsconfigs) {
  const tsconfig = readJson(tsconfigPath);
  const options = tsconfig.compilerOptions ?? {};
  const requiredOptions = {
    composite: true,
    declaration: true,
    emitDeclarationOnly: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2024",
    strict: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true
  };
  for (const [key, expected] of Object.entries(requiredOptions)) {
    if (options[key] !== expected) record(`${tsconfigPath} compilerOptions.${key} must be ${JSON.stringify(expected)}`);
  }
}

const files = await walk(path.join(root, "packages"));
const hasGuiImplementation = files.some((file) => /packages\/gui\/src\/(?:main|preload|renderer|api|terminal|doc-renderer)\//.test(relative(file)));
const hasStoreImplementation = files.some((file) => /packages\/kernel\/src\/store\//.test(relative(file)));
const hasPublishImplementation = files.some((file) => /packages\/(?:kernel|cli|gui)\/src\/.*publish/i.test(relative(file)));
for (const [kind, active] of Object.entries({ gui: hasGuiImplementation, store: hasStoreImplementation, publish: hasPublishImplementation })) {
  if (!active) continue;
  for (const requiredPath of expectedRuntimeTestFiles[kind]) {
    if (!existsSync(path.join(root, requiredPath))) record(`${kind} implementation requires contract test: ${requiredPath}`);
  }
}

for (const file of files) {
  const rel = relative(file);
  const text = await readFile(file, "utf8");
  const isTestOrFixture = /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);

  if (/\/Users\/lizeyu\/Projects\/multica|from\s+["']@multica\//.test(text)) {
    record(`${rel}: Multica source may be referenced only from private design docs, never from public implementation`);
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

  if (!rel.startsWith("packages/cli/src/") && /\b(?:Effect|E|Fx)\.runPromise\w*\s*\(|\brunPromise\w*\s*\(/.test(text)) {
    record(`${rel}: Effect.runPromise* is only allowed at CLI composition roots`);
  }

  if (rel.startsWith("packages/kernel/src/store/") && /\bfrom\s+["'][^"']*(?:packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
    record(`${rel}: store must not import engine adapter implementations`);
  }

  if (rel.startsWith("packages/adapters/") && !isTestOrFixture) {
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

  if (/new\s+BrowserWindow\s*\(/.test(text)) {
    for (const required of [
      /nodeIntegration\s*:\s*false/,
      /contextIsolation\s*:\s*true/,
      /sandbox\s*:\s*true/,
      /webSecurity\s*:\s*true/
    ]) {
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
