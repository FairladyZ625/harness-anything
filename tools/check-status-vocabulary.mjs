#!/usr/bin/env node
/**
 * G-IRONLAW4 status-word ratchet gate (blueprint 铁律四 · slice 5).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1 (add ratchet gates only —
 * existing words are grandfathered through the register, new unregistered ones
 * are refused); dec_499E4E98A3D4754132B3BCA1E6 CH1 (every persistent status
 * signal must resolve to a declared state store).
 *
 * The gate judges real declarations, not prose:
 *   1. The register (packages/kernel/src/domain/status-vocabulary.ts) is
 *      well-formed: every row carries a meaning, divergent words carry a
 *      resolution, subsets stay inside their parent, mirrors match their source,
 *      and a row carries at most one ownership form (mirrorOf / ownerStore /
 *      scope: "view-local").
 *   2. Every kernel-domain status vocabulary bound to a runtime export equals the
 *      register exactly — the register and the kernel cannot drift apart.
 *   3. Every status-vocabulary declaration in packages/*\/src (named const
 *      arrays and literal-union type aliases) is registered with the same words;
 *      every registered inline `readonly field:` union still exists with the
 *      registered words. Declarations outside the kernel domain choose one of three forms:
 *      mirrorOf (a generated/mirrored copy), ownerStore (a word set owned by a
 *      declared state store), or scope: "view-local" (a GUI-local view type that
 *      is never persisted or imported). Anything else is a shrink-only baseline
 *      entry until its owner declares a store.
 *   4. A view-local declaration is refused when it is exported, imported by
 *      another module, or its file owns a persistent write.
 *   5. A registered ownerStore resolves to exactly one declared state store and
 *      that store lists the vocabulary in its `vocabulary` facet.
 *   6. The GUI model mirrors equal their kernel vocabularies (plus the explicit
 *      `unknown` where the GUI convention adds it), and the unknown fallback
 *      stays deleted: unrecognised decision states map to "unknown", never to a
 *      plausible neighbour.
 *   7. Baseline entries are frozen: a baseline declaration whose words changed,
 *      whose declaration disappeared, or whose anchor is now registered is
 *      refused (the baseline only shrinks).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { daemonStatusVocabularyProjectionFinding } from "./generate-daemon-status-vocabulary.mjs";
import { statusVocabularyBaseline } from "./gate-allowlists/status-vocabulary-baseline.mjs";
import { entityKindContracts } from "../packages/kernel/src/domain/entity-kind-registry.ts";
import { listWorktreeFiles } from "./gates/git.mjs";

const REGISTER = "../packages/kernel/src/domain/status-vocabulary.ts";
const PACKAGE_SCOPES = ["packages"];
const GUI_ADAPTER = "packages/gui/src/renderer/triadic-data.ts";
const STATUS_WORDS_SUFFIX = /(?:Status|State|Phase|Disposition|Verdict|Outcome|Liveness)Words$/u;
const LOCAL_MIRROR_CONST =
  /(export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]\s*as\s+const/gu;
export const STATUS_DECLARATION_SUFFIX =
  /(?:Statuses|Status|States|State|Phases|Phase|Dispositions|Disposition|Verdicts|Verdict|Outcomes|Outcome|Liveness|Readinesses|Readiness)$/u;
// The `\|?` after the `=` accepts prettier's canonical multi-line union, which
// leads with a pipe:
//
//     export type FooStatus =
//       | "a"
//       | "b";
//
// Without it this pattern only ever saw the single-line `= "a" | "b"` form. That
// mattered in both directions, and only one of them was loud: a registered anchor
// reformatted this way reports "no longer exists" (fail-closed, visible), but a
// brand-new status vocabulary written this way is simply never collected as a
// site — so the unregistered-vocabulary finding that enforces 铁律四 could not fire
// on it at all. Found when prettier reformatted RuntimeSessionSemanticState in
// packages/kernel/src/domain/agent-runtime.ts under task_2c909af2cae0b23abd1e34a2e2.
const NAMED_TYPE = /(export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\|?\s*("(?:[^"]*)"(?:\s*\|\s*"[^"]*")*)\s*;/gu;
const INLINE_FIELD = /readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:\s*("[^"]+"(?:\s*\|\s*"[^"]+")+)/gu;
const KERNEL_DECISION_FALLBACK = /function\s+decisionState\s*\([^)]*\)[^}]*return\s+"(?!unknown)[a-z_]+"/u;
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gu;
// S1/S2 signals from the residue design: a file holding a persistent write cannot
// also declare a view-local vocabulary.
const PERSISTENT_WRITE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|createWriteStream)\s*\(|\bnew\s+DatabaseSync\s*\(|\bCREATE\s+(?:VIRTUAL\s+)?TABLE\b/u;

function literalWords(fragment) {
  return [...fragment.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function sameWords(left, right) {
  return left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0");
}

function declarationKey(module, anchor) {
  return `${module}#${anchor}`;
}

export function checkRegisterShape({ statusVocabularies, statusWordRegister }, findings = []) {
  const vocabularyById = new Map(statusVocabularies.map((vocabulary) => [vocabulary.id, vocabulary]));
  const anchors = new Set();
  for (const vocabulary of statusVocabularies) {
    for (const field of ["id", "entity", "field", "module", "anchor"]) {
      if (typeof vocabulary[field] !== "string" || vocabulary[field].trim() === "") {
        findings.push(`statusVocabularies[${vocabulary.id ?? "?"}]: ${field} must be a non-empty string`);
      }
    }
    const ownershipForms = [vocabulary.mirrorOf, vocabulary.ownerStore, vocabulary.scope].filter(
      (value) => value !== undefined,
    );
    if (ownershipForms.length > 1) {
      findings.push(`${vocabulary.id}: declare at most one ownership form (mirrorOf / ownerStore / scope)`);
    }
    if (vocabulary.scope !== undefined && vocabulary.scope !== "view-local") {
      findings.push(`${vocabulary.id}: scope must be "view-local" when present`);
    }
    if (vocabulary.scope === "view-local" && !vocabulary.module.startsWith("packages/gui/")) {
      findings.push(`${vocabulary.id}: view-local scope is only for GUI renderer declarations`);
    }
    if (vocabulary.ownerStore !== undefined && (typeof vocabulary.ownerStore !== "string" || !vocabulary.ownerStore)) {
      findings.push(`${vocabulary.id}: ownerStore must be a non-empty state-store id`);
    }
    if (
      !Array.isArray(vocabulary.words) ||
      vocabulary.words.length === 0 ||
      vocabulary.words.some((word) => typeof word !== "string" || word.trim() === "")
    ) {
      findings.push(`${vocabulary.id}: words must be a non-empty array of non-empty strings`);
    }
    const anchorKey = declarationKey(vocabulary.module, vocabulary.anchor);
    if (anchors.has(anchorKey)) findings.push(`duplicate vocabulary anchor ${anchorKey}`);
    anchors.add(anchorKey);
  }
  for (const vocabulary of statusVocabularies) {
    if (vocabulary.subsetOf !== undefined) {
      const parent = vocabularyById.get(vocabulary.subsetOf);
      if (!parent) {
        findings.push(`${vocabulary.id}: subsetOf references unknown vocabulary ${vocabulary.subsetOf}`);
      } else if (vocabulary.words.some((word) => !parent.words.includes(word))) {
        findings.push(`${vocabulary.id}: words must be a subset of ${vocabulary.subsetOf}`);
      }
    }
    if (vocabulary.mirrorOf !== undefined) {
      const parent = vocabularyById.get(vocabulary.mirrorOf);
      if (!parent) {
        findings.push(`${vocabulary.id}: mirrorOf references unknown vocabulary ${vocabulary.mirrorOf}`);
        continue;
      }
      const expected = [...parent.words, ...(vocabulary.plusWords ?? [])];
      if (!sameWords(vocabulary.words, expected)) {
        findings.push(
          `${vocabulary.id}: mirror words [${vocabulary.words}] must equal ${vocabulary.mirrorOf} plus [${vocabulary.plusWords ?? []}]`,
        );
      }
    }
  }
  const wordKeys = new Set();
  for (const row of statusWordRegister) {
    for (const field of ["word", "entity", "field", "meaning"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        findings.push(
          `statusWordRegister: ${field} must be a non-empty string (row ${row.word ?? "?"} on ${row.entity ?? "?"})`,
        );
      }
    }
    const key = `${row.word}|${row.entity}|${row.field}`;
    if (wordKeys.has(key)) findings.push(`statusWordRegister: duplicate row ${key}`);
    wordKeys.add(key);
    if (row.divergence === "divergent" && (typeof row.resolution !== "string" || row.resolution.trim() === "")) {
      findings.push(`statusWordRegister: divergent word ${key} must carry a resolution`);
    }
    if (row.divergence === "entity-scoped" && row.resolution !== undefined) {
      findings.push(`statusWordRegister: entity-scoped word ${key} must not carry a resolution`);
    }
  }
  for (const vocabulary of statusVocabularies) {
    // Mirrors reuse the mirrored vocabulary's words; view-local view types are not
    // persistent state, so neither owns a register meaning of its own.
    if (vocabulary.mirrorOf !== undefined || vocabulary.scope === "view-local") continue;
    for (const word of vocabulary.words) {
      const covered = statusWordRegister.some(
        (row) => row.word === word && row.entity === vocabulary.entity && row.field === vocabulary.field,
      );
      if (!covered)
        findings.push(
          `${vocabulary.id}: word "${word}" has no register row for ${vocabulary.entity}.${vocabulary.field}`,
        );
    }
  }
  if (statusVocabularies.length === 0) findings.push("statusVocabularies: register is empty");
  return findings;
}

/** Index every declared state store by id; a duplicate id is reported, never silently overwritten. */
export function buildStateStoreIndex(contracts, findings = []) {
  const byId = new Map();
  for (const contract of contracts) {
    for (const store of contract.stateStores ?? []) {
      if (byId.has(store.id)) {
        const owner = byId.get(store.id).kind;
        findings.push(`state store ${store.id} is claimed by both ${owner} and ${contract.kind}`);
        continue;
      }
      byId.set(store.id, { kind: contract.kind, store });
    }
  }
  return { byId, findings };
}

