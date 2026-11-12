import { describe, expect, it } from "vitest";
import { createPacer } from "../src/pacer.ts";

/** A pacer on a clock that only the waits move, and the waits it asked for. */
function pacedOnFakeClock(burst: number, perSecond: number) {
  let clock = 0;
  const waits: number[] = [];
  const pace = createPacer({
    burst,
    perSecond,
    now: () => clock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });
  return { pace, waits, advance: (milliseconds: number) => (clock += milliseconds) };
}

describe("createPacer", () => {
  it("lets the burst through at once, then one request per interval", async () => {
    const { pace, waits } = pacedOnFakeClock(10, 8);
    for (let index = 0; index < 13; index += 1) await pace();
    expect(waits).toEqual([125, 125, 125]);
  });

  it("refills while nobody asks, up to the burst", async () => {
    const { pace, waits, advance } = pacedOnFakeClock(2, 10);
    await pace();
    await pace();
    advance(60_000);
    await pace();
    await pace();
    await pace();
    expect(waits).toEqual([100]);
  });
});
