#!/usr/bin/env node
/**
 * G-IRONLAW4 status-word ratchet gate (blueprint 铁律四 · slice 5).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1 (add ratchet gates only —
 * existing words are grandfathered through the register, new unregistered ones
 * are refused).
 *
 * The gate judges real declarations, not prose:
 *   1. The register (packages/kernel/src/domain/status-vocabulary.ts) is
 *      well-formed: every row carries a meaning, divergent words carry a
 *      resolution, subsets stay inside their parent, mirrors match their source.
 *   2. Every kernel-domain status vocabulary bound to a runtime export equals the
 *      register exactly — the register and the kernel cannot drift apart.
 *   3. Every status-vocabulary declaration in packages/kernel/src/domain (named
 *      const arrays, literal-union type aliases, inline status-field unions) is
 *      registered with the same words — a new status word cannot appear
 *      unregistered, and a registered entry cannot go stale.
 *   4. The GUI model mirrors equal their kernel vocabularies (plus the explicit
 *      `unknown` where the GUI convention adds it), and the unknown fallback
 *      stays deleted: unrecognised decision states map to "unknown", never to a
 *      plausible neighbour.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REGISTER = "../packages/kernel/src/domain/status-vocabulary.ts";
const KERNEL_DOMAIN = "packages/kernel/src/domain";
const GUI_MODEL = "packages/gui/src/renderer/model/types.ts";
const GUI_ADAPTER = "packages/gui/src/renderer/triadic-data.ts";
const DAEMON_PROTOCOL = "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts";
const DAEMON_MIRROR_CONST = /(?:Status|State|Phase|Disposition|Verdict|Outcome)Words$/u;
const LOCAL_MIRROR_CONST = /const\s+([A-Za-z_][A-Za-z0-9_]*Words)\s*(?::[^=\n]+)?=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]\s*as\s+const/gu;
export const KERNEL_DECLARATION_SUFFIX = /(?:Statuses|Status|States|State|Phases|Phase|Dispositions|Disposition|Verdicts|Verdict|Outcomes|Outcome|Liveness|Readinesses)$/u;
const STATUS_FIELD = /(?:status|state|phase|disposition|verdict|outcome|liveness)$/iu;
const NAMED_CONST = /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]\s*as\s+const/gu;
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
const NAMED_TYPE = /export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\|?\s*("(?:[^"]*)"(?:\s*\|\s*"[^"]*")*)\s*;/gu;
const INLINE_FIELD = /readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:\s*("[^"]+"(?:\s*\|\s*"[^"]+")+)/gu;
const KERNEL_DECISION_FALLBACK = /function\s+decisionState\s*\([^)]*\)[^}]*return\s+"(?!unknown)[a-z_]+"/u;

function literalWords(fragment) {
  return [...fragment.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function sameWords(left, right) {
  return left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0");
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
    if (!Array.isArray(vocabulary.words) || vocabulary.words.length === 0 || vocabulary.words.some((word) => typeof word !== "string" || word.trim() === "")) {
      findings.push(`${vocabulary.id}: words must be a non-empty array of non-empty strings`);
    }
    const anchorKey = `${vocabulary.module}#${vocabulary.anchor}`;
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
        findings.push(`${vocabulary.id}: mirror words [${vocabulary.words}] must equal ${vocabulary.mirrorOf} plus [${vocabulary.plusWords ?? []}]`);
      }
    }
  }
  const wordKeys = new Set();
  for (const row of statusWordRegister) {
    for (const field of ["word", "entity", "field", "meaning"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        findings.push(`statusWordRegister: ${field} must be a non-empty string (row ${row.word ?? "?"} on ${row.entity ?? "?"})`);
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
    // Mirrors reuse the mirrored vocabulary's words; their meanings are registered on
    // the source entity, so mirror words do not need their own GuiAdapter rows.
    if (vocabulary.mirrorOf !== undefined) continue;
    for (const word of vocabulary.words) {
      const covered = statusWordRegister.some((row) => row.word === word && row.entity === vocabulary.entity && row.field === vocabulary.field);
      if (!covered) findings.push(`${vocabulary.id}: word "${word}" has no register row for ${vocabulary.entity}.${vocabulary.field}`);
    }
  }
  if (statusVocabularies.length === 0) findings.push("statusVocabularies: register is empty");
  return findings;
}

export function checkKernelVocabularyBijection(register, modulesByFile, sites, findings = []) {
  for (const vocabulary of register.statusVocabularies) {
    if (!vocabulary.module.startsWith(`${KERNEL_DOMAIN}/`) || vocabulary.anchor.startsWith("#")) continue;
    // Only runtime const vocabularies have an export to bijection-check; literal-union
    // type aliases are text-checked by the coverage scan.
    const site = sites.find((candidate) => candidate.module === vocabulary.module && candidate.anchor === vocabulary.anchor);
    if (site?.kind !== "const") continue;
    const module = modulesByFile.get(vocabulary.module);
    if (!module) {
      findings.push(`${vocabulary.id}: cannot import ${vocabulary.module}`);
      continue;
    }
    const exported = module[vocabulary.anchor];
    if (!Array.isArray(exported)) {
      findings.push(`${vocabulary.id}: ${vocabulary.module} does not export a runtime array named ${vocabulary.anchor}`);
      continue;
    }
    if (!sameWords(exported, vocabulary.words)) {
      findings.push(`${vocabulary.id}: kernel export ${vocabulary.anchor} is [${exported}] but the register says [${vocabulary.words}]`);
    }
  }
  return findings;
}

export function collectKernelDeclarationSites(sourcesByFile) {
  const sites = [];
  for (const [module, text] of sourcesByFile) {
    for (const match of text.matchAll(NAMED_CONST)) {
      if (!KERNEL_DECLARATION_SUFFIX.test(match[1])) continue;
      const words = literalWords(match[2]);
      if (words.length > 0) sites.push({ module, anchor: match[1], kind: "const", words });
    }
    for (const match of text.matchAll(NAMED_TYPE)) {
      if (!KERNEL_DECLARATION_SUFFIX.test(match[1])) continue;
      sites.push({ module, anchor: match[1], kind: "type", words: literalWords(match[1 + 1]) });
    }
    for (const match of text.matchAll(INLINE_FIELD)) {
      if (!STATUS_FIELD.test(match[1])) continue;
      const words = literalWords(match[2]);
      if (words.length < 2) continue;
      sites.push({ module, anchor: `#${match[1]}`, kind: "field", words });
    }
  }
  return sites;
}

export function checkKernelDeclarationCoverage(register, sites, findings = []) {
  const registered = register.statusVocabularies.filter((vocabulary) => vocabulary.module.startsWith(`${KERNEL_DOMAIN}/`));
  for (const site of sites) {
    const match = registered.find((vocabulary) => vocabulary.module === site.module && vocabulary.anchor === site.anchor && sameWords(vocabulary.words, site.words));
    if (!match) {
      const anchorRegistered = registered.find((vocabulary) => vocabulary.module === site.module && vocabulary.anchor === site.anchor);
      findings.push(anchorRegistered
        ? `${site.module}#${site.anchor}: declared words [${site.words}] drift from the register [${anchorRegistered.words}]`
        : `${site.module}#${site.anchor}: unregistered status vocabulary [${site.words}] — register it in status-vocabulary.ts (blueprint 铁律四)`);
    }
  }
  for (const vocabulary of registered) {
    const site = sites.find((candidate) => candidate.module === vocabulary.module && candidate.anchor === vocabulary.anchor);
    if (!site) findings.push(`${vocabulary.id}: registered anchor ${vocabulary.module}#${vocabulary.anchor} no longer exists`);
    else if (!sameWords(site.words, vocabulary.words)) {
      findings.push(`${vocabulary.id}: declaration at ${vocabulary.module}#${vocabulary.anchor} is [${site.words}] but the register says [${vocabulary.words}]`);
    }
  }
  return findings;
}

function parseTypeUnion(text, name) {
  const match = new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([\\s\\S]*?);`, "u").exec(text);
  if (!match) return null;
  const body = match[1];
  const words = literalWords(body);
  const remainder = body.replace(/"[^"]*"/gu, "");
  const pureUnion = words.length > 0 && /^[\s|]*$/u.test(remainder);
  return pureUnion ? words : null;
}

export function checkGuiMirrorAgreement(register, guiModelText, guiAdapterText, findings = []) {
  const byAnchor = new Map(register.statusVocabularies.filter((vocabulary) => vocabulary.module === GUI_MODEL).map((vocabulary) => [vocabulary.anchor, vocabulary]));
  for (const [anchor, vocabulary] of byAnchor) {
    const words = parseTypeUnion(guiModelText, anchor);
    if (words === null) {
      findings.push(`GUI mirror ${anchor} (${GUI_MODEL}) must be a literal string union`);
      continue;
    }
    if (!sameWords(words, vocabulary.words)) {
      findings.push(`GUI mirror ${anchor} is [${words}] but the register says [${vocabulary.words}]`);
    }
  }
  const boardColumns = /export\s+const\s+BOARD_COLUMNS[^=]*=\s*\[([^\]]*)\]/u.exec(guiModelText);
  const snapshot = byAnchor.get("SnapshotStatus");
  if (boardColumns && snapshot) {
    const columns = literalWords(boardColumns[1]);
    if (!sameWords(columns, snapshot.words)) {
      findings.push(`BOARD_COLUMNS [${columns}] must cover exactly the SnapshotStatus vocabulary [${snapshot.words}]`);
    }
  } else if (!boardColumns) {
    findings.push("BOARD_COLUMNS declaration not found in the GUI model");
  }
  if (KERNEL_DECISION_FALLBACK.test(guiAdapterText)) {
    findings.push(`${GUI_ADAPTER}: decisionState must map unrecognised states to "unknown", not to a known neighbour (the deleted proposed-fallback defect)`);
  }
  return findings;
}

export function checkDaemonMirrorAgreement(register, daemonText, findings = []) {
  // The daemon vocabulary module is imported by the wire contract on the CLI's eager
  // startup path, so it carries plain-data mirrors. This check makes those mirrors
  // ratchet-locked to the register instead of being free-floating hand copies.
  const registered = register.statusVocabularies.filter((vocabulary) => vocabulary.module === DAEMON_PROTOCOL);
  const declared = [...daemonText.matchAll(LOCAL_MIRROR_CONST)]
    .map((match) => ({ anchor: match[1], words: literalWords(match[2]) }))
    .filter((entry) => DAEMON_MIRROR_CONST.test(entry.anchor));
  for (const entry of declared) {
    const match = registered.find((vocabulary) => vocabulary.anchor === entry.anchor && sameWords(vocabulary.words, entry.words));
    if (!match) {
      const anchorRegistered = registered.find((vocabulary) => vocabulary.anchor === entry.anchor);
      findings.push(anchorRegistered
        ? `${DAEMON_PROTOCOL}#${entry.anchor}: mirrored words [${entry.words}] drift from the register [${anchorRegistered.words}]`
        : `${DAEMON_PROTOCOL}#${entry.anchor}: unregistered status-word mirror [${entry.words}] — register it in status-vocabulary.ts (blueprint 铁律四)`);
    }
  }
  for (const vocabulary of registered) {
    if (!declared.some((entry) => entry.anchor === vocabulary.anchor)) {
      findings.push(`${vocabulary.id}: registered mirror ${DAEMON_PROTOCOL}#${vocabulary.anchor} no longer exists`);
    }
  }
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

function readKernelDomainSources(root) {
  const dir = path.join(root, KERNEL_DOMAIN);
  const sources = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ts$/u.test(entry.name)) continue;
    const rel = `${KERNEL_DOMAIN}/${entry.name}`;
    sources.set(rel, readFileSync(path.join(dir, entry.name), "utf8"));
  }
  return sources;
}

async function main() {
  const root = process.cwd();
  const register = await import(pathToFileURL(path.resolve(import.meta.dirname, REGISTER)).href);
  const kernelSources = readKernelDomainSources(root);
  const sites = collectKernelDeclarationSites(kernelSources);
  const kernelModules = await loadModules([...new Set(register.statusVocabularies
    .filter((vocabulary) => vocabulary.module.startsWith(`${KERNEL_DOMAIN}/`) && !vocabulary.anchor.startsWith("#"))
    .map((vocabulary) => vocabulary.module))]);
  const guiModelText = readFileSync(path.join(root, GUI_MODEL), "utf8");
  const guiAdapterText = readFileSync(path.join(root, GUI_ADAPTER), "utf8");
  const daemonText = readFileSync(path.join(root, DAEMON_PROTOCOL), "utf8");
  const findings = [
    ...checkRegisterShape(register),
    ...checkKernelVocabularyBijection(register, kernelModules, sites),
    ...checkKernelDeclarationCoverage(register, sites),
    ...checkGuiMirrorAgreement(register, guiModelText, guiAdapterText),
    ...checkDaemonMirrorAgreement(register, daemonText)
  ];
  if (findings.length > 0) {
    console.error("Status vocabulary check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log("Status vocabulary check passed (register, kernel vocabularies, and GUI mirrors agree; unknown stays unknown).");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
