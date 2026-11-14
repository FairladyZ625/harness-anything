// Non-main GUI client & higher-order callback source-proof (dec_7E44897ECDCAEF2B92EC66A260/CH1).
// Resolves direct RPC/IPC transport calls and higher-order callback runners in packages/gui/src/{renderer,preload,browser}
// to their concrete ActionDeclaration and daemon protocol route, failing closed on unproven callbacks.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { allDaemonProtocolMethods } from "../../packages/daemon/src/protocol/daemon-protocol-commands.ts";
import { daemonGuiStreamFacets } from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { isFunctionNode, unwrap } from "./authorization-flow-graph.mjs";

export const sourceSite = (graph, node) => `${graph.fileOf(node)}:${node.getStart(node.getSourceFile())}:${node.end}`;
export const guiClientSource = (graph, node) =>
  /^packages\/gui\/src\/(?:renderer|preload|browser)\//u.test(graph.fileOf(node));

export function declaredPortKey(graph, node) {
  const declaration = graph.callDeclaration(node);
  if (!declaration) return null;
  const names = [];
  for (let current = declaration; current && !ts.isSourceFile(current); current = current.parent)
    if (current.name && (ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name)))
      names.unshift(current.name.text);
  const file = graph.fileOf(declaration).replace(/^.*\/node_modules\//u, "node_modules/");
  return `${file}#${names.join(".")}`;
}

export function returnExpressions(declaration) {
  const returns = [];
  if (!declaration?.body) return returns;
  if (!ts.isBlock(declaration.body)) return [declaration.body];
  ts.forEachChild(declaration.body, function walk(node) {
    if (isFunctionNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    ts.forEachChild(node, walk);
  });
  return returns;
}

const GUI_LOCAL_IPC_CHANNELS = new Set([
  "DESKTOP_FIRST_RUN_STATUS_CHANNEL",
  "DESKTOP_FIRST_RUN_SETUP_CHANNEL",
  "FIRST_RUN_CHOOSE_CHANNEL",
  "ARTIFACT_OPEN_EXTERNAL_CHANNEL",
  "LOCAL_DOC_EXTRACT_WORD_CHANNEL",
  "LOCAL_DOC_READ_CHANNEL",
  "LOCAL_DOC_WRITE_CHANNEL",
  "LOCAL_DOC_PPTX_CHANNEL",
  "WORKSPACE_INSPECT_CHANNEL",
  "OIDC_CANCEL_LOGIN_CHANNEL",
  "PROJECT_DIRECTORY_CHANNEL",
  "PROJECT_WINDOW_OPEN_CHANNEL",
  "PROJECT_WINDOW_ACTIVE_CHANNEL",
  "UPDATE_CHECK_CHANNEL",
  "UPDATE_INSTALL_CHANNEL",
  "UPDATE_STATUS_CHANNEL",
]);

const GUI_DIRECT_IPC_CHANNELS = new Map([
  ["ACCESS_ADMIN_CHANNEL", { actionKind: "access-manage", route: "node-unregister", isRead: false }],
  ["FIRST_RUN_BOOTSTRAP_CHANNEL", { actionKind: "repo-bootstrap", route: "repo-bootstrap", isRead: false }],
  ["CONNECTION_STATUS_CHANNEL", { actionKind: "repository-read", route: "daemon-status", isRead: true }],
  [
    "CONNECTION_PROBE_CHANNEL",
    { actionKind: "daemon-connection-probe", route: "daemon-connection-probe", isRead: false },
  ],
  [
    "CONNECTION_REGISTER_CHANNEL",
    { actionKind: "daemon-connection-add", route: "daemon-connection-add", isRead: false },
  ],
  [
    "CONNECTION_UPDATE_CHANNEL",
    { actionKind: "daemon-connection-update", route: "daemon-connection-update", isRead: false },
  ],
  [
    "CONNECTION_UNREGISTER_CHANNEL",
    { actionKind: "daemon-connection-remove", route: "daemon-connection-remove", isRead: false },
  ],
  ["REPO_REGISTER_CHANNEL", { actionKind: "daemon-repo-register", route: "daemon-repo-register", isRead: false }],
  ["REPO_UPDATE_CHANNEL", { actionKind: "daemon-repo-update", route: "daemon-repo-update", isRead: false }],
  ["REPO_UNREGISTER_CHANNEL", { actionKind: "repo-unbind", route: "repo-unbind", isRead: false }],
  ["OIDC_LOGIN_CHANNEL", { actionKind: "rbac-bootstrap", route: "rbac-bootstrap", isRead: false }],
  ["OIDC_LOGOUT_CHANNEL", { actionKind: "rbac-bootstrap", route: "rbac-bootstrap", isRead: false }],
  ["OIDC_CONFIGURE_CHANNEL", { actionKind: "rbac-bootstrap", route: "rbac-bootstrap", isRead: false }],
  ["OIDC_BOOTSTRAP_ADMIN_CHANNEL", { actionKind: "rbac-bootstrap", route: "rbac-bootstrap", isRead: false }],
  ["OIDC_STATUS_CHANNEL", { actionKind: "repository-read", route: "oidc-status-read", isRead: true }],
  ["OIDC_BINDING_STATUS_CHANNEL", { actionKind: "repository-read", route: "oidc-status-read", isRead: true }],
  ["OIDC_OPEN_CONSOLE_CHANNEL", { actionKind: "repository-read", route: "oidc-status-read", isRead: true }],
  ["OIDC_BOOTSTRAP_STATUS_CHANNEL", { actionKind: "repository-read", route: "oidc-status-read", isRead: true }],
]);

const GUI_BRIDGE_INTERFACE_PORTS = new Map([
  [
    "packages/gui/src/renderer/connection-admin-client.ts#ConnectionsBridge.update",
    { actionKind: "daemon-connection-update", route: "daemon-connection-update", isRead: false },
  ],
  [
    "packages/gui/src/renderer/connection-admin-client.ts#RepoAdminBridge.update",
    { actionKind: "daemon-repo-update", route: "daemon-repo-update", isRead: false },
  ],
  [
    "packages/gui/src/renderer/edge-join-client.ts#EdgeJoinBridge.begin",
    { actionKind: "rbac-bootstrap", route: "edge-join", isRead: false },
  ],
  [
    "packages/gui/src/renderer/edge-join-client.ts#EdgeJoinBridge.poll",
    { actionKind: "repository-read", route: "edge-join-poll", isRead: true },
  ],
  [
    "packages/gui/src/renderer/edge-join-client.ts#EdgeJoinBridge.progress",
    { actionKind: "repository-read", route: "edge-join-progress", isRead: true },
  ],
]);

function evalGuiString(graph, expr, env = new Map(), seen = new Set()) {
  const node = unwrap(expr);
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (env.has(node.text)) return env.get(node.text);
    const binding = graph.lookup(node.text, node);
    if (binding?.declaration && ts.isVariableDeclaration(binding.declaration) && binding.declaration.initializer) {
      if (seen.has(binding.declaration)) return null;
      seen.add(binding.declaration);
      return evalGuiString(graph, binding.declaration.initializer, env, seen);
    }
    return null;
  }
  if (ts.isConditionalExpression(node)) {
    const cond = unwrap(node.condition);
    if (
      cond &&
      ts.isBinaryExpression(cond) &&
      (cond.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        cond.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const left = evalGuiString(graph, cond.left, env, seen);
      const right = evalGuiString(graph, cond.right, env, seen);
      if (left !== null && right !== null) {
        const equal = left === right;
        const takeTrue = cond.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal;
        return evalGuiString(graph, takeTrue ? node.whenTrue : node.whenFalse, env, seen);
      }
    }
  }
  return null;
}

function readGuiObjectStringField(graph, expr, fieldName, env) {
  const obj = unwrap(expr);
  if (!obj) return null;
  if (ts.isIdentifier(obj)) return env.get(`field:${obj.text}:${fieldName}`) ?? null;
  if (!ts.isObjectLiteralExpression(obj)) return null;
  let result = null;
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
      prop.name.text === fieldName
    )
      result = evalGuiString(graph, prop.initializer, env);
    else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === fieldName)
      result = evalGuiString(graph, prop.name, env);
    else if (ts.isSpreadAssignment(prop)) {
      const inner = readGuiObjectStringField(graph, prop.expression, fieldName, env);
      if (inner !== null) result = inner;
    }
  }
  return result;
}

