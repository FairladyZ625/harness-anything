// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { centerServiceState, centerStartDefaults } from "../src/renderer/views/settings/centerService.ts";

describe("center service readiness", () => {
  it("classifies only a definite ok reply and leaves failures unknown", () => {
    expect(centerServiceState({ ok: true, running: true })).toEqual({ state: "running" });
    expect(centerServiceState({ ok: true, running: false })).toEqual({ state: "stopped" });
    // A refused or malformed read is not evidence the service is down; the form stays usable.
    expect(centerServiceState({ ok: false, code: "local_transport_required" })).toEqual({ state: "unknown" });
    expect(centerServiceState(null)).toEqual({ state: "unknown" });
    expect(centerServiceState(new Error("socket gone"))).toEqual({ state: "unknown" });
  });

  it("derives one-click start parameters from the saved config first", () => {
    expect(
      centerStartDefaults({
        status: {
          ok: true,
          running: false,
          port: 7545,
          bind: "127.0.0.1",
          externalUrl: "https://center.example.test:7545",
          repoId: "canonical",
          quotaBytes: 1024,
          certificateSource: "login-listener",
        },
        loginHostname: "login.example.test",
        localRepoIds: ["canonical", "other"],
      }),
    ).toEqual({
      port: 7545,
      repoId: "canonical",
      quotaBytes: 1024,
      bind: "127.0.0.1",
      externalUrl: "https://center.example.test:7545",
    });
  });

  it("falls back to the single local repository and the login hostname for a first start", () => {
    expect(
      centerStartDefaults({
        status: {
          ok: true,
          running: false,
          port: null,
          bind: null,
          externalUrl: null,
          repoId: null,
          quotaBytes: null,
          certificateSource: null,
        },
        loginHostname: "login.example.test",
        localRepoIds: ["canonical"],
      }),
    ).toEqual({
      port: 7545,
      repoId: "canonical",
      quotaBytes: 50 * 1024 ** 3,
      bind: "0.0.0.0",
      externalUrl: "https://login.example.test:7545",
    });
  });

  it("refuses to guess when the authority repository is ambiguous or absent", () => {
    const firstStart = {
      status: {
        ok: true,
        running: false,
        port: null,
        bind: null,
        externalUrl: null,
        repoId: null,
        quotaBytes: null,
        certificateSource: null,
      },
      loginHostname: "login.example.test",
    } as const;
    expect(centerStartDefaults({ ...firstStart, localRepoIds: ["a", "b"] })).toBeNull();
    expect(centerStartDefaults({ ...firstStart, localRepoIds: [] })).toBeNull();
    // A saved repoId that is no longer a local repository must not anchor the restart either.
    expect(
      centerStartDefaults({
        status: {
          ok: true,
          running: false,
          port: 7545,
          bind: "0.0.0.0",
          externalUrl: null,
          repoId: "gone",
          quotaBytes: 1,
          certificateSource: null,
        },
        loginHostname: null,
        localRepoIds: ["a", "b"],
      }),
    ).toBeNull();
  });
});
