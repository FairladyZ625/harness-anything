import { systemTmuxController } from "../../src/terminal-tmux.ts";

// Keep the pre-existing registry entries live inside the actual writer isolate, without
// discovering or changing a host tmux server. No terminal is spawned in this worker.
Object.assign(systemTmuxController, {
  probe: () => ({ available: true, executable: "/fixture/tmux", version: "fixture" }),
  hasSession: () => true,
  killSession: () => {
    throw new Error("The repository writer must not own terminal sessions.");
  },
});
