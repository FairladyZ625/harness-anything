/* global window, document */
import assert from "node:assert/strict";

export default {
  id: "my-devices",
  feature: "identity-access",
  lane: "isolated",
  description: "Versioned device rename, pause, resume, removal and global sign-out on the actual identity page.",
  async run({ page, app, fixture, shot }) {
    fixture.keycloak.node("device-a", "person-gui");
    fixture.keycloak.node("device-b", "person-gui");
    fixture.keycloak.node("another-owner", "person-bo");
    await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
    await page.getByRole("tab", { name: /^(?:我的设备|My devices)$/u }).click();
    const a = page.getByTestId("device-device-a");
    await a.waitFor();
    assert.equal(await page.getByTestId("device-another-owner").count(), 0);
    await page.getByTestId("device-rename-device-a").click();
    await page.getByTestId("device-name").fill("工作设备 A · Development computer with a long name");
    await page.getByTestId("device-save-name").click();
    await a.filter({ hasText: "Development computer" }).waitFor();
    await page.getByTestId("device-toggle-device-a").click();
    await page.getByTestId("device-confirm").click();
    await a.filter({ hasText: /已暂停|Paused/u }).waitFor();
    await page
      .getByTestId("device-device-b")
      .filter({ hasText: /在用|In use/u })
      .waitFor();
    await page.getByTestId("device-toggle-device-a").click();
    await page.getByTestId("device-confirm").click();
    await a.filter({ hasText: /在用|In use/u }).waitFor();
    await page.getByTestId("device-remove-device-a").click();
    await page.getByTestId("device-confirm").click();
    await a.filter({ hasText: /已移除|Removed/u }).waitFor();
    assert.equal(await a.getByRole("button").count(), 0);
    await page.getByTestId("devices-logout-all").click();
    await page.getByTestId("device-confirm").click();
    await page
      .getByTestId("device-device-b")
      .filter({ hasText: /已暂停|Paused/u })
      .waitFor();
    assert.match(await page.getByTestId("devices-security-boundary").textContent(), /Keycloak/u);
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused));
    for (const [width, theme] of [
      [1440, "dark"],
      [1120, "light"],
    ]) {
      await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
      await page.getByRole("button", { name: /外观|Appearance/u }).click();
      await page.getByRole("button", { name: theme === "light" ? /亮色|Light/u : /暗色|Dark/u }).click();
      await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
      await page.getByRole("tab", { name: /^(?:我的设备|My devices)$/u }).click();
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      await page.waitForFunction((width) => window.innerWidth === width, width);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await shot(`my-devices-${width}-${theme}`);
    }
    await page.getByTestId("device-toggle-device-b").press("Enter");
    await page.getByTestId("device-confirmation").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByTestId("device-confirmation").count(), 0);
    await page.getByTestId("device-rename-device-b").click();
    const record = fixture.keycloak.nodeClients.get("harness-node-device-b");
    const device = JSON.parse(record.attributes.harness_device);
    record.attributes.harness_device = JSON.stringify({ ...device, revision: device.revision + 1 });
    await page.getByTestId("device-name").fill("Concurrent stale rename");
    await page.getByTestId("device-save-name").click();
    await page.getByTestId("device-refusal").waitFor();
    await page.keyboard.press("Escape");
    await shot("my-devices-version-conflict");
    assert.notEqual(JSON.parse(record.attributes.harness_device).displayName, "Concurrent stale rename");
    fixture.keycloak.nodeClients.delete("harness-node-device-a");
    fixture.keycloak.nodeClients.delete("harness-node-device-b");
    await page.getByRole("button", { name: /^(?:刷新|Refresh)$/u }).click();
    await page.getByTestId("devices-empty").waitFor();
    await shot("my-devices-empty");
  },
};
