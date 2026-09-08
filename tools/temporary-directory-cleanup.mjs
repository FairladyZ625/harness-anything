import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 25;

export function removeTemporaryDirectorySync(target, options = {}) {
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS),
    delayMs = nonNegativeInteger(options.retryDelayMs, DEFAULT_DELAY_MS);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === attempts) break;
      options.onRetry?.({ attempt, target, error });
      wait(delayMs * attempt);
    }
  }
  throw cleanupError(target, attempts, lastError);
}

export async function removeTemporaryDirectory(target, options = {}) {
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS),
    delayMs = nonNegativeInteger(options.retryDelayMs, DEFAULT_DELAY_MS);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === attempts) break;
      options.onRetry?.({ attempt, target, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw cleanupError(target, attempts, lastError);
}

function retryable(error) {
  return RETRYABLE_CODES.has(error?.code);
}

function cleanupError(target, attempts, cause) {
  const code = cause?.code ?? "unknown",
    message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`temporary directory cleanup failed after ${attempts} attempts (${code}) at ${target}: ${message}`, {
    cause,
  });
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function wait(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
