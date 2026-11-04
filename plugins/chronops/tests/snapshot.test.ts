import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChronopsSnapshot, type ChronopsSnapshot } from "../src/chronops.ts";
import { CHRONOPS_HOME_URL, HOURS_NOTE, mapChronopsSnapshot } from "../src/snapshot.ts";

const fixture: ChronopsSnapshot = JSON.parse(
  readFileSync(new URL("../contract/fixture.json", import.meta.url), "utf8"),
);

function withBudget(budget: Partial<ChronopsSnapshot["projects"][number]["budget"]>) {
  const [acme] = fixture.projects;
  return { ...fixture, projects: [{ ...acme!, budget: { ...acme!.budget, ...budget } }] };
}

describe("parseChronopsSnapshot", () => {
  it("accepts the contract fixture as is", () => {
    expect(parseChronopsSnapshot(fixture)).toEqual(fixture);
  });

  it("refuses a snapshot version it does not know, naming both versions", () => {
    expect(() => parseChronopsSnapshot({ ...fixture, version: 2 })).toThrow(/version 2.*version 1/);
  });

  it("names the field that breaks the contract", () => {
    const [acme] = fixture.projects;
    const noMode = withBudget({ mode: undefined as never });
    expect(() => parseChronopsSnapshot(noMode)).toThrow(/projects\[0\]\.budget\.mode/);

    const badStatus = withBudget({ status: "Blue" as never });
    expect(() => parseChronopsSnapshot(badStatus)).toThrow(/projects\[0\]\.budget\.status/);

    const taskId = { ...fixture, projects: [{ ...acme!, tasks: [{ ...acme!.tasks[0]!, id: 1001 }] }] };
    expect(() => parseChronopsSnapshot(taskId)).toThrow(/projects\[0\]\.tasks\[0\]\.id/);

    expect(() => parseChronopsSnapshot("not json")).toThrow(/snapshot/);
    expect(() => parseChronopsSnapshot({ ...fixture, me: { email: "a@b.c" } })).toThrow(/me\.workerLinked/);
  });
});

describe("mapChronopsSnapshot", () => {
  const snapshot = mapChronopsSnapshot(fixture);

  it("names the source, dates the figures at reportAt and says whether my hours are known", () => {
    expect(snapshot.source).toEqual({ label: "ChronOps", url: CHRONOPS_HOME_URL });
    expect(snapshot.asOf).toBe("2026-10-31T23:59:59.000Z");
    expect(snapshot.me).toEqual({ hoursAvailable: true, hoursNote: HOURS_NOTE });
    expect(snapshot.projects).toHaveLength(2);
  });

  it("maps a monthly project to an hours budget, with its dates and client", () => {
    const [acme] = snapshot.projects;
    expect(acme).toEqual({
      remoteId: "ACME-SUP",
      code: "ACME-SUP",
      name: "Acme - Support",
      client: "Acme inc.",
      url: `${CHRONOPS_HOME_URL}/timetracking/projects/ACME-SUP`,
      complete: false,
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
      budget: { unit: "hours", total: 40, consumed: 31.5, remaining: 8.5, status: "Yellow" },
      tasks: [
        { remoteId: "1001", name: "Billet #101 - Login", group: "Support", closed: false, billable: true, estimateHours: 8, assigned: true, myHours: 5.25 },
        { remoteId: "1002", name: "Billet #102 - Export CSV", group: "Support", closed: false, billable: true, estimateHours: 4, assigned: false },
        { remoteId: "1003", name: "Billet #099 - Fuseau horaire", group: "Support", closed: true, billable: true, estimateHours: 2, assigned: true, myHours: 2 },
      ],
    });
  });

  it("leaves out what ChronOps does not know: client, dates, my hours", () => {
    const [, globex] = snapshot.projects;
    expect(globex).not.toHaveProperty("client");
    expect(globex).not.toHaveProperty("startsOn");
    expect(globex).not.toHaveProperty("endsOn");
    expect(globex!.tasks[1]).not.toHaveProperty("myHours");
    expect(globex!.tasks[0]).toMatchObject({ remoteId: "2001", group: "Gestion", billable: false, estimateHours: 0, assigned: true, myHours: 14 });
  });

  it("maps an annual project to a money budget when ChronOps knows the money, else to hours", () => {
    // The fixture's annual project has no money figures: hours, so the
    // over-budget state still shows.
    const [, globex] = snapshot.projects;
    expect(globex!.budget).toEqual({ unit: "hours", total: 200, consumed: 212, remaining: -12, status: "Red" });

    const money = mapChronopsSnapshot(withBudget({ mode: "annual", maxBudget: 6000, spentBudget: 4725 }));
    expect(money.projects[0]!.budget).toEqual({ unit: "money", total: 6000, consumed: 4725, remaining: 1275, status: "Yellow" });

    const noCap = mapChronopsSnapshot(withBudget({ mode: "annual", maxBudget: null, spentBudget: 4725 }));
    expect(noCap.projects[0]!.budget).toEqual({ unit: "money", consumed: 4725, status: "Yellow" });
  });

  it("gives no budget to a project ChronOps has not configured", () => {
    const unconfigured = mapChronopsSnapshot(withBudget({ status: "Unconfigured", capHours: 0, consumedHours: 3, remainingHours: -3 }));
    expect(unconfigured.projects[0]).not.toHaveProperty("budget");
  });

  it("says why my hours are missing when the user has no linked worker", () => {
    const unlinked = mapChronopsSnapshot({ ...fixture, me: { ...fixture.me, workerLinked: false } });
    expect(unlinked.me).toEqual({ hoursAvailable: false, hoursNote: HOURS_NOTE });
  });
});
