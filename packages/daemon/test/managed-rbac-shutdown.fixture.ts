import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentityManagement } from "../src/daemon-host/authorization-provider.ts";
import type { ManagedRbacLifecycleEvent } from "@harness-anything/authorization/keycloak/managed-rbac-service";

const childEntrypoint = fileURLToPath(new URL("./managed-rbac-shutdown-child.fixture.mjs", import.meta.url));

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
      const name: FixtureChild = /^postgres(?:\.exe)?$/iu.test(path.basename(command)) ? "postgres" : "keycloak",
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
          [childEntrypoint, "server", root, name, fixtureOptions.ignoreSigterm ?? "", mode, gateFile],
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
