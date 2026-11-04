// A stand-in for MineHunter's Forwarder, for the chronops plugin's tests and
// for trying the plugin against Ajour before MineHunter ships the route.
//
//   node contract/fake-minehunter.mjs [--port 8787] [--scope read|read-write] [--expires-at <ISO date>]
//
// It serves two routes, as MineHunter does:
// - GET /integration/me, the token's user, with the scope and expiry chosen
//   above, so the plugin can test its warnings.
// - GET /integration/ajour/snapshot, fixture.json as is, with an ETag, and
//   304 when If-None-Match matches.
// Every request needs X-ChronOps-Token, any value, or gets 401, as does one
// once the chosen expiry is past. A read token gets 403 on anything but GET,
// so an integration can test the Forwarder's scope refusal. The real
// Forwarder also needs X-ChronOps-Source: ajour and limits at 10 requests a
// second; this fake does neither.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCOPES = ["read", "read-write"];

/**
 * Starts the fake on `port` (0 picks a free one) and resolves with its URL
 * and a `close` function.
 * @param {{ port?: number, scope?: "read" | "read-write", expiresAt?: string | null }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startFakeMinehunter({ port = 0, scope = "read", expiresAt = null } = {}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`scope must be one of ${SCOPES.join(", ")}, not ${JSON.stringify(scope)}.`);
  }
  const snapshot = readFileSync(new URL("./fixture.json", import.meta.url), "utf8");
  // A strong ETag from the fixture's bytes. It changes when the fixture does.
  const etag = `"${createHash("sha256").update(snapshot).digest("hex").slice(0, 32)}"`;
  const email = JSON.parse(snapshot).me.email;
  const me = JSON.stringify({ email, login: email.split("@")[0], scope, expiresAt });

  const server = createServer((request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      response.end(body);
    };
    const path = new URL(request.url, "http://localhost").pathname;

    // The same statuses and bodies as the real Forwarder and ChronOps.
    if (request.headers["x-chronops-token"] === undefined) {
      send(401, JSON.stringify({ error: "a personal token is required" }));
    } else if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      send(401, JSON.stringify({ error: "expired personal token" }));
    } else if (request.method !== "GET" && scope === "read") {
      send(403, JSON.stringify({ error: "this personal token only reads" }));
    } else if (request.method !== "GET") {
      send(404, JSON.stringify({ error: "not found" }));
    } else if (path === "/integration/me") {
      send(200, me);
    } else if (path === "/integration/ajour/snapshot") {
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag });
        response.end();
      } else {
        send(200, snapshot, { ETag: etag });
      }
    } else {
      send(404, JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: boundPort } = server.address();
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8787" },
      scope: { type: "string", default: "read" },
      "expires-at": { type: "string" },
    },
  });
  const fake = await startFakeMinehunter({
    port: Number(values.port),
    scope: values.scope,
    expiresAt: values["expires-at"] ?? null,
  });
  console.log(`Fake MineHunter at ${fake.url} (scope ${values.scope}, expires ${values["expires-at"] ?? "never"}). Ctrl+C stops it.`);
}