export function checkOwnerStoreAgreement(register, stores, findings = []) {
  const vocabularyById = new Map(register.statusVocabularies.map((vocabulary) => [vocabulary.id, vocabulary]));
  for (const vocabulary of register.statusVocabularies) {
    if (vocabulary.ownerStore === undefined) continue;
    const declared = stores.get(vocabulary.ownerStore);
    if (!declared) {
      findings.push(
        `${vocabulary.id}: ownerStore ${vocabulary.ownerStore} does not resolve to a declared state store (dec_499E4E98A3D4754132B3BCA1E6 CH1)`,
      );
    } else if (!declared.store.vocabulary.includes(vocabulary.id)) {
      findings.push(
        `${vocabulary.id}: state store ${vocabulary.ownerStore} does not list this vocabulary in its vocabulary facet`,
      );
    }
  }
  for (const [storeId, { store }] of stores) {
    for (const vocabularyId of store.vocabulary) {
      const vocabulary = vocabularyById.get(vocabularyId);
      // Dangling store vocabulary ids are the registry facet's debt (slice 1); this
      // gate only judges rows that exist in the status register.
      if (!vocabulary) continue;
      if (vocabulary.ownerStore !== storeId) {
        findings.push(
          `state store ${storeId} lists ${vocabularyId}, which declares ownerStore ${vocabulary.ownerStore ?? "(none)"}`,
        );
      }
    }
  }
  return findings;
}

