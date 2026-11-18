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
    expect(() => parseChronopsSnapshot({ ...fixture, version: 1 })).toThrow(/version 1.*versions 2 and 3/);
  });

  it("reads a version 2 snapshot, whose tasks have a phase and no budget or worked hours", () => {
    // MineHunter answers version 2 until its version 3 is deployed.
    const v2 = {
      ...fixture,
      version: 2,
      projects: fixture.projects.map((project) => ({
        ...project,
        tasks: project.tasks.map(({ budgetHours: _budget, workedHours: _worked, workedHoursAdjustment: _adjustment, ...task }) => ({
          ...task,
          phase: "",
        })),
      })),
    };
    const [task] = parseChronopsSnapshot(v2).projects[0]!.tasks;
    expect(task).toEqual({ ...fixture.projects[0]!.tasks[0]!, budgetHours: null, workedHours: null, workedHoursAdjustment: 0 });
    // A version 2 task with version 3's fields, or a version 3 task with a phase, strays from its contract.
    expect(() => parseChronopsSnapshot({ ...fixture, version: 2 })).toThrow(/tasks\[0\]\.phase/);
    const [acme] = fixture.projects;
    expect(() =>
      parseChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks: [{ ...acme!.tasks[0]!, phase: "" }] }] }),
    ).toThrow(/tasks\[0\]\.phase should be left out/);
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

  it("applies the schema's rules beyond types, as the JSON schema would", () => {
    const [acme] = fixture.projects;
    const task = acme!.tasks[0]!;
    const cases: [unknown, RegExp][] = [
      [withBudget({ consumedHours: -1 }), /budget\.consumedHours should be a number of 0 or more/],
      [{ ...fixture, reportAt: "yesterday" }, /snapshot\.reportAt should be an ISO 8601/],
      [{ ...fixture, projects: [{ ...acme!, contractStart: "2026-1-1" }] }, /projects\[0\]\.contractStart should be a date/],
      // Date.parse rolls these over to March 2 and May 1. The schema refuses them.
      [{ ...fixture, projects: [{ ...acme!, contractStart: "2026-02-30" }] }, /projects\[0\]\.contractStart should be a date/],
      [{ ...fixture, projects: [{ ...acme!, contractEnd: "2026-04-31" }] }, /projects\[0\]\.contractEnd should be a date/],
      [{ ...fixture, reportAt: "2026-02-30T12:00:00Z" }, /snapshot\.reportAt should be an ISO 8601/],
      [{ ...fixture, projects: [{ ...acme!, tasks: [{ ...task, id: "" }] }] }, /tasks\[0\]\.id should be a non-empty string/],
      [{ ...fixture, projects: [{ ...acme!, tasks: [{ ...task, myHours: -2 }] }] }, /tasks\[0\]\.myHours/],
      [{ ...fixture, projects: [{ ...acme!, tasks: [{ ...task, budgetHours: 0 }] }] }, /tasks\[0\]\.budgetHours should be a number over 0/],
      [{ ...fixture, projects: [{ ...acme!, tasks: [{ ...task, workedHours: "8" }] }] }, /tasks\[0\]\.workedHours should be a number/],
      [{ ...fixture, extra: true }, /snapshot\.extra should be left out/],
      [{ ...fixture, projects: [{ ...acme!, tasks: [{ ...task, colour: "red" }] }] }, /tasks\[0\]\.colour should be left out/],
      [{ ...fixture, me: { ...fixture.me, email: "not an email" } }, /me\.email/],
    ];
    for (const [body, message] of cases) {
      expect(() => parseChronopsSnapshot(body)).toThrow(message);
    }
    // remainingHours is the one figure the contract lets go negative.
    expect(parseChronopsSnapshot(withBudget({ remainingHours: -1 }))).toBeTruthy();
  });
});

