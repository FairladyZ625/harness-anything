// GUI main forwards business authority (dec_7E44897ECDCAEF2B92EC66A260/CH1).
import ts from "typescript";
import {
  daemonGuiInvokeFacets,
  daemonProtocolCommands,
} from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { unwrap } from "./authorization-flow-graph.mjs";

const main = "packages/gui/src/main/";
const api = "packages/gui/src/api/service-bridge.ts";
const bridgePort = `${api}#GuiServiceBridge.invoke`;
const composition = `${main}local-composition-root.ts`;
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
  const bridge = fn(graph, api, "createGuiServiceBridgeForDaemon");
  const invoke = descendants(bridge, (n) => ts.isPropertyAssignment(n) && n.name.getText() === "invoke")[0]
    ?.initializer;
  const lookup = calls(variable(graph, api, "route"), "routeByGuiMethod.get")[0];
  const guard = invoke?.body?.statements?.find((n) => ts.isIfStatement(n) && compact(n.expression) === "!route");
  const facetsImport = graph.modules.get(api)?.imports.get("daemonGuiInvokeFacets");
  if (
    !lookup ||
    compact(lookup.arguments[0]) !== "method" ||
    !guard ||
    !returns(guard.thenStatement, 'failure("method_not_allowed",`UnsupportedGUIservicemethod:${method}`)') ||
    !returns(invoke?.body, "request(route,payload)") ||
    facetsImport?.from !== "@harness-anything/daemon/protocol" ||
    facetsImport.exported !== "daemonGuiInvokeFacets" ||
    compact(variable(graph, api, "shippedRoutes")?.initializer) !==
      'daemonGuiInvokeFacets.map((facet)=>({guiBridgeMethod:facet.guiBridgeMethod,rpcMethod:facet.method,requiresRepo:facet.requiresRepo,...("commandClass"infacet?{commandClass:facet.commandClass}:{}),...("inputSchemaId"infacet?{inputSchemaId:facet.inputSchemaId}:{}),}))' ||
    compact(variable(graph, api, "routeByGuiMethod")?.initializer) !==
      "newMap(shippedRoutes.map((route)=>[route.guiBridgeMethod,route]),)"
  )
    return false;

  const create = calls(fn(graph, composition, "createLocalGuiServiceBridge"), "createGuiServiceBridgeForDaemon")[0];
  if (!create || compact(create.arguments[0]) !== "(route,payload)=>request(route,payload)") return false;
  const request = fn(graph, composition, "request");
  const rpc = calls(request, "daemon.requestLocalDaemonJsonRpcForTarget");
  if (
    rpc.length !== 1 ||
    compact(rpc[0].arguments[1]) !== "route.rpcMethod" ||
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
  if (!file.startsWith(main)) return null;
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
  if (!ipc && !controls && !request) {
    // Native desktop callbacks may contain forwarding too. An opaque bridge/RPC remains
    // a remote transport even outside the four current multiplexers.
    const bridge = port === bridgePort;
    const rpc = port === `${composition}#DaemonClient.requestLocalDaemonJsonRpcForTarget`;
    if (!bridge && !rpc) return null;
    const method = unwrap(node.arguments[bridge ? 0 : 1]);
    const facet =
      method && ts.isStringLiteralLike(method) && bridge
        ? daemonGuiInvokeFacets.find((f) => f.guiBridgeMethod === method.text)
        : null;
    const binding =
      method &&
      ts.isStringLiteralLike(method) &&
      resolveRpc(bridge ? facet?.method : method.text, node.arguments[bridge ? 1 : 2]);
    return binding
      ? { bindings: [binding], reachesDaemonTransport: true, viaCallbackParam: false, hasUnprovenCallback: false }
      : failed();
  }
  if (!provenMultiplexer(graph)) return failed();
  if (
    (ipc && compact(node) !== "bridge.invoke(method,payload)") ||
    (controls && compact(node) !== "input.bridge.invoke(method,payload)")
  )
    return failed();
  const bindings = daemonGuiInvokeFacets.map((facet) => resolveRpc(facet.method));
  if (bindings.some((binding) => !binding)) return failed();
  // One RPC can dispatch several operations, such as handoff export/claim/revoke.
  // Require every variant, rather than borrowing the GUI facade's default operation.
  for (const descriptor of daemonProtocolCommands.filter(
    (d) => d.commandClass !== "repo-read" && daemonGuiInvokeFacets.some((facet) => facet.method === d.method),
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
