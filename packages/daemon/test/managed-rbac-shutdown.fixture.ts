import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentityManagement } from "../src/authorization-provider.ts";

export function managedShutdownFixture(
  root: string,
  fixtureOptions: { readonly ignoreSigterm?: "postgres" | "keycloak" } = {},
) {
  const children: ReturnType<typeof spawn>[] = [];
  const service = createIdentityManagement(root, {
    spawn: ((command: string, _args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
      const name = path.basename(command) === "postgres" ? "postgres" : "keycloak",
        child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "server", root, name, fixtureOptions.ignoreSigterm ?? ""],
          {
            env: spawnOptions.env,
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
    config = JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8")),
    pidFile = path.join(root, "rbac", "data", "postgres", "postmaster.pid");
  if (name === "postgres" && existsSync(pidFile)) process.exit(1);
  const server = createServer((socket) => socket.on("data", (chunk) => socket.end(`tls:${chunk}`)));
  server.listen(name === "postgres" ? config.postgresPort : Number(process.env.KC_HTTPS_PORT), "127.0.0.1", () => {
    if (name === "postgres") writeFileSync(pidFile, `${process.pid}\n`);
    console.log(name === "postgres" ? "database system is ready to accept connections" : "Keycloak 26 started in 1s");
  });
  if (name === ignoreSigterm) process.on("SIGTERM", () => {});
  else
    process.once("SIGTERM", () => {
      server.close(() => {
        if (name === "postgres") rmSync(pidFile, { force: true });
        process.exit(0);
      });
    });
}
