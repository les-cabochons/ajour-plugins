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
