import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConnection } from "../src/plugin.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("azure_devops plugin validateConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves task icon display mode in normalized config", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ value: [] }))
        .mockResolvedValueOnce(jsonResponse({ workItems: [] })),
    );

    await expect(
      validateConnection({
        organizationUrl: "https://dev.azure.com/contoso",
        personalAccessToken: "secret",
        queryScope: "assigned_to_me",
        taskIconDisplayMode: "fallback",
      }),
    ).resolves.toMatchObject({
      normalizedConfig: {
        organizationUrl: "https://dev.azure.com/contoso",
        personalAccessToken: "secret",
        queryScope: "assigned_to_me",
        taskIconDisplayMode: "fallback",
      },
    });
  });

  it("keeps each priority level's values, with defaults for a connection saved before they existed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ value: [] }))
        .mockResolvedValueOnce(jsonResponse({ workItems: [] })),
    );

    const result = await validateConnection({
      organizationUrl: "https://dev.azure.com/contoso",
      personalAccessToken: "secret",
      queryScope: "assigned_to_me",
      priorityUrgent: " 0-1 ",
      priorityLow: "",
    });

    expect(result.normalizedConfig).toMatchObject({
      priorityUrgent: "0-1",
      priorityHigh: "2",
      priorityMedium: "3",
      priorityLow: "",
    });
  });

  it("rejects invalid priority level values before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      validateConnection({
        organizationUrl: "https://dev.azure.com/contoso",
        personalAccessToken: "secret",
        queryScope: "assigned_to_me",
        priorityUrgent: "1-3",
        priorityHigh: "3",
      }),
    ).rejects.toThrow('High priority "3" overlaps Urgent priority.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-primitive field values before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      validateConnection({
        organizationUrl: "https://dev.azure.com/contoso",
        personalAccessToken: "secret",
        queryScope: "assigned_to_me",
        priorityFieldName: ["invalid"],
      } as never),
    ).rejects.toThrow("must contain only primitive values");
    expect(fetch).not.toHaveBeenCalled();
  });
});