const GUI_NON_DESCRIPTOR_READ_METHODS = new Set([
  "daemon.fleet.center.read",
  "daemon.fleet.center.external-address.read",
  "repo.agentRuntime.quote",
  "repo.agentRuntime.attach",
  "daemon.skillEval.cases.list",
]);

function resolveGuiRpcMethod(graph, method, payloadExpr, env, descriptors) {
  if (method === "repo.agentRuntime.handoff") {
    const op = readGuiObjectStringField(graph, payloadExpr, "operation", env);
    if (op === "export" || op === "revoke" || op === "claim") {
      const id = `runtime-handoff-${op}`;
      if (descriptors.some((d) => d.id === id)) return { actionKind: id, route: id, isRead: false };
    }
  }
  const guiDesc = descriptors.find((d) => d.method === method && d.guiBridgeMethod);
  const matching = guiDesc ? [guiDesc] : descriptors.filter((d) => d.method === method);
  if (matching.length > 0) {
    const chosen = matching[0];
    if (chosen.commandClass === "repo-read") {
      return {
        actionKind: method === "repo.fleet.overview.read" ? "fleet-overview-read" : "repository-read",
        route: chosen.id,
        isRead: true,
      };
    }
    return { actionKind: chosen.actionKind ?? chosen.id, route: chosen.id, isRead: false };
  }
  const proto = allDaemonProtocolMethods.find((m) => m.method === method);
  if (!proto) return null;
  if (method === "daemon.fleet.center.external-address.set")
    return { actionKind: "daemon-fleet-center-start", route: "daemon-fleet-center-start", isRead: false };
  if (proto.commandClass !== "repo-read" && !GUI_NON_DESCRIPTOR_READ_METHODS.has(method)) return null;
  const isFleetRead =
    method === "repo.fleet.overview.read" ||
    method === "daemon.fleet.center.read" ||
    method === "daemon.fleet.center.external-address.read";
  return {
    actionKind: isFleetRead ? "fleet-overview-read" : "repository-read",
    route: proto.id,
    isRead: true,
  };
}

function resolveGuiPreloadIpcLeaf(graph, callExpr, portKey, env) {
  const isPreloadInvoke =
    portKey === "packages/gui/src/preload/electron-preload.ts#invoke" ||
    portKey === "node_modules/electron/electron.d.ts#Electron.IpcRenderer.invoke" ||
    portKey === "packages/gui/src/preload/access-admin-preload.ts#accessAdminPreloadApi.invoke" ||
    portKey === "packages/gui/src/preload/center-settings-preload.ts#centerSettingsPreloadApi.invoke" ||
    portKey === "packages/gui/src/preload/edge-join-entry-preload.ts#edgeJoinEntryPreloadApi.invoke";
  if (!isPreloadInvoke) return null;
  const chArg = unwrap(callExpr.arguments[0]);
  const payloadArg = callExpr.arguments[1];
  const chIdent = chArg && ts.isIdentifier(chArg) ? chArg.text : null;
  if (chIdent && GUI_LOCAL_IPC_CHANNELS.has(chIdent)) return { localOnly: true };
  if (chIdent && GUI_DIRECT_IPC_CHANNELS.has(chIdent))
    return { binding: GUI_DIRECT_IPC_CHANNELS.get(chIdent), reachesDaemon: true };
  if (chIdent === "CENTER_SETTINGS_CHANNEL") {
    const op = readGuiObjectStringField(graph, payloadArg, "operation", env);
    if (op === "select-file") return { localOnly: true };
    if (op === "listener")
      return {
        binding: { actionKind: "repository-read", route: "center-listener-read", isRead: true },
        reachesDaemon: true,
      };
    if (op === "fleet-status")
      return {
        binding: { actionKind: "fleet-overview-read", route: "daemon.fleet.center.read", isRead: true },
        reachesDaemon: true,
      };
    if (op === "external-address")
      return {
        binding: {
          actionKind: "fleet-overview-read",
          route: "daemon.fleet.center.external-address.read",
          isRead: true,
        },
        reachesDaemon: true,
      };
    if (op === "center-start" || op === "external-address-set")
      return {
        binding: { actionKind: "daemon-fleet-center-start", route: "daemon-fleet-center-start", isRead: false },
        reachesDaemon: true,
      };
    if (op === "listener-set")
      return { binding: { actionKind: "rbac-bootstrap", route: "rbac-bootstrap", isRead: false }, reachesDaemon: true };
    return { reachesDaemon: true };
  }
  if (chIdent === "EDGE_JOIN_ENTRY_CHANNEL") {
    const kind = readGuiObjectStringField(graph, payloadArg, "kind", env);
    if (kind === "open-login") return { localOnly: true };
    if (kind === "join")
      return { binding: { actionKind: "rbac-bootstrap", route: "edge-join", isRead: false }, reachesDaemon: true };
    if (kind === "poll")
      return { binding: { actionKind: "repository-read", route: "edge-join-poll", isRead: true }, reachesDaemon: true };
    if (kind === "progress")
      return {
        binding: { actionKind: "repository-read", route: "edge-join-progress", isRead: true },
        reachesDaemon: true,
      };
    return { reachesDaemon: true };
  }
  if (
    (chArg && ts.isTemplateExpression(chArg) && chArg.head.text === "harness:") ||
    (portKey === "node_modules/electron/electron.d.ts#Electron.IpcRenderer.invoke" &&
      graph.fileOf(callExpr) === "packages/gui/src/preload/electron-preload.ts")
  ) {
    return {
      binding: { actionKind: "repository-read", route: "repository-read", isRead: true },
      reachesDaemon: true,
    };
  }
  return null;
}

