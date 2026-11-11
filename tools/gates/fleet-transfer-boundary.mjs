import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const FLEET_ROOT = "packages/daemon/src/fleet";
const FORWARDING_ROOTS = Object.freeze(["packages/cli/src/daemon", "packages/daemon/src"]);
const FORWARDING_BOUNDARY_SOURCES = new Set([
  "packages/cli/src/daemon/fleet-payload-serializer.ts",
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
  return [...new Set(FORWARDING_ROOTS.flatMap((root) => collectTypeScriptSources(rootDir, root)))];
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

/** dec_2C49A4516E540906721AF01840: zero allowance for command forwarding construction.
 * Inspect expressions and their use, not shared words in local authorization, replica reads or types.
 * Fleet frames passed to the peer session are wire encoding; results are ingress/receipt values.
 */
export function findFleetForwardingBypasses(sourceText, fileName = "inline.ts") {
  const file = portablePath(fileName);
  if (file === "packages/daemon/src/fleet/forwarding-port.ts") return [];
  const source = String(sourceText),
    tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
    violations = [];
  const add = (node, fingerprint) =>
    violations.push({
      file,
      line: lineNumber(source, node.getStart(tree)),
      fingerprint,
      reason: `forwarding construction ${fingerprint} is outside ForwardingPort`,
    });
  const name = (node) => node.name?.getText(tree).replace(/^["']|["']$/gu, "");
  const scope = (node) => {
    let parent = node.parent;
    while (parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
    return parent?.getText(tree) ?? source;
  };
  const forwardingUse = (node) =>
    /\b(?:payload\s*\.\s*action\s*=|runFleetEdgeTask\s*\(|runFleet(?:Task|Schedule|Runtime|Write)[A-Za-z]*Client\s*\(|forward\s*\(|edgeRuntimeFor\s*\(|fleet[.-](?:task|doc|runtime|schedule))/u.test(
      scope(node),
    );
  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    // The actual sender dependency is port-owned, independently of payload spelling or spreads.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause,
        typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && !typeOnly)
        for (const binding of bindings.elements)
          if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === "runFleetEdgeTask")
            add(binding, "forwardingTransportDependency");
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "runFleetEdgeTask") ||
      (ts.isElementAccessExpression(node) && node.argumentExpression?.text === "runFleetEdgeTask") ||
      (ts.isBindingElement(node) && (node.propertyName ?? node.name).text === "runFleetEdgeTask")
    )
      add(node, "forwardingTransportDependency");
    const callee = ts.isCallExpression(node)
      ? ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(tree)
      : undefined;
    if (callee === "runFleetEdgeTask") add(node, "forwardingTransportCall");
    if (FORWARDING_BOUNDARY_SOURCES.has(file)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (callee === "edgeRuntimeFor") add(node, "edgeRuntimeFor");
      if (callee === "readFleetEdgeConfig" && forwardingUse(node)) add(node, "readFleetEdgeConfig");
      if (/^(?:readFileSync|readFile)$/u.test(callee) && /fleet-edge\.json/u.test(node.getText(tree)))
        add(node, "directFleetEdgeFileRead");
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map(node.properties.map((property) => [name(property), property])),
        kind = properties.get("kind"),
        schema = properties.get("schema"),
        wireCall =
          file === `${FLEET_ROOT}/peer.ts` &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression.getText(tree) === "session.request";
      if (
        kind &&
        ts.isPropertyAssignment(kind) &&
        /^fleet-(?:task|doc|runtime|schedule)$/u.test(kind.initializer.text ?? "")
      )
        add(kind, "fleetRequestEnvelope");
      if (
        schema &&
        ts.isPropertyAssignment(schema) &&
        /^fleet\.(?:task|doc|runtime|schedule)\.(?![^/]*result\/)[^/]+\/v\d+$/u.test(schema.initializer.text ?? "") &&
        !wireCall
      )
        add(schema, "fleetRequestEnvelope");
      // A node credential combined with a person/execution token is a forwarding identity envelope.
      // A local principal/session binding or a node join response alone is not one.
      if (
        properties.has("credential") &&
        ["accessToken", "executionCredential", "keycloakAuthorization"].some((key) => properties.has(key))
      )
        add(node, "forwardingCredentialAssembly");
    }
    if ((ts.isIfStatement(node) || ts.isConditionalExpression(node)) && forwardingUse(node)) {
      const condition = node.expression ?? node.condition;
      for (const field of ["fromFile", "bodyFile", "idsFile"])
        if (new RegExp(`\\b${field}\\b`, "u").test(condition.getText(tree)))
          add(node, ts.isIfStatement(node) ? `${field}SpecialCase` : "fileInputConditional");
    }
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node) || ts.isSwitchStatement(node)) {
      const condition = ts.isConditionalExpression(node) ? node.condition : node.expression;
      if (
        /\b(?:action|command)(?:\.action)?\.kind/u.test(condition.getText(tree)) &&
        /["'`]fleet-(?:task|doc|runtime|schedule)["'`]|["'`]fleet\.(?:task|doc|runtime|schedule)\.[^"'`/\r\n]+["'`]/u.test(
          node.getText(tree),
        )
      )
        add(node, "fleetMethodByDiscriminant");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
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
  for (const relative of forwardingSources(rootDir))
    for (const violation of findFleetForwardingBypasses(readFileSync(path.join(rootDir, relative), "utf8"), relative))
      errors.push(`${violation.file}:${violation.line}: ${violation.reason}`);
  return errors;
}

async function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/fleet-transfer-boundary.mjs --check");
  const errors = checkFleetTransferBoundary(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("fleet-transfer-boundary: ok");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
