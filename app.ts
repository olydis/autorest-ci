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
  "autorest",
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

function runCommand(command: string, cwd: string): [() => string, Promise<Error | null>, () => void] {
  let output: string = "";
  let cancel: () => void = () => null;
  const promise = new Promise<Error | null>(r => {
    let res = (e: Error | null) => { r(e); res = () => { }; };
    try {
      const cp = exec(command, { cwd, maxBuffer: 64 * 1000 * 1000 }, err => res(err || null));
      cancel = () => cp.kill('SIGKILL');
      cp.stdout.on("data", chunk => output += chunk.toString());
      cp.stderr.on("data", chunk => output += chunk.toString());
    } catch (e) {
      res(e);
    }
  });
  return [() => output, promise, cancel];
}

// connect to storage
const blobSvc = createBlobService(azStorageAccount, azStorageAccessKey);

async function runJob(ghClient: GitHubCiClient, repo: string, pr: PullRequest): Promise<void> {
  try {
    const jobID = new Date().toISOString().replace(/[:-]/g, "").split('.')[0] + "_" + pr.number;
    const jobFolder = join(tmpFolder, jobID, repo);
    log("   - creating workspace");
    await mkdir(jobFolder);
    log("   - setting up blob storage");
    const container = await new Promise<string>((res, rej) => blobSvc.createContainerIfNotExists(
      "autorest-ci",
      { publicAccessLevel: "blob" },
      (error, result) => error ? rej(error) : res(result.name)));
    const blobContentSettings = { contentSettings: { contentType: "text/html", contentEncoding: "utf8" } };
    const blob = workerID + "_" + jobID;
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
    const pushLog = async (text: string): Promise<Error | null> => {
      try {
        await new Promise<void>((res, rej) => blobSvc.appendFromText(container, blob, text, blobContentSettings, (error, result) => error ? rej(error) : res()));
      } catch (e) {
        return e;
      }
      return null;
    };
    const pushFinal = async (success: boolean): Promise<Error | null> => pushLog(`</pre><style>body { background: ${success ? "#cfc" : "#fcc"} }</style>`);

    // git
    const timeStamp1 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Fetching");
    log(`   - fetching (target: '${jobFolder}')`);
    log("     - cloning");
    const git = simpleGit(jobFolder);
    await (git as any).init(false);
    await git.pull(ghClient.pullUrl, pr.baseRef);
    // log(`     - checkout base (${pr.baseRef})`);
    // await git.checkout(pr.baseRef);
    log(`     - fetch head repo (${pr.headRepoUrl})`);
    await (git as any).addRemote("other", pr.headRepoUrl);
    await git.fetch("other", "-v");
    log(`     - merge head (${pr.headID})`);
    await git.merge([pr.headID]);

    // recheck if what we're doing still makes sense
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // job
    const timeStamp2 = Date.now();
    await ghClient.setPullRequestStatus(pr, "pending", "Running test job", urlAR);
    log(`   - running test job`);
    const [pollOutput, resultPromise, cancel] = runCommand("npm install && npm test", jobFolder);
    let lastLength = 0;
    const sendFeedback = async () => {
      try {
        const output = pollOutput();
        const err = await pushLog(output.slice(lastLength));
        if (err) throw err;
        lastLength = output.length;
      } catch (e) {
        log(`     - failed to upload logs (${e})`);
      }
      // timeout?
      const timeoutSec = 60 * 30;
      // log(`     - heartbeat (${(Date.now() - timeStamp2) / 1000 | 0}s / ${timeoutSec | 1000}s)}`);
      if (Date.now() - timeStamp2 > 1000 * timeoutSec) {
        log(`     - cancelling`);
        cancel();
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
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // process error
    if (error) {
      log(`     - error`);
      pushFinal(false);
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
    pushFinal(true);
    await ghClient.setPullRequestStatus(pr, "success", `Success (git took ${(timeStamp2 - timeStamp1) / 1000 | 0}s, tests took ${(timeStamp3 - timeStamp2) / 1000 | 0}s)`, url);
    log(`     - success`);
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
    try {
      let didAnything = false; // for backing off
      for (const githubRepo of githubRepos) {
        const ghClient = new GitHubCiClient(ciIdentifier, workerID, githubOwner, githubRepo, githubToken);
        log(`Polling PRs of ${githubOwner}/${githubRepo}`);
        const prs = await ghClient.getPullRequests();
        for (const pr of prs) {
          // check commants
          const comments = await ghClient.getComments(pr);
          const prefix = `> ${ciIdentifier}`;
          const commants = comments.filter(x => x.message.startsWith(prefix));
          for (const commant of commants) {
            const command = commant.message.slice(prefix.length).trim();
            switch (command) {
              case "restart":
                await ghClient.setComment(commant.id, `~~~
${prefix} restart
< done
~~~
`);
                log("   - classification: commant restart");
                await runJob(ghClient, githubRepo, pr);
                knownPRs[pr.number] = pr;
                didAnything = true;
                break;
              default:
                await ghClient.setComment(commant.id, `# CI command help

| Comment | Effect |
| --- | --- |
| \`${prefix} restart\` | restarts job |
`)
            }
          }

          if (knownPRs[pr.number] && knownPRs[pr.number].headID === pr.headID) continue; // seen that PR?
          log(` - PR #${pr.number} ('${pr.title}')`);
          const status = await ghClient.getJobStatus(pr);
          if (!status) {
            log("   - classification: fresh");
            await runJob(ghClient, githubRepo, pr);
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
            await runJob(ghClient, githubRepo, pr);
            knownPRs[pr.number] = pr;
            didAnything = true;
          }
        }
      }
      await delay(didAnything ? 20000 : 120000);
    } catch (e) {
      await delay(120000);
      log("WORKER CARSHED:");
      log(e);
    }
  }
}

main();