function resolveGuiBindingDecl(graph, binding, seen = new Set()) {
  if (!binding || seen.has(binding)) return null;
  seen.add(binding);
  if (binding.kind === "fn") return binding.node;
  if (binding.kind === "var") return binding.declaration;
  if (binding.kind === "import") {
    const target = graph.importTarget(binding);
    if (target?.file) return resolveGuiBindingDecl(graph, graph.exportedBinding(target.file, binding.exported), seen);
  }
  return null;
}

function unwrapGuiCallable(graph, decl, seen = new Set()) {
  if (!decl || seen.has(decl)) return null;
  seen.add(decl);
  if (isFunctionNode(decl)) return decl;
  if (ts.isShorthandPropertyAssignment(decl)) {
    const target = resolveGuiBindingDecl(graph, graph.lookup(decl.name.text, decl));
    return unwrapGuiCallable(graph, target, seen);
  }
  if (ts.isPropertyAssignment(decl) || ts.isVariableDeclaration(decl)) {
    const init = unwrap(decl.initializer);
    if (!init) return null;
    if (isFunctionNode(init)) return init;
    if (ts.isIdentifier(init))
      return unwrapGuiCallable(graph, resolveGuiBindingDecl(graph, graph.lookup(init.text, init)), seen);
    if (ts.isPropertyAccessExpression(init)) {
      const propFn = resolveGuiHookPropertyFn(graph, init);
      if (propFn) return propFn;
      for (const sig of graph.memberSignature(init) ?? []) {
        const fn = unwrapGuiCallable(graph, sig, seen);
        if (fn) return fn;
      }
    }
    if (ts.isCallExpression(init)) {
      const callee = unwrap(init.expression);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if ((name === "useCallback" || name === "useMemo") && init.arguments[0]) {
        const inner = unwrap(init.arguments[0]);
        if (inner && isFunctionNode(inner)) return inner;
      }
    }
  }
  return null;
}

function resolveGuiBridgeMethodCall(graph, callExpr, env, descriptors) {
  const callee = unwrap(callExpr.expression);
  let methodName = null;
  if (callee && ts.isPropertyAccessExpression(callee)) methodName = callee.name.text;
  else if (callee && ts.isElementAccessExpression(callee))
    methodName = evalGuiString(graph, callee.argumentExpression, env);
  if (!methodName) return null;
  const targetExpr =
    callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      ? unwrap(callee.expression)
      : null;
  if (!targetExpr || !ts.isCallExpression(targetExpr)) return null;
  const bridgeDecl = graph.callDeclaration(targetExpr) ?? resolveGuiExprFn(graph, targetExpr.expression);
  if (!bridgeDecl || !guiClientSource(graph, bridgeDecl)) return null;
  const proto =
    descriptors.find((d) => d.guiBridgeMethod === methodName) ??
    allDaemonProtocolMethods.find((m) => m.guiBridgeMethod === methodName);
  if (!proto) return null;
  return resolveGuiRpcMethod(graph, proto.method, callExpr.arguments[0], env, descriptors);
}

function findGuiObjectPropertyFn(graph, objExpr, propName) {
  for (const p of objExpr.properties) {
    if (
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === propName
    )
      return unwrapGuiCallable(graph, p);
  }
  return null;
}

