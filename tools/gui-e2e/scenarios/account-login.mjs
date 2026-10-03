/* global window, document */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Real Electron, loopback callback and daemon PKCE exchange; only the identity provider is a protocol fixture.
export default {
  id: "account-login",
  feature: "identity-access",
  lane: "isolated",
  description: "Account navigation, explicit logout, embedded PKCE login, cancellation and retry.",
  async run({ page, app, fixture, shot }) {
    const originalFetch = fixture.keycloak.fetch;
    const accessToken = `fixture.${Buffer.from(JSON.stringify({ realm_access: { roles: ["access-admin"] } })).toString("base64url")}.fixture`;
    let pending,
      exchanges = 0,
      refuse = false;
    const handle = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/realms/harness") return Response.json({ realm: "harness" });
      if (url.pathname.endsWith("/protocol/openid-connect/auth")) {
        pending = url.searchParams;
        assert.equal(pending.get("code_challenge_method"), "S256");
        const callback = new URL(pending.get("redirect_uri"));
        callback.search = new URLSearchParams(
          refuse
            ? { error: "access_denied", state: pending.get("state") }
            : { code: "fixture-code", state: pending.get("state") },
        ).toString();
        return new Response(
          `<!doctype html><html><body><h1>Fixture identity provider</h1><p>Isolated PKCE sign-in</p><a href="${callback.toString().replaceAll("&", "&amp;")}">Continue</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname.endsWith("/token") && init.body.get("grant_type") === "authorization_code") {
        assert.equal(init.body.get("code"), "fixture-code");
        assert.equal(init.body.get("redirect_uri"), pending.get("redirect_uri"));
        assert.equal(
          createHash("sha256").update(init.body.get("code_verifier")).digest("base64url"),
          pending.get("code_challenge"),
        );
        exchanges++;
        return Response.json({
          access_token: accessToken,
          refresh_token: "fixture-refresh",
          expires_in: 300,
          refresh_expires_in: 1800,
        });
      }
      if (url.pathname.endsWith("/userinfo"))
        return Response.json({ sub: "person-gui", harness_person_id: "person-gui" });
      if (url.pathname.endsWith("/revoke")) return new Response(null, { status: 204 });
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") === `Bearer ${accessToken}`)
        headers.set("authorization", "Bearer token-person-gui");
      return originalFetch(input, { ...init, headers });
    };
    const provider = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const answer = await handle(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(body
          ? {
              body: request.headers["content-type"]?.includes("x-www-form-urlencoded")
                ? new URLSearchParams(body)
                : body,
            }
          : {}),
      });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const configPath = path.join(fixture.userRoot, "rbac", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, url: `http://127.0.0.1:${provider.address().port}` }));
    try {
      await app.evaluate(({ shell }) => {
        globalThis.accountExternalCalls = 0;
        shell.openExternal = async () => {
          globalThis.accountExternalCalls++;
        };
      });
      const account = page.getByTestId("sidebar-account");
      await account.filter({ hasText: "person-gui" }).waitFor();
      await account.click();
      await page.getByTestId("identity-session").filter({ hasText: "person-gui" }).waitFor();
      assert.equal((await page.evaluate(() => window.harness.auth.status())).authenticated, true);
      const action = page.getByTestId("account-session-action");
      await action.click();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="identity-session"]')?.textContent.includes("person-gui"),
      );
      assert.equal((await page.evaluate(() => window.harness.auth.status())).authenticated, false);

      const openLogin = async () => {
        await action.click();
        await page.getByTestId("in-app-browser-webview").waitFor();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="in-app-browser-webview"]')
            ?.getURL()
            .includes("/protocol/openid-connect/auth"),
        );
        const guest = await app.evaluate(({ webContents }) => {
          const guest = webContents.getAllWebContents().find((content) => content.getType() === "webview");
          const prefs = guest.getLastWebPreferences();
          return { url: guest.getURL(), node: prefs.nodeIntegration, sandbox: prefs.sandbox, preload: prefs.preload };
        });
        assert.ok(guest.url.includes("code_challenge="));
        assert.equal(guest.node, false);
        assert.equal(guest.sandbox, true);
        assert.equal(guest.preload, undefined);
      };
      const continueLogin = () =>
        app.evaluate(async ({ webContents }) => {
          const guest = webContents.getAllWebContents().find((content) => content.getType() === "webview");
          await guest.executeJavaScript('document.querySelector("a").click()');
        });
      await openLogin();
      for (const width of [1440, 1120]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await page.waitForFunction((width) => window.innerWidth === width, width);
        await shot(`account-login-${width}`);
      }
      await page.getByTestId("account-login-cancel").click();
      await action.waitFor();
      assert.equal(exchanges, 0);
      await openLogin();
      await continueLogin();
      await page.getByTestId("identity-session").filter({ hasText: "person-gui" }).waitFor();
      await account.filter({ hasText: "person-gui" }).waitFor();
      assert.equal(exchanges, 1);
      await account.click();
      assert.equal((await page.evaluate(() => window.harness.auth.status())).authenticated, true);
      await shot("account-signed-in");
      await action.click();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="identity-session"]')?.textContent.includes("person-gui"),
      );
      refuse = true;
      await openLogin();
      await continueLogin();
      await page.getByRole("alert").filter({ hasText: "omitted code or state" }).waitFor();
      assert.equal(exchanges, 1);
      refuse = false;
      await openLogin();
      await continueLogin();
      await page.getByTestId("identity-session").filter({ hasText: "person-gui" }).waitFor();
      assert.equal(exchanges, 2);
      assert.equal(await app.evaluate(() => globalThis.accountExternalCalls), 0);
      await shot("account-retry-complete");
    } finally {
      writeFileSync(configPath, JSON.stringify(config));
      await new Promise((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
    }
  },
};
