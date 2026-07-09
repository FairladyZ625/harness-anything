import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LayoutFileSystem } from "../layout/file-system.ts";

export const localLayoutFileSystem: LayoutFileSystem = {
  exists: (inputPath) => existsSync(inputPath),
  readText: (inputPath) => readFileSync(inputPath, "utf8"),
  readDirents: (inputPath) => readdirSync(inputPath, { withFileTypes: true })
};

export const localRuntimeStateFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  mkdirp: (inputPath: string) => mkdirSync(inputPath, { recursive: true }),
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  rename: (fromPath: string, toPath: string) => renameSync(fromPath, toPath),
  writeText: (inputPath: string, value: string) => writeFileSync(inputPath, value, "utf8")
};
