#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  exitCodeFor,
  findVariable,
  unwrapExpression,
  lineNumber,
  loadDurableActionKinds,
  parseCommonArgs,
  parseTypeScript,
  walkTypeScriptFiles,
} from "./ontology-gate-lib.mjs";

const receiptPath = "packages/kernel/src/domain/receipt-domain-registry.ts";
const authorizationPath = "packages/daemon/src/authorization.ts";
const routeSourceExclusion =
  /(?:daemon-protocol-(?:commands|gui-actions|validate)|protocol\.contract|(?:^|-)types?)\.ts$/u;

export function auditDurableActionAuthorization(rootDir = process.cwd(), durableKinds = null) {
  const kinds = durableKinds ?? loadDurableActionKinds(rootDir);
  const analysis = buildCallGraph(rootDir);
  const authority = authorizationAuthority(rootDir, analysis);
  const receipt = receiptAuthorizationContract(rootDir);
  const taskWrites = taskCatalogAuthorization(rootDir, analysis, authority);
  const rows = kinds.map((kind) => ({
    action: kind,
    authorizationPort:
      kind === "rbac-bootstrap"
        ? bootstrapAuthority(analysis)
        : taskWrites.has(kind)
          ? taskWrites.get(kind)
          : actionReachesAuthorization(kind, analysis, authority),
    receiptAuthorizationDecision: receipt.nonNullable,
  }));
  const findings = [
    ...rows
      .filter((row) => !row.authorizationPort)
      .map((row) => `${row.action}: durable execution path does not statically reach its authorization boundary`),
    ...(receipt.nonNullable
      ? []
      : [`${receipt.file}:${receipt.line} receipt.authorizationDecision is optional or nullable`]),
    ...(authority.ok ? [] : [`${authorizationPath}: authorizeAction no longer calls the typed AuthorizationPort`]),
  ];
  return { rows, findings, receipt, authority };
}

function buildCallGraph(rootDir) {
  const files = [
    ...walkTypeScriptFiles(rootDir, "packages/daemon/src"),
    ...walkTypeScriptFiles(rootDir, "packages/application/src"),
  ];
  const sources = [];
  const functions = new Map();
  for (const file of files) {
    const sourceFile = parseTypeScript(rootDir, file);
    sources.push({ file, sourceFile });
    visit(sourceFile);

    function visit(node) {
      const named = namedFunction(node);
      if (named) {
        const definitions = functions.get(named.name) ?? [];
        definitions.push({ file, sourceFile, body: named.body });
        functions.set(named.name, definitions);
      }
      ts.forEachChild(node, visit);
    }
  }
  return { sources, functions };
}

function namedFunction(node) {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) return { name: node.name.text, body: node.body };
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, body: node.initializer.body };
  }
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return { name: node.name.text, body: node.initializer.body };
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
    return { name: node.name.text, body: node.body };
  }
  return null;
}

function authorizationAuthority(rootDir, analysis) {
  const sourceFile = parseTypeScript(rootDir, authorizationPath);
  const typedPort = sourceFile.getText().includes("daemonAuthorizationPort: AuthorizationPort");
  const definitions = analysis.functions.get("authorizeAction") ?? [];
  const callsPort = definitions.some(({ body }) => containsPortAuthorize(body));
  const person = analysis.functions
    .get("evaluateKeycloakPerson")
    ?.find((definition) => definition.file === "packages/daemon/src/repo-cell-authorization.ts");
  const keycloak =
    person !== undefined &&
    ["authorize", "authorizePerson"].every((method) =>
      someNode(
        person.body,
        (node) =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === method &&
          ts.isNewExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === "KeycloakPolicyAdapter",
      ),
    );
  return { ok: typedPort && callsPort, keycloak };
}

function someNode(node, predicate) {
  if (predicate(node)) return true;
  return ts.forEachChild(node, (child) => someNode(child, predicate) || undefined) === true;
}

