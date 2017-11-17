#!/usr/bin/env node

import { GitHubCiClient, PullRequest } from './github';
import { arch, platform, release, tmpdir } from "os";
import { writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import * as simpleGit from 'simple-git/promise';
import * as mkdir from 'mkdirp-promise';
import { exec, execSync } from "child_process";
import { createBlobService } from "azure-storage";
import * as as from 'azure-storage';
import { commentIndicatorCoverage, commentIndicatorPublish, createBlobContainer, githubOwner, githubRepos } from './common';
import { delay } from "./delay";

const commentHeader = "# 🤖 AutoRest automatic publish job 🤖";

// config
const workerID = "PUBLISH" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), workerID);

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("expected args: <GitHub Token ('public_repo' access)> <Azure Storage Account> <Azure Storage Access Key> [<working folder>]");
  process.exit(1);
}

const githubToken = args[0];
const azStorageAccount = args[1];
const azStorageAccessKey = args[2];

// connect to storage
const blobSvc = createBlobService(azStorageAccount, azStorageAccessKey);

function log(x: any): void { console.log(x); }

function runCommand(command: string, cwd: string): [() => string, Promise<Error | null>, () => void] {
  let output: string = "";
  let cancel: () => void = () => null;
  const promise = new Promise<Error | null>(r => {
    let res = (e: Error | null) => { r(e); res = () => { }; };
    try {
      const cp = exec(command, { cwd, maxBuffer: 64 * 1000 * 1000 }, err => res(err || null));
      cancel = () => { cp.kill('SIGKILL'); res(new Error("timeout")); }
      cp.stdout.on("data", chunk => output += chunk.toString());
      cp.stderr.on("data", chunk => output += chunk.toString());
    } catch (e) {
      res(e);
    }
  });
  return [() => output, promise, cancel];
}

async function runJob(ghClient: GitHubCiClient, repo: string, pr: PullRequest, commentId: number): Promise<void> {
  try {
    const jobID = pr.number + "_" + new Date().toISOString().replace(/[:-]/g, "").split('.')[0];
    const jobFolder = join(tmpFolder, jobID, repo);
    log("   - creating workspace");
    await mkdir(jobFolder);

    log("   - init status comment");
    const updateComment = (message: string): Promise<void> => ghClient.setComment(commentId, `${commentIndicatorPublish}${commentHeader}\n${message}`);
    let comment = "";
    const appendLine = (message: string): Promise<void> => {
      comment += `> ${message}\n`;
      return updateComment(`~~~ Haskell
${comment}~~~`)
    };

    // git
    await appendLine("fetching");
    log(`   - cloning (target: '${jobFolder}')`);
    const git = simpleGit(jobFolder);
    await (git as any).init(false);
    await git.pull(ghClient.pullUrl, pr.baseRef);

    // job
    await appendLine("running publish job");
    log(`   - running publish job`);
    const [pollOutput, resultPromise, cancel] = runCommand("npm install && npm run publish-preview", jobFolder);
    const error = await resultPromise;

    // process error
    if (error) {
      log(`     - error`);
      try {
        log(`       - output: ${pollOutput()}`);
        await updateComment(`## failed
~~~ Haskell
${pollOutput()}
~~~`);
      } catch (_) {
        log(`       - output (fallback): ${error}`);
        await updateComment(`## failed
~~~ Haskell
${error}
~~~`);
      }
      return;
    }

    // process success
    log(`     - success`);
    try {
      if (repo === "autorest") throw "autorest";
      const version = require(join(jobFolder, "package.json")).version;

      // try pushing coverage
      try {
        const coverageComment = (await ghClient.getCommentsWithIndicator(pr, commentIndicatorCoverage))[0];
        if (coverageComment) {
          const container = await createBlobContainer(blobSvc, "coverage");
          await new Promise<string>((res, rej) =>
            blobSvc.createAppendBlobFromText(
              container,
              `${repo}_${version}.md`,
              coverageComment.message,
              { contentSettings: { contentType: "text/markdown; charset=utf-8" } },
              (error, result) => error ? rej(error) : res(result.name)));
        }
      } catch (e) {
        log(`       - coverage publish error: ${e}`);
      }

      await updateComment(`## success (version: ${version})`);
    } catch (_) {
      await updateComment(`## success
~~~ Haskell
${pollOutput()}
~~~`);
    }
  } catch (e) {
    log(`     - job error`);
    log(`       - output: ${e}`);
  }
}

async function main() {
  log("PUBLISH job info");
  log(` - using tmp folder: ${tmpFolder}`);

  const knownOpenPRsx: { [repo: string]: { [prNumber: number]: number } } = {};

  // test
  // const ghRepo = "autorest.csharp";
  // const ghClient = new GitHubCiClient(null, workerID, githubOwner, ghRepo, githubToken);
  // const pr = await ghClient.getPullRequest(21);
  // await runJob(ghClient, ghRepo, pr);
  // if (!!1) return;

  let iteration = 0;
  const pollDelaySeconds = 30;

  const targetBranch = "master";

  while (true) {
    try {
      let didAnything = false; // for backing off
      for (const githubRepo of githubRepos) {
        const knownOpenPRs = knownOpenPRsx[githubRepo] = knownOpenPRsx[githubRepo] || {};
        const ghClient = new GitHubCiClient(null, workerID, githubOwner, githubRepo, githubToken, "olydis");
        log(`Polling PRs of ${githubOwner}/${githubRepo}`);

        // new PRs
        const prs = await ghClient.getPullRequests();
        for (const pr of prs) {
          if (!(pr.number in knownOpenPRs) && pr.baseRef === targetBranch) {
            // try cleaning up previous auto-comments
            try {
              const comments = await ghClient.getCommentsWithIndicator(pr, commentIndicatorPublish);
              for (const comment of comments)
                await ghClient.tryDeleteComment(comment.id);
            } catch { }

            knownOpenPRs[pr.number] = await ghClient.createComment(pr, `${commentIndicatorPublish}${commentHeader}\n~~~ Haskell\n> will publish once PR gets merged\n~~~`);
            log(` - new PR #${pr.number} ('${pr.title}')`);
          }
        }

        // closed PRs
        for (const _prNumber of Object.keys(knownOpenPRs)) {
          const prNumber: number = parseInt(_prNumber);
          if (!prs.some(pr => pr.number === prNumber)) {
            const pr = await ghClient.getPullRequest(prNumber);
            const commentId = knownOpenPRs[prNumber];
            delete knownOpenPRs[prNumber];
            if (pr.merged && pr.baseRef === targetBranch) {
              log(` - merged PR #${pr.number} ('${pr.title}')`);
              await runJob(ghClient, githubRepo, pr, commentId);
            } else {
              log(` - closed PR #${pr.number} ('${pr.title}')`);
            }
          }
        }
      }
      await delay(pollDelaySeconds);
    } catch (e) {
      log("WORKER CARSHED:");
      log(e);
      await delay(pollDelaySeconds);
    }
  }
}

main();