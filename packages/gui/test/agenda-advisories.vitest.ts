// harness-test-tier: fast
import { afterEach, expect, it, vi } from "vitest";
import { harnessClient } from "../src/renderer/api-client.ts";
import { readAgendaDispatches } from "../src/renderer/agenda-advisories.ts";

afterEach(() => vi.restoreAllMocks());
it("follows the authoritative dispatch page cursor through the last page", async () => {
  const read = vi.spyOn(harnessClient, "getTaskDispatches");
  const page = (cursor: string | null, nextCursor: string | null) => ({
    ok: true as const,
    status: "ready" as const,
    taskIds: ["task-one"],
    unavailableTaskIds: [],
    dispatches: [],
    outcome: "unknown" as const,
    exitCode: 1,
    page: { cursor, nextCursor, limit: 500 },
    watermark: 1,
    sourceRevision: 1,
  });
  read.mockResolvedValueOnce(page(null, "last-page")).mockResolvedValueOnce(page("last-page", null));
  expect(await readAgendaDispatches("repo-one", ["task-one"])).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenNthCalledWith(2, {
    repoId: "repo-one",
    taskIds: ["task-one"],
    limit: 500,
    cursor: "last-page",
  });
});
it("surfaces a failed center read", async () => {
  vi.spyOn(harnessClient, "getTaskDispatches").mockRejectedValue(new Error("Center unavailable"));
  await expect(readAgendaDispatches("repo-one", ["task-one"])).rejects.toThrow("Center unavailable");
});
