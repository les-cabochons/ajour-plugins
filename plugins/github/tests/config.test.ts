import { describe, expect, it } from "vitest";
import { buildGitHubConfig, repositoryInScope } from "../src/config.ts";
import { pluginConnection } from "./support/github-ajour.ts";

const build = (config: Record<string, string | number | boolean> = {}) =>
  buildGitHubConfig(pluginConnection(config));

describe("GitHub connection config", () => {
  it("defaults to github.com, team requests on and drafts shown, and holds no token", () => {
    expect(buildGitHubConfig({ id: "c1", config: {} })).toEqual({
      connectionId: "c1",
      hostUrl: "https://github.com",
      include: [],
      exclude: [],
      hideDrafts: false,
      includeTeamRequests: true,
    });
  });

  it("keeps the origin of the saved URL, port included, for Enterprise Server", () => {
    expect(build({ hostUrl: "https://github.acme.com:8443/ignored/path" }).hostUrl).toBe("https://github.acme.com:8443");
    expect(build({ hostUrl: "http://ghe.internal.test/" }).hostUrl).toBe("http://ghe.internal.test");
  });

  it("rejects a GitHub URL that is not an HTTP address", () => {
    expect(() => build({ hostUrl: "not a url" })).toThrow(/GitHub URL/);
    expect(() => build({ hostUrl: "ftp://github.com" })).toThrow(/HTTP or HTTPS/);
    expect(() => build({ hostUrl: "https://www.github.com" })).toThrow(/without www/);
  });

  it("rejects a scope that is not an owner or owner/repository", () => {
    expect(() => build({ include: "acme/api/extra" })).toThrow(/acme\/api\/extra/);
  });

  it("keeps included owners and repositories and drops excluded ones", () => {
    const config = build({
      include: "Acme, octocat/hello-world",
      exclude: "acme/legacy",
    });

    expect(repositoryInScope(config, "acme/api")).toBe(true);
    expect(repositoryInScope(config, "ACME/Legacy")).toBe(false);
    expect(repositoryInScope(config, "octocat/hello-world")).toBe(true);
    expect(repositoryInScope(config, "octocat/other")).toBe(false);
  });

  it("keeps every repository without an include list", () => {
    expect(repositoryInScope(build(), "any/repo")).toBe(true);
  });
});