function unwrapGuiMemoOrVarExpr(graph, expr, seen = new Set()) {
  const u = unwrap(expr);
  if (!u || seen.has(u)) return null;
  seen.add(u);
  if (ts.isIdentifier(u)) {
    const decl = resolveGuiBindingDecl(graph, graph.lookup(u.text, u));
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
      return unwrapGuiMemoOrVarExpr(graph, decl.initializer, seen);
  }
  if (ts.isCallExpression(u)) {
    const callee = unwrap(u.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (name === "useMemo" && u.arguments[0]) {
      const inner = unwrap(u.arguments[0]);
      if (inner && isFunctionNode(inner)) {
        const ret = returnExpressions(inner)[0];
        if (ret) return unwrapGuiMemoOrVarExpr(graph, ret, seen);
      }
    }
  }
  return u;
}

function unwrapGuiObjectLiteral(graph, expr, seen = new Set()) {
  const u = unwrapGuiMemoOrVarExpr(graph, expr, seen);
  return u && ts.isObjectLiteralExpression(u) ? u : null;
}

function findGuiHookReturnFn(graph, callExpr, propName, seen = new Set()) {
  const hookFn = unwrapGuiCallable(
    graph,
    graph.callDeclaration(callExpr) ??
      (ts.isIdentifier(callExpr.expression)
        ? resolveGuiBindingDecl(graph, graph.lookup(callExpr.expression.text, callExpr.expression))
        : null),
  );
  if (!hookFn?.body || seen.has(hookFn)) return null;
  seen.add(hookFn);
  let found = null;
  for (const retExpr of returnExpressions(hookFn)) {
    if (found) break;
    const retObj = unwrapGuiObjectLiteral(graph, retExpr);
    if (retObj) found = findGuiObjectPropertyFn(graph, retObj, propName);
    else {
      const forwarded = unwrapGuiMemoOrVarExpr(graph, retExpr);
      if (forwarded && ts.isCallExpression(forwarded)) found = findGuiHookReturnFn(graph, forwarded, propName, seen);
    }
  }
  return found;
}

function resolveGuiHookPropertyFn(graph, access) {
  if (!ts.isIdentifier(access.expression)) return null;
  const objDecl = resolveGuiBindingDecl(graph, graph.lookup(access.expression.text, access.expression));
  if (!objDecl || !ts.isVariableDeclaration(objDecl)) return null;
  const objInit = unwrapGuiMemoOrVarExpr(graph, objDecl.initializer);
  if (!objInit) return null;
  if (ts.isObjectLiteralExpression(objInit)) return findGuiObjectPropertyFn(graph, objInit, access.name.text);
  return ts.isCallExpression(objInit) ? findGuiHookReturnFn(graph, objInit, access.name.text) : null;
}

function resolveGuiExprFn(graph, expr) {
  const unwrapped = unwrap(expr);
  if (!unwrapped) return null;
  if (isFunctionNode(unwrapped)) return unwrapped;
  if (ts.isIdentifier(unwrapped)) {
    const b = graph.lookup(unwrapped.text, unwrapped);
    if (b?.kind === "var" && b.trail?.length === 1 && b.declaration.initializer) {
      const init = unwrapGuiMemoOrVarExpr(graph, b.declaration.initializer);
      if (init && ts.isObjectLiteralExpression(init)) return findGuiObjectPropertyFn(graph, init, b.trail[0]);
      if (init && ts.isCallExpression(init)) return findGuiHookReturnFn(graph, init, b.trail[0]);
    }
    return unwrapGuiCallable(graph, resolveGuiBindingDecl(graph, b));
  }
  if (ts.isPropertyAccessExpression(unwrapped)) return resolveGuiHookPropertyFn(graph, unwrapped);
  return null;
}

function resolveGuiUseMutationFn(graph, callExpr) {
  const callee = unwrap(callExpr.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  if (callee.name.text !== "mutate" && callee.name.text !== "mutateAsync") return null;
  const b = graph.lookup(callee.expression.text, callee.expression);
  const init = b?.kind === "var" && b.declaration.initializer ? unwrap(b.declaration.initializer) : null;
  if (!init || !ts.isCallExpression(init)) return null;
  const hookCallee = unwrap(init.expression);
  const hookName = ts.isIdentifier(hookCallee) ? hookCallee.text : "";
  if (hookName !== "useMutation" || !init.arguments[0]) return null;
  const opts = unwrapGuiObjectLiteral(graph, init.arguments[0]);
  return opts ? findGuiObjectPropertyFn(graph, opts, "mutationFn") : null;
}

function reactStateSetterCall(graph, expr) {
  const u = unwrap(expr);
  const b = u && ts.isIdentifier(u) ? graph.lookup(u.text, u) : null;
  const init = b?.kind === "var" && b.trail?.length === 1 ? unwrap(b.declaration.initializer) : null;
  const callee = init && ts.isCallExpression(init) ? unwrap(init.expression) : null;
  const cb = callee && ts.isIdentifier(callee) ? graph.lookup(callee.text, callee) : null;
  return cb?.kind === "import" && cb.from === "react" && (cb.exported === "useState" || cb.exported === "useReducer")
    ? init
    : null;
}

function resolveGuiParamTarget(graph, callee) {
  if (!callee) return null;
  if (ts.isIdentifier(callee)) {
    const b = graph.lookup(callee.text, callee);
    if (b?.kind === "param" && (b.trail?.length ?? 0) === 0) return { param: b.parameter, propName: null };
    if (b?.kind === "param" && b.trail?.length === 1) return { param: b.parameter, propName: b.trail[0] };
    if (b?.kind === "var" && b.trail?.length === 1 && b.declaration.initializer) {
      const init = unwrap(b.declaration.initializer);
      const pb = init && ts.isIdentifier(init) ? graph.lookup(init.text, init) : null;
      if (pb?.kind === "param" && (pb.trail?.length ?? 0) === 0) return { param: pb.parameter, propName: b.trail[0] };
    }
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const b = graph.lookup(callee.expression.text, callee.expression);
    if (b?.kind === "param" && (b.trail?.length ?? 0) === 0) return { param: b.parameter, propName: callee.name.text };
  }
  return null;
}

const guiParamEnvKey = (graph, param, propName) => `fn:${sourceSite(graph, param)}:${propName ?? ""}`;

function resolveGuiBoundArg(graph, argExpr, env) {
  const u = unwrap(argExpr);
  if (!u) return null;
  const target = resolveGuiParamTarget(graph, u);
  if (target) {
    const bound = env.get(guiParamEnvKey(graph, target.param, target.propName));
    if (bound) return bound;
  }
  return { expr: u, env };
}

function walkGuiCallbackExpr(ctx, expr, env, depth) {
  const fn = resolveGuiExprFn(ctx.graph, expr);
  if (!fn || !guiClientSource(ctx.graph, fn)) return;
  if (isFunctionNode(unwrap(expr))) {
    walkGuiSubtree(ctx, fn.body ?? fn, env, depth);
  } else if (!ctx.visitedFns.has(fn)) {
    ctx.visitedFns.add(fn);
    walkGuiSubtree(ctx, fn.body ?? fn, env, depth);
  }
}

const GUI_STREAM_DISPOSER_METHODS = new Set(daemonGuiStreamFacets.map((f) => f.guiBridgeMethod));

function streamDisposerCall(graph, expr, seen = new Set()) {
  const u = unwrap(expr);
  if (!u || seen.has(u)) return null;
  seen.add(u);
  if (ts.isIdentifier(u)) {
    const decl = resolveGuiBindingDecl(graph, graph.lookup(u.text, u));
    return decl && ts.isVariableDeclaration(decl) && decl.initializer
      ? streamDisposerCall(graph, decl.initializer, seen)
      : null;
  }
  if (!ts.isCallExpression(u)) return null;
  const callee = unwrap(u.expression);
  if (
    callee &&
    ts.isPropertyAccessExpression(callee) &&
    GUI_STREAM_DISPOSER_METHODS.has(callee.name.text) &&
    ts.isCallExpression(unwrap(callee.expression))
  ) {
    const bridgeDecl =
      graph.callDeclaration(unwrap(callee.expression)) ?? resolveGuiExprFn(graph, unwrap(callee.expression).expression);
    if (bridgeDecl && guiClientSource(graph, bridgeDecl)) return u;
  }
  const fn = resolveGuiExprFn(graph, callee);
  const rets = fn ? returnExpressions(fn) : [];
  return rets.length > 0 && rets.every((ret) => streamDisposerCall(graph, ret, seen)) ? u : null;
}

function resolveGuiRefMapValues(graph, expr) {
  if (!ts.isCallExpression(expr)) return null;
  const callee = unwrap(expr.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee) || callee.name.text !== "get") return null;
  const cur = unwrap(callee.expression);
  if (!cur || !ts.isPropertyAccessExpression(cur) || cur.name.text !== "current" || !ts.isIdentifier(cur.expression))
    return null;
  const b = graph.lookup(cur.expression.text, cur.expression);
  const init = b?.kind === "var" && b.declaration.initializer ? unwrap(b.declaration.initializer) : null;
  const initCallee = init && ts.isCallExpression(init) ? unwrap(init.expression) : null;
  const mapArg =
    initCallee && ts.isIdentifier(initCallee) && initCallee.text === "useRef" ? unwrap(init.arguments[0]) : null;
  if (!mapArg || !ts.isNewExpression(mapArg) || mapArg.expression.getText() !== "Map") return null;
  const scope = b.declaration.parent?.parent?.parent ?? b.declaration.getSourceFile();
  const values = [];
  (function scan(n) {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      const inner = c && ts.isPropertyAccessExpression(c) && c.name.text === "set" ? unwrap(c.expression) : null;
      if (
        inner &&
        ts.isPropertyAccessExpression(inner) &&
        inner.name.text === "current" &&
        ts.isIdentifier(inner.expression) &&
        inner.expression.text === cur.expression.text &&
        graph.lookup(inner.expression.text, inner.expression)?.declaration === b.declaration
      )
        values.push(n.arguments[1] ?? null);
    }
    ts.forEachChild(n, scan);
  })(scope);
  return values;
}

