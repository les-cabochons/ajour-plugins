import { describe, expect, it } from "vitest";
import {
  buildPullRequestConfig,
  formatScopes,
  organizationRootUrl,
  repositoryInScope,
} from "../src/pull-request-config.ts";

describe("organizationRootUrl", () => {
  it.each([
    ["https://dev.azure.com/contoso", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/contoso/", "https://dev.azure.com/contoso"],
    ["https://contoso.visualstudio.com", "https://contoso.visualstudio.com"],
    ["https://contoso.visualstudio.com/DefaultCollection", "https://contoso.visualstudio.com/DefaultCollection"],
    ["https://ado.contoso.com/tfs/DefaultCollection/", "https://ado.contoso.com/tfs/DefaultCollection"],
  ])("normalizes %s", (input, expected) => {
    expect(organizationRootUrl(input)).toBe(expected);
  });

  it.each([["https://dev.azure.com"], ["not a url"], ["ftp://dev.azure.com/contoso"], [""]])(
    "rejects %j",
    (input) => {
      expect(() => organizationRootUrl(input)).toThrow(/organizationUrl/);
    },
  );

  // Ajour's broker sends every request under the saved URL and never above it.
  it.each([
    ["https://dev.azure.com/contoso/Fabrikam/_git/api", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/contoso/Fabrikam", "https://dev.azure.com/contoso"],
    ["https://contoso.visualstudio.com/Fabrikam", "https://contoso.visualstudio.com"],
  ])("refuses the project URL %s and names the organization's", (input, organization) => {
    expect(() => organizationRootUrl(input)).toThrow(`must be the organization's URL, ${organization}, not a project's`);
  });
});

function connection(config: Record<string, string | number | boolean>) {
  return { id: "c1", config };
}

describe("buildPullRequestConfig", () => {
  it("parses scopes and defaults", () => {
    const config = buildPullRequestConfig(
      connection({
        organizationUrl: "https://dev.azure.com/contoso/",
        pullRequestsInclude: "Fabrikam, Contoso / api ,",
        pullRequestsExclude: "Contoso/legacy",
      }),
    );

    expect(config).toEqual({
      connectionId: "c1",
      organizationUrl: "https://dev.azure.com/contoso",
      include: [{ project: "Fabrikam" }, { project: "Contoso", repository: "api" }],
      exclude: [{ project: "Contoso", repository: "legacy" }],
      hideDrafts: false,
      includeTeamRequests: true,
    });
    expect(formatScopes(config.include)).toBe("Fabrikam, Contoso/api");
  });

  it("holds no token: Ajour's broker keeps it", () => {
    const config = buildPullRequestConfig(
      connection({ organizationUrl: "https://dev.azure.com/contoso", personalAccessToken: "leaked" }),
    );
    expect(JSON.stringify(config)).not.toContain("leaked");
  });

  it("rejects a scope with too many slashes", () => {
    expect(() =>
      buildPullRequestConfig(connection({ organizationUrl: "https://dev.azure.com/contoso", pullRequestsInclude: "a/b/c" })),
    ).toThrow(/project\/repository/);
  });
});

describe("repositoryInScope", () => {
  const config = buildPullRequestConfig(
    connection({
      organizationUrl: "https://dev.azure.com/contoso",
      pullRequestsInclude: "Fabrikam",
      pullRequestsExclude: "fabrikam/Legacy",
    }),
  );

  it("keeps included projects case-insensitively and drops excluded repositories", () => {
    expect(repositoryInScope(config, "FABRIKAM", "api")).toBe(true);
    expect(repositoryInScope(config, "Fabrikam", "legacy")).toBe(false);
    expect(repositoryInScope(config, "Other", "api")).toBe(false);
  });
});
