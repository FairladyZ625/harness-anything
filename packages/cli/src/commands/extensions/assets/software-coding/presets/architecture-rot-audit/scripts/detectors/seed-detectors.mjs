import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const seedDetectors = new Map([
  ["ROT-001", detectCommandDescriptors],
  ["ROT-002", detectCommandHelp],
  ["ROT-003", detectExecutableApiContracts],
  ["ROT-004", detectDaemonClasses],
  ["ROT-005", detectWriteOpInterpreters],
  ["ROT-006", detectTaskHolderAtomicity],
  ["ROT-007", detectDaemonRuntimeOwnership],
  ["ROT-008", detectScriptExecutorOwnership],
  ["ROT-009", detectPresetIdLeaks],
  ["ROT-010", detectRelationSourceCatalog],
  ["ROT-011", detectVcsSeam],
  ["ROT-012", detectPrAdmission],
  ["ROT-013", detectTaskWriteRoutePolicy],
  ["ROT-014", detectRendererTaskOwner],
  ["ROT-015", detectProjectionVocabulary],
  ["ROT-016", detectPhysicalIoDebt],
  ["ROT-017", detectMetadataFastPaths]
]);

export function runSeedDetectors(rootDir, records) {
  return records.map((record) => runSeedDetector(rootDir, record.id));
}

export function runSeedDetector(rootDir, id) {
  const detector = seedDetectors.get(id);
  if (!detector) return unverified(id, `No pure detector is registered for ${id}.`);
  try {
    const verdict = detector(rootDir);
    return {
      id,
      outcome: verdict.pass ? "pass" : "fail",
      exitCode: verdict.pass ? 0 : 1,
      evidence: verdict.evidence
    };
  } catch (error) {
    return unverified(id, error instanceof Error ? error.message : String(error));
  }
}

function detectCommandDescriptors(rootDir) {
  const sources = commandSpecSources(rootDir);
  const total = countMatches(sources, /"kind"\s*:/gu);
  const parse = countMatches(sources, /"parse"\s*:/gu);
  const run = countMatches(sources, /"run"\s*:/gu);
  return verdict(total > 0 && parse === total && run === total, { total, executableDescriptors: Math.min(parse, run), missingCount: total - Math.min(parse, run) });
}

function detectCommandHelp(rootDir) {
  const sources = commandSpecSources(rootDir);
  const optionPattern = /\{\s*"flag"\s*:\s*"([^"]+)"\s*,\s*"description"\s*:\s*"([^"]*)"\s*\}/gu;
  const descriptions = new Map();
  let options = 0;
  let malformed = 0;
  for (const source of sources) {
    for (const match of source.matchAll(optionPattern)) {
      options += 1;
      if (!match[2].trim()) malformed += 1;
      const values = descriptions.get(match[1]) ?? new Set();
      values.add(match[2]);
      descriptions.set(match[1], values);
    }
  }
  const contextual = [...descriptions].filter(([, values]) => values.size > 1).map(([flag]) => flag);
  return verdict(options > 0 && malformed === 0 && contextual.length > 0, { options, malformedCount: malformed, contextualFlagCount: contextual.length, contextualSample: contextual.slice(0, 5) });
}

