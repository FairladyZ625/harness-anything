// GUI main forwards business authority (dec_7E44897ECDCAEF2B92EC66A260/CH1).
import ts from "typescript";
import {
  interactiveRpcMethods,
  daemonProtocolCommands,
} from "../../packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts";
import { unwrap } from "./authorization-flow-graph.mjs";

const main = "packages/gui/src/main/";
const composition = `${main}local-composition-root.ts`;
const bridgePort = `${composition}#GuiServiceBridge.invoke`;
const preload = "packages/gui/src/preload/electron-preload.ts";
const compact = (node) => node?.getText().replace(/\s+/gu, "");
const failed = () => ({
  bindings: [],
  reachesDaemonTransport: true,
  viaCallbackParam: true,
  hasUnprovenCallback: true,
});

function descendants(node, predicate) {
  const result = [];
  if (node)
    (function visit(child) {
      if (predicate(child)) result.push(child);
      ts.forEachChild(child, visit);
    })(node);
  return result;
}
function named(graph, file, name, predicate) {
  return descendants(graph.modules.get(file)?.sourceFile, (n) => predicate(n) && n.name?.getText() === name)[0];
}
const fn = (graph, file, name) => named(graph, file, name, ts.isFunctionDeclaration);
const variable = (graph, file, name) => named(graph, file, name, ts.isVariableDeclaration);
const calls = (node, callee) => descendants(node, (n) => ts.isCallExpression(n) && compact(n.expression) === callee);
const returns = (node, value) =>
  descendants(node, (n) => ts.isReturnStatement(n) && compact(n.expression) === value).length === 1;

// Check finite route selection and the actual composition, not just an interface's spelling.
function provenMultiplexer(graph) {
  // dec_89D06D7360CBEC09795F7B12EC/CH3: the raw method is checked before forwarding.
  const create = fn(graph, composition, "createLocalGuiServiceBridge");
  const invoke = descendants(create, (n) => ts.isPropertyAssignment(n) && n.name.getText() === "invoke")[0]
    ?.initializer;
  const lookup = calls(variable(graph, composition, "descriptor"), "interactiveRpcDescriptor")[0];
  const guard = invoke?.body?.statements?.find((n) => ts.isIfStatement(n) && compact(n.expression) === "!descriptor");
  const facetsImport = graph.modules.get(composition)?.imports.get("interactiveRpcDescriptor");
  if (
    !lookup ||
    compact(lookup.arguments[0]) !== "method" ||
    !guard ||
    !compact(guard.thenStatement).startsWith('returnfailure(method,"UnsupportedinteractiveRPC"') ||
    !returns(invoke?.body, "request(descriptor,params)") ||
    facetsImport?.from !== "@harness-anything/daemon/protocol" ||
    facetsImport.exported !== "interactiveRpcDescriptor"
  )
    return false;

  const handler = fn(graph, `${main}ipc-handlers.ts`, "registerHarnessIpcHandlers");
  const listener = calls(handler, "registrar.handle").find((call) => compact(call.arguments[0]) === "RPC_CHANNEL")
    ?.arguments[1];
  const statements = listener?.body?.statements ?? [];
  const trusted = statements.findIndex(
    (stmt) =>
      ts.isExpressionStatement(stmt) && compact(stmt.expression) === "assertTrustedIpcSender(event,trustPolicy)",
  );
  const admitted = statements.findIndex(
    (stmt) =>
      ts.isExpressionStatement(stmt) && compact(stmt.expression) === "assertRendererRpc(value.method,value.params)",
  );
  const forward = statements.findIndex(
    (stmt) => ts.isReturnStatement(stmt) && calls(stmt, "bridge.invoke").length === 1,
  );
  if (trusted < 0 || trusted >= admitted || admitted >= forward) return false;

  const request = fn(graph, composition, "request");
  const rpc = calls(request, "daemon.requestLocalDaemonJsonRpcForTarget");
  if (
    rpc.length !== 1 ||
    compact(rpc[0].arguments[1]) !== "route.method" ||
    compact(rpc[0].arguments[2]) !== "params" ||
    !returns(request, "parse(awaitinvoke())")
  )
    return false;

  const electron = `${main}electron-main.ts`;
  const install = calls(graph.modules.get(electron)?.sourceFile, "registerHarnessIpcHandlers");
  return (
    compact(variable(graph, electron, "bridge")?.initializer) === "createLocalGuiServiceBridge()" &&
    compact(variable(graph, electron, "controlled")?.initializer) ===
      "addLocalMainControls({bridge,target:async()=>guiGlobalDaemonTarget(),})" &&
    install.length === 1 &&
    compact(install[0].arguments[1]) === "controlled"
  );
}

