import { ChildProcess } from "child_process";

export class ManagedChildProcess {
  private proc: ChildProcess | null = null;

  public get running(): boolean {
    return this.proc !== null;
  }

  public get pid(): number {
    return this.proc === null ? null : this.proc.pid;
  }

  public constructor(private spawn: () => ChildProcess, private onStdout?: (msg: string) => void, private onStderr?: (msg: string) => void) { }

  private onExit() {
    this.proc.stdout.removeAllListeners();
    this.proc.stderr.removeAllListeners();
    this.proc = null;
  }

  public start() {
    if (!this.running) {
      const proc = this.proc = this.spawn();
      proc.once("exit", () => { if (proc === this.proc) this.onExit(); });
      proc.once("error", () => { if (proc === this.proc) this.onExit(); });
      if (this.onStdout) proc.stdout.on("data", chunk => this.onStdout(chunk.toString()));
      if (this.onStderr) proc.stdout.on("data", chunk => this.onStderr(chunk.toString()));
    }
  }

  public async stop(): Promise<void> {
    if (this.running) {
      return new Promise<void>(res => {
        this.proc.once("exit", res);
        this.proc.once("error", res);
        this.proc.kill();
      });
    }
  }
}
