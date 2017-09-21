#!/usr/bin/env node

import { GitHubCiClient, PullRequest } from './github';
import { arch, platform, release, tmpdir } from "os";
import { writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import * as simpleGit from 'simple-git/promise';
import * as mkdir from 'mkdirp-promise';
import { exec, execSync } from "child_process";
import { createBlobService } from "azure-storage";
import * as as from "azure-storage";
import { githubOwner, githubRepos } from "./common";
import { delay } from "./delay";

// config
const workerID = "PUBLISH" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), workerID);


const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("expected args: <GitHub Token ('public_repo' access)>");
  process.exit(1);
}

const githubToken = args[0];

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

async function runJob(ghClient: GitHubCiClient, repo: string, pr: PullRequest): Promise<void> {
  try {
    const jobID = pr.number + "_" + new Date().toISOString().replace(/[:-]/g, "").split('.')[0];
    const jobFolder = join(tmpFolder, jobID, repo);
    log("   - creating workspace");
    await mkdir(jobFolder);

    log("   - init status comment");
    const commentHeader = "# release job";
    const commentId = await ghClient.createComment(pr, commentHeader);
    // await delay(1000); // make sure comment was created internally... apparently that isn't guaranteed to be done when the REST call returns!
    const updateComment = (message: string): Promise<void> => ghClient.setComment(commentId, `${commentHeader}\n${message}`);
    let comment = "";
    const appendLine = (message: string): Promise<void> => {
      comment += `> ${message}\n`;
      return updateComment(`~~~
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
        await updateComment(`## error
~~~
${pollOutput()}
~~~`)
      } catch (_) {
        log(`       - output (fallback): ${error}`);
        await updateComment(`## error
~~~
${error}
~~~`)
      }
      return;
    }

    // process success
    log(`     - success`);
    await updateComment(`## done
~~~
${error}
~~~`)
  } catch (e) {
    log(`     - job error`);
    log(`       - output: ${e}`);
  }
}

async function main() {
  log("PUBLISH job info");
  log(` - using tmp folder: ${tmpFolder}`);

  const knownOpenPRsx: { [repo: string]: Set<number> } = {};

  // // test
  // const ghClient = new GitHubCiClient(null, workerID, githubOwner, "autorest.testserver", githubToken);
  // const pr = await ghClient.getPullRequest(9);
  // await runJob(ghClient, "autorest.testserver", pr);
  // if (!!1) return;

  while (true) {
    try {
      let didAnything = false; // for backing off
      for (const githubRepo of githubRepos) {
        const knownOpenPRs = knownOpenPRsx[githubRepo] = knownOpenPRsx[githubRepo] || new Set<number>();
        const ghClient = new GitHubCiClient(null, workerID, githubOwner, githubRepo, githubToken);
        log(`Polling PRs of ${githubOwner}/${githubRepo}`);

        // closed PRs
        for (const prNumber of knownOpenPRs.values()) {
          const pr = await ghClient.getPullRequest(prNumber);
          if (pr.state === "closed") {
            knownOpenPRs.delete(prNumber);
            if (pr.merged) {
              log(` - merged PR #${pr.number} ('${pr.title}')`);
              await runJob(ghClient, githubRepo, pr);
            } else {
              log(` - closed PR #${pr.number} ('${pr.title}')`);
            }
          }
        }

        // new PRs
        const prs = await ghClient.getPullRequests();
        for (const pr of prs) {
          if (!knownOpenPRs.has(pr.number) && pr.baseRef === "master") {
            knownOpenPRs.add(pr.number);
            log(` - new PR #${pr.number} ('${pr.title}')`);
          }
        }
      }
      await delay(didAnything ? 20000 : 120000);
    } catch (e) {
      log("WORKER CARSHED:");
      log(e);
      await delay(120000);
    }
  }
}

main();