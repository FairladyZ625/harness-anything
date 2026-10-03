import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export default {
  id: "external-keycloak",
  feature: "identity-access",
  lane: "isolated",
  description: "External center credentials pass through the GUI; secrets clear on success and refusal.",
  async run({ page, app, shot }) {
    const secret = randomBytes(24).toString("hex");
    const authority = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const url = new URL(request.url, "http://localhost");
      const json = (value, status = 200) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname.endsWith("/token")) {
        const params = new URLSearchParams(body);
        return params.get("client_secret") === secret && params.get("client_id") === "harness-center"
          ? json({ access_token: "gui-service-token" })
          : json({}, 401);
      }
      if (url.pathname === "/realms/gui-fleet") return json({ realm: "gui-fleet" });
      if (request.headers.authorization !== "Bearer gui-service-token") return json({}, 403);
      if (url.pathname.endsWith("/users")) return json([]);
      return json({}, 404);
    });
    await new Promise((resolve) => authority.listen(0, "127.0.0.1", resolve));
    try {
      await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
      const form = page.getByTestId("external-binding-form");
      await form.waitFor();
      await form.locator('[name="url"]').fill(`http://127.0.0.1:${authority.address().port}`);
      await form.locator('[name="realm"]').fill("gui-fleet");
      const password = form.locator('[name="clientSecret"]');
      assert.equal(await password.getAttribute("type"), "password");
      await password.fill(secret);
      await form.locator('button[type="submit"]').click();
      await page.getByTestId("bootstrap-admin-form").waitFor();
      assert.equal(await password.inputValue(), "");
      await password.fill("invalid-candidate");
      await form.locator('button[type="submit"]').click();
      await page.getByRole("alert").filter({ hasText: "rbac_external_credentials_rejected" }).waitFor();
      assert.equal(await password.inputValue(), "");
      assert.equal((await page.locator("body").textContent()).includes(secret), false);
      const windows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(windows.length > 0 && windows.every((window) => !window.visible && !window.focused));
      await shot("external-keycloak-cleared");
    } finally {
      await new Promise((resolve, reject) => authority.close((error) => (error ? reject(error) : resolve())));
    }
  },
};
