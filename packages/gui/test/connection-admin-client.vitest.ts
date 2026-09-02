// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { readProbe, readStatus } from "../src/renderer/connection-admin-client.ts";

/**
 * 连接 admin 客户端的结果解析(PLT-EdgeGUI-W3):daemon 形态失败
 * (`{ok:false,error:{code,hint}}`)折叠成 Error(hint),成功结果做形状校验后放行;
 * 形状不对的「成功」一律拒绝,不把畸形数据带进视图。
 */

describe("connection admin client parsing", () => {
  it("reads daemon.status connections through the status bridge shape", () => {
    const rows = readStatus({
      ok: true,
      connections: [
        { id: "local", kind: "local", displayName: "This device", state: "enabled" },
        { id: "server-b", kind: "remote-endpoint", displayName: "Server B", state: "disabled", endpoint: "tcp://x:1" },
        { id: "weird", kind: "alien", displayName: "Alien", state: "enabled" },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["local", "server-b"]);
  });

  it("folds a daemon error result into an Error carrying the hint", () => {
    expect(() =>
      readStatus({ ok: false, error: { code: "remote_proxy_unavailable", hint: "endpoint closed" } }),
    ).toThrow(/endpoint closed/u);
  });

  it("rejects malformed success payloads", () => {
    expect(() => readStatus({ ok: true })).toThrow(/invalid result/u);
    expect(() => readStatus({ ok: true, connections: "nope" })).toThrow(/invalid result/u);
  });

  it("normalizes the probe result to version, build, and repo rows", () => {
    const probe = readProbe({
      ok: true,
      endpoint: "tcp://127.0.0.1:9911",
      protocolVersion: { major: 1, minor: 0 },
      build: { commit: "abcdef" },
      repos: [
        { repoId: "ledger-a", mode: "local", state: "attached" },
        { repoId: "ledger-b", mode: null, state: "closed" },
      ],
    });
    expect(probe.protocolVersion).toEqual({ major: 1, minor: 0 });
    expect(probe.build).toEqual({ commit: "abcdef" });
    expect(probe.repos.map((repo) => repo.repoId)).toEqual(["ledger-a", "ledger-b"]);
  });

  it("surfaces an explicit unavailable probe instead of an empty repo list", () => {
    expect(() =>
      readProbe({ ok: false, error: { code: "remote_proxy_unavailable", hint: "connect ECONNREFUSED" } }),
    ).toThrow(/ECONNREFUSED/u);
  });
});
