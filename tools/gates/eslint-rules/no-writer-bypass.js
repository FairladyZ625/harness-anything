import path from "node:path";

const FILE_SYSTEM_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"]);
const FILE_MUTATORS = new Set(["appendFile", "appendFileSync", "writeFile", "writeFileSync"]);
const WRITER_CALLS = new Set(["issueWriterGenerationToken"]);
const WRITER_OWNER = /(?:^|\/)(?:write-chain\.contract|write-journal-operations)\.[^.]+$|\/eslint-rules\/no-writer-bypass\.js$|(?:^|\/)tools\/gates\/test\//u;

function filenameOf(context) {
  const filename = path.isAbsolute(context.filename) ? path.relative(process.cwd(), context.filename) : context.filename;
  return filename.replaceAll("\\", "/");
}

function propertyName(node) {
  return node?.type === "Identifier" ? node.name : node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

function callName(node) {
  return node.callee.type === "Identifier" ? node.callee.name
    : node.callee.type === "MemberExpression" ? propertyName(node.callee.property) : null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep event and lease publication behind the workspace writer owner" },
    schema: [],
    messages: {
      writerCall: "Workspace event/lease mutation and writer-token issuance belong to the writer owner.",
      eventFile: "Do not write an event stream through fs; submit a normalized command to the writer owner."
    }
  },
  create(context) {
    const owner = WRITER_OWNER.test(filenameOf(context));
    const fsMutators = new Set();
    const fsNamespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (!owner) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportSpecifier" && WRITER_CALLS.has(propertyName(specifier.imported))) context.report({ node: specifier, messageId: "writerCall" });
          }
        }
        if (!FILE_SYSTEM_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && FILE_MUTATORS.has(propertyName(specifier.imported))) fsMutators.add(specifier.local.name);
          if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") fsNamespaces.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const name = callName(node);
        if (!owner && name !== null && WRITER_CALLS.has(name)) context.report({ node, messageId: "writerCall" });
        const directFs = node.callee.type === "Identifier" && fsMutators.has(node.callee.name);
        const namespaceFs = node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier"
          && fsNamespaces.has(node.callee.object.name) && name !== null && FILE_MUTATORS.has(name);
        const target = node.arguments[0] === undefined ? "" : context.sourceCode.getText(node.arguments[0]);
        if ((directFs || namespaceFs) && /(?:harness[\\/]events|task-events\.ndjson)/u.test(target)) context.report({ node, messageId: "eventFile" });
      }
    };
  }
};
