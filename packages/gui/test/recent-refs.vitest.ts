// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { pushRecentRef, RECENT_LIMIT } from "../src/renderer/navigation/recentRefs.ts";
import { searchPaletteEntries } from "../src/renderer/components/FocusSwitcher.tsx";
import type { PaletteEntry } from "../src/renderer/components/CommandPalette.tsx";

describe("graph left rail recents and typeahead (archive-line parity)", () => {
  it("pushes refs to the front, deduplicates, and caps at the limit", () => {
    let refs: string[] = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i += 1) refs = pushRecentRef(refs, `task/t${i}`);
    expect(refs).toHaveLength(RECENT_LIMIT);
    expect(refs[0]).toBe(`task/t${RECENT_LIMIT + 4}`);
    refs = pushRecentRef(refs, "task/t0");
    expect(refs[0]).toBe("task/t0");
    expect(refs.filter((ref) => ref === "task/t0")).toHaveLength(1);
  });

  it("searches the unified entity index by label, ref, and sub", () => {
    const entries: PaletteEntry[] = [
      { ref: "task/task_a", label: "Fix daemon spawn", sub: "active", entity: "task" },
      { ref: "decision/dec_1", label: "Adopt tmux", sub: "proposed", entity: "decision" },
      { ref: "fact/F-001", label: "posix_spawn failed", sub: "evidence", entity: "fact" },
    ];
    expect(searchPaletteEntries(entries, "spawn").map((e) => e.ref)).toEqual(["task/task_a", "fact/F-001"]);
    expect(searchPaletteEntries(entries, "DEC_1").map((e) => e.ref)).toEqual(["decision/dec_1"]);
    expect(searchPaletteEntries(entries, "proposed").map((e) => e.ref)).toEqual(["decision/dec_1"]);
    expect(searchPaletteEntries(entries, "")).toEqual([]);
  });
});
