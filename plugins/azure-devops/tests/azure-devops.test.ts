import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAzureDevOpsImportCandidates,
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
  validateAzureDevOpsConnection,
} from "../src/azure-devops.ts";

function buildConnection(
  overrides: Partial<AzureDevOpsConnectionInput> = {},
): AzureDevOpsConnectionInput {
  return {
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: "https://dev.azure.com/contoso",
    personalAccessToken: "secret",
    queryScope: "assigned_to_me",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("Azure DevOps connector priority field resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves a configured display name to the Azure reference name before syncing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              name: "MS Priority",
              referenceName: "Custom.MSPriority",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.fields).toContain("Custom.MSPriority");
        expect(body.fields).not.toContain("MS Priority");

        return jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Investigate incident",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
                "Custom.MSPriority": "55",
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              relations: [],
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAzureDevOpsImportCandidates(
        buildConnection({
          priorityFieldName: "MS Priority",
        }),
      ),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          title: "Investigate incident",
          priority: 55,
          workItemType: "Task",
        }),
      ],
    });
  });

  it("returns resolved field metadata including WIQL queryability during validation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              name: "MS Priority",
              referenceName: "Custom.MSPriority",
              type: "integer",
              isQueryable: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateAzureDevOpsConnection(
        buildConnection({
          priorityFieldName: "MS Priority",
        }),
      ),
    ).resolves.toEqual({
      priorityField: {
        configuredName: "MS Priority",
        resolvedName: "MS Priority",
        resolvedReferenceName: "Custom.MSPriority",
        type: "integer",
        isQueryable: false,
      },
    });
  });

  it("reads mapped estimate fields from Azure work items", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Original Estimate",
          referenceName: "Custom.OriginalEstimate",
        },
        {
          name: "Remaining Work",
          referenceName: "Custom.RemainingWork",
        },
        {
          name: "Completed Work",
          referenceName: "Custom.CompletedWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.fields).toEqual(
          expect.arrayContaining([
            "Custom.OriginalEstimate",
            "Custom.RemainingWork",
            "Custom.CompletedWork",
          ]),
        );

        return jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Investigate incident",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
                "Custom.OriginalEstimate": 12,
                "Custom.RemainingWork": 8,
                "Custom.CompletedWork": 4,
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              relations: [],
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAzureDevOpsImportCandidates(
        buildConnection({
          originalEstimateFieldName: "Original Estimate",
          remainingEstimateFieldName: "Remaining Work",
          completedEstimateFieldName: "Completed Work",
        }),
      ),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          originalEstimateHours: 12,
          remainingEstimateHours: 8,
          completedEstimateHours: 4,
        }),
      ],
    });
  });

  it("pushes non-conflicting local estimate changes back to Azure DevOps", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Remaining Work",
          referenceName: "Custom.RemainingWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.fields).toContain("Custom.RemainingWork");
        return jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Investigate incident",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
                "Custom.RemainingWork": 8,
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              relations: [],
            },
          ],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual([
          {
            op: "add",
            path: "/fields/Custom.RemainingWork",
            value: 5,
          },
        ]);
        return jsonResponse({});
      });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncAzureDevOpsConnection(
        buildConnection({
          remainingEstimateFieldName: "Remaining Work",
        }),
        [
          {
            localWorkItemId: "local-1",
            sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
            remainingEstimateHours: 5,
            estimateSync: {
              remainingEstimateHours: {
                baselineValue: 8,
                remoteValue: 8,
              },
            },
          },
        ],
      ),
    ).resolves.toMatchObject({
      workItemUpdates: [
        {
          localWorkItemId: "local-1",
          fields: {
            remainingEstimateHours: expect.objectContaining({
              status: "pushed",
              nextBaselineValue: 5,
            }),
          },
        },
      ],
    });
  });

  it("pushes local completed work when the Azure field is initially blank", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Completed Work",
          referenceName: "Custom.CompletedWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.fields).toContain("Custom.CompletedWork");
        return jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Investigate incident",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              relations: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            null,
            { referenceName: 42 },
            {},
            {
              name: "Completed Work",
              referenceName: "CUSTOM.COMPLETEDWORK",
            },
          ],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual([
          {
            op: "add",
            path: "/fields/Custom.CompletedWork",
            value: 2,
          },
        ]);
        return jsonResponse({});
      });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncAzureDevOpsConnection(
        buildConnection({
          completedEstimateFieldName: "Completed Work",
        }),
        [
          {
            localWorkItemId: "local-1",
            sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
            completedEstimateHours: 2,
          },
        ],
      ),
    ).resolves.toMatchObject({
      workItemUpdates: [
        {
          localWorkItemId: "local-1",
          fields: {
            completedEstimateHours: expect.objectContaining({
              status: "pushed",
              nextBaselineValue: 2,
            }),
          },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5]?.[0]).toContain("/_apis/wit/workitems/123");
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("preflights missing-field metadata before applying any work item updates", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Completed Work",
          referenceName: "Custom.CompletedWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }, { id: 456 }, { id: 789 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Existing completed work",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
                "Custom.CompletedWork": 1,
              },
            },
            {
              id: 456,
              fields: {
                "System.Title": "First blank completed work",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
            {
              id: 789,
              fields: {
                "System.Title": "Second blank completed work",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { id: 123, relations: [] },
            { id: 456, relations: [] },
            { id: 789, relations: [] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: "Metadata unavailable" }, 503),
      )
      .mockResolvedValueOnce(
        jsonResponse({}),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncAzureDevOpsConnection(
      buildConnection({
        completedEstimateFieldName: "Completed Work",
      }),
      [
        {
          localWorkItemId: "local-1",
          sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
          completedEstimateHours: 2,
          estimateSync: {
            completedEstimateHours: {
              baselineValue: 1,
              remoteValue: 1,
            },
          },
        },
        {
          localWorkItemId: "local-2",
          sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/456",
          completedEstimateHours: 2,
        },
        {
          localWorkItemId: "local-3",
          sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/789",
          completedEstimateHours: 3,
        },
      ],
    );

    expect(result.workItemUpdates).toMatchObject([
      {
        localWorkItemId: "local-1",
        fields: {
          completedEstimateHours: {
            status: "pushed",
            nextBaselineValue: 2,
          },
        },
      },
      {
        localWorkItemId: "local-2",
        fields: {
          completedEstimateHours: {
            status: "error",
            message: "Azure DevOps request failed (503): Metadata unavailable",
          },
        },
      },
      {
        localWorkItemId: "local-3",
        fields: {
          completedEstimateHours: {
            status: "error",
            message: "Azure DevOps request failed (503): Metadata unavailable",
          },
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("does not expose a next baseline when a blank-field write fails", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Completed Work",
          referenceName: "Custom.CompletedWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Rejected completed work",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 123, relations: [] }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              name: "Completed Work",
              referenceName: "Custom.CompletedWork",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: "Write rejected" }, 400),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncAzureDevOpsConnection(
      buildConnection({
        completedEstimateFieldName: "Completed Work",
      }),
      [
        {
          localWorkItemId: "local-1",
          sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
          completedEstimateHours: 2,
        },
      ],
    );

    expect(result.workItemUpdates).toMatchObject([
      {
        localWorkItemId: "local-1",
        fields: {
          completedEstimateHours: {
            status: "error",
            message: "Azure DevOps request failed (400): Write rejected",
          },
        },
      },
    ]);
    expect(
      result.workItemUpdates?.[0]?.fields.completedEstimateHours,
    ).not.toHaveProperty("nextBaselineValue");
  });

  it("reports malformed work item type metadata as a field error", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Completed Work",
          referenceName: "Custom.CompletedWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({ workItems: [{ id: 123 }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Malformed metadata",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 123, relations: [] }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: {} }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncAzureDevOpsConnection(
      buildConnection({ completedEstimateFieldName: "Completed Work" }),
      [
        {
          localWorkItemId: "local-1",
          sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
          completedEstimateHours: 2,
        },
      ],
    );

    expect(result.workItemUpdates).toMatchObject([
      {
        localWorkItemId: "local-1",
        fields: {
          completedEstimateHours: {
            status: "error",
            message: "Azure DevOps returned invalid work item type field metadata.",
          },
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
  });

  it("skips mapped estimate sync when a work item type does not expose that field", async () => {
    const fieldListResponse = jsonResponse({
      value: [
        {
          name: "Remaining Work",
          referenceName: "Custom.RemainingWork",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
          workItems: [{ id: 123 }],
        }),
      )
      .mockImplementationOnce(async () =>
        jsonResponse({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "PBI without estimate field",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Product Backlog Item",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 123,
              relations: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              name: "Title",
              referenceName: "System.Title",
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncAzureDevOpsConnection(
        buildConnection({
          remainingEstimateFieldName: "Remaining Work",
        }),
        [
          {
            localWorkItemId: "local-1",
            sourceId: "https://dev.azure.com/contoso/Maintenance%20and%20Support/_workitems/edit/123",
            remainingEstimateHours: 5,
            estimateSync: {
              remainingEstimateHours: {
                baselineValue: 3,
                remoteValue: 3,
              },
            },
          },
        ],
      ),
    ).resolves.toMatchObject({
      workItemUpdates: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("rejects ambiguous display-name matches during connection validation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              name: "MS Priority",
              referenceName: "Custom.TeamA.Priority",
            },
            {
              name: "MS Priority",
              referenceName: "Custom.TeamB.Priority",
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateAzureDevOpsConnection(
        buildConnection({
          priorityFieldName: "MS Priority",
        }),
      ),
    ).rejects.toThrow(
      'Azure DevOps field "MS Priority" matched multiple fields by display name.',
    );
  });
});