function calls(node, name) {
  return someNode(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      (ts.isIdentifier(candidate.expression)
        ? candidate.expression.text
        : ts.isPropertyAccessExpression(candidate.expression)
          ? candidate.expression.name.text
          : "") === name,
  );
}

// CH3's first administrator is a local, serialized, one-time boundary, not an online grant.
function bootstrapAuthority(analysis) {
  const host = analysis.functions
    .get("manageRbac")
    ?.find((definition) => definition.file === "packages/daemon/src/daemon-host-open.ts");
  const admin = analysis.functions
    .get("bootstrapAdmin")
    ?.find((definition) => definition.file === "packages/daemon/src/oidc-session-service.ts");
  if (!host || !admin || !ts.isBlock(host.body) || !host.body.statements[0]) return false;
  return (
    calls(host.body.statements[0], "localOnly") &&
    calls(host.body, "bootstrapAdmin") &&
    someNode(
      host.body,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "requireAuthorizedHostAction" &&
        node.arguments.some(
          (argument) =>
            calls(argument, "localSystemBinding") &&
            someNode(argument, (child) => ts.isStringLiteral(child) && child.text === "rbac-bootstrap"),
        ),
    ) &&
    hostRejectionGuard(analysis) &&
    socketOwnerAuthority(analysis) &&
    calls(admin.body, "serialize") &&
    calls(admin.body, "#createUser") &&
    someNode(
      admin.body,
      (node) =>
        ts.isIfStatement(node) &&
        ts.isPrefixUnaryExpression(node.expression) &&
        node.expression.operator === ts.SyntaxKind.ExclamationToken &&
        calls(node.expression, "#bootstrapRequired") &&
        someNode(
          node.thenStatement,
          (child) =>
            ts.isThrowStatement(child) &&
            someNode(child, (literal) => ts.isStringLiteral(literal) && literal.text === "bootstrap_admin_closed"),
        ),
    )
  );
}

function socketOwnerAuthority(analysis) {
  const fleet = analysis.functions
    .get("evaluateFleetAction")
    ?.find((definition) => definition.file === "packages/daemon/src/host-action-authorization.ts");
  if (!fleet) return false;
  return someNode(
    fleet.body,
    (node) =>
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(node.expression.operand) &&
      node.expression.operand.text === "credential" &&
      someNode(
        node.thenStatement,
        (guard) =>
          ts.isIfStatement(guard) &&
          [
            'input.binding.source === "local"',
            "input.binding.daemonSocketOwner === true",
            'declaration.residency.scope !== "canonical"',
          ].every((expression) => conjuncts(guard.expression).some((term) => term.getText() === expression)) &&
          calls(guard.thenStatement, "keycloakDecision"),
      ) &&
      someNode(
        node.thenStatement,
        (denial) =>
          ts.isReturnStatement(denial) &&
          denial.expression &&
          ts.isCallExpression(denial.expression) &&
          denial.expression.arguments.some(
            (argument) => ts.isStringLiteral(argument) && argument.text === "authentication_required",
          ),
      ),
  );
}

function conjuncts(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? [...conjuncts(node.left), ...conjuncts(node.right)]
    : [node];
}

function hostRejectionGuard(analysis) {
  const host = analysis.functions
    .get("requireAuthorizedHostAction")
    ?.find((definition) => definition.file === "packages/daemon/src/host-action-authorization.ts");
  return (
    host !== undefined &&
    calls(host.body, "evaluateFleetAction") &&
    someNode(
      host.body,
      (node) =>
        ts.isIfStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        node.expression.left.getText() === "decision.outcome" &&
        ts.isStringLiteral(node.expression.right) &&
        node.expression.right.text === "denied" &&
        someNode(node.thenStatement, ts.isThrowStatement),
    )
  );
}

