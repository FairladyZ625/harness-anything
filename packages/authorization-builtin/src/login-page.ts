/** Self-contained loopback sign-in pages. No script, fonts or other external requests. */
export function builtinLoginPage(input: {
  readonly title: string;
  readonly message: string;
  readonly kind?: "login" | "device";
  readonly value?: string;
  readonly error?: boolean;
}): string {
  const field = input.kind === "device" ? "userCode" : "state";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)} · Harness Anything</title>
<link rel="icon" href="data:,">
<style>
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif;color:#253331;background:#f5f7f6}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;background:#fff;border:1px solid #dce5e2;border-radius:20px;padding:32px}
.brand{font-size:12px;font-weight:700;letter-spacing:.12em;color:#087d72;margin:0 0 28px}
h1{font-size:26px;line-height:1.2;margin:0 0 12px}p{margin:0 0 24px}form{display:grid;gap:18px}
label{display:grid;gap:6px;font-size:14px;font-weight:600}input,button{font:inherit;width:100%;border-radius:8px;padding:11px 12px}
input{border:1px solid #aebfba;background:transparent;color:inherit;min-width:0}
input:focus-visible,button:focus-visible{outline:3px solid #44b6a7;outline-offset:3px}
button{border:0;background:#087d72;color:#fff;font-weight:650;cursor:pointer}button:hover{background:#05675e}
.note{font-size:13px;color:#61716c;margin:26px 0 0}.error{color:#ad2e36}
@media(prefers-color-scheme:dark){:root{color:#e4eee9;background:#131b19}main{background:#1c2723;border-color:#35453f}.brand{color:#67d4c3}.note{color:#a3b6ad}.error{color:#ff9b9f}}
</style></head><body><main>
<p class="brand">HARNESS ANYTHING</p><h1>${escapeHtml(input.title)}</h1>
<p${input.error ? ' role="alert" class="error"' : ' role="status"'}>${escapeHtml(input.message)}</p>
${
  input.kind
    ? `<form method="post" action="/${input.kind}">
<label for="username">Username<input id="username" name="username" autocomplete="username" required autofocus></label>
<label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
<input type="hidden" name="${field}" value="${escapeHtml(input.value ?? "")}">
<button type="submit">Sign in</button></form>`
    : ""
}
<p class="note">Built-in identity · This computer only</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
