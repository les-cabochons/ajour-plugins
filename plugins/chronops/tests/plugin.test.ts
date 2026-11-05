import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeMinehunter } from "../contract/fake-minehunter.mjs";
import type { ChronopsSnapshot } from "../src/chronops.ts";
import { syncProjects, validateConnection } from "../src/plugin.ts";
import { mapChronopsSnapshot } from "../src/snapshot.ts";
import { answer, connection, createFakeAjour, forwardTo, requestError, type Responder } from "./fake-ajour.ts";

const fixture: ChronopsSnapshot = JSON.parse(readFileSync(new URL("../contract/fixture.json", import.meta.url), "utf8"));

/** Installs a test `ajour` for the plugin and returns it for assertions. */
function install(respond: Responder) {
  const ajour = createFakeAjour(respond);
  vi.stubGlobal("ajour", ajour);
  return ajour;
}

type Fake = Awaited<ReturnType<typeof startFakeMinehunter>>;
type FakeOptions = Parameters<typeof startFakeMinehunter>[0];

/** Starts a fake MineHunter for the suite and stops it after. */
function useFake(options: FakeOptions = {}) {
  let fake: Fake;
  beforeAll(async () => {
    fake = await startFakeMinehunter({ port: 0, ...options });
  });
  afterAll(() => fake.close());
  return () => install(forwardTo(fake.url));
}

afterEach(() => vi.unstubAllGlobals());

describe("validateConnection against the fake MineHunter", () => {
  describe("with a read token that never expires", () => {
    const withFake = useFake();

    it("reports the email, sends the source tag, and warns about nothing", async () => {
      const ajour = withFake();
      const result = await validateConnection(connection, { capabilities: [] });
      expect(result.normalizedConfig).toEqual(connection.config);
      expect(result.connectionSummary).toEqual({ Email: "marie.tremblay@example.com", Scope: "Read" });
      expect(result.warnings).toBeUndefined();
      expect(ajour.requests).toEqual([
        { method: "GET", path: "/integration/me", headers: { "x-chronops-source": "ajour" } },
      ]);
    });
  });

  describe("with a read-write token that expires", () => {
    // The fake compares the expiry with its own clock, so the date is computed
    // from now rather than fixed, or the test would start failing on that day.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const withFake = useFake({ scope: "read-write", expiresAt });

    it("asks for a read-only token and says when this one expires", async () => {
      withFake();
      const result = await validateConnection(connection, { capabilities: [] });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toMatch(/read token/);
      expect(result.connectionSummary).toEqual({
        Email: "marie.tremblay@example.com",
        Scope: "Read and write",
        "Token expires": expiresAt.slice(0, 10),
        Warning: result.warnings?.[0],
      });
    });
  });

  describe("with an expired token", () => {
    const withFake = useFake({ expiresAt: "2026-01-01T00:00:00.000Z" });

    it("says the token was revoked or expired", async () => {
      withFake();
      await expect(validateConnection(connection, { capabilities: [] })).rejects.toThrow(/revoked or expired/);
    });
  });
});

describe("syncProjects against the fake MineHunter", () => {
  const withFake = useFake();

  it("returns the mapped snapshot and the ETag as the cursor", async () => {
    const ajour = withFake();
    const result = await syncProjects(connection, {});
    expect(result).toEqual({ snapshot: mapChronopsSnapshot(fixture), cursor: expect.stringMatching(/^"[^"]+"$/) });
    expect(ajour.requests).toEqual([
      { method: "GET", path: "/integration/ajour/snapshot", headers: { "x-chronops-source": "ajour" } },
    ]);
  });

  it("sends the cursor as If-None-Match and reports unchanged on 304", async () => {
    const ajour = withFake();
    const first = await syncProjects(connection, {});
    const cursor = "cursor" in first ? first.cursor : undefined;
    expect(cursor).toBeDefined();

    await expect(syncProjects(connection, { cursor })).resolves.toEqual({ unchanged: true });
    expect(ajour.requests[1]?.headers).toEqual({ "x-chronops-source": "ajour", "if-none-match": cursor });

    const stale = await syncProjects(connection, { cursor: '"stale"' });
    expect(stale).toHaveProperty("snapshot");
  });

  it("logs one wide event per sync with counts and no names", async () => {
    const ajour = withFake();
    await syncProjects(connection, {});
    await syncProjects(connection, { cursor: '"stale"' });
    expect(ajour.logs).toHaveLength(2);
    expect(ajour.logs[0]).toMatchObject({ level: "info", fields: { projects: 3, tasks: 6, unchanged: false, hoursAvailable: true } });
    expect(JSON.stringify(ajour.logs)).not.toMatch(/Acme|marie/);
  });
});

describe("syncProjects with an ETag Ajour would refuse as a cursor", () => {
  it.each([
    ["empty", ""],
    ["longer than 2,000 characters", `"${"x".repeat(2_000)}"`],
  ])("returns the snapshot without a cursor when the ETag is %s", async (_case, etag) => {
    install(answer(200, fixture, { etag }));
    const result = await syncProjects(connection, {});
    expect(result).toEqual({ snapshot: mapChronopsSnapshot(fixture) });
  });
});

describe("syncProjects when the Forwarder refuses or fails", () => {
  it("says the token was revoked or expired on 401", async () => {
    install(answer(401, { error: "unknown or revoked personal token" }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/revoked or expired/);
  });

  it("passes on the reason of a 403", async () => {
    install(answer(403, { error: "this personal token only reads" }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/forbids.*this personal token only reads/);
  });

  it("says the Forwarder rate limited the request on 429", async () => {
    install(answer(429));
    await expect(syncProjects(connection, {})).rejects.toThrow(/10 requests a second/);
  });

  it("says ChronOps could not be reached on a network failure, without retrying", async () => {
    const ajour = install(() => {
      throw requestError("network");
    });
    await expect(syncProjects(connection, {})).rejects.toThrow(/could not be reached/);
    expect(ajour.requests).toHaveLength(1);
  });

  it("names any other status", async () => {
    install(answer(502, { error: "bad gateway" }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/HTTP 502/);
  });

  it("refuses a body that breaks the contract, and one that is not JSON", async () => {
    install(answer(200, { ...fixture, version: 1 }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/snapshot version 1/);

    const [acme] = fixture.projects;
    install(answer(200, { ...fixture, projects: [{ ...acme, budget: { ...acme!.budget, status: "Blue" } }] }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/projects\[0\]\.budget\.status/);

    install(() => ({ status: 200, body: "<html>" }));
    await expect(syncProjects(connection, {})).rejects.toThrow(/not JSON/);
  });
});