export function resolvedGuiMainForwarding(graph, node, port, descriptors, resolveRpc) {
  const file = graph.fileOf(node);
  const preloadRpc = file === preload && port === `${preload}#invoke` && compact(node.arguments[0]) === "RPC_CHANNEL";
  if (!file.startsWith(main) && !preloadRpc) return null;
  const declaration = graph.callDeclaration(node);
  const body = declaration && unwrap(declaration.body);
  if (file === composition && port === `${composition}#bootstrapLocalRepository.invoke`) {
    const rpc = body && ts.isCallExpression(body) ? body : null;
    const method = rpc?.arguments[1];
    const binding =
      rpc &&
      compact(rpc.expression) === "daemon.requestLocalDaemonJsonRpcForTarget" &&
      method &&
      ts.isStringLiteralLike(method) &&
      method.text === "daemon.repo.bootstrap" &&
      resolveRpc(method.text, rpc.arguments[2]);
    return binding
      ? { bindings: [binding], reachesDaemonTransport: true, viaCallbackParam: false, hasUnprovenCallback: false }
      : failed();
  }
  const ipc = file === `${main}ipc-handlers.ts` && port === bridgePort;
  const controls = file === `${main}local-main-controls.ts` && port === bridgePort;
  const request = file === composition && port === `${composition}#request.invoke`;
  if (!ipc && !controls && !request && !preloadRpc) {
    // An opaque daemon bridge remains a remote transport inside native desktop callbacks.
    const bridge = port === bridgePort;
    const rpc = port === `${composition}#DaemonClient.requestLocalDaemonJsonRpcForTarget`;
    if (!bridge && !rpc) return null;
    const method = unwrap(node.arguments[bridge ? 0 : 1]);
    const admitted = !bridge || interactiveRpcMethods.some((facet) => facet.method === method?.text);
    const binding =
      method && ts.isStringLiteralLike(method) && admitted && resolveRpc(method.text, node.arguments[bridge ? 1 : 2]);
    return binding
      ? { bindings: [binding], reachesDaemonTransport: true, viaCallbackParam: false, hasUnprovenCallback: false }
      : failed();
  }
  if (!provenMultiplexer(graph)) return failed();
  if (preloadRpc) {
    // dec_89D06D7360CBEC09795F7B12EC/CH3: prove the preload channel forwards the same guarded route set.
    const nativeCalls = calls(declaration, "ipcRenderer.invoke");
    if (
      compact(node) !== "invoke(RPC_CHANNEL,{method,params})" ||
      nativeCalls.length !== 1 ||
      compact(nativeCalls[0]) !== "ipcRenderer.invoke(channel,payload)" ||
      graph.modules.get(preload)?.imports.get("ipcRenderer")?.from !== "electron" ||
      graph.modules.get(preload)?.imports.get("RPC_CHANNEL")?.from !== "./allowlist.ts" ||
      graph.modules.get(`${main}ipc-handlers.ts`)?.imports.get("RPC_CHANNEL")?.from !== "../preload/allowlist.ts"
    )
      return failed();
  }
  if (
    (ipc && (compact(node.arguments[0]) !== "value.method" || compact(unwrap(node.arguments[1])) !== "value.params")) ||
    (controls && compact(node) !== "input.bridge.invoke(method,payload)")
  )
    return failed();
  const bindings = interactiveRpcMethods.map((facet) => resolveRpc(facet.method));
  if (bindings.some((binding) => !binding)) return failed();
  // One RPC can dispatch several operations, such as handoff export/claim/revoke.
  // Require every variant, rather than borrowing the GUI facade's default operation.
  for (const descriptor of daemonProtocolCommands.filter(
    (d) => d.commandClass !== "repo-read" && interactiveRpcMethods.some((facet) => facet.method === d.method),
  )) {
    if (
      !descriptors.some(
        (d) => d.id === descriptor.id && (d.actionKind ?? d.id) === (descriptor.actionKind ?? descriptor.id),
      )
    )
      return failed();
    bindings.push({ actionKind: descriptor.actionKind ?? descriptor.id, route: descriptor.id, isRead: false });
  }
  return { bindings, reachesDaemonTransport: true, viaCallbackParam: true, hasUnprovenCallback: false };
}
