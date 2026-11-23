// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedRbacService, type ManagedRbacPorts } from "../src/keycloak/managed-rbac-service.ts";
import type { ManagedRbacHost } from "../src/keycloak/managed-host.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function fakeExtractHost(): ManagedRbacHost {
  const runProcessText = (command: string, args: readonly string[]): string => {
    if (command === "unzip") {
      const targetIndex = args.indexOf("-d");
      const targetDir = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
      if (targetDir) {
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(path.join(targetDir, "postgres.txz"), "stub-txz");
      }
      return "";
    }
    if (command === "tar") {
      const targetIndex = args.indexOf("-C");
      const targetDir = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
      if (targetDir) {
        const binDir = path.join(targetDir, "bin");
        mkdirSync(binDir, { recursive: true });
        for (const binary of ["initdb", "postgres", "pg_ctl"]) writeFileSync(path.join(binDir, binary), "#!/bin/sh\n");
      }
      return "";
    }
    return "";
  };
  return {
    runProcessText,
    runProcessTextAsync: async (command, args) => runProcessText(command, args),
    runProcessExitAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    validateCertificateNames: () => undefined,
    mapListenerBindError: (error) => (error instanceof Error ? error : new Error(String(error))),
  };
}

function createService(
  root: string,
  ports: Partial<ManagedRbacPorts> & {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
  },
): ManagedRbacService {
  return new ManagedRbacService(root, fakeExtractHost(), {
    platform: "linux",
    arch: "x64",
    now: () => "2026-11-23T15:00:00.000Z",
    ...ports,
  });
}

test("ensurePostgresBinaries retries HTTP 429 (honoring capped Retry-After) and HTTP 503 with bounded backoff before succeeding", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-download-retry-429-"));
  const archiveBytes = Buffer.from("embedded-postgres-jar-payload");
  const expectedSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const delays: number[] = [];
  let payloadCalls = 0;
  let checksumCalls = 0;
  try {
    const service = createService(root, {
      random: () => 0.5,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      fetch: (async (url: string | URL | Request) => {
        const textUrl = String(url);
        if (textUrl.endsWith(".sha256")) {
          checksumCalls += 1;
          if (checksumCalls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
          return new Response(`${expectedSha256}\n`, { status: 200 });
        }
        payloadCalls += 1;
        if (payloadCalls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
        if (payloadCalls === 2) return new Response("rate limited", { status: 429, headers: { "retry-after": "999" } });
        if (payloadCalls === 3) return new Response("service unavailable", { status: 503 });
        return new Response(archiveBytes, { status: 200 });
      }) as typeof fetch,
    });

    const binaries = await service.ensurePostgresBinaries();
    assert.equal(existsSync(binaries.postgres), true);
    assert.equal(payloadCalls, 4, "expected 1 initial attempt + 3 retries for payload");
    assert.equal(checksumCalls, 2, "expected 1 initial attempt + 1 retry for checksum");
    assert.deepEqual(
      delays,
      [3_000, 10_000, 750, 2_000],
      "expected Retry-After (3s), capped Retry-After (10s), equal-jitter 503 backoff (750ms), and checksum Retry-After (2s)",
    );
  } finally {
    removeTempRepository(root);
  }
});

test("ensurePostgresBinaries retries transient fetch transport failures and installs on recovery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-download-retry-net-"));
  const archiveBytes = Buffer.from("embedded-postgres-jar-payload-net");
  const expectedSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const delays: number[] = [];
  let payloadCalls = 0;
  try {
    const service = createService(root, {
      random: () => 0,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      fetch: (async (url: string | URL | Request) => {
        const textUrl = String(url);
        if (textUrl.endsWith(".sha256")) return new Response(`${expectedSha256}\n`, { status: 200 });
        payloadCalls += 1;
        if (payloadCalls === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          });
        }
        return new Response(archiveBytes, { status: 200 });
      }) as typeof fetch,
    });

    const binaries = await service.ensurePostgresBinaries();
    assert.equal(existsSync(binaries.initdb), true);
    assert.equal(payloadCalls, 2);
    assert.deepEqual(delays, [125]);
  } finally {
    removeTempRepository(root);
  }
});

test("ensurePostgresBinaries fails with rbac_download_failed after exhausting retry budget on persistent HTTP 429", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-download-exhaust-"));
  const delays: number[] = [];
  let fetchCalls = 0;
  try {
    const service = createService(root, {
      random: () => 1,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("still rate limited", { status: 429 });
      }) as typeof fetch,
    });

    await assert.rejects(service.ensurePostgresBinaries(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "rbac_download_failed");
      assert.match(String(error), /HTTP 429/u);
      return true;
    });
    assert.equal(fetchCalls, 5, "expected 1 initial attempt + 4 retries");
    assert.deepEqual(delays, [250, 500, 1_000, 2_000]);
  } finally {
    removeTempRepository(root);
  }
});

for (const status of [400, 401, 403, 404] as const) {
  test(`ensurePostgresBinaries fails fast without retrying on permanent HTTP ${status}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `ha-rbac-download-${status}-`));
    const delays: number[] = [];
    let fetchCalls = 0;
    try {
      const service = createService(root, {
        sleep: async (ms: number) => {
          delays.push(ms);
        },
        fetch: (async () => {
          fetchCalls += 1;
          return new Response("permanent error", { status });
        }) as typeof fetch,
      });

      await assert.rejects(service.ensurePostgresBinaries(), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "rbac_download_failed");
        assert.match(String(error), new RegExp(`HTTP ${status}`, "u"));
        return true;
      });
      assert.equal(fetchCalls, 1, `HTTP ${status} must fail fast with a single fetch call`);
      assert.deepEqual(delays, [], `HTTP ${status} must not sleep or retry`);
    } finally {
      removeTempRepository(root);
    }
  });
}
