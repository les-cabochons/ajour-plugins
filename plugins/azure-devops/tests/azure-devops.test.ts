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
          },
        ],
      ),
    ).resolves.toMatchObject({
      workItemUpdates: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
