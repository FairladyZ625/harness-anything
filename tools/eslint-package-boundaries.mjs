import path from "node:path";
import {
  loadPackageBoundaryContract,
  ownerForFile,
  packageForSpecifier,
  resolveRelativePackage
} from "./package-boundary-contract.mjs";

export const packageBoundaryMessageIds = Object.freeze({
  forbiddenEdge: "forbiddenEdge",
  crossPackageRelative: "crossPackageRelative",
  unregisteredDeepSubpath: "unregisteredDeepSubpath",
  crossPackageSourcePath: "crossPackageSourcePath"
});

export function createPackageBoundaryPlugin(root) {
  const contract = loadPackageBoundaryContract(root);
  return {
    rules: {
      adjacency: createRule(contract, root, new Set([packageBoundaryMessageIds.forbiddenEdge])),
      paths: createRule(contract, root, new Set([
        packageBoundaryMessageIds.crossPackageRelative,
        packageBoundaryMessageIds.unregisteredDeepSubpath,
        packageBoundaryMessageIds.crossPackageSourcePath
      ]))
    }
  };
}

function createRule(contract, root, enabledMessageIds) {
  return {
    meta: {
      type: "problem",
      schema: [],
      messages: {
        forbiddenEdge: "Package '{{source}}' may not depend on '{{target}}' according to tools/package-boundaries.json.",
        crossPackageRelative: "Cross-package relative import '{{specifier}}' must use a package export.",
        unregisteredDeepSubpath: "Deep subpath '{{specifier}}' is not registered with owner and sunset metadata.",
        crossPackageSourcePath: "Cross-package source-path string '{{specifier}}' bypasses package exports."
      }
    },
    create(context) {
      const filename = path.relative(root, context.filename).split(path.sep).join("/");
      const sourcePackage = ownerForFile(contract, filename);
      if (!sourcePackage) return {};
      const moduleLiterals = new WeakSet();

      const inspectModule = (node, literal) => {
        if (!literal || typeof literal.value !== "string") return;
        moduleLiterals.add(literal);
        const specifier = literal.value;
        const targetPackage = specifier.startsWith(".")
          ? resolveRelativePackage(contract, filename, specifier)
          : packageForSpecifier(contract, specifier);
        if (!targetPackage || targetPackage.id === sourcePackage.id) return;
        if (specifier.startsWith(".")) {
          report(packageBoundaryMessageIds.crossPackageRelative, { node, data: { specifier } });
          return;
        }
        if (!sourcePackage.allowedDependencies.includes(targetPackage.id)) {
          report(packageBoundaryMessageIds.forbiddenEdge, {
            node,
            data: { source: sourcePackage.id, target: targetPackage.id }
          });
        }
        const subpath = specifier.slice(targetPackage.name.length);
        if (subpath && !contract.deepSubpaths.some((entry) => entry.package === targetPackage.id && entry.subpath === `.${subpath}`)) {
          report(packageBoundaryMessageIds.unregisteredDeepSubpath, { node, data: { specifier } });
        }
      };

      const report = (messageId, descriptor) => {
        if (enabledMessageIds.has(messageId)) context.report({ ...descriptor, messageId });
      };

      return {
        ImportDeclaration: (node) => inspectModule(node, node.source),
        ExportNamedDeclaration: (node) => inspectModule(node, node.source),
        ExportAllDeclaration: (node) => inspectModule(node, node.source),
        ImportExpression: (node) => inspectModule(node, node.source),
        CallExpression(node) {
          if (node.callee?.type === "Identifier" && node.callee.name === "require") inspectModule(node, node.arguments?.[0]);
        },
        TSImportType(node) {
          const literal = node.source ?? node.argument?.literal ?? node.argument;
          // Parser AST variants without a literal source cannot identify a
          // package edge, so they are intentionally skipped rather than
          // allowing a non-literal parameter node to mask node.source.
          if (!literal) return;
          inspectModule(node, literal);
        },
        Literal(node) {
          if (moduleLiterals.has(node) || typeof node.value !== "string" || !node.value.startsWith(".") || !node.value.includes("/src/")) return;
          const targetPackage = resolveRelativePackage(contract, filename, node.value);
          if (!targetPackage || targetPackage.id === sourcePackage.id) return;
          report(packageBoundaryMessageIds.crossPackageSourcePath, { node, data: { specifier: node.value } });
        },
        TemplateLiteral(node) {
          if (node.expressions.length > 0 || node.quasis.length !== 1) return;
          const value = node.quasis[0].value.cooked;
          if (moduleLiterals.has(node) || typeof value !== "string" || !value.startsWith(".") || !value.includes("/src/")) return;
          const targetPackage = resolveRelativePackage(contract, filename, value);
          if (!targetPackage || targetPackage.id === sourcePackage.id) return;
          report(packageBoundaryMessageIds.crossPackageSourcePath, { node, data: { specifier: value } });
        }
      };
    }
  };
}
