/**
 * 契约:入口的 stdout 只有最后那一个 JSON 对象。daemon 夹具(WAL materializer 等)直接写
 * process.stdout,单靠改 console.log 拦不住,运行期间把 console.log 与 stdout.write 一并导到
 * stderr,结束后只把结果 JSON 写回 stdout。gui-e2e.mjs 与 e2e-probe.mjs 两个入口共用。
 */
export async function withStdoutReservedForJson(run, onError) {
  const writeDiagnostic = console.log,
    writeStdout = process.stdout.write.bind(process.stdout);
  console.log = (...args) => console.error(...args);
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
  const emit = (value) => {
    process.stdout.write = writeStdout;
    writeStdout(`${JSON.stringify(value)}\n`);
  };
  try {
    emit(await run());
  } catch (error) {
    emit(onError(error));
    process.exitCode = 1;
  } finally {
    console.log = writeDiagnostic;
    process.stdout.write = writeStdout;
  }
}
