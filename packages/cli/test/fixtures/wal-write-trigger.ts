import { existsSync, statSync } from "node:fs";

/**
 * Fire `onWrite` when the SQLite WAL grows past its baseline. This is test input (the SIGTERM that
 * interrupts an import), not a correctness wait: FSEvents delivery lags past the response window on
 * macOS, so watching the file is unreliable and the trigger polls. The caller owns the reaction.
 */
export function triggerOnFirstWalWrite(walPath: string, baseline: number, onWrite: (size: number) => void): () => void {
  const size = (): number => (existsSync(walPath) ? statSync(walPath).size : -1);
  const timer = setInterval(() => {
    const current = size();
    if (current === baseline) return;
    clearInterval(timer);
    onWrite(current);
  }, 15);
  return () => clearInterval(timer);
}
