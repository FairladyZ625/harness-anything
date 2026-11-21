// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createIdentityManagement } from "../src/daemon-host/authorization-provider.ts";
import { credentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import {
  daemonServiceCommands,
  daemonServiceUnit,
  daemonServiceUnitContent,
} from "../src/daemon-host/client/daemon-service.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("linux-arm64 external OIDC/Keycloak configuration, health, and resume succeed without managed downloads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-arm64-rbac-external-"));
  let fetches = 0;
  try {
    mkdirSync(path.join(root, "rbac"), { recursive: true });
    const service = createIdentityManagement(root, {
      platform: "linux",
      arch: "arm64",
      fetch: ((url: string | URL | Request) => {
        fetches += 1;
        if (String(url).endsWith("/token")) return Promise.resolve(Response.json({ access_token: "arm64-token" }));
        return Promise.resolve(Response.json([]));
      }) as typeof fetch,
    });
    const configured = await service.run({
      mode: "external",
      url: "https://identity.arm64.example.test",
      realm: "fleet",
      clientId: "harness-center",
      clientSecret: "arm64-external-secret",
    });
    assert.equal(configured.ok, true);
    assert.equal(configured.mode, "external");
    assert.equal(fetches, 3);

    const health = await service.run({ operation: "health" });
    assert.equal(health.ok, true);
    assert.equal(health.mode, "external");
    assert.equal(health.url, "https://identity.arm64.example.test");

    await service.resume();
    assert.equal(existsSync(path.join(root, "rbac", "runtime")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["bootstrap", "upgrade"] as const) {
  test(`linux-arm64 managed ${operation} rejects with rbac_platform_unsupported and external configuration guidance`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `ha-arm64-rbac-managed-${operation}-`));
    let fetches = 0;
    try {
      mkdirSync(path.join(root, "rbac"), { recursive: true });
      // Explicit managed mode avoids builtin delegation and exercises the managed install guard directly.
      writeFileSync(
        path.join(root, "rbac", "config.json"),
        JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "managed" }),
      );
      const service = createIdentityManagement(root, {
        platform: "linux",
        arch: "arm64",
        fetch: (() => {
          fetches += 1;
          return Promise.resolve(new Response(null, { status: 500 }));
        }) as typeof fetch,
      });

      await assert.rejects(service.run({ operation }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "rbac_platform_unsupported");
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /linux-arm64/u);
        assert.match(message, /ha bootstrap --mode external/u);
        assert.match(message, /--client-secret-stdin/u);
        return true;
      });
      assert.equal(fetches, 0, "unsupported platform must fail before issuing any download request");
      assert.equal(existsSync(path.join(root, "rbac", "runtime")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("linux daemon service unit and credential port are architecture-independent", async () => {
  const unit = daemonServiceUnit({ userRoot: "/srv/ha", daemonId: "default" }, "linux", "/home/arm64");
  assert.ok(unit);
  assert.equal(unit.manager, "systemd");
  assert.ok(unit.unitPath.startsWith("/home/arm64/.config/systemd/user/"));
  const content = daemonServiceUnitContent(unit, {
    userRoot: "/srv/ha",
    daemonId: "default",
    execPath: "/usr/bin/node",
    entry: "/opt/ha/dist/index.js",
    searchPath: "/usr/local/bin:/usr/bin:/bin",
  });
  assert.match(content, /^ExecStart="\/usr\/bin\/node" "\/opt\/ha\/dist\/index\.js" "--service"/mu);
  assert.match(content, /^KillMode=process$/mu);
  const commands = daemonServiceCommands(unit);
  assert.equal(commands.start[0], "systemctl");

  const invoked: Array<{ file: string; args: readonly string[] }> = [];
  const port = credentialPort("linux", async (command) => {
    invoked.push({ file: command.file, args: command.args });
    return "resolved-secret";
  });
  const ref = port.issue();
  await port.store(ref, "secret-value");
  assert.equal(await port.resolve(ref), "resolved-secret");
  await port.remove(ref);
  assert.deepEqual(
    invoked.map((entry) => [entry.file, entry.args[0]]),
    [
      ["secret-tool", "store"],
      ["secret-tool", "lookup"],
      ["secret-tool", "clear"],
    ],
  );
  await assert.rejects(port.resolve("keychain:service/account"), { code: "runtime_credential_unavailable" });
});

test("node:sqlite DatabaseSync round-trips rows on the active architecture", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE smoke (id TEXT PRIMARY KEY, arch TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke (id, arch) VALUES (?, ?)").run("g6", `${process.platform}-${process.arch}`);
    const row = db.prepare("SELECT id, arch FROM smoke WHERE id = ?").get("g6") as
      | { id: string; arch: string }
      | undefined;
    assert.deepEqual(row ? { ...row } : undefined, { id: "g6", arch: `${process.platform}-${process.arch}` });
  } finally {
    db.close();
  }
});

test("package-lock.json provides linux-arm64 counterparts for every linux-x64 optional native package family", () => {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
    readonly packages?: Readonly<
      Record<string, { readonly os?: readonly string[]; readonly cpu?: readonly string[]; readonly optional?: boolean }>
    >;
  };
  const families = new Map<string, Set<string>>();
  for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
    if (!meta.os && !meta.cpu) continue;
    if (meta.os && !meta.os.includes("linux")) continue;
    const family = pkgPath.replace(/(?:linux|darwin|win32|freebsd|android|openharmony|sunos|netbsd|openbsd).*/u, "");
    const cpus = families.get(family) ?? new Set<string>();
    for (const cpu of meta.cpu ?? ["any"]) cpus.add(cpu);
    families.set(family, cpus);
  }
  assert.ok(families.size > 0, "expected linux optional native dependency families in package-lock.json");
  const missingArm64 = [...families.entries()]
    .filter(([, cpus]) => cpus.has("x64") && !cpus.has("arm64"))
    .map(([family]) => family);
  assert.deepEqual(
    missingArm64,
    [],
    `linux-x64 native package families missing linux-arm64: ${missingArm64.join(", ")}`,
  );
});
