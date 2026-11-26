import { afterEach, describe, expect, it, vi } from "vitest";
import { getPullRequestContent, validateConnection } from "../src/plugin.ts";
import { pluginConnection, stubAzureFetch } from "./support/azure-ajour.ts";

/*
 * The plugin sends REST api-version 7.1, which Azure DevOps Server has
 * since 2022.1. An older server refuses it; the plugin says which release
 * it needs instead of passing Azure DevOps's message on.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Azure DevOps Server 2022.0, refusing 7.1 as it answers an api-version past its own. */
function serverOf2022() {
  return stubAzureFetch(
    async () =>
      new Response(
        JSON.stringify({
          $id: "1",
          innerException: null,
          message:
            "The requested REST API version of 7.1 is out of range for this server. The latest REST API version this server supports is 7.0.",
          typeName: "Microsoft.VisualStudio.Services.WebApi.VssVersionOutOfRangeException, Microsoft.VisualStudio.Services.WebApi",
          typeKey: "VssVersionOutOfRangeException",
          errorCode: 0,
          eventId: 3000,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
  );
}

const TOO_OLD = "This Azure DevOps Server is older than Ajour supports. Ajour needs Azure DevOps Server 2022.1 or later.";

describe("an Azure DevOps Server older than 2022.1", () => {
  it("says which release Ajour needs when Deck reads a pull request", async () => {
    serverOf2022();

    await expect(
      getPullRequestContent(pluginConnection(), { repository: "Fabrikam/api", number: 12 }),
    ).rejects.toThrow(TOO_OLD);
  });

  it("says which release it needs when a work items connection is saved", async () => {
    serverOf2022();

    await expect(validateConnection(pluginConnection(), { capabilities: ["connector"] })).rejects.toThrow(TOO_OLD);
  });
});