function containsPortAuthorize(node) {
  let found = false;
  visit(node);
  return found;
  function visit(current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "authorize"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
}

function receiptAuthorizationContract(rootDir) {
  const sourceFile = parseTypeScript(rootDir, receiptPath);
  let member = null;
  visit(sourceFile);
  if (!member) return { file: receiptPath, line: 1, nonNullable: false };
  return {
    file: receiptPath,
    line: lineNumber(sourceFile, member.getStart(sourceFile)),
    nonNullable: !member.questionToken && member.type !== undefined && !typeContainsNullish(member.type),
  };

  function visit(node) {
    if (!member && ts.isInterfaceDeclaration(node) && node.name.text === "WriteReceipt") {
      member = node.members.find(
        (candidate) =>
          ts.isPropertySignature(candidate) &&
          ((ts.isIdentifier(candidate.name) && candidate.name.text === "authorizationDecision") ||
            (ts.isStringLiteral(candidate.name) && candidate.name.text === "authorizationDecision")),
      );
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function typeContainsNullish(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (typeContainsNullish(child)) found = true;
  });
  return found;
}

// Catalog ingress is declared in the kernel; a read handler mentioning a policy action
// is not evidence for this write. Fail closed when any part of the queued write route breaks.
function taskCatalogAuthorization(rootDir, analysis, authority) {
  const contractPath = "packages/kernel/src/domain/task-action-contract.ts",
    declarationPath = "packages/kernel/src/domain/action-declaration.ts",
    rows = new Map();
  if (!existsSync(path.join(rootDir, contractPath))) return rows;
  const contract = parseTypeScript(rootDir, contractPath),
    specs = unwrapExpression(findVariable(contract, "lifecycleSpecs")?.initializer),
    registrations = unwrapExpression(findVariable(contract, "declarations")?.initializer),
    declarations = existsSync(path.join(rootDir, declarationPath)) ? parseTypeScript(rootDir, declarationPath) : null,
    inventory = declarations && unwrapExpression(findVariable(declarations, "actionDeclarations")?.initializer),
    wired = authority.ok && authority.keycloak && queuedTaskWrite(analysis) && taskCatalogWiring(analysis);
  if (!specs || !ts.isObjectLiteralExpression(specs)) return rows;
  for (const spec of specs.properties) {
    if (!ts.isPropertyAssignment(spec) || !ts.isObjectLiteralExpression(spec.initializer)) continue;
    const fields = new Map(
      spec.initializer.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => [property.name.getText(), property.initializer]),
    );
    const ingress = fields.get("ingress");
    if (!ingress || !ts.isStringLiteral(ingress)) continue;
    const id = spec.name.getText(),
      kind = ingress.text;
    const registered =
      registrations &&
      ts.isArrayLiteralExpression(registrations) &&
      registrations.elements.some(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText() === "lifecycle" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === id,
      );
    const declared =
      inventory &&
      ts.isArrayLiteralExpression(inventory) &&
      inventory.elements.some(
        (node) =>
          ts.isCallExpression(node) &&
          ["canonical", "closure"].includes(node.expression.getText()) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === kind &&
          node.arguments[1] &&
          ts.isStringLiteral(node.arguments[1]) &&
          node.arguments[1].text === `task/${id}` &&
          (node.expression.getText() === "closure" ||
            ['"repo-write"', '"arbiter"'].includes(node.arguments[2]?.getText())),
      );
    rows.set(kind, Boolean(wired && registered && declared));
  }
  return rows;
}

function source(analysis, name) {
  return analysis.sources.find(({ file }) => file === `packages/daemon/src/${name}.ts`)?.sourceFile;
}

function definition(analysis, file, name) {
  return analysis.functions.get(name)?.find((entry) => entry.file === `packages/daemon/src/${file}.ts`)?.body;
}

// Compare syntax rather than comments/formatting. These are deliberately conservative
// wiring contracts, not a general-purpose proof of arbitrary JavaScript control flow.
function syntax(node) {
  if (!node) return "";
  const tokens = [];
  function visit(current) {
    const children = current.getChildren();
    if (children.length === 0) tokens.push(current.getText());
    else children.forEach(visit);
  }
  visit(node);
  return tokens.join("");
}

function queuedTaskWrite(analysis) {
  const runner = source(analysis, "repo-cell-command-run"),
    current = definition(analysis, "repo-cell-command-run", "authorizeAtCurrentCut"),
    enqueue = definition(analysis, "repo-cell-command-run", "enqueuePublication"),
    evaluate = definition(analysis, "repo-cell-authorization", "evaluateRepoCellAction");
  if (!runner || !current || !enqueue || !evaluate) return false;
  const durable = findVariable(runner, "durable")?.initializer;
  if (syntax(durable) !== "(durablePolicyActionsasreadonlystring[]).includes(action.kind)") return false;
  if (
    !syntax(current).includes("revision=context.store.readHead()?.revision??0") ||
    !syntax(current).includes(
      "returnevaluateRepoCellAction({action,binding,actionId,repoId:context.input.repoId,revision,now:context.now(),})",
    ) ||
    !calls(evaluate, "evaluateKeycloakPerson")
  )
    return false;
  let publication;
  someNode(enqueue, (node) => {
    if (
      !ts.isCallExpression(node) ||
      node.expression.getText() !== "chainRepoCellWrite" ||
      node.arguments[0]?.getText() !== "context.tail"
    )
      return false;
    const callback = node.arguments[1];
    if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) publication = callback.body;
    return Boolean(publication);
  });
  if (!publication) return false;
  const guard = publication.statements.find(
    (node) => ts.isIfStatement(node) && node.expression.getText() === "durable",
  );
  if (!guard || !ts.isBlock(guard.thenStatement)) return false;
  const [evaluation, denial] = guard.thenStatement.statements;
  if (
    syntax(evaluation) !== "queuedDecision=awaitauthorizeAtCurrentCut()!;" ||
    !denial ||
    !ts.isIfStatement(denial) ||
    syntax(denial.expression) !== 'queuedDecision.outcome==="denied"' ||
    !ts.isReturnStatement(denial.thenStatement) ||
    !calls(denial.thenStatement, "withAuthorizationDecision") ||
    !calls(denial.thenStatement, "rejected")
  )
    return false;
  const executes = [];
  someNode(publication, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === "execute") executes.push(node);
    return false;
  });
  if (executes.length !== 1 || executes[0].pos < guard.end || syntax(executes[0]) !== "execute(queuedDecision)")
    return false;
  const run = definition(analysis, "repo-cell-command-run", "run");
  return Boolean(
    run &&
      ts.isBlock(run) &&
      syntax(run.statements.at(-1)) ===
        "returnenqueuePublication((authorizationDecision)=>context.executeAction(action,authorizationDecision?{...binding,authorizationDecision}:binding),);",
  );
}