export function checkKernelVocabularyBijection(register, modulesByFile, sites, findings = []) {
  for (const vocabulary of register.statusVocabularies) {
    if (!vocabulary.module.startsWith("packages/kernel/src/domain/") || vocabulary.anchor.startsWith("#")) continue;
    // Only runtime const vocabularies have an export to bijection-check; literal-union
    // type aliases are text-checked by the coverage scan.
    const site = sites.find(
      (candidate) => candidate.module === vocabulary.module && candidate.anchor === vocabulary.anchor,
    );
    if (site?.kind !== "const" || !site.exported) continue;
    const module = modulesByFile.get(vocabulary.module);
    if (!module) {
      findings.push(`${vocabulary.id}: cannot import ${vocabulary.module}`);
      continue;
    }
    const exported = module[vocabulary.anchor];
    if (!Array.isArray(exported)) {
      findings.push(
        `${vocabulary.id}: ${vocabulary.module} does not export a runtime array named ${vocabulary.anchor}`,
      );
      continue;
    }
    if (!sameWords(exported, vocabulary.words)) {
      findings.push(
        `${vocabulary.id}: kernel export ${vocabulary.anchor} is [${exported}] but the register says [${vocabulary.words}]`,
      );
    }
  }
  return findings;
}

/**
 * Collect every status-vocabulary declaration in the scanned production sources.
 * Inline `readonly field: "a" | "b"` unions are not part of the S4 signal; the
 * registered ones stay checked separately so no pre-existing coverage is lost.
 */