function detectExecutableApiContracts(rootDir) {
  const source = read(rootDir, "packages/gui/src/api/api-contract-registry.ts");
  const schemas = count(source, /\{\s*id:\s*"[^"]+"\s*,\s*owner:/gu);
  const executable = count(source, /(?:decode|codec)\s*:/gu);
  const routes = count(source, /inputSchemaId\s*:/gu) - 1;
  return verdict(schemas > 0 && executable >= schemas, { schemas, executableSchemas: executable, routes, routesWithExecutableInput: executable >= schemas ? routes : 0 });
}

function detectDaemonClasses(rootDir) {
  const sources = commandSpecSources(rootDir);
  const commands = countMatches(sources, /"kind"\s*:/gu);
  const classified = countMatches(sources, /"daemonClass"\s*:\s*"(?:repo-read|repo-write|arbiter)"/gu);
  const mirror = read(rootDir, "packages/daemon/src/protocol/method-registry.ts");
  const manualMirrorMembers = count(interfaceBody(mirror, "repoCommandRunClassifiedActionKinds"), /"[^"]+"/gu);
  return verdict(commands > 0 && classified === commands && manualMirrorMembers === 0, { commands, descriptorsWithDaemonClass: classified, manualMirrorMembers });
}

function detectWriteOpInterpreters(rootDir) {
  const source = read(rootDir, "packages/kernel/src/store/write-journal-operations.ts");
  let current = "module";
  const interpreters = new Set();
  for (const line of source.split(/\r?\n/u)) {
    const declaration = /(?:export\s+)?function\s+([A-Za-z0-9_]+)/u.exec(line);
    if (declaration) current = declaration[1];
    if (/\bop\.kind\b/u.test(line)) interpreters.add(current);
  }
  return verdict(interpreters.size <= 1, { opKindInterpreterCount: interpreters.size, interpreters: [...interpreters] });
}

function detectTaskHolderAtomicity(rootDir) {
  const source = read(rootDir, "packages/kernel/src/local/task-holder-state.ts");
  const helper = /(?:async\s+)?function\s+withTaskHolderMutationLock\b/u.test(source);
  const lockCalls = count(source, /\bwithTaskHolderMutationLock\s*\(/gu);
  return verdict(helper && lockCalls >= 2, { atomicMutationHelper: helper, guardedMutationCallsites: lockCalls });
}

function detectDaemonRuntimeOwnership(rootDir) {
  const daemon = read(rootDir, "packages/daemon/src/index.ts");
  const store = read(rootDir, "packages/kernel/src/store/index.ts");
  const daemonOwnsRuntime = runtimeExports(daemon);
  const kernelStoreOwnsRuntime = /\bcreate(?:MultiRepo)?DaemonRuntime\b|["']\.\/daemon-runtime\.ts["']/u.test(store);
  return verdict(daemonOwnsRuntime && !kernelStoreOwnsRuntime, { daemonOwnsRuntime, kernelStoreOwnsRuntime });
}

function detectScriptExecutorOwnership(rootDir) {
  const directory = path.join(rootDir, "packages/cli/src/commands/extensions");
  requirePath(directory);
  const owners = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => readFileSync(path.join(directory, name), "utf8").includes("spawnSync"));
  return verdict(owners.length === 1 && owners[0] === "script-executor.ts", { spawnSyncOwnerCount: owners.length, owners });
}

function detectPresetIdLeaks(rootDir) {
  const ids = ["create-milestone", "milestone-closeout", "decision-conformance"];
  const files = ["packages/cli/src/commands/extensions/preset-policy.ts", "packages/cli/src/commands/extensions/state.ts"];
  const hits = files.flatMap((file) => ids.filter((id) => new RegExp(`["']${id}["']`, "u").test(read(rootDir, file))).map((value) => ({ file, value })));
  return verdict(hits.length === 0, { presetIdLiteralHits: hits.length, hits });
}

function detectRelationSourceCatalog(rootDir) {
  const domain = ["task-index", "task-facts", "decision-document"];
  const graph = literalSet(read(rootDir, "packages/kernel/src/projection/relation-graph-projection.ts"), domain);
  const hash = literalSet(read(rootDir, "packages/kernel/src/projection/sqlite-task-source.ts"), domain);
  const duplicated = [...graph].filter((value) => hash.has(value)).sort();
  return verdict(duplicated.length === 0, { graphKinds: [...graph].sort(), hashKinds: [...hash].sort(), manuallyDuplicatedKinds: duplicated });
}

function detectVcsSeam(rootDir) {
  const vcs = interfaceMembers(read(rootDir, "packages/kernel/src/ports/version-control-system.ts"), "VersionControlSystem");
  const app = interfaceMembers(read(rootDir, "packages/application/src/code-doc-reconciliation.ts"), "GitRunner");
  const pathAtRef = vcs.includes("pathExistsAtCommit") || vcs.includes("pathExistsAtRef");
  return verdict(pathAtRef && app.length === 0, { vcsSupportsPathAtRef: pathAtRef, applicationGitRunnerMembers: app });
}

function detectPrAdmission(rootDir) {
  const manifest = JSON.parse(read(rootDir, "tools/gate-manifest.json"));
  const gaps = manifest.gates.filter((gate) => gate.aggregate !== true && gate.executionSurfaces?.packageJson?.checkPr === true && (gate.executionSurfaces?.rewriteCi?.pullRequestJobs?.length ?? 0) === 0 && (gate.executionSurfaces?.rewriteCi?.nonPullRequestJobs ?? []).includes("full-check")).map((gate) => gate.id);
  return verdict(gaps.length === 0, { prDeclaredButNotRunBeforeMerge: gaps.length, gates: gaps });
}

function detectTaskWriteRoutePolicy(rootDir) {
  const source = read(rootDir, "packages/application/src/task-write-route-policy.ts");
  const writes = [...source.matchAll(/id:\s*"(tasks\.[^"]+)"[\s\S]*?commandClass:\s*"([^"]+)"/gu)].map((match) => ({ id: match[1], commandClass: match[2] }));
  const missing = writes.filter((route) => !["repo-write", "arbiter"].includes(route.commandClass)).map((route) => route.id);
  const review = writes.find((route) => route.id === "tasks.review");
  return verdict(writes.length > 0 && missing.length === 0 && review?.commandClass === "arbiter", { taskWriteRoutes: writes.length, declarativeCommandClasses: writes.length - missing.length, missing, reviewClass: review?.commandClass ?? null });
}

function detectRendererTaskOwner(rootDir) {
  const source = read(rootDir, "packages/gui/src/renderer/App.tsx");
  const queryOwner = /\buseTasksQuery\s*\(/u.test(source);
  const localTaskOwners = count(source, /\[\s*tasks\s*,[^\]]*\]\s*=\s*useState\s*\(/gu);
  const owners = Number(queryOwner) + localTaskOwners;
  return verdict(queryOwner && owners === 1, { queryOwner, localTaskOwners, totalServerStateOwners: owners });
}

function detectProjectionVocabulary(rootDir) {
  const kernel = new Set(interfaceNames(read(rootDir, "packages/kernel/src/projection/types.ts")));
  const application = new Set(interfaceNames(read(rootDir, "packages/application/src/index.ts")));
  const duplicated = [...kernel].filter((name) => application.has(name)).sort();
  return verdict(duplicated.length === 0, { duplicatedProjectionInterfaces: duplicated.length, names: duplicated });
}

function detectPhysicalIoDebt(rootDir) {
  const source = read(rootDir, "tools/port-physical-io-boundary-known-debt.mjs");
  const entries = [...source.matchAll(/\{[\s\S]*?\bfile:\s*"[^"]+"[\s\S]*?\}/gu)].map((match) => match[0]);
  const governed = entries.filter((entry) => /\bowner:\s*"[^"]+"/u.test(entry) && /\bexpiresAt:\s*"[^"]+"/u.test(entry) && /\b(?:symbols|imports):\s*\[/u.test(entry));
  const manifest = JSON.parse(read(rootDir, "tools/gate-manifest.json"));
  const lint = manifest.gates.find((gate) => gate.id === "lint");
  return verdict(entries.length > 0 && governed.length === entries.length && lint?.bypassFixtureRequired === true, { debtEntries: entries.length, entriesWithOwnerExpiryAndNarrowScope: governed.length, bypassFixtureRequired: lint?.bypassFixtureRequired ?? null });
}

function detectMetadataFastPaths(rootDir) {
  const lines = read(rootDir, ".github/workflows/rewrite-ci.yml").split(/\r?\n/u);
  const starts = lines.map((line, index) => line.trim() === "- name: Accept Mergify queue metadata edit" ? index : -1).filter((index) => index >= 0);
  const blocks = starts.map((start) => {
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith("      - ")) end += 1;
    return lines.slice(start, end).join("\n");
  });
  const verified = blocks.filter((block) => (block.includes("PR_HEAD_SHA") || block.includes("github.event.pull_request.head.sha")) && block.includes("run:") && !block.includes("run: echo"));
  return verdict(blocks.length > 0 && verified.length === blocks.length, { metadataFastPathSteps: blocks.length, stepsWithSameShaVerification: verified.length, unverifiedSteps: blocks.length - verified.length });
}

function commandSpecSources(rootDir) {
  const directory = path.join(rootDir, "packages/cli/src/cli/command-spec");
  requirePath(directory);
  return readdirSync(directory).filter((name) => /^command-spec-.*\.ts$/u.test(name)).map((name) => readFileSync(path.join(directory, name), "utf8"));
}

function runtimeExports(source) {
  return /\bcreateDaemonRuntime\b/u.test(source) && /\bcreateMultiRepoDaemonRuntime\b/u.test(source);
}

function literalSet(source, values) {
  return new Set(values.filter((value) => new RegExp(`["']${value}["']`, "u").test(source)));
}

function interfaceMembers(source, name) {
  const body = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u").exec(source)?.[1] ?? "";
  return [...body.matchAll(/\b(?:readonly\s+)?([A-Za-z0-9_]+)\s*[?:]/gu)].map((match) => match[1]);
}

function interfaceNames(source) {
  return [...source.matchAll(/^(?:export\s+)?interface\s+([A-Za-z0-9_]+)/gmu)].map((match) => match[1]);
}

function interfaceBody(source, name) {
  return new RegExp(`${name}[\\s\\S]*?\\[([\\s\\S]*?)\\]`, "u").exec(source)?.[1] ?? "";
}

function countMatches(sources, pattern) {
  return sources.reduce((total, source) => total + count(source, pattern), 0);
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function read(rootDir, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  requirePath(filePath);
  return readFileSync(filePath, "utf8");
}

function requirePath(filePath) {
  if (!existsSync(filePath)) throw new Error(`Required detector input is missing: ${filePath}`);
}

function verdict(pass, evidence) {
  return { pass, evidence };
}

function unverified(id, error) {
  return { id, outcome: "unverified", exitCode: null, evidence: null, error };
}
