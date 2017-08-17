#!/usr/bin/env node

import { fork } from "child_process";
import { arch, platform, release } from "os";
import { delay } from './delay';
import { getBinPath } from './get-bin-path';
import { ManagedChildProcess } from './managed-child-process';
import { CIStatus, logStatus } from './status';

const ciIdentifier = process.argv[2];
const commitID = process.argv[3];

if (typeof ciIdentifier !== "string")
  throw new Error("Missing ciIdentifier");
if (typeof commitID !== "string")
  throw new Error("Missing commitID");

function reportStatus(status: string): void {
  logStatus({
    commitID: commitID,
    status: status
  });
}

async function main() {
  const child = new ManagedChildProcess(() => fork(getBinPath("surf-build", "surf-build"), ["-n", ciIdentifier, "-d", "npm", commitID]));
  child.start();
  while (child.running) {
    reportStatus("running");
    await delay(3000);
  }
}

main();