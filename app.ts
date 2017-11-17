#!/usr/bin/env node

import { GitHubCiClient, PullRequest } from './github';
import { arch, platform, release, tmpdir } from "os";
import { join } from "path";
import * as simpleGit from 'simple-git/promise';
import * as mkdir from 'mkdirp-promise';
import { exec } from "child_process";
import { createBlobService } from "azure-storage";
import * as as from 'azure-storage';
import { commentIndicatorCoverage, createBlobContainer, githubOwner, githubRepos } from './common';
import { delay } from "./delay";
import { readFileSync } from 'fs';

// config
const ciIdentifier = `${platform()}-${arch()}`;

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("expected args: <GitHub Token ('repo' access)> <Azure Storage Account> <Azure Storage Access Key> [<working folder>]");
  process.exit(1);
}

process.on("uncaughtException", e => console.error("Just caught this: " + e));

const githubToken = args[0];
const azStorageAccount = args[1];
const azStorageAccessKey = args[2];
const timeoutSec = 60 * 30;
const ciStatusTimeoutMs = 1500 * timeoutSec; // 1.5 * timeout
const workerID = "CI" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(args[3] || tmpdir(), workerID);

if (!githubToken) {
  console.error("No GitHub token specified");
  process.exit(1);
}

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
      cp.once("close", () => res(null))
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
    const jobID = pr.number + "_" + new Date().toISOString().replace(/[:-]/g, "").split('.')[0];
    const jobFolder = join(tmpFolder, jobID, repo);
    log("   - creating workspace");
    await mkdir(jobFolder);
    log("   - setting up blob storage");
    const container = await createBlobContainer(blobSvc, "job-nov");
    const blobContentSettings = { contentSettings: { contentType: "text/html; charset=utf-8" } };
    const blob = workerID + "_" + repo + "_" + jobID;
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
  <title>${ghClient.getPrName(pr)}</title>
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
    const [pollOutput, resultPromise, cancel] = runCommand("npm install && npm run testci", jobFolder);
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
    while (mutex) await delay(1);
    await sendFeedback();

    // recheck if what we're doing still makes sense
    if (!await ghClient.isLastStatusOurs(pr)) { log("   - abort: looks like another worker handles this PR"); return; }

    // try posting coverage
    try {
      // try cleaning up previous auto-comments
      try {
        const comments = await ghClient.getCommentsWithIndicator(pr, commentIndicatorCoverage);
        for (const comment of comments)
          await ghClient.tryDeleteComment(comment.id);
      } catch (e) { }

      // search for report
      const testServerFolder = join(jobFolder, "node_modules", "@microsoft.azure", "autorest.testserver");
      const testServerVersion = require(join(testServerFolder, "package.json")).version;
      const report: any = {};
      report.General = require(join(testServerFolder, "report-vanilla.json"));
      report.Azure = require(join(testServerFolder, "report-azure.json"));

      // post report
      let comment = "";
      for (const category of Object.keys(report)) {
        const categoryObject = report[category];
        const features = Object.keys(categoryObject).sort().map(x => [x, categoryObject[x] > 0] as [string, boolean]);
        const percentCoverage = features.filter(x => x[1]).length / features.length * 100 | 0;
        const countMissing = features.filter(x => !x[1]).length;
        comment += `## ${category}: ${percentCoverage}% ${countMissing ? "" : "✔️"}\n\n`;
        if (countMissing > 0) {
          comment += `The following ${countMissing} features are not covered by your tests:\n`;
          for (const feature of features.filter(x => !x[1])) {
            const f = feature[0];
            comment += `❌ [\`${f}\`](https://github.com/Azure/autorest.testserver/search?q=${f})\n`;
          }
        }
        comment += "\n\n";
      }

      await ghClient.createComment(pr, `${commentIndicatorCoverage}# 🤖 AutoRest automatic feature coverage report 🤖\n*feature set version ${testServerVersion}*\n\n${comment}`);
    } catch (e) {
      log(`     - test coverage error: ${e}`);
    }

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

  const knownPRsx: { [repo: string]: { [prNumber: number]: PullRequest } } = {};

  while (true) {
    try {
      let didAnything = false; // for backing off
      for (const githubRepo of githubRepos) {
        const knownPRs = knownPRsx[githubRepo] = knownPRsx[githubRepo] || {};
        const ghClient = new GitHubCiClient(ciIdentifier, workerID, githubOwner, githubRepo, githubToken, "olydis");
        log(`Polling PRs of ${githubOwner}/${githubRepo}`);
        const prs = await ghClient.getPullRequests();
        for (const pr of prs) {
          log(` - PR #${pr.number} ('${pr.title}')`);

          // check commants
          const prefix = `> ${ciIdentifier}`;
          const commants = await ghClient.getCommentsWithIndicator(pr, prefix);
          for (const commant of commants) {
            const command = commant.message.slice(prefix.length).trim();
            log("   - command: " + command);
            switch (command) {
              case "restart":
                await ghClient.setComment(commant.id, `~~~
${prefix} restart
~~~
`);
                await runJob(ghClient, githubRepo, pr);
                knownPRs[pr.number] = pr;
                didAnything = true;
                break;
              default:
                await ghClient.setComment(commant.id, `# CI commands for \`${ciIdentifier}\`

| Comment | Effect |
| --- | --- |
| \`${prefix} restart\` | restarts job |
`)
            }
          }

          if (knownPRs[pr.number] && knownPRs[pr.number].headID === pr.headID) continue; // seen that PR?
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
      await delay(didAnything ? 20 : 120);
    } catch (e) {
      log("WORKER CARSHED:");
      log(e);
      await delay(120);
    }
  }
}

main();