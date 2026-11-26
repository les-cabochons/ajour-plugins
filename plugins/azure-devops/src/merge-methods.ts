import { API_VERSION, type AzurePullRequest, type AzureReposClient } from "./pull-requests.ts";
import type { CodeHostMergeRequest } from "./contract.ts";

/*
 * The merge methods Deck offers on Azure DevOps (les-cabochons/ajour#786):
 * those the target branch's "Limit merge types" policies allow.
 */

/** Azure DevOps's "Limit merge types" policy, once "Require a merge strategy". */
export const MERGE_STRATEGY_POLICY = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

interface MergeStrategyPolicy {
  type?: { id: string };
  isEnabled?: boolean;
  isDeleted?: boolean;
  settings?: {
    allowNoFastForward?: boolean;
    allowSquash?: boolean;
    allowRebase?: boolean;
    allowRebaseMerge?: boolean;
    /** The policy's older form: true allows only squash. */
    useSquashMerge?: boolean;
  };
}

const EVERY_METHOD: CodeHostMergeRequest["method"][] = ["merge", "squash", "rebase"];

/** The methods one policy allows. A semi-linear merge has no method in Deck. */
function allowedBy(policy: MergeStrategyPolicy): CodeHostMergeRequest["method"][] {
  const settings = policy.settings ?? {};
  const modern = ["allowNoFastForward", "allowSquash", "allowRebase", "allowRebaseMerge"].some(
    (field) => field in settings,
  );
  if (!modern) return settings.useSquashMerge ? ["squash"] : EVERY_METHOD;
  return [
    ...(settings.allowNoFastForward ? (["merge"] as const) : []),
    ...(settings.allowSquash ? (["squash"] as const) : []),
    ...(settings.allowRebase ? (["rebase"] as const) : []),
  ];
}

/**
 * The merge methods the target branch's policies allow, each one of every
 * policy that's on. Every method without a policy, or when the token can't
 * read them: Azure DevOps refuses a method its policy forbids at the merge.
 */
export async function allowedMergeMethods(client: AzureReposClient, pullRequest: AzurePullRequest) {
  if (!pullRequest.targetRefName) return EVERY_METHOD;
  let policies: MergeStrategyPolicy[];
  try {
    policies = (
      await client.get<{ value: MergeStrategyPolicy[] }>(
        `/${encodeURIComponent(pullRequest.repository.project.id)}/_apis/policy/configurations`,
        {
          repositoryId: pullRequest.repository.id,
          refName: pullRequest.targetRefName,
          policyType: MERGE_STRATEGY_POLICY,
          "api-version": API_VERSION,
        },
      )
    ).value;
  } catch {
    return EVERY_METHOD;
  }
  return policies
    .filter(
      (policy) =>
        (policy.type?.id ?? MERGE_STRATEGY_POLICY) === MERGE_STRATEGY_POLICY &&
        policy.isEnabled !== false &&
        !policy.isDeleted,
    )
    .reduce((allowed, policy) => {
      const own = allowedBy(policy);
      return allowed.filter((method) => own.includes(method));
    }, EVERY_METHOD);
}
