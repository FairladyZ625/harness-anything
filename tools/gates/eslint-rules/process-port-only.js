import { createHash } from "node:crypto";
import path from "node:path";

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SPAWNING_FUNCTIONS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
// Only package sources load into the daemon, which runs detached and console-less. Gate and tool scripts run from a terminal that their children inherit.
const DAEMON_REACHABLE_FILE = /^packages\/.*\/src\//u;
const PORT_FILE = /(?:^|\/)(?:ports\/[^/]+|(?:child-|sub)?process(?:-[^/]*)?-port)\.[^.]+$|\/eslint-rules\/process-port-only\.js$/u;

function normalizedFilename(filename) {
  const relative = path.isAbsolute(filename) ? path.relative(process.cwd(), filename) : filename;
  return relative.replaceAll("\\", "/");
}

function fingerprint(filename, node, sourceText) {
  const location = `${node.loc.start.line}:${node.loc.start.column + 1}`;
  // Baselines are generated from LF sources; hashing a CRLF checkout's raw text would
  // never match them, failing lint on every Windows (core.autocrlf=true) checkout.
  return `${normalizedFilename(filename)}:${location}#${createHash("sha256").update(sourceText.replaceAll("\r\n", "\n")).digest("hex")}`;
}

/** A console child spawned from the console-less daemon allocates its own window unless CREATE_NO_WINDOW is requested. Options reaching the call by spread are invisible here, so those sites declare the flag literally or live in a port file. */
function declaresWindowsHide(node) {
  return node.arguments.some((argument) => argument.type === "ObjectExpression"
    && argument.properties.some((property) => property.type === "Property" && propertyName(property.key) === "windowsHide"));
}

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function reportUnlessBaselined(context, baseline, node, messageId) {
  const key = fingerprint(context.filename, node, context.sourceCode.getText(node));
  if (!baseline.has(key)) context.report({ node, messageId, data: { fingerprint: key } });
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Route child processes and executable entrypoint discovery through a cross-platform process port" },
    schema: [{
      type: "object",
      properties: { baseline: { type: "array", items: { type: "string" }, uniqueItems: true } },
      additionalProperties: false
    }],
    messages: {
      execString: "child_process.exec(string) is platform-specific; use the process port. Baseline key: {{fingerprint}}",
      shellTrue: "shell: true is platform-specific; use an argv-based process port. Baseline key: {{fingerprint}}",
      posixShell: "The /bin/sh literal is not cross-platform; use a declared process capability. Baseline key: {{fingerprint}}",
      entryRegex: "Do not discover executable entrypoints with a path regex; resolve package bin/exports through the process port. Baseline key: {{fingerprint}}",
      windowsHide: "A child process spawned without windowsHide: true opens a visible console window on Windows when its parent has no console. Baseline key: {{fingerprint}}"
    }
  },
  create(context) {
    const filename = normalizedFilename(context.filename);
    if (PORT_FILE.test(filename)) return {};
    const baseline = new Set(context.options[0]?.baseline ?? []);
    const execBindings = new Set();
    const spawnBindings = new Map();
    const namespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (!CHILD_PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && propertyName(specifier.imported) === "exec") execBindings.add(specifier.local.name);
          if (specifier.type === "ImportSpecifier" && SPAWNING_FUNCTIONS.has(propertyName(specifier.imported))) spawnBindings.set(specifier.local.name, propertyName(specifier.imported));
          if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") namespaces.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const directExec = node.callee.type === "Identifier" && execBindings.has(node.callee.name);
        const namespaceExec = node.callee.type === "MemberExpression"
          && node.callee.object.type === "Identifier"
          && namespaces.has(node.callee.object.name)
          && propertyName(node.callee.property) === "exec";
        if ((directExec || namespaceExec) && node.arguments.length > 0) reportUnlessBaselined(context, baseline, node, "execString");
        const directSpawn = node.callee.type === "Identifier" && spawnBindings.has(node.callee.name);
        const namespaceSpawn = node.callee.type === "MemberExpression"
          && node.callee.object.type === "Identifier"
          && namespaces.has(node.callee.object.name)
          && SPAWNING_FUNCTIONS.has(propertyName(node.callee.property));
        if (DAEMON_REACHABLE_FILE.test(filename) && (directSpawn || namespaceSpawn) && !declaresWindowsHide(node)) reportUnlessBaselined(context, baseline, node, "windowsHide");
      },
      Property(node) {
        if (propertyName(node.key) === "shell" && node.value.type === "Literal" && node.value.value === true) {
          reportUnlessBaselined(context, baseline, node, "shellTrue");
        }
      },
      Literal(node) {
        if (node.value === "/bin/sh") reportUnlessBaselined(context, baseline, node, "posixShell");
        if (node.regex !== undefined && /(?:bin|dist).*(?:index|cli)|(?:index|cli).*(?:bin|dist)/iu.test(node.regex.pattern)) {
          reportUnlessBaselined(context, baseline, node, "entryRegex");
        }
      }
    };
  }
};
