import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fleetForwardingBoundaryBaseline } from "../gate-allowlists/fleet-forwarding-boundary-baseline.mjs";

const FLEET_ROOT = "packages/daemon/src/fleet";
const FORWARDING_ROOTS = Object.freeze(["packages/cli/src/daemon", "packages/daemon/src"]);
const FORWARDING_BOUNDARY_SOURCES = new Set([
  "packages/cli/src/daemon/fleet-payload-serializer.ts",
  "packages/cli/src/daemon/forwarding-port.ts",
  "packages/daemon/src/fleet/forwarding-port.ts",
]);

function portablePath(relative) {
  return relative.split(path.sep).join("/");
}

function collectTypeScriptSources(rootDir, relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  const sources = [];
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relative = portablePath(path.join(relativeRoot, entry.name));
    if (entry.isDirectory()) sources.push(...collectTypeScriptSources(rootDir, relative));
    else if (entry.isFile() && entry.name.endsWith(".ts")) sources.push(relative);
  }
  return sources;
}

export function fleetSources(rootDir) {
  return collectTypeScriptSources(rootDir, FLEET_ROOT).concat("packages/daemon/src/daemon-host-repository-api.ts");
}

export function forwardingSources(rootDir) {
  return [...new Set(FORWARDING_ROOTS.flatMap((root) => collectTypeScriptSources(rootDir, root)))].filter(
    (relative) => !FORWARDING_BOUNDARY_SOURCES.has(relative),
  );
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function collectSocketAliases(source) {
  const aliases = new Set(["socket"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:as\s+[A-Za-z_$][\w$<>.[\]| ]*)?;/gu,
    )) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return aliases;
}

function collectStringifyAliases(source, wrappers) {
  const aliases = new Set();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\s*\.\s*stringify\s*\(/gu))
    aliases.add(match[1]);
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\s*\.\s*stringify\s*;/gu))
    aliases.add(match[1]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu)) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if ((aliases.has(match[2]) || wrappers.has(match[2])) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return aliases;
}

function collectStringifyWrappers(source) {
  const wrappers = new Set();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{[\s\S]*?\}|[^;\n]+)/gu,
  )) {
    if (/JSON\s*\.\s*stringify/gu.test(match[0])) wrappers.add(match[1]);
  }
  for (const match of source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[\s\S]*?JSON\s*\.\s*stringify[\s\S]*?\}/gu,
  ))
    wrappers.add(match[1]);
  return wrappers;
}

function callArgument(source, openParen) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = openParen + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, index);
    }
  }
  return source.slice(openParen + 1);
}

