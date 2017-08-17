
const magicStringBegin = "<CI_STATUS>";
const magicStringEnd = "</CI_STATUS>";

export function logStatus(status: CIStatus): void {
  console.log(magicStringBegin + JSON.stringify(status) + magicStringEnd);
}

export function* parseStatus(rawOutput: string): Iterable<CIStatus> {
  let index: number;
  while ((index = rawOutput.indexOf(magicStringBegin)) !== -1) {
    const end = rawOutput.indexOf(magicStringEnd, index);
    const statusText = rawOutput.substring(index + magicStringBegin.length, end);
    yield JSON.parse(statusText);
    rawOutput = rawOutput.slice(end);
  }
}

export interface CIStatus {
  commitID: string;
  status: string;
}