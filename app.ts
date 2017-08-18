#!/usr/bin/env node

import { GitHubCiClient, PullRequest } from './github';
import { arch, platform, release, tmpdir } from "os";
import { join } from "path";
import * as simpleGit from 'simple-git/promise';
import * as mkdir from 'mkdirp-promise';
import { exec } from "child_process";

// config
const ciIdentifier = `${platform()}-${arch()}`;
const githubOwner = "Azure";
const githubRepos = [
  "autorest.common",
  "autorest.modeler",
  "autorest.azureresourceschema",
  "autorest.csharp",
  "autorest.go",
  "autorest.java",
  "autorest.nodejs",
  "autorest.php",
  "autorest.ruby",
  "autorest.python",
  "autorest.testserver"
];
const githubToken = process.env.GITHUB_TOKEN;
const ciStatusTimeoutMs = 1000 * 60 * 5; // 5min
const jobUid = "CI" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), jobUid);

if (!githubToken) {
  console.error("No GitHub token specified");
  process.exit(1);
}

const delay = (ms: number): Promise<void> => new Promise<void>(res => setTimeout(res, ms));
function log(x: any): void { console.log(x); }

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

async function runJob(ghClient: GitHubCiClient, pr: PullRequest): Promise<void> {
  try {
    const jobFolder = join(tmpFolder, new Date().toISOString().replace(/[:-]/g, "").split('.')[0] + "_" + pr.number);
    log("   - creating workspace");
    await mkdir(jobFolder);

    // git
    const timeStamp1 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Fetching");
    log(`   - fetching (target: '${jobFolder}')`);
    log("     - cloning");
    const git = simpleGit(jobFolder);
    await git.clone(ghClient.cloneUrl, jobFolder);
    log(`     - checkout base (${pr.baseRef})`);
    await git.checkout(pr.baseRef);
    log(`     - merge head (${pr.headID})`);
    await git.merge([pr.headID]);

    // recheck if what we're doing still makes sense
    if (await ghClient.wasUpdated(pr)) { log("   - abort: the PR was updated"); return; }
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // job
    const timeStamp2 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Running test job");
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
    if (await ghClient.wasUpdated(pr)) { log("   - abort: the PR was updated"); return; }
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // process error
    if (error) throw error;

    // process success
    const timeStamp3 = Date.now();
    await ghClient.setPullRequestStatus(pr, "success", `Success (git took ${(timeStamp2 - timeStamp1) / 1000 | 0}s, tests took ${(timeStamp3 - timeStamp2) / 1000 | 0}s)`);
    log(`     - success`);

    // recheck if we just marked an updated PR as succeeded
    if (await ghClient.wasUpdated(pr)) { await ghClient.setPullRequestStatus(pr, "pending", `Stall. Just set status of an updated PR.`); log(`     - stall`); }
  } catch (e) {
    // at least try notifying about failure
    try { await ghClient.setPullRequestStatus(pr, "failure", ("" + e).slice(0, 1000)); } catch (_) { }
    log(`     - error (${e})`);
    throw e;
  }
}

async function main() {
  log("CI job info");
  log(` - CI identifier: ${ciIdentifier}`);
  log(` - using tmp folder: ${tmpFolder}`);

  const prs: { [prNumber: number]: Date } = {};

  while (true) {
    let didAnything = false; // for backing off
    for (const githubRepo of githubRepos) {
      const ghClient = new GitHubCiClient(ciIdentifier, jobUid, githubOwner, githubRepo, githubToken);
      log(`Polling PRs of ${githubOwner}/${githubRepo}`);
      const prs = await ghClient.getPullRequests();
      for (const pr of prs) {
        try {
          if (prs[pr.number] && prs[pr.number].updatedAt === pr.updatedAt) continue; // seen that PR?
          log(` - PR #${pr.number} ('${pr.title}')`);
          const status = await ghClient.getJobStatus(pr);
          if (!status || status.updatedAt < pr.updatedAt) {
            log("   - classification: " + (status ? "updated" : "new"));
            await runJob(ghClient, pr);
            prs[pr.number] = pr;
            didAnything = true;
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
            await runJob(ghClient, pr);
            prs[pr.number] = pr;
            didAnything = true;
          }
        } catch (e) {
          console.error(e);
          log("Skipping PR...");
        }
      }
    }
    await delay(didAnything ? 10000 : 60000);
  }
}

main();