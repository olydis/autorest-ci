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

const commentHeader = "# 🤖 AutoRest automatic publish job 🤖";

// config
const workerID = "PUBLISH" + Math.random().toString(36).substr(2, 5);
const tmpFolder = join(tmpdir(), workerID);

const npmRepo = new Set<string>([
  "autorest.modeler",
  "autorest.azureresourceschema",
  "autorest.csharp",
  "autorest.go",
  "autorest.java",
  "autorest.nodejs",
  "autorest.php",
  "autorest.ruby",
  "autorest.python",
  "autorest.typescript",
  "autorest.testserver"
]);

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

async function runJob(ghClient: GitHubCiClient, repo: string, pr: PullRequest, commentId: number): Promise<void> {
  try {
    const jobID = pr.number + "_" + new Date().toISOString().replace(/[:-]/g, "").split('.')[0];
    const jobFolder = join(tmpFolder, jobID, repo);
    log("   - creating workspace");
    await mkdir(jobFolder);

    log("   - init status comment");
    const updateComment = (message: string): Promise<void> => ghClient.setComment(commentId, `${commentHeader}\n${message}`);
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
      if (!npmRepo.has(repo)) throw "non-npm repo";
      await updateComment(`## success (version: ${require(join(jobFolder, "package.json")).version})`);
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
          if (!(pr.number in knownOpenPRs) && pr.baseRef === "master") {
            // try cleaning up previous auto-comments
            try {
              const comments = await ghClient.getOwnComments(pr);
              for (const comment of comments)
                if (comment.message.startsWith(commentHeader) || comment.message.startsWith("# AutoRest automatic publish job") /*old header*/)
                  await ghClient.deleteComment(comment.id);
            } catch (e) { }

            knownOpenPRs[pr.number] = await ghClient.createComment(pr, commentHeader + "\n~~~ Haskell\n> will publish once PR gets merged\n~~~");
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
            if (pr.merged) {
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