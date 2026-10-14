// Local dev server: the same app with an in-memory database, the synthetic mailbox,
// a test user and the rules-only classifier. No AWS account or network needed.
// Run with: npm run dev   (data resets on restart)

import { createServer } from "node:http";
import { createApp } from "../app";
import { LocalCipher, randomKeyB64 } from "../crypto";
import { FixtureMailbox } from "../fixtures";
import { TableAccounts } from "../store/single-table";
import { MemoryTable } from "../store/table";

const PORT = Number(process.env.PORT ?? 8787);

const app = createApp({
  config: {
    authkitDomain: "https://example.authkit.app",
    workosClientId: "dev",
    workosApiKey: "dev",
    googleClientId: "dev",
    googleClientSecret: "dev",
    sessionSecret: randomKeyB64(),
    withholdThreshold: 0.6,
    dev: true,
  },
  accounts: new TableAccounts(new MemoryTable()),
  cipher: new LocalCipher(randomKeyB64()),
  classifier: null,
  extractText: async () => null,
  devMailbox: () => new FixtureMailbox(),
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  const request = new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await app.handle(request);
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") out[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`Private Gmail gateway (dev) on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp  (header: authorization: Bearer dev)`);
});
