// harness-test-tier: fast
import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/renderer/api-client-invoke.ts", () => ({ invoke: invokeMock }));

import { todosClient } from "../src/renderer/todos-client.ts";

afterEach(() => vi.clearAllMocks());

describe("todosClient", () => {
  it("preserves the daemon's actual read rejection instead of replacing it with a generic message", async () => {
    invokeMock.mockResolvedValue({
      schema: "command-receipt/v2",
      ok: false,
      command: "todo-list",
      outcome: "op_rejected",
      opId: "N/A",
      code: "daemon_error",
      rejectionExplanation: "fetch failed: https://center.example.test:8443",
      error: { code: "daemon_error" },
    });

    await expect(todosClient.list("repo-edge")).rejects.toThrow(
      "daemon_error: fetch failed: https://center.example.test:8443",
    );
    expect(invokeMock).toHaveBeenCalledWith("repo.todo.list", { repoId: "repo-edge", all: true }, "listTodos");
  });
});