export function collectStatusDeclarationSites(sourcesByFile) {
  const sites = [];
  for (const [module, text] of sourcesByFile) {
    for (const match of text.matchAll(LOCAL_MIRROR_CONST)) {
      if (!STATUS_DECLARATION_SUFFIX.test(match[2]) && !STATUS_WORDS_SUFFIX.test(match[2])) continue;
      const words = literalWords(match[3]);
      if (words.length > 0) {
        sites.push({ module, anchor: match[2], kind: "const", exported: match[1] !== undefined, words });
      }
    }
    for (const match of text.matchAll(NAMED_TYPE)) {
      if (!STATUS_DECLARATION_SUFFIX.test(match[2])) continue;
      sites.push({
        module,
        anchor: match[2],
        kind: "type",
        exported: match[1] !== undefined,
        words: literalWords(match[3]),
      });
    }
  }
  return sites;
}

/**
 * Registered inline anchors are preserved: the module must still declare the
 * `readonly <field>:` union with exactly the registered words.
 */
export function checkRegisteredInlineAnchors(register, sourcesByFile, findings = []) {
  for (const vocabulary of register.statusVocabularies) {
    if (!vocabulary.anchor.startsWith("#")) continue;
    const text = sourcesByFile.get(vocabulary.module);
    if (text === undefined) {
      findings.push(`${vocabulary.id}: cannot read ${vocabulary.module}`);
      continue;
    }
    const field = vocabulary.anchor.slice(1);
    const declarations = [...text.matchAll(INLINE_FIELD)]
      .filter((match) => match[1] === field)
      .map((match) => literalWords(match[2]));
    if (!declarations.some((words) => sameWords(words, vocabulary.words))) {
      findings.push(
        `${vocabulary.id}: registered inline anchor ${declarationKey(vocabulary.module, vocabulary.anchor)} no longer declares [${vocabulary.words}]`,
      );
    }
  }
  return findings;
}

