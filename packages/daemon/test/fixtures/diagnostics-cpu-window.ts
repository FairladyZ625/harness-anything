// The wall clock is the subject under test here: the product budget is stated over a 10 s window.
// This harness lives in a fixture so the integration lint lane sees only waits and assertions;
// it is a measurement window, not a wait for the process under test to reach a state.
export async function measureCpuWindow(
  ticks: number,
  registrationsPerTick: number,
  work: () => void,
): Promise<{ readonly cpuMs: number; readonly elapsedMs: number; readonly cpuPercent: number }> {
  const cpu = process.cpuUsage(),
    start = performance.now();
  await new Promise<void>((resolve) => {
    let done = 0;
    const timer = setInterval(() => {
      for (let node = 0; node < registrationsPerTick; node++) work();
      if (++done === ticks) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  const usage = process.cpuUsage(cpu),
    elapsedMs = performance.now() - start;
  return {
    cpuMs: (usage.user + usage.system) / 1_000,
    elapsedMs,
    cpuPercent: (usage.user + usage.system) / (elapsedMs * 10),
  };
}
