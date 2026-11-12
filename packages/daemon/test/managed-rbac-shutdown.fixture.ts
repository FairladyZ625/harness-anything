import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentityManagement } from "../src/authorization-provider.ts";
import type { ManagedRbacLifecycleEvent } from "@harness-anything/authorization-keycloak/managed-rbac-service";

type FixtureChild = "postgres" | "keycloak";

export interface ManagedShutdownFixtureOptions {
  readonly ignoreSigterm?: FixtureChild;
  readonly recordLifecycle?: (event: ManagedRbacLifecycleEvent) => void;
  /** The nth spawn of this child (1-based) exits 0 before printing readiness. */
  readonly exitBeforeReadyOnCall?: { readonly child: FixtureChild; readonly call: number };
  /** The nth spawn of this child emits error and never emits exit. */
  readonly spawnErrorOnCall?: { readonly child: FixtureChild; readonly call: number };
  /** The nth spawn of this child waits for this file before printing readiness. */
  readonly delayReadyOnCall?: { readonly child: FixtureChild; readonly call: number; readonly gateFile: string };
  readonly onSpawn?: (child: FixtureChild, call: number) => void;
}

export function managedShutdownFixture(root: string, fixtureOptions: ManagedShutdownFixtureOptions = {}) {
  const children: ReturnType<typeof spawn>[] = [],
    calls: Record<FixtureChild, number> = { postgres: 0, keycloak: 0 };
  const service = createIdentityManagement(root, {
    ...(fixtureOptions.recordLifecycle ? { recordLifecycle: fixtureOptions.recordLifecycle } : {}),
    spawn: ((command: string, _args: string[], spawnOptions: Parameters<typeof spawn>[2]) => {
      const name: FixtureChild = path.basename(command) === "postgres" ? "postgres" : "keycloak",
        call = (calls[name] += 1);
      fixtureOptions.onSpawn?.(name, call);
      const spawnError = fixtureOptions.spawnErrorOnCall;
      if (spawnError?.child === name && spawnError.call === call) {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: () => false,
        }) as unknown as ReturnType<typeof spawn>;
        children.push(child);
        setImmediate(() => child.emit("error", new Error("fixture spawn failure")));
        return child;
      }
      const exitBeforeReady = fixtureOptions.exitBeforeReadyOnCall,
        delay = fixtureOptions.delayReadyOnCall,
        mode = exitBeforeReady?.child === name && exitBeforeReady.call === call ? "exit-before-ready" : "",
        gateFile = delay?.child === name && delay.call === call ? delay.gateFile : "",
        child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "server", root, name, fixtureOptions.ignoreSigterm ?? "", mode, gateFile],
          {
            env: spawnOptions?.env,
            detached: spawnOptions?.detached,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      children.push(child);
      return child;
    }) as typeof spawn,
  });
  return { service, children };
}

if (process.argv[2] === "server") {
  const root = process.argv[3]!,
    name = process.argv[4]!,
    ignoreSigterm = process.argv[5],
    mode = process.argv[6],
    gateFile = process.argv[7],
    config = JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8")),
    pidFile = path.join(root, "rbac", "data", "postgres", "postmaster.pid");
  if (mode === "exit-before-ready") process.exit(0);
  if (name === "postgres" && existsSync(pidFile)) process.exit(1);
  let server: Server | null = null,
    healthServer: HttpServer | null = null;
  const listen = () => {
    const ready = () => {
      if (name === "postgres") writeFileSync(pidFile, `${process.pid}\n`);
      console.log(name === "postgres" ? "database system is ready to accept connections" : "Keycloak 26 started in 1s");
    };
    server = createServer((socket) => socket.on("data", (chunk) => socket.end(`tls:${chunk}`)));
    if (name === "postgres") server.listen(config.postgresPort, "127.0.0.1", ready);
    else {
      let listening = 0;
      const endpointReady = () => {
        listening += 1;
        if (listening === 2) ready();
      };
      healthServer = createHttpServer((_request, response) => {
        response.writeHead(200);
        response.end("{}");
      });
      healthServer.listen(Number(new URL(config.url).port), "127.0.0.1", endpointReady);
      server.listen(Number(process.env.KC_HTTPS_PORT), "127.0.0.1", endpointReady);
    }
  };
  if (name === ignoreSigterm) process.on("SIGTERM", () => {});
  else
    process.once("SIGTERM", () => {
      const openServers = [server, healthServer].filter((item): item is Server | HttpServer => item?.listening);
      if (openServers.length === 0) process.exit(0);
      let remaining = openServers.length;
      for (const item of openServers)
        item.close(() => {
          remaining -= 1;
          if (remaining !== 0) return;
          if (name === "postgres") rmSync(pidFile, { force: true });
          process.exit(0);
        });
    });
  if (gateFile === "") listen();
  else {
    // A deterministic pause before readiness: the parent test owns when this child becomes ready.
    const poll = setInterval(() => {
      if (!existsSync(gateFile)) return;
      clearInterval(poll);
      listen();
    }, 25);
  }
}