export function checkStatusVocabularyCoverage(register, sites, findings = [], { baseline = [] } = {}) {
  const registeredByKey = new Map(
    register.statusVocabularies.map((vocabulary) => [declarationKey(vocabulary.module, vocabulary.anchor), vocabulary]),
  );
  const siteByKey = new Map();
  for (const site of sites) {
    const key = declarationKey(site.module, site.anchor);
    if (siteByKey.has(key)) findings.push(`duplicate status declaration ${key}`);
    siteByKey.set(key, site);
  }
  const baselineByKey = new Map();
  for (const entry of baseline) {
    if (typeof entry.key !== "string" || !Array.isArray(entry.words)) {
      findings.push(`status-vocabulary baseline entry ${entry.key ?? "?"} must carry a key and frozen words`);
      continue;
    }
    if (baselineByKey.has(entry.key)) findings.push(`duplicate status-vocabulary baseline entry ${entry.key}`);
    baselineByKey.set(entry.key, entry);
  }

  for (const [key, site] of siteByKey) {
    const words = site.words;
    const vocabulary = registeredByKey.get(key);
    if (vocabulary) {
      if (!sameWords(vocabulary.words, words)) {
        findings.push(`${key}: declared words [${words}] drift from the register [${vocabulary.words}]`);
      }
      continue;
    }
    const frozen = baselineByKey.get(key);
    if (!frozen) {
      findings.push(
        `${key}: unregistered status vocabulary [${words}] — register it in status-vocabulary.ts (blueprint 铁律四)`,
      );
      continue;
    }
    if (!sameWords(frozen.words, words)) {
      findings.push(`${key}: words [${words}] drifted from the frozen baseline [${frozen.words}]`);
    }
  }

  for (const [key, vocabulary] of registeredByKey) {
    // Inline anchors are not collected as sites; checkRegisteredInlineAnchors owns them.
    if (vocabulary.anchor.startsWith("#")) continue;
    if (!siteByKey.has(key)) findings.push(`${vocabulary.id}: registered anchor ${key} no longer exists`);
  }
  for (const key of baselineByKey.keys()) {
    if (!siteByKey.has(key)) {
      findings.push(`stale status-vocabulary baseline entry ${key} — the declaration no longer exists`);
    } else if (registeredByKey.has(key)) {
      findings.push(`status-vocabulary baseline entry ${key} is now registered — delete the baseline entry`);
    }
  }
  return findings;
}

function namedBindings(bindingText) {
  const braced = /\{([\s\S]*?)\}/u.exec(bindingText.replace(/^type\s+/u, ""));
  if (!braced) return [];
  return braced[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        .trim(),
    )
    .filter(Boolean);
}

function resolvesToModule(fromFile, specifier, targetModule) {
  if (!specifier.startsWith(".")) return false;
  const strip = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const target = strip(targetModule);
  return strip(resolved) === target || strip(resolved) === `${target}/index`;
}

export function isAnchorImportedElsewhere(module, anchor, sourcesByFile) {
  for (const [file, text] of sourcesByFile) {
    if (file === module) continue;
    for (const match of text.matchAll(IMPORT_FROM)) {
      if (!resolvesToModule(file, match[2], module)) continue;
      if (namedBindings(match[1]).includes(anchor)) return true;
    }
  }
  return false;
}

export function hasPersistentWrite(source) {
  return PERSISTENT_WRITE.test(source);
}

export function checkViewLocalDeclarations(register, sites, sourcesByFile, findings = []) {
  const siteByKey = new Map(sites.map((site) => [declarationKey(site.module, site.anchor), site]));
  for (const vocabulary of register.statusVocabularies) {
    if (vocabulary.scope !== "view-local") continue;
    const key = declarationKey(vocabulary.module, vocabulary.anchor);
    const site = siteByKey.get(key);
    if (!site) continue;
    if (site.exported) {
      findings.push(`${key}: view-local vocabulary must not be exported (another module could import it)`);
    } else if (isAnchorImportedElsewhere(vocabulary.module, vocabulary.anchor, sourcesByFile)) {
      findings.push(`${key}: view-local vocabulary must not be imported by another module`);
    }
    if (hasPersistentWrite(sourcesByFile.get(vocabulary.module) ?? "")) {
      findings.push(`${key}: view-local vocabulary cannot live in a file that owns a persistent write`);
    }
  }
  return findings;
}

