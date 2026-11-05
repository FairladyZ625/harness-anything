// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { appMainSurface } from "../src/renderer/app-main-surface.ts";

describe("app main surface precedence", () => {
  it("keeps the account recovery page reachable while another ledger read is unavailable", () => {
    // The notice can carry authentication_required while workspace summary or tasks carry
    // replica_unavailable/authorization_denied; the account page still has to mount so the
    // notice's sign-in request can start the one login flow.
    expect(appMainSurface("identityAccess", true)).toBe("account");
    expect(appMainSurface("identityAccess", false)).toBe("account");
    expect(appMainSurface("board", true)).toBe("ledger-unavailable");
    expect(appMainSurface("board", false)).toBe("default");
  });
});
