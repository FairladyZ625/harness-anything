const nativeWait = new Int32Array(new SharedArrayBuffer(4));
function busyJavaScript() {
  const until = performance.now() + 2_500;
  while (performance.now() < until) {
    /* intentional JS fault */
  }
}
function blockingNativeCall() {
  Atomics.wait(nativeWait, 0, 0, 2_500);
}
process.on("message", (mode) => {
  if (mode === "close") {
    process.disconnect();
    return;
  }
  process.send({ blockingAt: Date.now() });
  if (mode === "native") blockingNativeCall();
  else busyJavaScript();
  process.send({ recoveredAt: Date.now() });
});
process.send({ ready: true });
