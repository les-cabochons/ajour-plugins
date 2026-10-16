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
    ["https://dev.azure.com/contoso/Fabrikam/_git/api", "https://dev.azure.com/contoso"],
    ["https://contoso.visualstudio.com/Fabrikam", "https://contoso.visualstudio.com"],
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
});

describe("buildPullRequestConfig", () => {
  it("parses scopes and defaults", () => {
    const config = buildPullRequestConfig({
      organizationUrl: "https://dev.azure.com/contoso/",
      personalAccessToken: " secret ",
      pullRequestsInclude: "Fabrikam, Contoso / api ,",
      pullRequestsExclude: "Contoso/legacy",
    });

    expect(config).toEqual({
      organizationUrl: "https://dev.azure.com/contoso",
      token: "secret",
      include: [{ project: "Fabrikam" }, { project: "Contoso", repository: "api" }],
      exclude: [{ project: "Contoso", repository: "legacy" }],
      hideDrafts: false,
      includeTeamRequests: true,
    });
    expect(formatScopes(config.include)).toBe("Fabrikam, Contoso/api");
  });

  it("requires a token", () => {
    expect(() => buildPullRequestConfig({ organizationUrl: "https://dev.azure.com/contoso" })).toThrow(
      /personalAccessToken/,
    );
  });

  it("rejects a scope with too many slashes", () => {
    expect(() =>
      buildPullRequestConfig({ organizationUrl: "https://dev.azure.com/contoso", personalAccessToken: "t", pullRequestsInclude: "a/b/c" }),
    ).toThrow(/project\/repository/);
  });
});

describe("repositoryInScope", () => {
  const config = buildPullRequestConfig({
    organizationUrl: "https://dev.azure.com/contoso",
    personalAccessToken: "t",
    pullRequestsInclude: "Fabrikam",
    pullRequestsExclude: "fabrikam/Legacy",
  });

  it("keeps included projects case-insensitively and drops excluded repositories", () => {
    expect(repositoryInScope(config, "FABRIKAM", "api")).toBe(true);
    expect(repositoryInScope(config, "Fabrikam", "legacy")).toBe(false);
    expect(repositoryInScope(config, "Other", "api")).toBe(false);
  });
});
