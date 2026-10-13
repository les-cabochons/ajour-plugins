import { describe, expect, it } from "vitest";
import { buildGitHubConfig, graphqlUrlForHost, repositoryInScope } from "../src/config.ts";

describe("GitHub connection config", () => {
  it("uses api.github.com for github.com and /api for GitHub Enterprise Server", () => {
    expect(graphqlUrlForHost("https://github.com")).toBe("https://api.github.com/graphql");
    expect(graphqlUrlForHost("https://github.acme.com")).toBe("https://github.acme.com/api/graphql");
  });

  it("defaults to github.com, team requests on and drafts shown", () => {
    expect(buildGitHubConfig({ token: " secret " })).toEqual({
      hostUrl: "https://github.com",
      apiUrl: "https://api.github.com/graphql",
      token: "secret",
      include: [],
      exclude: [],
      hideDrafts: false,
      includeTeamRequests: true,
    });
  });

  it("requires a token", () => {
    expect(() => buildGitHubConfig({ hostUrl: "https://github.com" })).toThrow(/token/);
  });

  it("rejects a scope that is not an owner or owner/repository", () => {
    expect(() => buildGitHubConfig({ token: "t", include: "acme/api/extra" })).toThrow(/acme\/api\/extra/);
  });

  it("keeps included owners and repositories and drops excluded ones", () => {
    const config = buildGitHubConfig({
      token: "t",
      include: "Acme, octocat/hello-world",
      exclude: "acme/legacy",
    });

    expect(repositoryInScope(config, "acme/api")).toBe(true);
    expect(repositoryInScope(config, "ACME/Legacy")).toBe(false);
    expect(repositoryInScope(config, "octocat/hello-world")).toBe(true);
    expect(repositoryInScope(config, "octocat/other")).toBe(false);
  });

  it("keeps every repository without an include list", () => {
    expect(repositoryInScope(buildGitHubConfig({ token: "t" }), "any/repo")).toBe(true);
  });
});