function isBoundedFrameSerialization(argument, boundedFrameVariables) {
  const serializations = [...argument.matchAll(/JSON\s*\.\s*stringify\s*\(\s*([A-Za-z_$][\w$]*)/gu)];
  return serializations.length > 0 && serializations.every((match) => boundedFrameVariables.has(match[1]));
}

/** Return structural violations that would let a new Fleet RPC bypass the transfer boundary. */
export function findFleetTransferBypasses(sourceText, fileName = "inline.ts") {
  const violations = [];
  const source = String(sourceText);
  const socketAliases = collectSocketAliases(source);
  const stringifyWrappers = collectStringifyWrappers(source);
  const stringifyAliases = collectStringifyAliases(source, stringifyWrappers);
  const boundedFrameVariables = new Set(
    [...source.matchAll(/for\s+await\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+encodeFleetFrames\s*\(/gu)].map(
      (match) => match[1],
    ),
  );

  for (const alias of socketAliases) {
    const writePattern = new RegExp(`\\b${alias}\\s*\\.\\s*write\\s*\\(`, "gu");
    for (const match of source.matchAll(writePattern)) {
      const argument = callArgument(source, match.index + match[0].lastIndexOf("("));
      const directJson = /JSON\s*\.\s*stringify\s*\(/u.test(argument);
      const variableJson = [...stringifyAliases].some((name) => new RegExp(`\\b${name}\\b`, "u").test(argument));
      const wrapperJson = [...stringifyWrappers].some((name) => new RegExp(`\\b${name}\\s*\\(`, "u").test(argument));
      if (!directJson && !variableJson && !wrapperJson) continue;
      if (directJson && isBoundedFrameSerialization(argument, boundedFrameVariables)) continue;
      violations.push({
        file: fileName,
        line: lineNumber(source, match.index),
        reason: directJson ? "direct JSON socket write" : "JSON payload reaches socket.write through a variable",
      });
    }
  }
  for (const match of source.matchAll(/fleet\.task\.evidence\/v1|assertFleetReadFits\s*\(/gu))
    violations.push({
      file: fileName,
      line: lineNumber(source, match.index),
      reason: match[0].startsWith("fleet.")
        ? "retired per-read evidence transport"
        : "read face owns the Fleet frame limit",
    });
  return violations;
}

/** Scan the forwarding construction inventory; production counts are ratcheted against baseline. */
export function findFleetForwardingBypasses(sourceText, fileName = "inline.ts") {
  const file = portablePath(fileName);
  if (FORWARDING_BOUNDARY_SOURCES.has(file)) return [];
  const source = String(sourceText),
    patterns = [
      ["edgeRuntimeFor", /\bedgeRuntimeFor\s*\(/gu],
      ["readFleetEdgeConfig", /\breadFleetEdgeConfig\s*\(/gu],
      [
        "directFleetEdgeFileRead",
        /\b(?:readFileSync|readFile)\s*\([^;\n]{0,180}fleet-edge\.json|fleet-edge\.json[^;\n]{0,180}\b(?:readFileSync|readFile)\s*\(/gu,
      ],
      ["fromFileSpecialCase", /\bif\s*\([^)]*\bfromFile\b[^)]*\)/gu],
      ["bodyFileSpecialCase", /\bif\s*\([^)]*\bbodyFile\b[^)]*\)/gu],
      ["idsFileSpecialCase", /\bif\s*\([^)]*\bidsFile\b[^)]*\)/gu],
      ["fileInputConditional", /\b(?:fromFile|bodyFile|idsFile)\b\s*\?/gu],
      [
        "fleetRequestEnvelope",
        /(?:=\s*\{|\breturn\s*\{|\b(?:request|send|call|post)\s*\(\s*\{)[^{}]{0,1000}?\bschema\s*:\s*["']fleet\.(?:task|doc|runtime|schedule)\.[^"']+["']|\bkind\s*:\s*["']fleet-(?:task|doc|runtime|schedule)["']/gu,
      ],
      [
        "fleetMethodByDiscriminant",
        /\b(?:action|command)(?:\.action)?\.kind\b[\s\S]{0,300}?\b(?:fleet[.-](?:task|doc|runtime|schedule)|fleet\.(?:task|doc|runtime|schedule)\.)/gu,
      ],
      [
        "forwardingCredentialAssembly",
        /\b(?:credential|accessToken|keycloakAuthorization|executionCredential)\s*:\s*[^,\n;}]*?(?:\.(?:credential|accessToken|keycloakAuthorization)|executor|principal)/gu,
      ],
    ];
  return patterns.flatMap(([fingerprint, pattern]) =>
    [...source.matchAll(pattern)].map((match) => {
      const offset = match.index + (fingerprint === "fleetRequestEnvelope" ? match[0].lastIndexOf("schema") : 0);
      return {
        file,
        line: lineNumber(source, offset),
        symbol: symbolAt(source, offset),
        fingerprint,
        reason: `forwarding construction ${fingerprint} is outside ForwardingPort`,
      };
    }),
  );
}

function symbolAt(source, index) {
  const prefix = source.slice(0, index),
    keywords = new Set(["if", "for", "while", "switch", "catch", "return", "throw", "try"]),
    declarations = [
      ...prefix.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu),
      ...prefix.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gu,
      ),
      ...prefix.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;\n{}]*\)\s*(?::[^\n{}]+)?\{/gmu),
    ]
      .filter((match) => !keywords.has(match[1]))
      .sort((left, right) => left.index - right.index),
    name = declarations.at(-1)?.[1];
  return name ?? "<module>";
}

export function checkFleetTransferBoundary(rootDir) {
  const errors = [];
  for (const relative of fleetSources(rootDir)) {
    const file = path.join(rootDir, relative);
    if (!existsSync(file)) {
      errors.push(`${relative}: Fleet transport source is missing`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (
      (relative.endsWith("peer.ts") || relative.endsWith("center-transport.ts")) &&
      !source.includes("encodeFleetFrames")
    )
      errors.push(`${relative}: command writes must pass through encodeFleetFrames`);
    for (const violation of findFleetTransferBypasses(source, relative))
      errors.push(`${violation.file}:${violation.line}: ${violation.reason}`);
  }
  for (const relative of forwardingSources(rootDir)) {
    const source = readFileSync(path.join(rootDir, relative), "utf8"),
      violations = findFleetForwardingBypasses(source, relative),
      counts = new Map();
    for (const violation of violations) {
      const key = `${violation.symbol}\0${violation.fingerprint}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      const [symbol, fingerprint] = key.split("\0"),
        allowed = fleetForwardingBoundaryBaseline[relative]?.[symbol]?.[fingerprint] ?? 0;
      if (count > allowed)
        errors.push(`${relative}#${symbol}: ${fingerprint} count ${count} exceeds ratchet baseline ${allowed}`);
    }
  }
  return errors;
}

/** Baseline entries are exact, not ceilings: a removed construction must lower its entry in the same
 * change, otherwise the old judgment can be reintroduced without a gate failure. */
export function checkForwardingBaselineFreshness(rootDir) {
  const errors = [];
  for (const relative of forwardingSources(rootDir)) {
    const violations = findFleetForwardingBypasses(readFileSync(path.join(rootDir, relative), "utf8"), relative),
      counts = new Map();
    for (const violation of violations) {
      const key = `${violation.symbol}\0${violation.fingerprint}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [symbol, fingerprints] of Object.entries(fleetForwardingBoundaryBaseline[relative] ?? {}))
      for (const [fingerprint, allowed] of Object.entries(fingerprints)) {
        const count = counts.get(`${symbol}\0${fingerprint}`) ?? 0;
        if (count < allowed)
          errors.push(
            `${relative}#${symbol}: ${fingerprint} count ${count} is below ratchet baseline ${allowed}; lower the baseline`,
          );
      }
  }
  return errors;
}

async function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/fleet-transfer-boundary.mjs --check");
  const errors = [...checkFleetTransferBoundary(process.cwd()), ...checkForwardingBaselineFreshness(process.cwd())];
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("fleet-transfer-boundary: ok");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
