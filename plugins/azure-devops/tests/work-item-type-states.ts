/** The states of an Agile process work item type, as Azure DevOps lists them. */
export const AGILE_TASK_STATES = [
  { name: "New", category: "Proposed" },
  { name: "Active", category: "InProgress" },
  { name: "Resolved", category: "Resolved" },
  { name: "Closed", category: "Completed" },
  { name: "Removed", category: "Removed" },
];

const STATES_PATH = /\/_apis\/wit\/workitemtypes\/[^/]+\/states/;

/**
 * Answers work item type state requests and hands every other request to
 * `fetchMock`, so tests that list their requests in order keep that order.
 */
export function withWorkItemTypeStates(
  fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  states: unknown[] | "fail" = AGILE_TASK_STATES,
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (STATES_PATH.test(String(input))) {
      return states === "fail"
        ? new Response(JSON.stringify({ message: "Not found" }), { status: 404 })
        : new Response(JSON.stringify({ value: states }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }
    return await fetchMock(input, init);
  };
}
