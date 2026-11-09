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
import {
  statusVocabularyBaseline,
  statusVocabularyUnownedRegister,
} from "./gate-allowlists/status-vocabulary-baseline.mjs";
import { entityKindContracts } from "../packages/kernel/src/domain/entity-kind-registry.ts";
import { listWorktreeFiles } from "./gates/git.mjs";

const REGISTER = "../packages/kernel/src/domain/status-vocabulary.ts";
const PACKAGE_SCOPES = ["packages"];
const GUI_ADAPTER = "packages/gui/src/renderer/triadic-data.ts";
const STATUS_WORDS_SUFFIX = /(?:Status|State|Phase|Disposition|Verdict|Outcome|Liveness)Words$/u;
const LOCAL_MIRROR_CONST =
  /(export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]\s*as\s+const/gu;
export const STATUS_DECLARATION_SUFFIX =
  /(?:Statuses|Status|States|State|Phases|Phase|Dispositions|Disposition|Verdicts|Verdict|Outcomes|Outcome|Liveness|Readinesses|Readiness|Freshnesses|Freshness|Availabilities|Availability)$/u;
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
const STRING_LITERAL = String.raw`(?:"[^"]*"|'[^']*')`;
const NAMED_TYPE = new RegExp(
  String.raw`(export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\|?\s*(${STRING_LITERAL}(?:\s*\|\s*${STRING_LITERAL})*)\s*;`,
  "gu",
);
const INLINE_FIELD = new RegExp(
  String.raw`readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:\s*(${STRING_LITERAL}(?:\s*\|\s*${STRING_LITERAL})+)`,
  "gu",
);
const STATUS_FIELD = /(?:status|state|phase|disposition|verdict|outcome|liveness)$/iu;
const INLINE_CONTAINER = /(?:export\s+)?(?:default\s+)?(?:interface|type|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
const EXPORTED_ALIAS = /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/gu;
const EXPORT_SPECIFIERS = /(?:^|\n)\s*export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?\s*;?/gu;
const FS_IMPORT = /(?:^|\n)\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']((?:node:)?fs(?:\/promises)?)["']/gu;
const KERNEL_DECISION_FALLBACK = /function\s+decisionState\s*\([^)]*\)[^}]*return\s+"(?!unknown)[a-z_]+"/u;
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gu;
// S1/S2 signals from the residue design: a file holding a persistent write cannot
// also declare a view-local vocabulary.
const PERSISTENT_WRITE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|createWriteStream)\s*\(|\bnew\s+DatabaseSync\s*\(|\bCREATE\s+(?:VIRTUAL\s+)?TABLE\b/u;

function literalWords(fragment) {
  return [...fragment.matchAll(/"([^"]+)"|'([^']+)'/gu)].map((match) => match[1] ?? match[2]);
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

/**
 * Every status vocabulary declared outside the kernel domain must pick exactly one
 * ownership form. Rows that predate this slice are frozen in
 * statusVocabularyUnownedRegister; owning one later makes its entry stale.
 */
export function checkExternalOwnership(register, unownedBaseline = [], findings = []) {
  const baselineById = new Map();
  for (const entry of unownedBaseline) {
    if (typeof entry.id !== "string" || !Array.isArray(entry.words)) {
      findings.push(`unowned-register baseline entry ${entry.id ?? "?"} must carry an id and frozen words`);
      continue;
    }
    if (baselineById.has(entry.id)) findings.push(`duplicate unowned-register baseline entry ${entry.id}`);
    baselineById.set(entry.id, entry);
  }
  for (const vocabulary of register.statusVocabularies) {
    if (vocabulary.module.startsWith("packages/kernel/src/domain/")) continue;
    const forms = [vocabulary.mirrorOf, vocabulary.ownerStore, vocabulary.scope].filter((value) => value !== undefined);
    const frozen = baselineById.get(vocabulary.id);
    if (forms.length === 1) {
      if (frozen)
        findings.push(`${vocabulary.id}: external vocabulary is now owned — delete the unowned-register entry`);
      continue;
    }
    if (!frozen) {
      findings.push(
        `${vocabulary.id}: external status vocabulary must declare mirrorOf, ownerStore, or scope: "view-local" (dec_499E4E98A3D4754132B3BCA1E6 CH1)`,
      );
      continue;
    }
    if (!sameWords(frozen.words, vocabulary.words)) {
      findings.push(
        `${vocabulary.id}: words [${vocabulary.words}] drifted from the unowned-register baseline [${frozen.words}]`,
      );
    }
  }
  const ids = new Set(register.statusVocabularies.map((vocabulary) => vocabulary.id));
  for (const id of baselineById.keys()) {
    if (!ids.has(id)) findings.push(`stale unowned-register baseline entry ${id} — the vocabulary no longer exists`);
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
 * Inline `readonly field: "a" | "b"` unions keep the pre-existing kernel/authored-
 * document coverage: each one carries its enclosing named declaration so two
 * `#status` fields in one module stay distinct baseline identities.
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
    for (const match of text.matchAll(EXPORTED_ALIAS)) {
      if (!STATUS_WORDS_SUFFIX.test(match[1])) continue;
      sites.push({ module, anchor: match[1], kind: "alias", target: match[2] });
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
    const declarations = [...text.matchAll(INLINE_CONTAINER)].map((match) => ({
      name: match[1],
      index: match.index ?? 0,
    }));
    for (const match of text.matchAll(INLINE_FIELD)) {
      if (!STATUS_FIELD.test(match[1])) continue;
      const words = literalWords(match[0]);
      if (words.length < 2) continue;
      const container =
        declarations.filter((declaration) => declaration.index < (match.index ?? 0)).at(-1)?.name ?? "?";
      sites.push({
        module,
        anchor: `#${match[1]}`,
        container,
        kind: "field",
        words,
      });
    }
  }
  return sites;
}

function inlineSiteKey(site) {
  return `${site.module}##${site.container}.${site.anchor.slice(1)}`;
}

function registeredInlineMatch(register, site) {
  return register.statusVocabularies.find(
    (vocabulary) =>
      vocabulary.anchor.startsWith("#") &&
      vocabulary.module === site.module &&
      vocabulary.anchor === site.anchor &&
      sameWords(vocabulary.words, site.words),
  );
}

/**
 * Inline field coverage. A site is owned when a registered inline anchor in the
 * same module/field declares exactly its words; otherwise it needs a frozen
 * baseline entry keyed by module + enclosing declaration + field. A registered
 * inline anchor that no longer has its declaration is refused.
 */
export function checkInlineFieldCoverage(register, sites, findings = [], { baseline = [] } = {}) {
  const inlineSites = sites.filter((site) => site.kind === "field");
  const inlineBaseline = baseline.filter((entry) => entry.inline === true);
  const frozen = new Map();
  for (const entry of inlineBaseline) {
    if (typeof entry.key !== "string" || !Array.isArray(entry.words)) {
      findings.push(`inline status-vocabulary baseline entry ${entry.key ?? "?"} must carry a key and frozen words`);
      continue;
    }
    const pair = `${entry.key}|${[...entry.words].sort().join("\0")}`;
    if (frozen.has(pair)) findings.push(`duplicate inline status-vocabulary baseline entry ${entry.key}`);
    frozen.set(pair, entry);
  }
  const matchedBaseline = new Set();
  for (const site of inlineSites) {
    if (registeredInlineMatch(register, site)) continue;
    const key = inlineSiteKey(site);
    const pair = `${key}|${[...site.words].sort().join("\0")}`;
    if (frozen.has(pair)) {
      matchedBaseline.add(pair);
      continue;
    }
    findings.push(
      `${key}: unregistered inline status vocabulary [${site.words}] — register it in status-vocabulary.ts (blueprint 铁律四)`,
    );
  }
  for (const vocabulary of register.statusVocabularies) {
    if (!vocabulary.anchor.startsWith("#")) continue;
    const hasSite = inlineSites.some(
      (site) =>
        site.module === vocabulary.module &&
        site.anchor === vocabulary.anchor &&
        sameWords(site.words, vocabulary.words),
    );
    if (!hasSite) {
      findings.push(
        `${vocabulary.id}: registered inline anchor ${declarationKey(vocabulary.module, vocabulary.anchor)} no longer declares [${vocabulary.words}]`,
      );
    }
  }
  for (const entry of frozen.values()) {
    const site = inlineSites.find(
      (candidate) => inlineSiteKey(candidate) === entry.key && sameWords(candidate.words, entry.words),
    );
    if (!site) {
      findings.push(`stale inline status-vocabulary baseline entry ${entry.key} (${entry.words})`);
    } else if (registeredInlineMatch(register, site)) {
      findings.push(
        `inline status-vocabulary baseline entry ${entry.key} is now registered — delete the baseline entry`,
      );
    }
  }
  return findings;
}

function aliasSiteWords(site, register, findings) {
  if (site.kind !== "alias") return site.words;
  const candidates = register.statusVocabularies.filter((vocabulary) => vocabulary.anchor === site.target);
  if (candidates.length === 1) return candidates[0].words;
  findings.push(
    `${declarationKey(site.module, site.anchor)}: status-word alias target "${site.target}" has no unique registered vocabulary (found ${candidates.length})`,
  );
  return null;
}

export function checkStatusVocabularyCoverage(register, sites, findings = [], { baseline = [] } = {}) {
  const registeredByKey = new Map(
    register.statusVocabularies.map((vocabulary) => [declarationKey(vocabulary.module, vocabulary.anchor), vocabulary]),
  );
  const siteByKey = new Map();
  for (const site of sites) {
    if (site.kind === "field") continue;
    const key = declarationKey(site.module, site.anchor);
    if (siteByKey.has(key)) findings.push(`duplicate status declaration ${key}`);
    siteByKey.set(key, site);
  }
  const baselineByKey = new Map();
  for (const entry of baseline) {
    if (entry.inline === true) continue;
    if (typeof entry.key !== "string" || !Array.isArray(entry.words)) {
      findings.push(`status-vocabulary baseline entry ${entry.key ?? "?"} must carry a key and frozen words`);
      continue;
    }
    if (baselineByKey.has(entry.key)) findings.push(`duplicate status-vocabulary baseline entry ${entry.key}`);
    baselineByKey.set(entry.key, entry);
  }

  for (const [key, site] of siteByKey) {
    const words = aliasSiteWords(site, register, findings);
    if (words === null) continue;
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
    // Inline anchors are owned by checkInlineFieldCoverage; aliases are resolved above.
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

function specifierBindings(bindingText) {
  const braced = /\{([\s\S]*?)\}/u.exec(bindingText.replace(/^type\s+/u, ""));
  const source = braced ? braced[1] : bindingText;
  return source
    .split(",")
    .map((part) => {
      const cleaned = part.trim().replace(/^type\s+/u, "");
      if (!cleaned) return null;
      const [original, alias] = cleaned.split(/\s+as\s+/u);
      return { original: original.trim(), alias: (alias ?? original).trim() };
    })
    .filter(Boolean);
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    .replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

/**
 * Parse the re-export graph every view-local check consumes, once per scan instead
 * of once per vocabulary: `checkViewLocalDeclarations` used to re-read every
 * package source for each registered view-local row, which made the gate and its
 * positive-control test O(view-local rows × repository).
 *
 * `localAliases` maps a module to its `export { Phase as Alias }` bindings; the
 * `reexports` list holds `export { X } from "./y"` edges in source order.
 */
function buildReexportIndex(sourcesByFile) {
  const localAliases = new Map();
  const reexports = [];
  for (const [file, text] of sourcesByFile) {
    for (const match of text.matchAll(EXPORT_SPECIFIERS)) {
      const bindings = specifierBindings(match[1]);
      if (match[2] === undefined) {
        const aliases = localAliases.get(file) ?? [];
        for (const binding of bindings) aliases.push(binding);
        localAliases.set(file, aliases);
        continue;
      }
      const target = resolveSpecifier(file, match[2]);
      if (target === null) continue;
      for (const binding of bindings) reexports.push({ file, target, ...binding });
    }
  }
  return { localAliases, reexports };
}

function moduleBasename(module) {
  return path.posix.basename(module);
}

/**
 * Names under which `anchor` leaves its declaring module: the declaration itself,
 * local `export { Phase as Alias }`, and transitive re-export chains. The result
 * maps module -> exported alias set.
 *
 * `reexportIndex` lets a caller that checks several anchors share one parse of the
 * scanned sources; without it the graph is built for this call only.
 */
export function anchorExportNames(
  module,
  anchor,
  sourcesByFile,
  { declaredExported = false, reexportIndex = undefined } = {},
) {
  const names = new Map();
  const strip = (value) => value.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
  const add = (target, name) => {
    if (!name) return;
    const moduleName = strip(target);
    if (!names.has(moduleName)) names.set(moduleName, new Set());
    names.get(moduleName).add(name);
  };
  if (declaredExported) add(module, anchor);
  const index = reexportIndex ?? buildReexportIndex(sourcesByFile);
  for (const binding of index.localAliases.get(module) ?? []) {
    if (binding.original === anchor) add(module, binding.alias);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const reexport of index.reexports) {
      if (!names.get(reexport.target)?.has(reexport.original)) continue;
      const before = names.get(reexport.file)?.size ?? 0;
      add(reexport.file, reexport.alias);
      if ((names.get(reexport.file)?.size ?? 0) !== before) changed = true;
    }
  }
  return names;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function isAnchorImportedElsewhere(module, anchor, sourcesByFile, options = {}) {
  const source = sourcesByFile.get(module) ?? "";
  const declaredExported =
    options.declaredExported === true ||
    new RegExp(`export\\s+(?:type\\s+|interface\\s+|const\\s+|class\\s+)?${escapeRegExp(anchor)}\\b`, "u").test(source);
  const index = options.reexportIndex ?? buildReexportIndex(sourcesByFile);
  const exported =
    options.exported ?? anchorExportNames(module, anchor, sourcesByFile, { declaredExported, reexportIndex: index });
  // A relative specifier that resolves to one of these modules must spell that
  // module's basename, so a file that mentions none of them cannot import the
  // anchor. The prefilter only skips files the import parse below could not match.
  const basenames = [...new Set([...exported.keys()].map(moduleBasename))];
  for (const [file, text] of sourcesByFile) {
    if (file === module) continue;
    if (!basenames.some((basename) => text.includes(basename))) continue;
    for (const match of text.matchAll(IMPORT_FROM)) {
      const target = resolveSpecifier(file, match[2]);
      if (target === null) continue;
      const names = exported.get(target);
      if (!names) continue;
      if (specifierBindings(match[1]).some((binding) => names.has(binding.alias))) return true;
    }
  }
  return false;
}

const FS_WRITE_APIS = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "rename",
  "renameSync",
  "writeFile",
  "writeFileSync",
]);

export function hasPersistentWrite(source) {
  if (PERSISTENT_WRITE.test(source)) return true;
  for (const match of source.matchAll(FS_IMPORT)) {
    for (const binding of specifierBindings(match[1])) {
      if (!FS_WRITE_APIS.has(binding.original)) continue;
      if (new RegExp(`\\b${binding.alias}\\s*\\(`, "u").test(source)) return true;
    }
  }
  return false;
}

export function checkViewLocalDeclarations(register, sites, sourcesByFile, findings = []) {
  const siteByKey = new Map(sites.map((site) => [declarationKey(site.module, site.anchor), site]));
  // One re-export parse for every view-local row; the previous shape rebuilt it per
  // row and then rebuilt it again inside isAnchorImportedElsewhere.
  const reexportIndex = buildReexportIndex(sourcesByFile);
  for (const vocabulary of register.statusVocabularies) {
    if (vocabulary.scope !== "view-local") continue;
    const key = declarationKey(vocabulary.module, vocabulary.anchor);
    const site = siteByKey.get(key);
    if (!site) continue;
    const declaredExported = site.exported === true;
    const exportedNames = anchorExportNames(vocabulary.module, vocabulary.anchor, sourcesByFile, {
      declaredExported,
      reexportIndex,
    });
    if (exportedNames.size > 0) {
      findings.push(`${key}: view-local vocabulary must not be exported (directly or through an alias)`);
    } else if (
      isAnchorImportedElsewhere(vocabulary.module, vocabulary.anchor, sourcesByFile, {
        declaredExported,
        reexportIndex,
        exported: exportedNames,
      })
    ) {
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

/**
 * Every judgment the gate makes, assembled once. `main` and the positive-control
 * test call this same function, so a check dropped from the gate's wiring fails the
 * test instead of passing both places silently.
 */
export function collectStatusVocabularyFindings({ register, sourcesByFile, sites, storeIndex, kernelModules }) {
  return [
    ...checkRegisterShape(register),
    ...storeIndex.findings,
    ...checkOwnerStoreAgreement(register, storeIndex.byId),
    ...checkExternalOwnership(register, statusVocabularyUnownedRegister),
    ...checkKernelVocabularyBijection(register, kernelModules, sites),
    ...checkStatusVocabularyCoverage(register, sites, [], { baseline: statusVocabularyBaseline }),
    ...checkInlineFieldCoverage(register, sites, [], { baseline: statusVocabularyBaseline }),
    ...checkViewLocalDeclarations(register, sites, sourcesByFile),
    ...checkGuiAdapterInvariants(register, sourcesByFile),
    ...checkDaemonProjectionFreshness(register, sourcesByFile),
  ];
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
  const findings = collectStatusVocabularyFindings({ register, sourcesByFile, sites, storeIndex, kernelModules });
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
