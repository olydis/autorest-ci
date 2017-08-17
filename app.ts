import * as request_plain from "request-promise-native";
import { arch, platform, release, tmpdir } from "os";
import { join } from "path";
import { } from "nodegit";

// config
const githubOwner = "Azure";
const githubRepo = "autorest.common";
const githubToken = process.env.GITHUB_TOKEN;
const ciIdentifier = `${platform()}-${arch()}`;
const ciStatusTimeoutMs = 1000 * 60 * 5; // 5min
const jobUid = Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), jobUid);

// helpers
const request = request_plain.defaults({
  headers: {
    "User-Agent": "AutoRest CI",
    "Authorization": "token " + githubToken
  }
});

const delay = (ms: number): Promise<void> => new Promise<void>(res => setTimeout(res, ms));

// GitHub
type PullRequest = { number: number, title: string, baseID: string, headID: string };
async function getPullRequests(): Promise<PullRequest[]> { // https://developer.github.com/v3/pulls/#list-pull-requests
  const res = await request.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/pulls`);
  const prs = JSON.parse(res);
  return prs.map(x => {
    return <PullRequest>{
      number: x.number,
      title: x.title,
      baseID: x.base.sha,
      headID: x.head.sha
    };
  });
}
type State = "success" | "pending" | "failure";
type Status = { updatedAt: Date, state: State, description: string, url: string };
type Statuses = { [jobName: string]: Status };
async function getPullRequestStatuses(pr: PullRequest): Promise<Statuses> { // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
  const res = await request.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/commits/${pr.headID}/status`);
  const statuses = JSON.parse(res).statuses;
  const result: Statuses = {};
  for (const status of statuses) {
    result[status.context] = {
      updatedAt: new Date(status.updated_at),
      state: status.state,
      description: status.description,
      url: status.target_url
    };
  }
  return result;
}

// app

function log(x: any): void { console.log(x); }

async function getJobStatus(pr: PullRequest): Promise<Status | undefined> {
  const statuses = await getPullRequestStatuses(pr);
  return statuses[ciIdentifier];
}

async function isLastStatusOurs(pr: PullRequest): Promise<boolean> {
  const status = await getJobStatus(pr);
  return status && status.description.startsWith(jobUid);
}

async function updateJobStatus(pr: PullRequest, state: State, description: string, url?: string): Promise<void> {
  // probe statuses to see whether we accidentally run concurrently

}

async function runJob(pr: PullRequest): Promise<void> {
  updateJobStatus(pr, "pending", "Fetching PR");
  log("   - fetching");

}

async function main() {
  log("CI job info");
  log(` - CI identifier: ${ciIdentifier}`);
  log(` - GitHub repo: ${githubOwner}/${githubRepo}`);
  log(` - using tmp folder: ${tmpFolder}`);

  const knownPRs: number[] = [];
  while (true) {
    log("Polling PRs");
    const prs = await getPullRequests();
    for (const pr of prs) {
      if (!knownPRs.includes(pr.number)) {
        log(` - PR ${pr.number} (${pr.title})`);
        const status = await getJobStatus(pr);
        if (!status) {
          log("   - new");
          await runJob(pr);
          knownPRs.push(pr.number);
        }
        else if (status.state === "success") {
          log("   - success (already passed)");
          knownPRs.push(pr.number);
        }
        else if (status.state === "pending" && Date.now() - status.updatedAt.getTime() < ciStatusTimeoutMs) {
          log("   - pending (looks active)");
        }
        else if (status.state === "pending") {
          log("   - pending (looks stuck)");
          await runJob(pr);
          knownPRs.push(pr.number);
        }
        else if (status.state === "failure") {
          log("   - failure");
          await runJob(pr);
          knownPRs.push(pr.number);
        }
      }
    }

    await delay(30000);
  }
}

main();