function invokeGuiSuppliedCallback(ctx, argExpr, supplierEnv, invokeCallExpr, invokeEnv, depth) {
  const u = unwrap(argExpr);
  if (!u) {
    ctx.hasUnprovenCallback = true;
    return;
  }
  if (ts.isConditionalExpression(u)) {
    invokeGuiSuppliedCallback(ctx, u.whenTrue, supplierEnv, invokeCallExpr, invokeEnv, depth);
    invokeGuiSuppliedCallback(ctx, u.whenFalse, supplierEnv, invokeCallExpr, invokeEnv, depth);
    return;
  }
  if (
    ts.isBinaryExpression(u) &&
    (u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || u.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    invokeGuiSuppliedCallback(ctx, u.left, supplierEnv, invokeCallExpr, invokeEnv, depth);
    invokeGuiSuppliedCallback(ctx, u.right, supplierEnv, invokeCallExpr, invokeEnv, depth);
    return;
  }
  const paramTarget = resolveGuiParamTarget(ctx.graph, u);
  if (paramTarget) {
    const bound = supplierEnv.get(guiParamEnvKey(ctx.graph, paramTarget.param, paramTarget.propName));
    if (bound) {
      if (!bound.omitted) invokeGuiSuppliedCallback(ctx, bound.expr, bound.env, invokeCallExpr, invokeEnv, depth);
      return;
    }
    const outerFn = paramTarget.param?.parent;
    const outerIdx = outerFn?.parameters?.indexOf(paramTarget.param) ?? -1;
    if (outerFn && isFunctionNode(outerFn) && outerIdx >= 0) {
      walkGuiParamCallers(ctx, outerFn, outerIdx, paramTarget.propName, invokeCallExpr, invokeEnv, depth);
    } else {
      ctx.hasUnprovenCallback = true;
    }
    return;
  }
  const fn = resolveGuiExprFn(ctx.graph, u);
  if (fn && guiClientSource(ctx.graph, fn)) {
    const calleeEnv = invokeCallExpr ? buildGuiCalleeEnv(ctx.graph, fn, invokeCallExpr, invokeEnv) : supplierEnv;
    const visitKey = `${sourceSite(ctx.graph, fn)}::${invokeCallExpr ? sourceSite(ctx.graph, invokeCallExpr) : ""}`;
    if (!ctx.visitedCallbackFrames.has(visitKey)) {
      ctx.visitedCallbackFrames.add(visitKey);
      walkGuiSubtree(ctx, fn.body ?? fn, calleeEnv, depth);
    }
    return;
  }
  if (reactStateSetterCall(ctx.graph, u) || streamDisposerCall(ctx.graph, u)) return;
  const refMapValues = resolveGuiRefMapValues(ctx.graph, u);
  if (refMapValues) {
    if (refMapValues.length === 0) ctx.hasUnprovenCallback = true;
    else
      for (const val of refMapValues)
        invokeGuiSuppliedCallback(ctx, val, supplierEnv, invokeCallExpr, invokeEnv, depth);
    return;
  }
  if (
    ts.isObjectLiteralExpression(u) ||
    ts.isArrayLiteralExpression(u) ||
    ts.isStringLiteralLike(u) ||
    ts.isNumericLiteral(u) ||
    u.kind === ts.SyntaxKind.TrueKeyword ||
    u.kind === ts.SyntaxKind.FalseKeyword ||
    u.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(u) && u.text === "undefined")
  ) {
    walkGuiSubtree(ctx, u, supplierEnv, depth);
    return;
  }
  ctx.hasUnprovenCallback = true;
}

function collectParamCallsInFn(graph, fn, param, propName) {
  const calls = [];
  if (!fn?.body) return calls;
  (function scan(n) {
    if (ts.isCallExpression(n)) {
      const t = resolveGuiParamTarget(graph, unwrap(n.expression));
      if (t && t.param === param && t.propName === propName) calls.push(n);
    }
    ts.forEachChild(n, scan);
  })(fn.body);
  return calls;
}

function readObjectPropExpr(graph, objLit, propName) {
  let found = undefined;
  let opaqueSpread = false;
  for (const prop of objLit.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
      prop.name.text === propName
    ) {
      found = ts.isPropertyAssignment(prop)
        ? prop.initializer
        : ts.isShorthandPropertyAssignment(prop)
          ? prop.name
          : prop;
      opaqueSpread = false;
    } else if (ts.isSpreadAssignment(prop)) {
      const inner = unwrapGuiObjectLiteral(graph, prop.expression);
      if (inner) {
        const sub = readObjectPropExpr(graph, inner, propName);
        if (sub.found !== undefined) found = sub.found;
        if (sub.opaqueSpread) opaqueSpread = true;
      } else {
        opaqueSpread = true;
      }
    }
  }
  return { found, opaqueSpread };
}

const guiSupplyCache = new WeakMap();

function guiSupplyIndex(graph) {
  const hit = guiSupplyCache.get(graph.modules);
  if (hit) return hit;
  const calls = [],
    jsxElements = [],
    mutateCalls = [],
    calleeFns = new Map(),
    tagFns = new Map();
  for (const [file, mod] of graph.modules) {
    if (!/^packages\/gui\/src\/(?:renderer|preload|browser)\//u.test(file)) continue;
    (function collect(n) {
      if (ts.isCallExpression(n)) {
        calls.push(n);
        const fn = resolveGuiUseMutationFn(graph, n);
        if (fn) mutateCalls.push({ call: n, fn });
      } else if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        jsxElements.push(n);
      }
      ts.forEachChild(n, collect);
    })(mod.sourceFile);
  }
  const index = { calls, jsxElements, mutateCalls, calleeFns, tagFns };
  guiSupplyCache.set(graph.modules, index);
  return index;
}

function guiIndexCalleeOf(graph, index, node) {
  if (index.calleeFns.has(node)) return index.calleeFns.get(node);
  const fn = resolveGuiExprFn(graph, node.expression);
  index.calleeFns.set(node, fn ?? null);
  return fn ?? null;
}

function guiIndexCompOf(graph, index, node) {
  if (index.tagFns.has(node)) return index.tagFns.get(node);
  const fn = resolveGuiExprFn(graph, node.tagName);
  index.tagFns.set(node, fn ?? null);
  return fn ?? null;
}

function pushGuiSuppliedArg(supplied, targetFn, paramIdx, rawArg) {
  const param = targetFn.parameters?.[paramIdx];
  const arg = rawArg ?? param?.initializer;
  if (arg !== undefined) supplied.push(arg);
  else if (!param?.questionToken) supplied.push(null);
}

