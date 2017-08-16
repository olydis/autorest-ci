import { ChildProcess, spawn } from "child_process";
import { arch, platform, release } from "os";

const ciIdentifier = `surf-${platform()}-${release()}-${arch()}`;

spawn("surf-build")
console.log(ciIdentifier);

// set process.env.TMPDIR fo spawned process to something short