export function checkGuiAdapterInvariants(register, sourcesByFile, findings = []) {
  const model = register.statusVocabularies.find((vocabulary) => vocabulary.id === "gui.task.status")?.module;
  if (!model) {
    findings.push("GUI mirror vocabulary gui.task.status is not registered");
    return findings;
  }
  const guiModelText = sourcesByFile.get(model);
  if (guiModelText === undefined) {
    findings.push(`GUI mirror module ${model} was not scanned`);
    return findings;
  }
  const snapshot = register.statusVocabularies.find(
    (vocabulary) => vocabulary.module === model && vocabulary.anchor === "SnapshotStatus",
  );
  const boardColumns = /export\s+const\s+BOARD_COLUMNS[^=]*=\s*\[([^\]]*)\]/u.exec(guiModelText);
  if (boardColumns && snapshot) {
    const columns = literalWords(boardColumns[1]);
    if (!sameWords(columns, snapshot.words)) {
      findings.push(`BOARD_COLUMNS [${columns}] must cover exactly the SnapshotStatus vocabulary [${snapshot.words}]`);
    }
  } else if (!boardColumns) {
    findings.push("BOARD_COLUMNS declaration not found in the GUI model");
  }
  const guiAdapterText = sourcesByFile.get(GUI_ADAPTER);
  if (guiAdapterText === undefined) {
    findings.push(`GUI adapter ${GUI_ADAPTER} was not scanned`);
  } else if (KERNEL_DECISION_FALLBACK.test(guiAdapterText)) {
    findings.push(
      `${GUI_ADAPTER}: decisionState must map unrecognised states to "unknown", not to a known neighbour (the deleted proposed-fallback defect)`,
    );
  }
  return findings;
}

export function checkDaemonProjectionFreshness(register, sourcesByFile, findings = []) {
  // Core wire vocabularies are generated from their kernel runtime authorities because
  // the thin CLI path must stay dependency-free. The ratchet rejects a stale generated region.
  const module = register.statusVocabularies.find((vocabulary) => vocabulary.id === "daemon.task.status")?.module;
  if (!module) {
    findings.push("daemon wire vocabulary daemon.task.status is not registered");
    return findings;
  }
  const source = sourcesByFile.get(module);
  if (source === undefined) {
    findings.push(`daemon wire vocabulary module ${module} was not scanned`);
    return findings;
  }
  const projectionFinding = daemonStatusVocabularyProjectionFinding(source);
  if (projectionFinding) findings.push(`${module}: ${projectionFinding}`);
  return findings;
}

async function loadModules(files) {
  const modules = new Map();
  for (const file of files) {
    try {
      modules.set(file, await import(pathToFileURL(path.resolve(file)).href));
    } catch {
      modules.set(file, null);
    }
  }
  return modules;
}

function readSources(root, scopes) {
  const sources = new Map();
  for (const rel of listWorktreeFiles(root, scopes).filter(
    (entry) =>
      /\.(?:ts|tsx|mts)$/u.test(entry) &&
      !/(?:^|\/)(?:test|tests|fixtures)\//u.test(entry) &&
      !/\.(?:test|spec|vitest)\.[cm]?tsx?$/u.test(entry),
  )) {
    sources.set(rel, readFileSync(path.join(root, rel), "utf8"));
  }
  return sources;
}

async function main() {
  const root = process.cwd();
  const register = await import(pathToFileURL(path.resolve(import.meta.dirname, REGISTER)).href);
  const sourcesByFile = readSources(root, PACKAGE_SCOPES);
  const sites = collectStatusDeclarationSites(sourcesByFile);
  const storeIndex = buildStateStoreIndex(entityKindContracts);
  const kernelModules = await loadModules([
    ...new Set(
      register.statusVocabularies
        .filter(
          (vocabulary) =>
            vocabulary.module.startsWith("packages/kernel/src/domain/") && !vocabulary.anchor.startsWith("#"),
        )
        .map((vocabulary) => vocabulary.module),
    ),
  ]);
  const findings = [
    ...checkRegisterShape(register),
    ...storeIndex.findings,
    ...checkOwnerStoreAgreement(register, storeIndex.byId),
    ...checkKernelVocabularyBijection(register, kernelModules, sites),
    ...checkStatusVocabularyCoverage(register, sites, [], { baseline: statusVocabularyBaseline }),
    ...checkRegisteredInlineAnchors(register, sourcesByFile),
    ...checkViewLocalDeclarations(register, sites, sourcesByFile),
    ...checkGuiAdapterInvariants(register, sourcesByFile),
    ...checkDaemonProjectionFreshness(register, sourcesByFile),
  ];
  if (findings.length > 0) {
    console.error("Status vocabulary check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log(
    "Status vocabulary check passed (register, all package status vocabularies, owner stores, view-local scopes, frozen baseline, generated daemon mirrors, and GUI mirrors agree).",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