function collectGuiHigherOrderPropArgs(ctx, calledFn, k, node, targetFn, paramIdx, pushHit) {
  const argObj = unwrapGuiObjectLiteral(ctx.graph, node.arguments[k]);
  if (!argObj) return;
  for (const p of argObj.properties) {
    if (
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
    ) {
      const pExpr = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p;
      if (resolveGuiExprFn(ctx.graph, pExpr) === targetFn)
        for (const c of collectParamCallsInFn(ctx.graph, calledFn, calledFn.parameters[k], p.name.text)) pushHit(c);
    }
  }
}

function collectGuiSuppliedArgs(ctx, targetFn, paramIdx, propName) {
  const index = guiSupplyIndex(ctx.graph);
  const supplied = [];
  let matched = 0;
  const pushHit = (c) => {
    matched += 1;
    pushGuiSuppliedArg(supplied, targetFn, paramIdx, c.arguments[paramIdx]);
  };
  if (propName === null && paramIdx === 0) {
    for (const m of index.mutateCalls) if (m.fn === targetFn) pushHit(m.call);
  }
  for (const node of index.calls) {
    if (propName === null && paramIdx === 0 && index.mutateCalls.some((m) => m.call === node && m.fn === targetFn))
      continue;
    const calledFn = guiIndexCalleeOf(ctx.graph, index, node);
    if (calledFn === targetFn) {
      matched += 1;
      if (propName === null) pushGuiSuppliedArg(supplied, targetFn, paramIdx, node.arguments[paramIdx]);
      else {
        const param = targetFn.parameters?.[paramIdx];
        const rawObj = node.arguments[paramIdx] ?? param?.initializer;
        if (rawObj === undefined && param?.questionToken) continue;
        const argObj = unwrapGuiObjectLiteral(ctx.graph, rawObj);
        if (!argObj) supplied.push(null);
        else {
          const { found, opaqueSpread } = readObjectPropExpr(ctx.graph, argObj, propName);
          if (opaqueSpread && found === undefined) supplied.push(null);
          else if (found !== undefined) supplied.push(found);
        }
      }
    } else if (propName === null && calledFn?.parameters?.length) {
      for (let k = 0; k < node.arguments.length; k += 1) {
        if (!calledFn.parameters[k]) continue;
        if (resolveGuiExprFn(ctx.graph, node.arguments[k]) === targetFn)
          for (const c of collectParamCallsInFn(ctx.graph, calledFn, calledFn.parameters[k], null)) pushHit(c);
        else collectGuiHigherOrderPropArgs(ctx, calledFn, k, node, targetFn, paramIdx, pushHit);
      }
    }
  }
  for (const node of index.jsxElements) {
    const compFn = guiIndexCompOf(ctx.graph, index, node);
    if (compFn === targetFn && propName !== null && paramIdx === 0) {
      matched += 1;
      let attrExpr = undefined;
      let opaqueSpread = false;
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === propName) {
          attrExpr = attr.initializer
            ? ts.isJsxExpression(attr.initializer)
              ? (attr.initializer.expression ?? null)
              : attr.initializer
            : null;
          opaqueSpread = false;
        } else if (ts.isJsxSpreadAttribute(attr)) {
          const spreadObj = unwrapGuiObjectLiteral(ctx.graph, attr.expression);
          if (spreadObj) {
            const sub = readObjectPropExpr(ctx.graph, spreadObj, propName);
            if (sub.found !== undefined) attrExpr = sub.found;
            if (sub.opaqueSpread) opaqueSpread = true;
          } else {
            opaqueSpread = true;
          }
        }
      }
      if (opaqueSpread && attrExpr === undefined) supplied.push(null);
      else if (attrExpr !== undefined) supplied.push(attrExpr);
    } else if (propName === null && compFn?.parameters?.[0]) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.initializer) {
          const expr = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
          if (expr && resolveGuiExprFn(ctx.graph, expr) === targetFn)
            for (const c of collectParamCallsInFn(ctx.graph, compFn, compFn.parameters[0], attr.name.text)) pushHit(c);
        }
      }
    }
  }
  return { supplied, matched };
}

function walkGuiParamCallers(ctx, targetFn, paramIdx, propName, invokeCallExpr, invokeEnv, depth) {
  const paramKey = `${sourceSite(ctx.graph, targetFn)}:${paramIdx}:${propName ?? ""}`;
  if (ctx.activeParams.includes(paramKey)) return;
  ctx.activeParams.push(paramKey);
  const { supplied, matched } = collectGuiSuppliedArgs(ctx, targetFn, paramIdx, propName);
  if (matched === 0) {
    ctx.hasUnprovenCallback = true;
  } else {
    for (const expr of supplied) invokeGuiSuppliedCallback(ctx, expr, new Map(), invokeCallExpr, invokeEnv, depth);
  }
  ctx.activeParams.pop();
}

const GUI_NON_CALLBACK_METHODS = new Set([
  "trim",
  "slice",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "flatMap",
  "reduce",
  "forEach",
  "includes",
  "startsWith",
  "endsWith",
  "replace",
  "replaceAll",
  "split",
  "join",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "localeCompare",
  "match",
  "get",
  "set",
  "has",
  "delete",
  "add",
  "push",
  "pop",
  "shift",
  "unshift",
  "sort",
  "preventDefault",
  "stopPropagation",
  "focus",
  "blur",
  "scrollIntoView",
  "contains",
  "getBoundingClientRect",
]);

