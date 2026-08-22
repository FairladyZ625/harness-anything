#!/usr/bin/env node
/**
 * GUI status-judgment ratchet.
 *
 * Authority: dec_8DCD52E98BAB268B0194B1E399 CH1-CH3. Vocabulary and GUI
 * mirror anchors come from status-vocabulary.ts; this checker owns uses of
 * those vocabularies in GUI judgment syntax, not their declarations.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { statusVocabularies, statusWordRegister } from "../packages/kernel/src/domain/status-vocabulary.ts";
import { guiStatusJudgmentBaseline } from "./gate-allowlists/gui-status-judgment-baseline.mjs";

const GUI_SOURCE = "packages/gui/src";
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
]);
const BASELINE_CLASSIFICATIONS = new Set(["domain-judgment"]);
const TRANSIENT_OPERATION_ENTITY = /(?:Receipt|Recovery|Run|Script|Adapter|Wire)$/u;
const VALIDATION_FIELD = /(?:availability|targetState|sessionBinding|witness result|migration marker)/iu;

export function scanGuiStatusJudgments(
  root = process.cwd(),
  vocabularies = statusVocabularies,
  registrations = vocabularies === statusVocabularies ? statusWordRegister : registrationsFromVocabularies(vocabularies)
) {
  const files = walk(path.join(root, GUI_SOURCE));
  if (files.length === 0) return [];
  const program = createGuiProgram(root, files);
  const checker = program.getTypeChecker();
  const vocabulary = vocabularyIndex(vocabularies, registrations);
  const sites = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const relativePath = relative(root, file);
    const mirrorSpans = mirrorDeclarationSpans(source, vocabulary.mirrorAnchors.get(relativePath) ?? []);
    const fileSites = [];
    const add = (node, kind, words, vocabularyIds, shape = "point-comparison") => {
      if (insideAnySpan(node, mirrorSpans)) return;
      const point = source.getLineAndCharacterOfPosition(node.getStart(source));
      const content = node.getText(source).replaceAll("\r\n", "\n");
      const fingerprint = createHash("sha256").update(content).digest("hex");
      fileSites.push({
        path: relativePath,
        line: point.line + 1,
        column: point.character + 1,
        kind,
        shape,
        scope: semanticScope(node, source),
        fingerprint,
        classification: shape === "complete-mirror"
          ? "registry-mirror"
          : shape === "proper-subset" || !isPureDisplayUsage(node, checker)
            ? "domain-judgment"
            : "display-only",
        words: [...new Set(words)].sort(),
        vocabularyIds: [...new Set(vocabularyIds)].sort(),
        content
      });
    };

    const visit = (node) => {
      if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
        const literal = registeredLiteralOperand(node, vocabulary.words);
        if (literal) {
          const other = node.left === literal ? node.right : node.left;
          const match = carrierMatch(checker, other, [literal.text], vocabulary);
          if (match.inScope) add(node, "comparison", [literal.text], match.vocabularyIds);
        }
      } else if (ts.isSwitchStatement(node)) {
        const words = node.caseBlock.clauses
          .filter(ts.isCaseClause)
          .map((clause) => clause.expression)
          .filter((expression) => ts.isStringLiteralLike(expression) && vocabulary.words.has(expression.text))
          .map((expression) => expression.text);
        const match = carrierMatch(checker, node.expression, words, vocabulary);
        if (words.length > 0 && match.inScope) add(node, "switch", words, match.vocabularyIds);
      } else if (ts.isArrayLiteralExpression(node)) {
        const stringLiterals = node.elements.filter(ts.isStringLiteralLike);
        const literals = stringLiterals.filter((element) => vocabulary.words.has(element.text));
        if (literals.length > 0) {
          const contextualIds = literals.flatMap((literal) => vocabularyIdsForType(checker, checker.getContextualType(literal), vocabulary.sets));
          const groupedIds = vocabularyIdsCoveringWords(literals.map((literal) => literal.text), vocabulary.sets);
          const allWordsAreEntityJudgments = literals.every((literal) => vocabulary.registrations.some((entry) => entry.word === literal.text && entry.inScope));
          if (contextualIds.length > 0 || groupedIds.length > 0 || (literals.length > 1 && allWordsAreEntityJudgments)) {
            const words = literals.map((literal) => literal.text);
            add(node, "group", words, [...contextualIds, ...groupedIds], vocabulary.completeKeys.has(wordKey(words)) ? "complete-mirror" : "proper-subset");
          }
        }
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["has", "includes"].includes(node.expression.name.text)) {
        const literal = node.arguments.find((argument) => ts.isStringLiteralLike(argument) && vocabulary.words.has(argument.text));
        if (literal) {
          const ids = vocabularyIdsForType(checker, checker.getContextualType(literal), vocabulary.sets);
          if (ids.length > 0) add(node, "membership", [literal.text], ids);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const occurrences = new Map();
    for (const site of fileSites) {
      const identity = `${site.path}::${site.scope}::${site.kind}::${site.fingerprint}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      sites.push({ ...site, key: `${identity}::${occurrence}` });
    }
  }
  return sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
}

export function checkGuiStatusJudgments(sites, baseline = guiStatusJudgmentBaseline) {
  const findings = [];
  const baselineByKey = new Map();
  for (const entry of baseline) {
    if (!entry || typeof entry.key !== "string" || !BASELINE_CLASSIFICATIONS.has(entry.classification)) {
      findings.push(`invalid baseline entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (baselineByKey.has(entry.key)) findings.push(`duplicate baseline key ${entry.key}`);
    baselineByKey.set(entry.key, entry);
  }
  const siteByKey = new Map(sites.map((site) => [site.key, site]));
  for (const site of sites) {
    const entry = baselineByKey.get(site.key);
    if (entry && entry.classification !== site.classification) {
      findings.push(`${site.key}: baseline says ${entry.classification}, structural classification is ${site.classification}`);
    }
    if (!entry && site.classification === "domain-judgment") {
      findings.push(`${site.key}: new GUI status judgment (${site.shape}; ${site.words.join(", ") || "typed status"})`);
    }
  }
  for (const entry of baseline) {
    if (typeof entry?.key === "string" && !siteByKey.has(entry.key)) {
      findings.push(`${entry.key}: stale baseline entry; remove it rather than transferring the exemption`);
    }
  }
  return findings;
}

export function baselineCounts(baseline = guiStatusJudgmentBaseline) {
  const counts = { total: baseline.length, "domain-judgment": 0 };
  for (const entry of baseline) if (BASELINE_CLASSIFICATIONS.has(entry.classification)) counts[entry.classification] += 1;
  return counts;
}

export function inventoryCounts(sites) {
  const counts = {
    total: sites.length,
    shapes: { "proper-subset": 0, "point-comparison": 0, "complete-mirror": 0 },
    classifications: { "display-only": 0, "domain-judgment": 0, "registry-mirror": 0 }
  };
  for (const site of sites) {
    counts.shapes[site.shape] += 1;
    counts.classifications[site.classification] += 1;
  }
  return counts;
}

function createGuiProgram(root, files) {
  const configPath = path.join(root, "packages/gui/tsconfig.renderer.json");
  let options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, allowJs: true, skipLibCheck: true };
  if (existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!loaded.error) {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
      options = parsed.options;
    }
  }
  return ts.createProgram({ rootNames: files, options });
}

function vocabularyIndex(vocabularies, registrations = statusWordRegister) {
  const byId = new Map(vocabularies.map((entry) => [entry.id, entry]));
  const allSets = [];
  const sets = [];
  const words = new Set(registrations.map((entry) => entry.word));
  const scopedRegistrations = registrations.map((entry) => ({
    ...entry,
    inScope: isEntityJudgmentRegistration(entry)
  }));
  const mirrorAnchors = new Map();
  for (const entry of vocabularies) {
    if (entry.mirrorOf && entry.module.startsWith(`${GUI_SOURCE}/`)) {
      const anchors = mirrorAnchors.get(entry.module) ?? [];
      anchors.push(entry.anchor);
      mirrorAnchors.set(entry.module, anchors);
    }
    const authority = entry.mirrorOf ? byId.get(entry.mirrorOf) : entry;
    if (!authority) continue;
    const normalized = [...new Set(entry.words)].sort();
    const indexed = {
      id: entry.id,
      words: new Set(normalized),
      key: wordKey(normalized),
      complete: entry.subsetOf === undefined,
      inScope: isEntityJudgmentRegistration(authority)
    };
    allSets.push(indexed);
    if (indexed.inScope) sets.push(indexed);
  }
  return {
    allSets,
    sets,
    words,
    registrations: scopedRegistrations,
    mirrorAnchors,
    completeKeys: new Set(sets.filter((entry) => entry.complete).map((entry) => entry.key))
  };
}

function registrationsFromVocabularies(vocabularies) {
  return vocabularies.flatMap((entry) => entry.words.map((word) => ({
    word,
    entity: entry.entity,
    field: entry.field
  })));
}

function isEntityJudgmentRegistration(entry) {
  // Durable entity standing and derived domain verdicts are in scope. A one-shot
  // operation/result carrier or an availability/command-shape field is not: those
  // values validate or relay an envelope rather than decide what an entity means.
  return !TRANSIENT_OPERATION_ENTITY.test(entry.entity) && !VALIDATION_FIELD.test(entry.field);
}

function carrierMatch(checker, expression, literalWords, vocabulary) {
  const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const type = declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : checker.getTypeAtLocation(expression);
  const words = literalTypeWords(checker, type);
  if (words) {
    const allExactIds = vocabularyIdsForWords(words, vocabulary.allSets);
    const ids = vocabularyIdsForWords(words, vocabulary.sets);
    if (allExactIds.length > 0) return { inScope: ids.length > 0, vocabularyIds: ids };
    if (ids.length > 0) return { inScope: true, vocabularyIds: ids };
    if ([...words].every((word) => vocabulary.words.has(word))) {
      const coveringIds = vocabularyIdsCoveringWords([...words], vocabulary.sets);
      const allCoveringIds = vocabularyIdsCoveringWords([...words], vocabulary.allSets);
      if (allCoveringIds.length > 0) return { inScope: coveringIds.length > 0, vocabularyIds: coveringIds };
    }
    return { inScope: false, vocabularyIds: [] };
  }
  if (!containsBroadString(type)) return { inScope: false, vocabularyIds: [] };
  const fieldTerms = new Set(vocabulary.registrations
    .filter((entry) => entry.inScope && literalWords.includes(entry.word))
    .map((entry) => fieldTerm(entry.field))
    .filter(Boolean));
  return {
    inScope: statusLikeCarrierName(expression, fieldTerms),
    vocabularyIds: vocabularyIdsCoveringWords(literalWords, vocabulary.sets)
  };
}

function containsBroadString(type) {
  if (!type) return false;
  if ((type.flags & ts.TypeFlags.String) !== 0) return true;
  if (type.isUnion()) return type.types.some(containsBroadString);
  return false;
}

function vocabularyIdsForType(checker, type, sets) {
  const words = literalTypeWords(checker, type);
  return words ? vocabularyIdsForWords(words, sets) : [];
}

function vocabularyIdsForWords(words, sets) {
  const key = wordKey(words);
  return sets.filter((entry) => entry.key === key).map((entry) => entry.id);
}

function literalTypeWords(checker, type) {
  if (!type) return null;
  if (type.isStringLiteral()) return new Set([type.value]);
  if (type.isUnion()) {
    const words = new Set();
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) continue;
      const nested = literalTypeWords(checker, member);
      if (!nested) return null;
      for (const word of nested) words.add(word);
    }
    return words.size > 0 ? words : null;
  }
  const apparent = checker.getApparentType(type);
  return apparent !== type ? literalTypeWords(checker, apparent) : null;
}

function vocabularyIdsCoveringWords(words, sets) {
  const unique = new Set(words);
  return sets.filter((entry) => [...unique].every((word) => entry.words.has(word))).map((entry) => entry.id);
}

function statusLikeCarrierName(expression, fieldTerms) {
  const raw = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : "";
  const name = raw.toLowerCase();
  return [...fieldTerms].some((term) => name.endsWith(term) || name.endsWith(`${term}s`) || (term === "status" && name.endsWith("statuses")));
}

function fieldTerm(field) {
  return field.match(/[A-Za-z]+/gu)?.at(-1)?.toLowerCase() ?? "";
}

function registeredLiteralOperand(node, words) {
  if (ts.isStringLiteralLike(node.left) && words.has(node.left.text)) return node.left;
  if (ts.isStringLiteralLike(node.right) && words.has(node.right.text)) return node.right;
  return null;
}

function isPureDisplayUsage(node, checker) {
  for (let current = node; current; current = current.parent) {
    if (ts.isJsxExpression(current)) {
      if (ts.isJsxAttribute(current.parent) && /^(?:aria-|className$|style$|title$)/u.test(current.parent.name.getText())) return true;
      if (current.expression && containsOnlyNonInteractiveIntrinsicJsx(current.expression)) return true;
      break;
    }
    if (ts.isFunctionLike(current)) {
      const signature = checker.getSignatureFromDeclaration(current);
      if (signature && checker.typeToString(checker.getReturnTypeOfSignature(signature)) === "string") return true;
      break;
    }
  }
  return false;
}

function containsOnlyNonInteractiveIntrinsicJsx(node) {
  let sawIntrinsic = false;
  let disallowed = false;
  const visit = (current) => {
    if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
      const tag = current.tagName.getText();
      if (!/^[a-z]/u.test(tag) || current.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && /^on[A-Z]/u.test(attribute.name.getText()))) disallowed = true;
      else sawIntrinsic = true;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return sawIntrinsic && !disallowed;
}

function mirrorDeclarationSpans(source, anchors) {
  const wanted = new Set(anchors);
  const spans = [];
  const visit = (node) => {
    if ((ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && wanted.has(node.name.text)) {
      spans.push([node.getStart(source), node.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return spans;
}

function semanticScope(node, source) {
  const segments = [];
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isClassDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) {
      const name = stableName(current.name, source);
      if (name) segments.unshift(name);
    }
  }
  return segments.join(".") || "<module>";
}

function stableName(name, source) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(source).replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function wordKey(words) { return [...new Set(words)].sort().join("\0"); }

function insideAnySpan(node, spans) { return spans.some(([start, end]) => node.getStart() >= start && node.getEnd() <= end); }
function relative(root, file) { return path.relative(root, file).split(path.sep).join("/"); }
function walk(directory) { const files = []; let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return files; throw error; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const full = path.join(directory, entry.name); if (entry.isDirectory()) { if (!["dist", "node_modules", "out"].includes(entry.name)) files.push(...walk(full)); } else if (SOURCE_FILE.test(entry.name)) files.push(full); } return files; }

function printBaseline(sites) {
  console.log("export const guiStatusJudgmentBaseline = Object.freeze([");
  for (const site of sites.filter((entry) => entry.classification === "domain-judgment")) console.log(`  { key: ${JSON.stringify(site.key)}, classification: "domain-judgment" }, // ${site.shape}: ${site.words.join(", ")} @ ${site.scope}`);
  console.log("]);");
}

function printInventory(sites) {
  for (const site of sites) console.log(`${site.path}:${site.line}:${site.column} [${site.shape}/${site.classification}] ${site.words.join(", ")} @ ${site.scope}`);
}

async function main() {
  const sites = scanGuiStatusJudgments();
  if (process.argv.includes("--print-baseline")) { printBaseline(sites); return; }
  if (process.argv.includes("--print-inventory")) { printInventory(sites); return; }
  if (process.argv.includes("--report")) {
    console.log(JSON.stringify({ inventory: inventoryCounts(sites), baseline: baselineCounts() }, null, 2));
    return;
  }
  const findings = checkGuiStatusJudgments(sites);
  if (findings.length > 0) {
    console.error("GUI status judgment check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const baseline = baselineCounts();
  const inventory = inventoryCounts(sites);
  console.log(`GUI status judgment check passed (${baseline.total} frozen domain judgments; ${inventory.shapes["proper-subset"]} proper subsets, ${inventory.shapes["point-comparison"]} point comparisons, ${inventory.shapes["complete-mirror"]} complete mirrors).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
