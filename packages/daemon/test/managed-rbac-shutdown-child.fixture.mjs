import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import path from "node:path";

if (process.argv[2] === "server") {
  const root = process.argv[3],
    name = process.argv[4],
    ignoreSigterm = process.argv[5],
    mode = process.argv[6],
    gateFile = process.argv[7],
    config = JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8")),
    pidFile = path.join(root, "rbac", "data", "postgres", "postmaster.pid");
  if (mode === "exit-before-ready") process.exit(0);
  if (name === "postgres" && existsSync(pidFile)) {
    const existingPid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = false;
    if (Number.isSafeInteger(existingPid) && existingPid > 0) {
      try {
        process.kill(existingPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) process.exit(1);
    rmSync(pidFile, { force: true });
  }
  let server = null,
    healthServer = null;
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
        response.writeHead(200, { connection: "close" });
        response.end("{}");
      });
      healthServer.listen(Number(new URL(config.url).port), "127.0.0.1", endpointReady);
      server.listen(Number(process.env.KC_HTTPS_PORT), "127.0.0.1", endpointReady);
    }
  };
  if (name === ignoreSigterm) process.on("SIGTERM", () => {});
  else
    process.once("SIGTERM", () => {
      const openServers = [server, healthServer].filter((item) => Boolean(item?.listening));
      if (openServers.length === 0) process.exit(0);
      let remaining = openServers.length;
      for (const item of openServers) {
        item.close(() => {
          remaining -= 1;
          if (remaining !== 0) return;
          if (name === "postgres") rmSync(pidFile, { force: true });
          process.exit(0);
        });
        item.closeAllConnections?.();
      }
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
