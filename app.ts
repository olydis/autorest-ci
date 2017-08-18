import * as request_plain from "request-promise-native";
import { arch, platform, release, tmpdir } from "os";
import { join } from "path";
import * as simpleGit from "simple-git/promise";
import * as mkdir from "mkdirp-promise";
import { exec } from "child_process";

// config
const githubOwner = "Azure";
const githubRepo = "autorest.common";
const githubToken = process.env.GITHUB_TOKEN;
const ciIdentifier = `${platform()}-${arch()}`;
const ciStatusTimeoutMs = 1000 * 60 * 5; // 5min
const jobUid = "CI" + Math.random().toString(36).substr(2, 5);
const statusPrefix = `[${jobUid}] `
const tmpFolder = join(tmpdir(), jobUid);

if (!githubToken) {
  console.error("No GitHub token specified");
  process.exit(1);
}

// helpers
const request = request_plain.defaults({
  headers: {
    "User-Agent": "AutoRest CI",
    "Authorization": "token " + githubToken
  }
});

const delay = (ms: number): Promise<void> => new Promise<void>(res => setTimeout(res, ms));

// GitHub
type PullRequest = { updatedAt: Date, number: number, title: string, baseRef: string, baseID: string, headID: string };
function parsePR(pr: any): PullRequest {
  return {
    updatedAt: new Date(pr.updated_at),
    number: pr.number,
    title: pr.title,
    baseRef: pr.base.ref,
    baseID: pr.base.sha,
    headID: pr.head.sha
  };
}
async function getPullRequests(): Promise<PullRequest[]> { // https://developer.github.com/v3/pulls/#list-pull-requests
  return JSON.parse(await request.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/pulls`)).map(parsePR);
}
async function getPullRequest(prNumber: number): Promise<PullRequest> { // https://developer.github.com/v3/pulls/#get-a-single-pull-request
  return parsePR(JSON.parse(await request.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/pulls/${prNumber}`)));
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
async function setPullRequestStatus(pr: PullRequest, state: State, description: string, url?: string): Promise<void> { // https://developer.github.com/v3/repos/statuses/#create-a-status
  const body: any = {};
  body.state = state;
  if (url) body.target_url = url;
  if (description) body.description = statusPrefix + description;
  body.context = ciIdentifier;
  const res = await request.post(`https://api.github.com/repos/${githubOwner}/${githubRepo}/statuses/${pr.headID}`, { body: JSON.stringify(body) });
}

// app

function log(x: any): void { console.log(x); }

async function getJobStatus(pr: PullRequest): Promise<Status | undefined> {
  const statuses = await getPullRequestStatuses(pr);
  return statuses[ciIdentifier];
}

async function isLastStatusOurs(pr: PullRequest): Promise<boolean> {
  const status = await getJobStatus(pr);
  console.log(status.description);
  return status && status.description.startsWith(statusPrefix);
}

async function wasUpdated(pr: PullRequest): Promise<boolean> {
  return (await getPullRequest(pr.number)).updatedAt.getTime() !== pr.updatedAt.getTime();
}

function runCommand(command: string, cwd: string): [() => string, Promise<Error | null>] {
  let output: string = "";
  return [() => output, new Promise<Error | null>(r => {
    let res = (e: Error | null) => { r(e); res = () => { }; };
    try {
      const cp = exec(command, { cwd }, err => res(err || null));
      cp.stdout.on("data", chunk => output += chunk.toString());
      cp.stderr.on("data", chunk => output += chunk.toString());
    } catch (e) {
      res(e);
    }
  })];
}

async function runJob(pr: PullRequest): Promise<void> {
  try {
    const jobFolder = join(tmpFolder, new Date().toISOString().replace(/[:-]/g, "").split('.')[0] + "_" + pr.number);
    log("   - creating workspace");
    await mkdir(jobFolder);

    // git
    const timeStamp1 = Date.now();
    await setPullRequestStatus(pr, "pending", "Fetching");
    log(`   - fetching (target: '${jobFolder}')`);
    log("     - cloning");
    const git = simpleGit(jobFolder);
    await git.clone(`https://${githubToken}@github.com/${githubOwner}/${githubRepo}`, jobFolder);
    log(`     - checkout base (${pr.baseRef})`);
    await git.checkout(pr.baseRef);
    log(`     - merge head (${pr.headID})`);
    await git.merge([pr.headID]);

    // recheck if what we're doing still makes sense
    if (await wasUpdated(pr)) { log("   - abort: the PR was updated"); return; }
    if (!await isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // job
    const timeStamp2 = Date.now();
    await setPullRequestStatus(pr, "pending", "Running test job");
    log(`   - running test job`);
    const [pollOutput, resultPromise] = runCommand("npm install && npm test", jobFolder);
    const sendFeedback = async () => {
    };
    let mutex = false;
    const feedbackTimer = setInterval(async () => { if (mutex) return; mutex = true; await sendFeedback(); mutex = false; }, 1000 * 5);
    const error = await resultPromise;

    // send final feedback one last time
    clearInterval(feedbackTimer);
    while (mutex) await delay(100);
    await sendFeedback();

    // recheck if what we're doing still makes sense
    if (await wasUpdated(pr)) { log("   - abort: the PR was updated"); return; }
    if (!await isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // process error
    if (error) throw error;

    // process success
    const timeStamp3 = Date.now();
    await setPullRequestStatus(pr, "success", `Success (git took ${(timeStamp2 - timeStamp1) / 1000 | 0}s, tests took ${(timeStamp3 - timeStamp2) / 1000 | 0}s)`);
    log(`     - success`);

    // recheck if we just marked an updated PR as succeeded
    if (await wasUpdated(pr)) { await setPullRequestStatus(pr, "pending", `Stall. Just set status of an updated PR.`); log(`     - stall`); }
  } catch (e) {
    // at least try notifying about failure
    try { await setPullRequestStatus(pr, "failure", ("" + e).slice(0, 1000)); } catch (_) { }
    log(`     - error (${e})`);
    throw e;
  }
}

async function main() {
  log("CI job info");
  log(` - CI identifier: ${ciIdentifier}`);
  log(` - GitHub repo: ${githubOwner}/${githubRepo}`);
  log(` - using tmp folder: ${tmpFolder}`);

  const prs: { [prNumber: number]: Date } = {};

  while (true) {
    try {
      log("Polling PRs");
      const prs = await getPullRequests();
      for (const pr of prs) {
        if (prs[pr.number] && prs[pr.number].updatedAt === pr.updatedAt) continue; // seen that PR?
        log(` - PR #${pr.number} ('${pr.title}')`);
        const status = await getJobStatus(pr);
        if (!status || status.updatedAt < pr.updatedAt) {
          log("   - classification: " + (status ? "updated" : "new"));
          await runJob(pr);
          prs[pr.number] = pr;
        }
        else if (status.state === "success" || status.state === "failure") {
          log(`   - classification: done (${status.state})`);
          prs[pr.number] = pr;
        }
        else if (status.state === "pending" && Date.now() - status.updatedAt.getTime() < ciStatusTimeoutMs) {
          log("   - classification: looks active (pending)");
        }
        else if (status.state === "pending") {
          log("   - classification: looks stuck (pending)");
          await runJob(pr);
          prs[pr.number] = pr;
        }
      }
    } catch (e) {
      console.error(e);
      log("Will retry...");
    }

    await delay(10000);
  }
}

main();