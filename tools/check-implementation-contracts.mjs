import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceFile = /\.(?:ts|mts|js|mjs)$/;
const violations = [];

const workspaceTsconfigs = [
  "packages/kernel/tsconfig.json",
  "packages/cli/tsconfig.json",
  "packages/gui/tsconfig.json",
  "packages/adapters/local/tsconfig.json",
  "packages/adapters/multica/tsconfig.json",
  "packages/adapters/github-issues/tsconfig.json",
  "packages/adapters/linear/tsconfig.json"
];

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
if (rootPackage.engines?.node !== ">=24") record("root engines.node must remain >=24");
if (rootPackage.dependencies?.effect !== "3.21.2") record("effect version must remain 3.21.2 until an explicit upgrade task");
if (rootPackage.devDependencies?.typescript !== "5.9.3") record("typescript version must remain 5.9.3 until an explicit upgrade task");
if (rootPackage.devDependencies?.["@types/node"] !== "24") record("@types/node version must remain 24");
if (!existsSync(path.join(root, "package-lock.json"))) record("package-lock.json is required; npm is the package manager");
for (const forbiddenLockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
  if (existsSync(path.join(root, forbiddenLockfile))) record(`${forbiddenLockfile} is not allowed in this npm workspace`);
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
    erasableSyntaxOnly: true
  };
  for (const [key, expected] of Object.entries(requiredOptions)) {
    if (options[key] !== expected) record(`${tsconfigPath} compilerOptions.${key} must be ${JSON.stringify(expected)}`);
  }
}

const files = await walk(path.join(root, "packages"));

for (const file of files) {
  const rel = relative(file);
  const text = await readFile(file, "utf8");
  const isTestOrFixture = /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);

  if (/\/Users\/lizeyu\/Projects\/multica|from\s+["']@multica\//.test(text)) {
    record(`${rel}: Multica source may be referenced only from private design docs, never from public implementation`);
  }

  if (rel.startsWith("packages/kernel/src/domain/")) {
    if (/\b(?:Effect|Context|Layer|Queue|Semaphore)\b/.test(text)) {
      record(`${rel}: domain must not use Effect runtime, Context, Layer, Queue, or Semaphore`);
    }
    if (/\bData\.TaggedError\b/.test(text)) {
      record(`${rel}: domain errors must be plain readonly _tag unions, not Data.TaggedError`);
    }
  }

  if (rel.startsWith("packages/kernel/src/application/") && /\bEffect\.runPromise\b/.test(text)) {
    record(`${rel}: Effect.runPromise is only allowed at controller composition roots`);
  }

  if (rel.startsWith("packages/kernel/src/store/") && /\bfrom\s+["'][^"']*(?:packages\/adapters|@harness-anything\/adapter-)[^"']*["']/.test(text)) {
    record(`${rel}: store must not import engine adapter implementations`);
  }

  if (rel.startsWith("packages/adapters/") && !isTestOrFixture) {
    if (/(^|[^\w])(:\s*any\b|as\s+any\b|<any>)/.test(text)) {
      record(`${rel}: adapters must decode raw input instead of returning or casting any`);
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
    if (/from\s+["'][^"']*(?:@harness-anything\/adapter-|packages\/adapters)[^"']*["']/.test(text)) {
      record(`${rel}: GUI must read cached projections/application services, not call external adapter implementations`);
    }
    if (/terminal[\s\S]{0,120}(?:projection|mutate|ingest|parse output)/i.test(text)) {
      record(`${rel}: terminal output must not mutate projections or become implicit task state`);
    }
  }

  if (/new\s+BrowserWindow\s*\(/.test(text)) {
    for (const required of [
      /nodeIntegration\s*:\s*false/,
      /contextIsolation\s*:\s*true/,
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
