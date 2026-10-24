import { describe, expect, it } from "vitest";
import { resolveEstimateSyncAction } from "../src/estimate-sync.ts";

describe("resolveEstimateSyncAction", () => {
  it("pushes the local value when only local changed", () => {
    expect(
      resolveEstimateSyncAction({
        localValue: 5,
        remoteValue: 8,
        baselineValue: 8,
      }),
    ).toEqual({
      status: "push",
      localValue: 5,
      remoteValue: 8,
      baselineValue: 8,
      nextBaselineValue: 5,
    });
  });

  it("pulls the remote value when only remote changed", () => {
    expect(
      resolveEstimateSyncAction({
        localValue: 8,
        remoteValue: 5,
        baselineValue: 8,
      }),
    ).toEqual({
      status: "pull",
      localValue: 8,
      remoteValue: 5,
      baselineValue: 8,
      nextBaselineValue: 5,
    });
  });

  it("creates a conflict when both sides changed", () => {
    expect(
      resolveEstimateSyncAction({
        localValue: 5,
        remoteValue: 3,
        baselineValue: 8,
      }),
    ).toEqual({
      status: "conflict",
      localValue: 5,
      remoteValue: 3,
      baselineValue: 8,
    });
  });

  it("forces a push when the user resolved the conflict by keeping local", () => {
    expect(
      resolveEstimateSyncAction({
        localValue: 5,
        remoteValue: 3,
        baselineValue: 8,
        resolution: "keep_local",
      }),
    ).toEqual({
      status: "push",
      localValue: 5,
      remoteValue: 3,
      baselineValue: 8,
      nextBaselineValue: 5,
    });
  });
});