function importsBinding(node, module, exported, local) {
  return node.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === module &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (entry) => entry.name.text === local && (entry.propertyName?.text ?? entry.name.text) === exported,
      ),
  );
}

function taskCatalogWiring(analysis) {
  const dispatch = definition(analysis, "repo-cell-action-dispatch", "executeRepoAction"),
    execute = definition(analysis, "repo-cell-action-dispatch", "executeAction"),
    catalog = definition(analysis, "entity-action-catalog-executor", "run"),
    context = source(analysis, "repo-cell-action-context"),
    open = source(analysis, "repo-cell-open"),
    api = source(analysis, "repo-cell-api");
  if (!dispatch || !execute || !catalog || !context || !open || !api) return false;
  return (
    calls(execute, "executeRepoAction") &&
    syntax(dispatch).includes("actionContract=getExecutableEntityAction(action.kind)") &&
    someNode(
      dispatch,
      (node) =>
        ts.isIfStatement(node) &&
        syntax(node.expression) === 'actionContract?.target.kind==="task"&&actionContract.execution' &&
        someNode(
          node.thenStatement,
          (child) =>
            ts.isReturnStatement(child) &&
            child.expression &&
            ts.isCallExpression(child.expression) &&
            child.expression.expression.getText() === "cell.entityActionExecutor.run" &&
            syntax(child.expression.arguments[0]) === "action" &&
            syntax(child.expression.arguments[1]) === "binding" &&
            calls(child.expression.arguments[3], "lifecycleAction"),
        ),
    ) &&
    syntax(catalog).includes("contract=executableAction(action.kind)") &&
    syntax(catalog).includes("returnruntimes.task(contract,action,binding,opId)") &&
    importsBinding(context, "./repo-cell-action-dispatch.ts", "executeAction", "executeActionImpl") &&
    importsBinding(context, "./task-action-catalog-runtime.ts", "runTaskActionCatalogRuntime", "lifecycleActionImpl") &&
    syntax(context).includes("executeAction:bind(executeActionImpl)") &&
    syntax(context).includes("lifecycleAction:bind(lifecycleActionImpl)") &&
    syntax(open).includes("executeAction:extracted.executeAction") &&
    syntax(api).includes("run=makeRepoCellCommandRunner(context)")
  );
}

