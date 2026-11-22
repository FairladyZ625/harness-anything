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
        assert.match(message, /--client-secret-stdin < /u);
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

interface LockfilePackageMeta {
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly optional?: boolean;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface PackageLockDocument {
  readonly packages?: Readonly<Record<string, LockfilePackageMeta>>;
}

function resolveLockfilePackage(
  packages: Readonly<Record<string, LockfilePackageMeta>>,
  parentPath: string,
  dependencyName: string,
): { readonly key: string; readonly meta: LockfilePackageMeta } | undefined {
  let cursor = parentPath;
  while (cursor.length > 0) {
    const candidate = `${cursor}/node_modules/${dependencyName}`;
    if (packages[candidate]) return { key: candidate, meta: packages[candidate] };
    const idx = cursor.lastIndexOf("/node_modules/");
    if (idx === -1) break;
    cursor = cursor.slice(0, idx);
  }
  const topLevel = `node_modules/${dependencyName}`;
  return packages[topLevel] ? { key: topLevel, meta: packages[topLevel] } : undefined;
}

function matchesLinuxTarget(meta: LockfilePackageMeta, cpu: "x64" | "arm64", libc: "glibc" | "musl"): boolean {
  if (!meta.os?.includes("linux")) return false;
  if (!meta.cpu?.includes(cpu)) return false;
  return meta.libc === undefined || meta.libc.includes(libc);
}

function findMissingUbuntuArm64OptionalDeps(lock: PackageLockDocument): string[] {
  const packages = lock.packages ?? {};
  const missing: string[] = [];

  for (const [parentPath, parentMeta] of Object.entries(packages)) {
    const optDeps = Object.keys(parentMeta.optionalDependencies ?? {});
    if (optDeps.length === 0) continue;
    let hasUbuntuX64 = false;
    let hasUbuntuArm64 = false;
    for (const depName of optDeps) {
      const resolved = resolveLockfilePackage(packages, parentPath, depName);
      if (!resolved) continue;
      if (matchesLinuxTarget(resolved.meta, "x64", "glibc")) hasUbuntuX64 = true;
      if (matchesLinuxTarget(resolved.meta, "arm64", "glibc")) hasUbuntuArm64 = true;
    }
    if (hasUbuntuX64 && !hasUbuntuArm64) {
      missing.push(`optionalDependencies:${parentPath} (missing linux-arm64 glibc)`);
    }
  }

  const familiesByLibc = new Map<string, Set<string>>();
  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!meta.os?.includes("linux") || !meta.cpu) continue;
    const family = pkgPath.replace(/(?:linux|darwin|win32|freebsd|android|openharmony|sunos|netbsd|openbsd).*/u, "");
    const libcs = meta.libc && meta.libc.length > 0 ? meta.libc : ["any"];
    for (const libc of libcs) {
      const bucketKey = `${family} [libc=${libc}]`;
      const cpus = familiesByLibc.get(bucketKey) ?? new Set<string>();
      for (const cpu of meta.cpu) cpus.add(cpu);
      familiesByLibc.set(bucketKey, cpus);
    }
  }
  for (const [bucketKey, cpus] of familiesByLibc.entries()) {
    if (cpus.has("x64") && !cpus.has("arm64")) {
      missing.push(`lockfile:${bucketKey}`);
    }
  }

  return missing.sort();
}

test("package-lock.json provides Ubuntu glibc linux-arm64 optionalDependencies without musl masking", () => {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as PackageLockDocument;
  const packages = lock.packages ?? {};
  assert.ok(
    packages["node_modules/@napi-rs/canvas-linux-arm64-gnu"],
    "expected @napi-rs/canvas-linux-arm64-gnu in package-lock.json",
  );
  assert.ok(
    packages["node_modules/@napi-rs/canvas-linux-arm64-musl"],
    "expected @napi-rs/canvas-linux-arm64-musl in package-lock.json",
  );

  const missing = findMissingUbuntuArm64OptionalDeps(lock);
  assert.deepEqual(
    missing,
    [],
    `linux-x64 native packages missing linux-arm64 Ubuntu glibc/libc counterpart: ${missing.join(", ")}`,
  );

  // Negative control: removing the glibc ARM64 entry must fail even while the musl ARM64 entry stays present.
  const withoutCanvasArm64Gnu = structuredClone(lock) as {
    packages: Record<string, LockfilePackageMeta>;
  };
  delete withoutCanvasArm64Gnu.packages["node_modules/@napi-rs/canvas-linux-arm64-gnu"];
  const missingAfterDelete = findMissingUbuntuArm64OptionalDeps(withoutCanvasArm64Gnu);
  assert.ok(
    missingAfterDelete.some((entry) => entry.includes("@napi-rs/canvas")),
    `deleting @napi-rs/canvas-linux-arm64-gnu must be detected even with musl present; got ${JSON.stringify(missingAfterDelete)}`,
  );
});
