import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { localWalFileSystem } from "../packages/kernel/src/local/local-layout-file-system.ts";

const root = mkdtempSync(path.join(tmpdir(), "ha-p50-fsync-probe-"));
const shadowPath = path.join(root, "shadow.log"), fsyncPath = path.join(root, "fsync.log");
const shadow = [], fsync = [];
try {
  for (let index = 0; index < 11; index += 1) {
    const body = `${index}\n`;
    if (index % 2 === 0) {
      shadow.push(measureShadow(shadowPath, body));
      fsync.push(measureFsync(fsyncPath, body));
    } else {
      fsync.push(measureFsync(fsyncPath, body));
      shadow.push(measureShadow(shadowPath, body));
    }
  }
  console.log(JSON.stringify({ shadow, fsync, ratio: median(shadow) / median(fsync) }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function measureShadow(target, body) {
  const started = performance.now();
  localWalFileSystem.append(target, body);
  return performance.now() - started;
}

function measureFsync(target, body) {
  const started = performance.now(), descriptor = openSync(target, "a");
  try {
    writeSync(descriptor, body, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return performance.now() - started;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}
