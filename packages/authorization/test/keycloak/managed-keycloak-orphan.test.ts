// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ManagedRbacHost } from "../../src/keycloak/managed-host.ts";
import { parseWindowsNetstatListeners, stopManagedKeycloakOrphan } from "../../src/keycloak/managed-keycloak-orphan.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

function windowsOrphanHost(input: {
  readonly java: string;
  readonly commandLine: string;
  readonly listeners: Set<number>;
  readonly ports?: readonly number[];
  readonly taskkillCalls: string[][];
}): ManagedRbacHost {
  return {
    runProcessText: () => "",
    runProcessTextAsync: async () => "",
    runProcessExitAsync: async (command, args) => {
      if (command === "taskkill.exe") {
        input.taskkillCalls.push([...args]);
        input.listeners.clear();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "netstat.exe") {
        const ports = input.ports ?? [62413, 62415];
        const rows = [...input.listeners].flatMap((pid) =>
          ports.map((port) => `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}`),
        );
        return { exitCode: 0, stdout: rows.join("\r\n"), stderr: "" };
      }
      if (command !== "powershell.exe") return { exitCode: 0, stdout: "", stderr: "" };
      const script = args.at(-1) ?? "";
      if (script.includes("Get-Process -Id")) return { exitCode: 1, stdout: "", stderr: "" };
      if (script.includes("Get-CimInstance"))
        return {
          exitCode: input.listeners.size > 0 ? 0 : 1,
          stdout: JSON.stringify({ path: input.java, commandLine: input.commandLine }),
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    validateCertificateNames: () => undefined,
    mapListenerBindError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  };
}

test("Windows orphan reclamation resolves kc.bat /bin/.. home properties while rejecting relative and sibling traversal", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-kc-win-orphan-"))),
    java = path.join(root, "runtime", "java", "bin", "java.exe"),
    keycloakHome = path.join(root, "runtime", "keycloak"),
    keycloakToolsHome = path.join(root, "runtime", "keycloak-tools"),
    quarkusJar = path.join(keycloakHome, "lib", "quarkus-run.jar"),
    taskkillCalls: string[][] = [],
    listeners = new Set<number>([732]);
  t.after(() => removeTempRepository(root));
  mkdirSync(path.dirname(java), { recursive: true });
  mkdirSync(keycloakHome, { recursive: true });
  mkdirSync(keycloakToolsHome, { recursive: true });
  writeFileSync(java, "fixture");

  for (const homeArg of [`${keycloakHome.replaceAll("\\", "/")}/bin/..`, `${keycloakHome}\\bin\\..`]) {
    taskkillCalls.length = 0;
    listeners.clear();
    listeners.add(732);
    const batLaunchedHost = windowsOrphanHost({
      java,
      commandLine: `java.exe -Dkc.home.dir="${homeArg}" -Dkc.http-port=62413 -cp "${quarkusJar}" io.quarkus.runner.GeneratedMain`,
      listeners,
      taskkillCalls,
    });
    await stopManagedKeycloakOrphan({
      host: batLaunchedHost,
      root,
      java,
      keycloakHome,
      ports: [62413, 62415],
      platform: "win32",
    });
    assert.equal(taskkillCalls.length, 1, `kc.bat home property ${homeArg} resolves to the managed Keycloak home`);
  }

  for (const commandLine of [
    `java.exe -Dkc.home.dir="${keycloakHome}/../keycloak-tools" -cp "${quarkusJar}" io.quarkus.runner.GeneratedMain`,
    `java.exe -Dkc.home.dir="runtime\\keycloak" -cp "${quarkusJar}" io.quarkus.runner.GeneratedMain`,
  ]) {
    taskkillCalls.length = 0;
    listeners.clear();
    listeners.add(733);
    const rejectedHost = windowsOrphanHost({
      java,
      commandLine,
      listeners,
      taskkillCalls,
    });
    await assert.rejects(
      stopManagedKeycloakOrphan({
        host: rejectedHost,
        root,
        java,
        keycloakHome,
        ports: [62413, 62415],
        platform: "win32",
      }),
      { code: "rbac_port_in_use" },
    );
    assert.equal(taskkillCalls.length, 0, `must not terminate ${commandLine}`);
    void keycloakToolsHome;
  }
});

test("Windows port inspection uses netstat.exe -ano without PowerShell CIM and ignores unoccupied ports", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-kc-win-port-"))),
    java = path.join(root, "runtime", "java", "bin", "java.exe"),
    keycloakHome = path.join(root, "runtime", "keycloak"),
    observedCommands: string[] = [];
  t.after(() => removeTempRepository(root));
  mkdirSync(path.dirname(java), { recursive: true });
  mkdirSync(keycloakHome, { recursive: true });
  writeFileSync(java, "fixture");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const freePort = (server.address() as { readonly port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const host: ManagedRbacHost = {
    runProcessText: () => "",
    runProcessTextAsync: async () => "",
    runProcessExitAsync: async (command, args, _cwd, env) => {
      observedCommands.push(`${command} ${args.join(" ")}`);
      if (process.platform === "win32" && command === "netstat.exe") {
        const result = spawnSync(command, [...args], { encoding: "utf8", env, timeout: 15_000 });
        return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    validateCertificateNames: () => undefined,
    mapListenerBindError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  };

  await stopManagedKeycloakOrphan({
    host,
    root,
    java,
    keycloakHome,
    ports: [freePort, freePort + 1],
    platform: "win32",
  });
  assert.deepEqual(observedCommands, ["netstat.exe -ano"]);
});

test("parseWindowsNetstatListeners extracts IPv4/IPv6 listening PIDs across Windows locales", () => {
  const sample = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234",
    "  TCP    127.0.0.1:9000         0.0.0.0:0              侦听            5678",
    "  TCP    [::1]:8080             [::]:0                 ABHÖREN         9012",
    "  TCP    127.0.0.1:8080         127.0.0.1:54321        ESTABLISHED     4444",
    "  UDP    0.0.0.0:8080           *:*                                    7777",
    "",
  ].join("\r\n");
  const parsed = parseWindowsNetstatListeners(sample, [8080, 9000, 9999]);
  assert.deepEqual(
    [...parsed.get(8080)!].sort((a, b) => a - b),
    [1234, 9012],
  );
  assert.deepEqual([...parsed.get(9000)!], [5678]);
  assert.deepEqual([...parsed.get(9999)!], []);
});