function walkGuiInjectedParam(ctx, callExpr, env, depth) {
  const target = resolveGuiParamTarget(ctx.graph, unwrap(callExpr.expression));
  if (!target) return;
  if (target.propName && GUI_NON_CALLBACK_METHODS.has(target.propName)) return;
  const callDecl = ctx.graph.callDeclaration(callExpr);
  if (callDecl && ts.isMethodDeclaration(callDecl) && ts.isClassLike(callDecl.parent)) return;
  const callDeclFile = callDecl?.getSourceFile().fileName ?? "";
  if (/\/node_modules\//u.test(callDeclFile) && !/\/node_modules\/@types\/react\//u.test(callDeclFile)) return;
  const enclosingFn = target.param?.parent;
  const paramIdx = enclosingFn?.parameters?.indexOf(target.param) ?? -1;
  if (!enclosingFn || !isFunctionNode(enclosingFn) || paramIdx < 0) return;
  const bound = env.get(guiParamEnvKey(ctx.graph, target.param, target.propName));
  if (bound) {
    if (!bound.omitted) invokeGuiSuppliedCallback(ctx, bound.expr, bound.env, callExpr, env, depth);
    return;
  }
  if (callExpr === ctx.entryNode && target.propName === null) ctx.viaCallbackParam = true;
  walkGuiParamCallers(ctx, enclosingFn, paramIdx, target.propName, callExpr, env, depth);
}

function buildGuiCalleeEnv(graph, fn, callExpr, env) {
  let entries = [...env];
  for (let i = 0; i < (fn.parameters?.length ?? 0); i += 1) {
    const param = fn.parameters[i];
    if (!param) continue;
    const paramPrefix = `fn:${sourceSite(graph, param)}:`;
    const pName = param.name;
    const identName = pName && ts.isIdentifier(pName) ? pName.text : null;
    entries = entries.filter(
      ([k]) => !k.startsWith(paramPrefix) && (!identName || (k !== identName && !k.startsWith(`field:${identName}:`))),
    );
    const argExpr = callExpr.arguments[i] ?? param.initializer;
    if (argExpr === undefined && param.questionToken) {
      entries.push([guiParamEnvKey(graph, param, null), { omitted: true }]);
      continue;
    }
    if (identName) {
      const val = evalGuiString(graph, argExpr, env);
      if (val !== null) entries.push([identName, val]);
    }
    const boundArg = resolveGuiBoundArg(graph, argExpr, env);
    if (boundArg) entries.push([guiParamEnvKey(graph, param, null), boundArg]);
    const argObj = unwrapGuiObjectLiteral(graph, argExpr);
    if (argObj) {
      for (const prop of argObj.properties) {
        if (
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
        ) {
          const propExpr = ts.isPropertyAssignment(prop)
            ? prop.initializer
            : ts.isShorthandPropertyAssignment(prop)
              ? prop.name
              : prop;
          if (identName) {
            const fv = evalGuiString(graph, propExpr, env);
            if (fv !== null) entries.push([`field:${identName}:${prop.name.text}`, fv]);
          }
          const boundProp = resolveGuiBoundArg(graph, propExpr, env);
          if (boundProp) entries.push([guiParamEnvKey(graph, param, prop.name.text), boundProp]);
        }
      }
    }
  }
  return new Map(entries);
}

function guiGuardIncrement(stmt) {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return 0;
  const thenStmt = stmt.thenStatement;
  if (ts.isReturnStatement(thenStmt) || ts.isThrowStatement(thenStmt)) return 1;
  if (ts.isBlock(thenStmt) && thenStmt.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s)))
    return 1;
  return 0;
}

function walkGuiResolvedCallee(ctx, calleeExpr, callExpr, env, depth) {
  const u = unwrap(calleeExpr);
  if (!u) return;
  if (ts.isConditionalExpression(u)) {
    walkGuiResolvedCallee(ctx, u.whenTrue, callExpr, env, depth);
    walkGuiResolvedCallee(ctx, u.whenFalse, callExpr, env, depth);
    return;
  }
  let fn = resolveGuiExprFn(ctx.graph, u);
  if (!fn && u === unwrap(callExpr.expression)) {
    const decl = ctx.graph.callDeclaration(callExpr);
    if (decl && guiClientSource(ctx.graph, decl)) fn = unwrapGuiCallable(ctx.graph, decl);
  }
  if (!fn) fn = resolveGuiUseMutationFn(ctx.graph, callExpr);
  if (fn && guiClientSource(ctx.graph, fn) && !ctx.activeFns.includes(fn)) {
    ctx.activeFns.push(fn);
    walkGuiSubtree(ctx, fn.body ?? fn, buildGuiCalleeEnv(ctx.graph, fn, callExpr, env), depth);
    ctx.activeFns.pop();
  }
}

function resolveGuiCallPortKey(graph, callExpr) {
  const typed = declaredPortKey(graph, callExpr);
  if (typed) return typed;
  const lexFn = resolveGuiExprFn(graph, callExpr.expression);
  if (lexFn && graph.fileOf(lexFn) === "packages/gui/src/renderer/api-client-invoke.ts")
    return "packages/gui/src/renderer/api-client-invoke.ts#invoke";
  return null;
}

function walkGuiCall(ctx, callExpr, env, depth) {
  const portKey = resolveGuiCallPortKey(ctx.graph, callExpr);
  if (portKey === "packages/gui/src/renderer/api-client-invoke.ts#invoke") {
    ctx.reachesDaemonTransport = true;
    const method = evalGuiString(ctx.graph, callExpr.arguments[0], env);
    const hit = method ? resolveGuiRpcMethod(ctx.graph, method, callExpr.arguments[1], env, ctx.descriptors) : null;
    if (hit) ctx.rawBindings.push({ ...hit, depth });
    else ctx.hasUnprovenCallback = true;
    return;
  }
  const preloadHit = resolveGuiPreloadIpcLeaf(ctx.graph, callExpr, portKey, env);
  if (preloadHit) {
    if (preloadHit.reachesDaemon) ctx.reachesDaemonTransport = true;
    if (preloadHit.binding) ctx.rawBindings.push({ ...preloadHit.binding, depth });
    else if (preloadHit.reachesDaemon) ctx.hasUnprovenCallback = true;
    return;
  }
  if (portKey && GUI_BRIDGE_INTERFACE_PORTS.has(portKey)) {
    ctx.reachesDaemonTransport = true;
    ctx.rawBindings.push({ ...GUI_BRIDGE_INTERFACE_PORTS.get(portKey), depth });
    return;
  }
  const bridgeHit = resolveGuiBridgeMethodCall(ctx.graph, callExpr, env, ctx.descriptors);
  if (bridgeHit) {
    ctx.reachesDaemonTransport = true;
    ctx.rawBindings.push({ ...bridgeHit, depth });
    return;
  }
  for (const arg of callExpr.arguments) {
    const unwrapped = unwrap(arg);
    if (unwrapped && isFunctionNode(unwrapped)) walkGuiSubtree(ctx, unwrapped.body ?? unwrapped, env, depth);
    else if (unwrapped && ts.isObjectLiteralExpression(unwrapped)) {
      for (const prop of unwrapped.properties) {
        if (ts.isPropertyAssignment(prop)) walkGuiCallbackExpr(ctx, prop.initializer, env, depth);
        else if (ts.isShorthandPropertyAssignment(prop)) walkGuiCallbackExpr(ctx, prop.name, env, depth);
      }
    }
  }
  walkGuiInjectedParam(ctx, callExpr, env, depth);
  walkGuiResolvedCallee(ctx, callExpr.expression, callExpr, env, depth);
}

function walkGuiSubtree(ctx, root, env, depth) {
  if (!root) return;
  if (ts.isBlock(root)) {
    let currentDepth = depth;
    for (const stmt of root.statements) {
      walkGuiSubtree(ctx, stmt, env, currentDepth);
      currentDepth += guiGuardIncrement(stmt);
    }
    return;
  }
  if (ts.isCallExpression(root)) walkGuiCall(ctx, root, env, depth);
  const nextDepth = depth + (ts.isIfStatement(root) || ts.isConditionalExpression(root) ? 1 : 0);
  ts.forEachChild(root, (child) => {
    if (isFunctionNode(child)) return;
    walkGuiSubtree(ctx, child, env, nextDepth);
  });
}

