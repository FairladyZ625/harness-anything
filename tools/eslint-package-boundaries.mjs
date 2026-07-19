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
      enforce: {
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
              context.report({ node, messageId: packageBoundaryMessageIds.crossPackageRelative, data: { specifier } });
              return;
            }
            if (!sourcePackage.allowedDependencies.includes(targetPackage.id)) {
              context.report({
                node,
                messageId: packageBoundaryMessageIds.forbiddenEdge,
                data: { source: sourcePackage.id, target: targetPackage.id }
              });
            }
            const subpath = specifier.slice(targetPackage.name.length);
            if (subpath && !contract.deepSubpaths.some((entry) => entry.package === targetPackage.id && entry.subpath === `.${subpath}`)) {
              context.report({ node, messageId: packageBoundaryMessageIds.unregisteredDeepSubpath, data: { specifier } });
            }
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
              inspectModule(node, node.parameter ?? node.argument?.literal ?? node.argument);
            },
            Literal(node) {
              if (moduleLiterals.has(node) || typeof node.value !== "string" || !node.value.startsWith(".") || !node.value.includes("/src/")) return;
              const targetPackage = resolveRelativePackage(contract, filename, node.value);
              if (!targetPackage || targetPackage.id === sourcePackage.id) return;
              context.report({ node, messageId: packageBoundaryMessageIds.crossPackageSourcePath, data: { specifier: node.value } });
            }
          };
        }
      }
    }
  };
}
