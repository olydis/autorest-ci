export const githubOwner = "Azure";
export const githubRepos = [
  "autorest",
  "autorest.common",
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
  "autorest.testserver",
  "perks.async-io",
  "perks.extension",
  "perks.eventing",
  "perks.tasks",
  "autorest.incubator",
  "autorest-extension-base"
];


export const commentIndicatorCoverage = "<!--AUTO-GENERATED COVERAGE COMMENT-->\n";
export const commentIndicatorPublish = "<!--AUTO-GENERATED PUBLISH JOB COMMENT-->\n";




import * as as from "azure-storage";

export function createBlobContainer(blobSvc: as.BlobService, purpose: string): Promise<string> {
  return new Promise<string>((res, rej) => blobSvc.createContainerIfNotExists(
    `autorest-ci-${purpose}`,
    { publicAccessLevel: "blob" },
    (error, result) => error ? rej(error) : res(result.name)));
}