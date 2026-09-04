export default {
  id: "daemon-startup-wait",
  feature: "daemon-startup",
  lane: "isolated",
  description: "A renderer reload waits visibly for an unavailable daemon and recovers without another reload.",
  async run({ page, fixture, shot }) {
    await fixture.pauseDaemon();
    await page.reload();
    await page.getByTestId("daemon-startup-waiting").waitFor();
    await shot("daemon-startup-waiting");
    await fixture.resumeDaemon();
    await page.getByTestId("daemon-startup-waiting").waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^(?:总览|Overview)$/u }).waitFor();
  },
};
