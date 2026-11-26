import { API_VERSION, type AzurePullRequest, type AzureReposClient } from "./pull-requests.ts";
import type { CodeHostMergeRequest } from "./contract.ts";

/*
 * The merge methods Deck offers on Azure DevOps (les-cabochons/ajour#786):
 * those the target branch's "Limit merge types" policies allow. The Git
 * policy configurations endpoint filters them by repository and branch;
 * each policy's own scope is checked again here, so one on another
 * repository or branch never narrows this one's methods.
 */

/** Azure DevOps's "Limit merge types" policy, once "Require a merge strategy". */
export const MERGE_STRATEGY_POLICY = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

/** Where a policy applies: a repository, a branch or a branch prefix, or the whole project when both are left out. */
interface PolicyScope {
  repositoryId?: string | null;
  refName?: string | null;
  matchKind?: string;
}

interface MergeStrategyPolicy {
  type?: { id: string };
  isEnabled?: boolean;
  isDeleted?: boolean;
  settings?: {
    scope?: PolicyScope[];
    allowNoFastForward?: boolean;
    allowSquash?: boolean;
    allowRebase?: boolean;
    allowRebaseMerge?: boolean;
    /** The policy's older form: true allows only squash, false only a merge commit. */
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
  if (!modern) {
    if (settings.useSquashMerge === undefined) return EVERY_METHOD;
    return settings.useSquashMerge ? ["squash"] : ["merge"];
  }
  return [
    ...(settings.allowNoFastForward ? (["merge"] as const) : []),
    ...(settings.allowSquash ? (["squash"] as const) : []),
    ...(settings.allowRebase ? (["rebase"] as const) : []),
  ];
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Whether a policy's scope covers the pull request's repository and target branch. */
function covers(scopes: PolicyScope[] | undefined, repositoryId: string, refName: string) {
  if (!scopes?.length) return true;
  return scopes.some((scope) => {
    if (scope.repositoryId && !same(scope.repositoryId, repositoryId)) return false;
    if (!scope.refName) return true;
    return scope.matchKind?.toLowerCase() === "prefix"
      ? refName.toLowerCase().startsWith(scope.refName.toLowerCase())
      : same(scope.refName, refName);
  });
}

/**
 * The merge methods the target branch's policies allow, each one of every
 * policy that's on. Every method without a policy, or when the token can't
 * read them: Azure DevOps refuses a method its policy forbids at the merge.
 */
export async function allowedMergeMethods(client: AzureReposClient, pullRequest: AzurePullRequest) {
  const { targetRefName: refName, repository } = pullRequest;
  if (!refName) return EVERY_METHOD;
  let policies: MergeStrategyPolicy[];
  try {
    policies = (
      await client.get<{ value: MergeStrategyPolicy[] }>(
        `/${encodeURIComponent(repository.project.id)}/_apis/git/policy/configurations`,
        {
          repositoryId: repository.id,
          refName,
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
        !policy.isDeleted &&
        covers(policy.settings?.scope, repository.id, refName),
    )
    .reduce((allowed, policy) => {
      const own = allowedBy(policy);
      return allowed.filter((method) => own.includes(method));
    }, EVERY_METHOD);
}