describe("mapChronopsSnapshot", () => {
  const snapshot = mapChronopsSnapshot(fixture);

  it("names the source, dates the figures at reportAt and says whether my hours are known", () => {
    expect(snapshot.source).toEqual({ label: "ChronOps", url: CHRONOPS_HOME_URL });
    // Ajour opens the links in the browser and refuses anything but absolute https.
    expect(CHRONOPS_HOME_URL).toMatch(/^https:\/\//);
    for (const project of snapshot.projects) expect(project.url).toMatch(/^https:\/\/[^/]+\/a\/wepoint-chronops-app\/timetracking\/projects\//);
    expect(snapshot.asOf).toBe("2026-10-31T23:59:59.000Z");
    expect(snapshot.me).toEqual({ hoursAvailable: true, hoursNote: HOURS_NOTE, hoursSince: "2026-10-01" });
    expect(snapshot.projects).toHaveLength(3);
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
      budget: { unit: "hours", total: 40, consumed: 31.5, remaining: 8.5, status: "warning", since: "2026-10-01" },
      tasks: [
        // The lead's budget of 10 wins over Workday's estimate of 8, and the worked hours add the lead's 1.5.
        { remoteId: "1001", name: "Billet #101 - Login", closed: false, billable: true, estimateHours: 10, assigned: true, myHours: 5.25, workedHours: 9.75 },
        { remoteId: "1002", name: "Billet #102 - Export CSV", closed: false, billable: true, estimateHours: 4, assigned: false, workedHours: 0 },
        { remoteId: "1003", name: "Billet #099 - Fuseau horaire", closed: true, billable: true, estimateHours: 2, assigned: true, myHours: 2, workedHours: 2 },
      ],
    });
  });

  it("leaves out what ChronOps does not know: client, dates, my hours", () => {
    const [, globex] = snapshot.projects;
    expect(globex).not.toHaveProperty("client");
    // ChronOps cannot tell whether Globex is complete. Unknown stays open, since Ajour archives a complete project.
    expect(globex!.complete).toBe(false);
    const [acme] = fixture.projects;
    const blank = mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, client: "  " }] });
    expect(blank.projects[0]).not.toHaveProperty("client");
    expect(globex).not.toHaveProperty("startsOn");
    expect(globex).not.toHaveProperty("endsOn");
    expect(globex!.tasks[1]).not.toHaveProperty("myHours");
    expect(globex!.tasks[0]).toMatchObject({ remoteId: "2001", billable: false, estimateHours: 40, assigned: true, myHours: 14 });
  });

  it("gives a task the budget ChronOps shows: the lead's, else Workday's estimate over 0, else none", () => {
    const [acme] = fixture.projects;
    const budgetOf = (budgetHours: number | null, estimateHours: number) =>
      mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks: [{ ...acme!.tasks[0]!, budgetHours, estimateHours }] }] })
        .projects[0]!.tasks[0]!.estimateHours;
    expect([budgetOf(12, 8), budgetOf(null, 8), budgetOf(null, 0)]).toEqual([12, 8, undefined]);
  });

  it("adds the lead's adjustment to the worked hours, never below 0", () => {
    const [, globex] = snapshot.projects;
    // 30 hours from Workday, 2 taken off by the lead.
    expect(globex!.tasks[0]!.workedHours).toBe(28);
    const [acme] = fixture.projects;
    const workedOf = (workedHours: number, workedHoursAdjustment: number) =>
      mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks: [{ ...acme!.tasks[0]!, workedHours, workedHoursAdjustment }] }] })
        .projects[0]!.tasks[0]!.workedHours;
    expect([workedOf(0.1, 0.2), workedOf(3, -5)]).toEqual([0.3, 0]);
  });

  it("sends no worked hours from a version 2 snapshot, so Ajour reads its own time", () => {
    const [acme] = fixture.projects;
    const v2Task = { ...acme!.tasks[0]!, budgetHours: null, workedHours: null, workedHoursAdjustment: 0 };
    const [task] = mapChronopsSnapshot({ ...fixture, version: 2, projects: [{ ...acme!, tasks: [v2Task] }] }).projects[0]!.tasks;
    expect(task).not.toHaveProperty("workedHours");
    expect(task!.estimateHours).toBe(8);
  });

  it("trims names and codes, and names a blank project by its code and a blank task by its id", () => {
    // Ajour trims every name and refuses an empty one, which would fail the whole sync.
    const [acme] = fixture.projects;
    const spaced = mapChronopsSnapshot({
      ...fixture,
      projects: [{ ...acme!, code: " ACME-SUP ", name: "   ", tasks: [{ ...acme!.tasks[0]!, id: " 1001 ", name: " 	 " }] }],
    });
    expect(spaced.projects[0]).toMatchObject({ remoteId: "ACME-SUP", code: "ACME-SUP", name: "ACME-SUP" });
    expect(spaced.projects[0]!.tasks[0]).toMatchObject({ remoteId: "1001", name: "1001" });
  });

  it("fails the sync with a message for a blank project code or task id, which Ajour links by", () => {
    const [acme] = fixture.projects;
    expect(() => mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, code: "  " }] })).toThrow(/blank project code/);
    expect(() =>
      mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks: [{ ...acme!.tasks[0]!, id: " " }] }] }),
    ).toThrow(/blank task id/);
  });

  it("dates a monthly budget and the user's hours from the first of the report's month", () => {
    // reportAt is 2026-10-31: ChronOps' month, and myHours, start on October 1.
    const monthly = mapChronopsSnapshot(withBudget({ mode: "monthly" }));
    expect(monthly.me).toMatchObject({ hoursSince: "2026-10-01" });
    expect(monthly.projects[0]!.budget).toMatchObject({ since: "2026-10-01" });
    // The report's own date counts, not UTC's: late on the 31st in Montreal is still October.
    const late = mapChronopsSnapshot({ ...fixture, reportAt: "2026-10-31T22:30:00-04:00" });
    expect(late.me).toMatchObject({ hoursSince: "2026-10-01" });
  });

  it("leaves an annual budget undated, since ChronOps does not give the year's start", () => {
    const annual = mapChronopsSnapshot(withBudget({ mode: "annual" }));
    expect(annual.projects[0]!.budget).not.toHaveProperty("since");
  });

  it("says a budget's health in Ajour's words", () => {
    const statusOf = (status: "Green" | "Yellow" | "Red") => mapChronopsSnapshot(withBudget({ status })).projects[0]!.budget?.status;
    expect([statusOf("Green"), statusOf("Yellow"), statusOf("Red")]).toEqual(["ok", "warning", "over"]);
  });

  it("maps an annual project to a money budget when ChronOps knows the money, else to hours", () => {
    // The fixture's annual project has no money figures, so it stays in
    // hours and the over-budget state still shows.
    const [, globex] = snapshot.projects;
    expect(globex!.budget).toEqual({ unit: "hours", total: 200, consumed: 212, remaining: -12, status: "over" });

    const money = mapChronopsSnapshot(withBudget({ mode: "annual", maxBudget: 6000, spentBudget: 4725 }));
    expect(money.projects[0]!.budget).toEqual({ unit: "money", total: 6000, consumed: 4725, remaining: 1275, status: "warning" });

    const noCap = mapChronopsSnapshot(withBudget({ mode: "annual", maxBudget: null, spentBudget: 4725 }));
    expect(noCap.projects[0]!.budget).toEqual({ unit: "money", consumed: 4725, status: "warning" });
  });

  it("gives no budget to a project without a cap, and maps the rest of it", () => {
    // The fixture's third project: complete, no cap, one closed task nobody is assigned to.
    const [, , initech] = snapshot.projects;
    expect(initech).toEqual({
      remoteId: "INIT-ONB",
      code: "INIT-ONB",
      name: "Initech - Onboarding",
      client: "Initech",
      url: `${CHRONOPS_HOME_URL}/timetracking/projects/INIT-ONB`,
      complete: true,
      startsOn: "2026-03-01",
      endsOn: "2026-06-30",
      tasks: [{ remoteId: "3001", name: "Accès et comptes", closed: true, billable: true, estimateHours: 4, assigned: false, workedHours: 3.5 }],
    });
    // A cap without figures for the period, or a status ChronOps did not set, gives none either.
    const unconfigured = mapChronopsSnapshot(withBudget({ status: "Unconfigured" }));
    expect(unconfigured.projects[0]).not.toHaveProperty("budget");
    const noCap = mapChronopsSnapshot(withBudget({ capHours: null, remainingHours: null }));
    expect(noCap.projects[0]).not.toHaveProperty("budget");
  });

  it("cuts texts to Ajour's bounds, with an ellipsis", () => {
    const [acme] = fixture.projects;
    const long = (length: number) => "x".repeat(length);
    const mapped = mapChronopsSnapshot({
      ...fixture,
      projects: [{ ...acme!, name: long(241), client: long(241), tasks: [{ ...acme!.tasks[0]!, name: long(241) }] }],
    });
    const [project] = mapped.projects;
    expect(project!.name).toHaveLength(240);
    expect(project!.name.endsWith("\u2026")).toBe(true);
    expect(project!.client).toHaveLength(240);
    expect(project!.tasks[0]!.name).toHaveLength(240);
    expect(mapChronopsSnapshot(fixture).projects[0]!.name).toBe("Acme - Support");
  });

  it("refuses an id longer than Ajour's remote id, since a cut id would drift", () => {
    const [acme] = fixture.projects;
    const code = "C".repeat(101);
    expect(() => mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, code }] })).toThrow(/project code .* longer than 100/);
    const tasks = [{ ...acme!.tasks[0]!, id: "T".repeat(101) }];
    expect(() => mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks }] })).toThrow(/task id .* longer than 100/);
  });

  it("leaves out a project link longer than Ajour takes, and keeps the project", () => {
    const [acme] = fixture.projects;
    // 100 characters fit the remote id, but each é is 6 once encoded in the link.
    const code = "\u00e9".repeat(100);
    const [project] = mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, code }] }).projects;
    expect(project!.code).toBe(code);
    expect(project!.url).toBeUndefined();
  });

  it("refuses more projects or tasks than Ajour takes in one snapshot", () => {
    const [acme] = fixture.projects;
    const projects = Array.from({ length: 201 }, (_, index) => ({ ...acme!, code: `P-${index}` }));
    expect(() => mapChronopsSnapshot({ ...fixture, projects })).toThrow(/201 projects.*at most 200/);
    const tasks = Array.from({ length: 10_001 }, (_, index) => ({ ...acme!.tasks[0]!, id: `${index}` }));
    expect(() => mapChronopsSnapshot({ ...fixture, projects: [{ ...acme!, tasks }] })).toThrow(/10001 tasks.*at most 10000/);
  });

  it("says why my hours are missing when the user has no linked worker", () => {
    const unlinked = mapChronopsSnapshot({ ...fixture, me: { ...fixture.me, workerLinked: false } });
    expect(unlinked.me).toEqual({ hoursAvailable: false, hoursNote: HOURS_NOTE, hoursSince: "2026-10-01" });
  });
});
