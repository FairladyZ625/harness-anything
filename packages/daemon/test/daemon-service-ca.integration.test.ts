// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { daemonServiceUnit, daemonServiceUnitContent } from "../src/client/daemon-service.ts";

const exec = promisify(execFile);

test("service CA environments retain HTTPS verification across fresh Node processes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-service-ca-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certFile = path.join(root, "R&D ca 100% $HOME.pem"),
    keyFile = path.join(root, "key.pem");
  // Same temporary certificate recipe as fleet-tls-session.fixture.ts, without opening a daemon/store.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (_request, response) => {
    response.end("trusted");
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = `
    try {
      const response = await fetch(${JSON.stringify(`https://127.0.0.1:${address.port}`)});
      console.log(await response.text());
    } catch (error) {
      console.log(error.cause?.code);
      process.exitCode = error.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ? 0 : 1;
    }
  `;
  const target = { userRoot: path.join(root, "user"), daemonId: "ca-test" },
    launch = { ...target, execPath: process.execPath, entry: "/unused/daemon.js", searchPath: "/usr/bin:/bin" };
  for (const platform of ["linux", "darwin"] as const) {
    const unit = daemonServiceUnit(target, platform, root)!;
    for (const extraCaCerts of [undefined, certFile]) {
      const content = daemonServiceUnitContent(unit, { ...launch, extraCaCerts });
      // Decode the generated environment only; this test never loads a host service.
      const env: NodeJS.ProcessEnv =
        platform === "darwin"
          ? JSON.parse(
              execFileSync(
                "python3",
                [
                  "-c",
                  "import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())['EnvironmentVariables']))",
                ],
                { input: content, encoding: "utf8" },
              ),
            )
          : Object.fromEntries(
              content
                .split("\n")
                .filter((line) => line.startsWith("Environment="))
                .map((line) => {
                  const assignment: string = JSON.parse(line.slice("Environment=".length));
                  const equals = assignment.indexOf("=");
                  return [assignment.slice(0, equals), assignment.slice(equals + 1).replaceAll("%%", "%")];
                }),
            );
      assert.deepEqual(Object.keys(env).sort(), extraCaCerts ? ["NODE_EXTRA_CA_CERTS", "PATH"] : ["PATH"]);
      if (extraCaCerts) assert.equal(env.NODE_EXTRA_CA_CERTS, certFile);
      // A successor reads the same persisted environment without inheriting the installer's shell.
      for (let start = 0; start < 2; start++) {
        const result = await exec(process.execPath, ["--input-type=module", "-e", script], { env, cwd: root });
        assert.equal(result.stdout.trim(), extraCaCerts ? "trusted" : "DEPTH_ZERO_SELF_SIGNED_CERT");
      }
    }
  }
});
