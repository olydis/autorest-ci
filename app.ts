#!/usr/bin/env node

import { GitHubCiClient, PullRequest } from './github';
import { arch, platform, release, tmpdir } from "os";
import { join } from "path";
import * as simpleGit from 'simple-git/promise';
import * as mkdir from 'mkdirp-promise';
import { exec } from "child_process";
import { createBlobService } from "azure-storage";
import * as as from "azure-storage";

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

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("expected args: <GitHub Token ('repo' access)> <Azure Storage Account> <Azure Storage Access Key>");
  process.exit(1);
}

const githubToken = args[0];
const azStorageAccount = args[1];
const azStorageAccessKey = args[2];
const ciStatusTimeoutMs = 1000 * 60 * 5; // 5min
const workerID = "CI" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), workerID);

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

// connect to storage
const blobSvc = createBlobService(azStorageAccount, azStorageAccessKey);

async function runJob(ghClient: GitHubCiClient, pr: PullRequest): Promise<void> {
  try {
    const jobID = new Date().toISOString().replace(/[:-]/g, "").split('.')[0] + "_" + pr.number;
    const jobFolder = join(tmpFolder, jobID);
    log("   - creating workspace");
    await mkdir(jobFolder);
    log("   - setting up blob storage");
    const container = await new Promise<string>((res, rej) => blobSvc.createContainerIfNotExists(
      "autorest-ci",
      { publicAccessLevel: "blob" },
      (error, result) => error ? rej(error) : res(result.name)));
    const blobContentSettings = { contentSettings: { contentType: "text/html", contentEncoding: "utf8" } };
    const blob = workerID + jobID;
    const url = `http://${azStorageAccount}.blob.core.windows.net/${container}/${blob}`;
    const urlAR = url + "?autorefresh";
    await new Promise<string>((res, rej) =>
      blobSvc.createAppendBlobFromText(
        container,
        blob,
        `
<head>
  <meta http-equiv="content-type" content="text/html; charset=UTF-8">
  <!--<meta http-equiv="refresh" content="5">-->
  <script>if(location.search) setTimeout(() => location.reload(), 5000);</script>
  <style>body { font-family: monospace; padding: 10px; }</style>
</head>
<h3>CI run for <a href="${ghClient.getPrUrl(pr)}">${ghClient.getPrName(pr)}</a> by worker ${workerID} (${ciIdentifier}) <span style="float: right">auto-refresh <a href="${urlAR}">on</a>/<a href="${url}">off</a></span></h3>
<hr>
<pre>`,
        blobContentSettings,
        (error, result) => error ? rej(error) : res(result.name)));

    // git
    const timeStamp1 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Fetching");
    log(`   - fetching (target: '${jobFolder}')`);
    log("     - cloning");
    const git = simpleGit(jobFolder);
    await git.clone(ghClient.cloneUrl, jobFolder);
    log(`     - checkout base (${pr.baseRef})`);
    await git.checkout(pr.baseRef);
    log(`     - fetch head repo (${pr.headRepoUrl})`);
    await (git as any).addRemote("other", pr.headRepoUrl);
    await git.fetch("other", "-v");
    log(`     - merge head (${pr.headID})`);
    await git.merge([pr.headID]);

    // recheck if what we're doing still makes sense
    if (await ghClient.wasUpdated(pr)) { log("   - abort: the PR was updated"); return; }
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // job
    const timeStamp2 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Running test job", urlAR);
    log(`   - running test job`);
    const [pollOutput, resultPromise] = runCommand("npm install && npm test", jobFolder);
    let lastLength = 0;
    const sendFeedback = async () => {
      try {
        const output = pollOutput();
        await new Promise<void>((res, rej) =>
          blobSvc.appendFromText(
            container,
            blob,
            output.slice(lastLength),
            blobContentSettings,
            (error, result) => error ? rej(error) : res()));
        lastLength = output.length;
      } catch (e) {
        log(`     - failed to upload logs (${e})`);
      }
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
    if (error) {
      log(`     - error`);
      await ghClient.setPullRequestStatus(pr, "failure", "" + error, url);
      try {
        log(`       - output: ${pollOutput()}`);
      } catch (_) {
        log(`       - output (fallback): ${error}`);
      }
      return;
    }

    // process success
    const timeStamp3 = Date.now();
    await ghClient.setPullRequestStatus(pr, "success", `Success (git took ${(timeStamp2 - timeStamp1) / 1000 | 0}s, tests took ${(timeStamp3 - timeStamp2) / 1000 | 0}s)`, url);
    log(`     - success`);

    // recheck if we just marked an updated PR as succeeded
    if (await ghClient.wasUpdated(pr)) { await ghClient.setPullRequestStatus(pr, "pending", `Stall. Just set status of an updated PR.`); log(`     - stall`); }
  } catch (e) {
    log(`     - job error`);
    // at least try notifying about failure
    try { await ghClient.setPullRequestStatus(pr, "pending", "Stall. Job error: " + e); } catch (en) {
      log(`       - failed notifying: ${en}`);
    }
    log(`       - output: ${e}`);
  }
}

async function main() {
  log("CI job info");
  log(` - CI identifier: ${ciIdentifier}`);
  log(` - using tmp folder: ${tmpFolder}`);

  const knownPRs: { [prNumber: number]: PullRequest } = {};

  while (true) {
    let didAnything = false; // for backing off
    for (const githubRepo of githubRepos) {
      const ghClient = new GitHubCiClient(ciIdentifier, workerID, githubOwner, githubRepo, githubToken);
      log(`Polling PRs of ${githubOwner}/${githubRepo}`);
      const prs = await ghClient.getPullRequests();
      for (const pr of prs) {
        if (knownPRs[pr.number] && knownPRs[pr.number].updatedAt === pr.updatedAt) continue; // seen that PR?
        log(` - PR #${pr.number} ('${pr.title}')`);
        const status = await ghClient.getJobStatus(pr);
        if (!status || status.updatedAt < pr.updatedAt) {
          log("   - classification: " + (status ? "updated" : "new"));
          await runJob(ghClient, pr);
          knownPRs[pr.number] = pr;
          didAnything = true;
        }
        else if (status.state === "success" || status.state === "failure") {
          log(`   - classification: done (${status.state})`);
          knownPRs[pr.number] = pr;
        }
        else if (status.state === "pending" && Date.now() - status.updatedAt.getTime() < ciStatusTimeoutMs) {
          log("   - classification: looks active (pending)");
        }
        else if (status.state === "pending") {
          log("   - classification: looks stuck (pending)");
          await runJob(ghClient, pr);
          knownPRs[pr.number] = pr;
          didAnything = true;
        }
      }
    }
    await delay(didAnything ? 10000 : 60000);
  }
}

main();