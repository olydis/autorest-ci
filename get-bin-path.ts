import { platform } from "os";
import { join } from "path";

export function getBinPath(packageName: string, binName: string): string {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const binPath = require(`${packageName}/package.json`).bin[binName];
  return join(packagePath, "..", binPath);
}