function actionReachesAuthorization(kind, analysis, authority) {
  const seeds = [];
  for (const { file, sourceFile } of analysis.sources) {
    if (routeSourceExclusion.test(file)) continue;
    visit(sourceFile);
    function visit(node) {
      if (ts.isStringLiteralLike(node) && node.text === kind) seeds.push(routeRegion(node));
      ts.forEachChild(node, visit);
    }
  }
  return seeds.some((seed) => nodeReachesAuthorization(seed, analysis, authority, new Set()));
}

function routeRegion(literal) {
  let current = literal;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return parent;
    if (ts.isIfStatement(parent) && containsNode(parent.expression, literal)) return parent.thenStatement;
    if (ts.isConditionalExpression(parent) && containsNode(parent.condition, literal)) return parent.whenTrue;
    if (ts.isBlock(parent)) return parent;
    if (ts.isFunctionLike(parent) && parent.body) return parent.body;
    current = parent;
  }
  return literal;
}

function containsNode(container, target) {
  return target.pos >= container.pos && target.end <= container.end;
}

function nodeReachesAuthorization(node, analysis, authority, visiting) {
  const calls = calledNames(node);
  if (calls.has("authorizeAction") && authority.ok) return true;
  if (calls.has("evaluateKeycloakPerson") && authority.keycloak) return true;
  for (const name of calls) {
    if (visiting.has(name)) continue;
    if (name === "requireAuthorizedHostAction" && !hostRejectionGuard(analysis)) continue;
    const next = new Set(visiting).add(name);
    for (const definition of analysis.functions.get(name) ?? []) {
      if (nodeReachesAuthorization(definition.body, analysis, authority, next)) return true;
    }
  }
  return false;
}

function calledNames(node) {
  const names = new Set();
  visit(node);
  return names;
  function visit(current) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) names.add(current.expression.text);
    }
    ts.forEachChild(current, visit);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const result = auditDurableActionAuthorization(rootDir, loadDurableActionKinds(rootDir, fixture));
    console.log(`G0-2 ontology-durable-action-authorization: ${mode}`);
    console.log("action | authorization boundary | receipt.authorizationDecision");
    for (const row of result.rows) {
      console.log(
        `${row.action} | ${row.authorizationPort ? (row.action === "rbac-bootstrap" ? "local one-time bootstrap" : "traced") : "missing"} | ${row.receiptAuthorizationDecision ? "non-null" : "optional/null"}`,
      );
    }
    console.log(
      `missing authorization paths: ${result.rows.filter((row) => !row.authorizationPort).length}/${result.rows.length}`,
    );
    console.log(
      `receipt contract: ${result.receipt.file}:${result.receipt.line} ${result.receipt.nonNullable ? "non-null" : "optional/null"}`,
    );
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-2 ontology-durable-action-authorization: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