/** Resolve daemon RPC or daemon-forwarding IPC actions reached by a non-main GUI callsite. */
export function resolvedGuiClientBindings(graph, node, descriptors = []) {
  const empty = {
    bindings: [],
    reachesDaemonTransport: false,
    viaCallbackParam: false,
    hasUnprovenCallback: false,
  };
  if (!ts.isCallExpression(node) || !guiClientSource(graph, node)) return empty;
  const ctx = {
    graph,
    descriptors,
    entryNode: node,
    rawBindings: [],
    visitedFns: new Set(),
    visitedCallbackFrames: new Set(),
    activeFns: [],
    activeParams: [],
    reachesDaemonTransport: false,
    viaCallbackParam: false,
    hasUnprovenCallback: false,
  };
  walkGuiCall(ctx, node, new Map(), 0);
  const unique = new Map();
  for (const b of ctx.rawBindings) {
    const key = `${b.actionKind}::${b.route}`;
    const prev = unique.get(key);
    if (!prev || b.depth < prev.depth) unique.set(key, b);
  }
  const all = [...unique.values()];
  const writes = all.filter((b) => !b.isRead);
  const minWriteDepth = writes.length > 0 ? Math.min(...writes.map((b) => b.depth)) : 0;
  const selectedWrites = ctx.viaCallbackParam ? writes : writes.filter((b) => b.depth === minWriteDepth);
  const reads = all.filter((b) => b.isRead);
  let bindings = (selectedWrites.length > 0 ? selectedWrites : reads)
    .map(({ actionKind, route, isRead }) => ({ actionKind, route, isRead }))
    .sort((a, b) => a.route.localeCompare(b.route) || a.actionKind.localeCompare(b.actionKind));
  if (writes.length === 0 && reads.length > 1 && reads.every((b) => b.actionKind === "repository-read"))
    bindings = [{ actionKind: "repository-read", route: "repository-read", isRead: true }];
  return {
    bindings,
    reachesDaemonTransport: ctx.reachesDaemonTransport,
    viaCallbackParam: ctx.viaCallbackParam,
    hasUnprovenCallback: ctx.hasUnprovenCallback,
  };
}

function listGuiClientTreeFiles(rootDir) {
  const result = [];
  function walkDir(relDir) {
    const abs = path.join(rootDir, relDir);
    if (!fs.existsSync(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.posix.join(relDir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "test" && ent.name !== "tests" && ent.name !== "fixtures") walkDir(childRel);
      } else if (
        /\.tsx?$/u.test(ent.name) &&
        !/\.(?:test|spec|vitest)\.tsx?$/u.test(ent.name) &&
        !ent.name.endsWith(".d.ts")
      ) {
        result.push(childRel);
      }
    }
  }
  for (const dir of ["packages/gui/src/renderer", "packages/gui/src/preload", "packages/gui/src/browser"]) walkDir(dir);
  return result;
}

function collectParamBindingNames(nameNode, out) {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode)) out.add(nameNode.text);
  else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) if (ts.isBindingElement(el)) collectParamBindingNames(el.name, out);
  }
}

function findGuiDirectCallbackSink(text, filePath) {
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let sinkNode = null;
  function checkCallee(expr, params) {
    const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (ts.isIdentifier(e) && (params.has(e.text) || e.text === "useMutation")) return e;
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      params.has(e.expression.text) &&
      !GUI_NON_CALLBACK_METHODS.has(e.name.text)
    )
      return e;
    if (ts.isConditionalExpression(e)) return checkCallee(e.whenTrue, params) ?? checkCallee(e.whenFalse, params);
    return null;
  }
  (function walkAst(node) {
    if (sinkNode) return;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      node.body
    ) {
      const params = new Set();
      for (const p of node.parameters ?? []) collectParamBindingNames(p.name, params);
      (function scanBody(child) {
        if (sinkNode) return;
        if (ts.isCallExpression(child)) sinkNode = checkCallee(child.expression, params);
        if (!sinkNode) ts.forEachChild(child, scanBody);
      })(node.body);
    }
    if (!sinkNode) ts.forEachChild(node, walkAst);
  })(sf);
  return sinkNode;
}

export function guiCallbackCallerFiles(rootDir, seedFiles) {
  if (seedFiles.length === 0) return [];
  const allFiles = listGuiClientTreeFiles(rootDir),
    fileSet = new Set(allFiles),
    texts = new Map(),
    forward = new Map(),
    reverse = new Map(),
    specRe = /(?:from|import)\s*\(?["'](\.[^"']+)["']/gu;
  for (const file of allFiles) {
    const text = fs.readFileSync(path.join(rootDir, file), "utf8");
    texts.set(file, text);
    const baseDir = path.posix.dirname(file),
      deps = new Set();
    for (const m of text.matchAll(specRe)) {
      const raw = path.posix.normalize(`${baseDir}/${m[1]}`).replace(/\.[cm]?js$/u, "");
      for (const cand of [raw, `${raw}.ts`, `${raw}.tsx`, `${raw}/index.ts`, `${raw}/index.tsx`]) {
        if (fileSet.has(cand)) {
          deps.add(cand);
          let rev = reverse.get(cand);
          if (!rev) {
            rev = new Set();
            reverse.set(cand, rev);
          }
          rev.add(file);
        }
      }
    }
    forward.set(file, deps);
  }
  const forwardClosure = new Set(seedFiles.filter((f) => fileSet.has(f))),
    fwdQueue = [...forwardClosure];
  while (fwdQueue.length > 0) {
    for (const dep of forward.get(fwdQueue.pop()) ?? []) {
      if (!forwardClosure.has(dep)) {
        forwardClosure.add(dep);
        fwdQueue.push(dep);
      }
    }
  }
  const callers = new Set(),
    revQueue = [...forwardClosure].filter((f) => findGuiDirectCallbackSink(texts.get(f) ?? "", f));
  while (revQueue.length > 0) {
    for (const caller of reverse.get(revQueue.pop()) ?? []) {
      if (!callers.has(caller)) {
        callers.add(caller);
        revQueue.push(caller);
      }
    }
  }
  const lexical = new Set([...forwardClosure, ...callers]),
    lexQueue = [...callers];
  while (lexQueue.length > 0) {
    for (const dep of forward.get(lexQueue.pop()) ?? []) {
      if (!lexical.has(dep)) {
        lexical.add(dep);
        lexQueue.push(dep);
      }
    }
  }
  return [...lexical];
}
