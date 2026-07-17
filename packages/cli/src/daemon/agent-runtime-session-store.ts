import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeSessionStore, StoredRuntimeSession } from "../../../daemon/src/agent-runtime/session-service.ts";

const storeSchema = "agent-runtime-session-store/v1" as const;

export function createFileRuntimeSessionStore(rootDir: string): RuntimeSessionStore {
  const directory = path.join(rootDir, ".harness", "generated");
  const filePath = path.join(directory, "agent-runtime-sessions.json");
  return {
    load: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      if (!isSessionStoreRecord(parsed) || parsed.schema !== storeSchema || !Array.isArray(parsed.sessions)) {
        throw new Error("invalid runtime session store schema");
      }
      if (!parsed.sessions.every(isStoredRuntimeSession)) throw new Error("invalid runtime session store record");
      return parsed.sessions;
    },
    save: async (sessions) => {
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `.agent-runtime-sessions.${process.pid}.${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify({ schema: storeSchema, sessions }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    }
  };
}

function isStoredRuntimeSession(value: unknown): value is StoredRuntimeSession {
  if (!isSessionStoreRecord(value) || typeof value.runtimeSessionId !== "string" || typeof value.kindId !== "string") return false;
  if (!isSessionStoreRecord(value.process) || !["alive", "exited", "unknown"].includes(String(value.process.state))) return false;
  if (typeof value.attachable !== "boolean" || !isSessionStoreRecord(value.capabilities) || !Array.isArray(value.events)) return false;
  return ["running", "completed", "failed", "unknown"].includes(String(value.resultState));
}

function isSessionStoreRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
