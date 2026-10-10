/* global window, document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { reportFleetDeviceLogin } from "../../../packages/daemon/src/fleet/edge.ts";

// Real daemon inbox + TLS authentication + Electron IPC/browser; the provider page is a protocol fixture.
export default {
  id: "device-login-approval",
  feature: "identity-access",
  lane: "isolated",
  description: "Two pending edge device sign-ins and in-app user-code approval, with no desktop focus.",
  async run({ page, app, fixture, shot }) {
    const originalFetch = fixture.keycloak.fetch;
    const provider = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/realms/harness/device") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<!doctype html><html><body><h1>Keycloak device approval (protocol fixture)</h1><p>Verify code: ${url.searchParams.get("user_code")}</p><p>Allow this device to sign in as person-gui?</p><button>Allow</button></body></html>`,
        );
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const answer = await originalFetch(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(raw
          ? {
              body: request.headers["content-type"]?.includes("x-www-form-urlencoded") ? new URLSearchParams(raw) : raw,
            }
          : {}),
      });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const configFile = path.join(fixture.userRoot, "rbac/config.json"),
      originalConfig = readFileSync(configFile, "utf8"),
      keyPath = path.join(fixture.rootDir, "device-tls.key"),
      certPath = path.join(fixture.rootDir, "device-tls.crt");
    writeFileSync(
      configFile,
      JSON.stringify({ ...JSON.parse(originalConfig), url: `http://127.0.0.1:${provider.address().port}` }),
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    try {
      const nodes = ["node-one", "node-two"],
        credentials = nodes.map((node) => fixture.keycloak.node(node, "person-gui")),
        center = await requestDaemonJsonRpcAt(
          fixture.endpoint,
          "daemon.fleet.center.start",
          {
            payload: {
              port: 0,
              keyPath,
              certPath,
              repoId: fixture.repoId,
              quotaBytes: 64 * 1024 * 1024,
            },
          },
          1_000,
          20_000,
        );
      assert.equal(center.ok, true, JSON.stringify(center));
      const now = Date.now(),
        requests = nodes.map((nodeId, index) => ({
          peer: { port: center.port, ca: readFileSync(certPath), nodeId, credential: credentials[index] },
          notice: {
            userCode: index ? "CCCC-DDDD" : "AAAA-BBBB",
            createdAt: now,
            expiresAt: now + 120_000,
            pending: true,
          },
        }));
      await Promise.all(requests.map(({ peer, notice }) => reportFleetDeviceLogin(peer, notice)));
      await page.getByTestId("sidebar-account").click();
      await page.getByTestId("device-login-node-one").waitFor();
      await page.getByTestId("device-login-node-two").waitFor();
      assert.equal((await page.evaluate(() => window.harness.auth.status())).deviceLoginRequests.length, 2);
      for (const width of [1440, 1120]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await page.waitForFunction((width) => window.innerWidth === width, width);
        await shot(`device-pending-${width}`);
      }
      await page.getByTestId("device-approve-node-two").click();
      await page.getByTestId("account-login").waitFor();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="in-app-browser-webview"]')?.getURL().includes("/realms/harness/device"),
      );
      const approval = await app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find((content) => content.getType() === "webview");
        return { url: guest?.getURL(), text: guest ? await guest.executeJavaScript("document.body.innerText") : null };
      });
      assert.equal(new URL(approval.url).searchParams.get("user_code"), "CCCC-DDDD");
      assert.ok(approval.text.includes("Allow this device"), approval.text);
      await shot("device-approval-page");
      // A successful edge poll sends this same completion notice; Harness does not click provider consent.
      await reportFleetDeviceLogin(requests[1].peer, { ...requests[1].notice, pending: false });
      await page.getByTestId("account-login-cancel").click();
      await page.getByTestId("device-login-node-one").waitFor();
      assert.equal(await page.getByTestId("device-login-node-two").count(), 0);
      await reportFleetDeviceLogin(requests[0].peer, { ...requests[0].notice, pending: false });
      await page.getByTestId("device-login-requests").waitFor({ state: "detached" });
    } finally {
      writeFileSync(configFile, originalConfig);
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    }
  },
};
