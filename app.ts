#!/usr/bin/env node

import { fork } from "child_process";
import { arch, platform, release } from "os";
import { delay } from './delay';
import { getBinPath } from './get-bin-path';
import { ManagedChildProcess } from "./managed-child-process";
import { CIStatus, parseStatus } from './status';

// config
// const ciIdentifier = `surf/${platform()}-${release()}-${arch()}`;
const ciIdentifier = `surf/${platform()}-${arch()}`;
const token = process.argv[2] || process.env.GITHUB_TOKEN;

if (typeof token !== "string") {
  console.error("Provide GitHub token (needs 'repo' and 'gist' permissions) via 'GITHUB_TOKEN' environment variable or as CLI arg");
  process.exit(1);
}

// jobs
const maxStatusesToKeep = 10;
const lastStatuses: { [name: string]: CIStatus[] } = {};
const jobs: { [name: string]: ManagedChildProcess } = {};
const addJob = (repo: string): void => {
  const args = ["-r", `https://github.com/Azure/${repo}`, "--", "node", "app-build", ciIdentifier];
  console.log(`Adding job: surf-run ${args.join(" ")}`);
  lastStatuses[repo] = [];
  jobs[repo] = new ManagedChildProcess(() =>
    fork(
      getBinPath("surf-build", "surf-run"),
      args,
      { cwd: __dirname, silent: true }),
    msg => {
      for (const status of parseStatus(msg)) {
        lastStatuses[repo].push(status);
        if (lastStatuses[repo].length > maxStatusesToKeep) {
          lastStatuses[repo].shift();
        }
      }
    }
  );
}

addJob("autorest.common");
addJob("autorest.modeler");
addJob("autorest.azureresourceschema");
addJob("autorest.csharp");
addJob("autorest.go");
addJob("autorest.java");
addJob("autorest.nodejs");
addJob("autorest.php");
addJob("autorest.ruby");
addJob("autorest.python");
addJob("autorest.testserver");

// status loop
const padRight = (str: string, len: number, pad: string = " ") => str.length >= len ? str : padRight(str + pad, len);

async function main() {
  while (true) {
    console.log();
    console.log(`This is '${ciIdentifier}'`);
    console.log(`${padRight("JOB", 32)} ${padRight("PID", 7)} STATUS`);
    for (const jobName of Object.keys(jobs)) {
      const job = jobs[jobName];
      const rawStatuses = lastStatuses[jobName];
      let commitIds = rawStatuses.map(x => x.commitID).sort();
      commitIds = commitIds.filter((x, i) => i === 0 || x !== commitIds[i - 1]);
      const distinctStatuses = commitIds.map(id => rawStatuses.filter(x => x.commitID === id).reverse()[0]);
      console.log(`${padRight(jobName, 32)} ${padRight((job.pid || "---") + "", 7)} ${distinctStatuses.map(x => `${x.commitID} ${x.status}`).join(", ")}`);
      job.start();
    }
    await delay(1000);
  }
}

main();