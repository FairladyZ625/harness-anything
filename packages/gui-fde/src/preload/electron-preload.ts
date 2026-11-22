import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("harnessFde", {
  surface: "electron",
  version: "0.0.1",
});
