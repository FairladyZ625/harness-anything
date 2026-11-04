import { createPGliteStorage } from "../../src/pglite/transaction.ts";

const [, , mode, dataDir] = process.argv;
try {
  const storage = createPGliteStorage({ dataDir });
  await storage.db.waitReady;
  if (mode === "hold") {
    await storage.db.exec("CREATE TABLE survived(value integer); INSERT INTO survived VALUES (7)");
    process.send!({ held: true });
    process.on("message", async () => {
      await storage.close();
      process.disconnect();
    });
  } else {
    await storage.close();
    process.send!({ opened: true });
    process.disconnect();
  }
} catch (error) {
  const value = error as Error & { code?: string; errcode?: number };
  process.send!({ error: { name: value.name, message: value.message, code: value.code, errcode: value.errcode } });
  process.disconnect();
}
