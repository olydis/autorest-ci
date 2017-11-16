import { arch, platform, release, tmpdir } from "os";
import { RequestAPI, UriOptions, UrlOptions } from "request";
import { defaults as request_defaults, RequestPromise, RequestPromiseOptions } from "request-promise-native";

export type PullRequest = { updatedAt: Date, number: number, title: string, baseRef: string, baseID: string, headID: string, headRepoUrl: string, merged: boolean, state: "open" | "closed" };
export type State = "success" | "pending" | "failure";
export type Status = { updatedAt: Date, state: State, description: string, url: string };
export type Statuses = { [jobName: string]: Status };
export type Comment = { id: number, message: string, user: string };

function parsePR(pr: any): PullRequest {
  return {
    updatedAt: new Date(pr.updated_at),
    number: pr.number,
    title: pr.title,
    baseRef: pr.base.ref,
    baseID: pr.base.sha,
    headID: pr.head.sha,
    headRepoUrl: pr.head.repo.clone_url,
    merged: pr.merged,
    state: pr.state
  };
}

export class GitHubCiClient {
  private request: RequestAPI<RequestPromise, RequestPromiseOptions, UriOptions | UrlOptions>;
  private statusPrefix: string;

  public constructor(
    private readonly ciIdentifier: string | null,
    readonly jobUid: string,
    private readonly githubOwner: string,
    private readonly githubRepo: string,
    readonly githubTokenOfCI: string,
    private readonly githubUserOfCI: string
  ) {
    this.request = request_defaults({
      headers: {
        "User-Agent": "AutoRest CI",
        "Authorization": "token " + githubTokenOfCI
      }
    });
    this.statusPrefix = `[${jobUid}] `;
  }

  public async getPullRequests(): Promise<PullRequest[]> { // https://developer.github.com/v3/pulls/#list-pull-requests
    const res = await this.request.get(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/pulls`);
    return JSON.parse(res).map(parsePR);
  }
  public async getPullRequest(prNumber: number): Promise<PullRequest> { // https://developer.github.com/v3/pulls/#get-a-single-pull-request
    return parsePR(JSON.parse(await this.request.get(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/pulls/${prNumber}`)));
  }
  public async getPullRequestStatuses(pr: PullRequest): Promise<Statuses> { // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
    const res = await this.request.get(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/commits/${pr.headID}/status`);
    const statuses = JSON.parse(res).statuses;
    const result: Statuses = {};
    for (const status of statuses) {
      result[status.context] = {
        updatedAt: new Date(status.updated_at),
        state: status.state,
        description: status.description,
        url: status.target_url
      };
    }
    return result;
  }
  public async setPullRequestStatus(pr: PullRequest, state: State, description: string, url?: string): Promise<void> { // https://developer.github.com/v3/repos/statuses/#create-a-status
    const body: any = {};
    body.state = state;
    if (url) body.target_url = url;
    if (description) body.description = (this.statusPrefix + description).slice(0, 140);
    body.context = this.ciIdentifier;
    const res = await this.request.post(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/statuses/${pr.headID}`, { body: JSON.stringify(body) });
  }

  public async getJobStatus(pr: PullRequest): Promise<Status | undefined> {
    const statuses = await this.getPullRequestStatuses(pr);
    return statuses[this.ciIdentifier];
  }

  public async getComments(pr: PullRequest): Promise<Comment[]> {
    const res = await this.request.get(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/issues/${pr.number}/comments`);
    const comments = JSON.parse(res);
    return comments.map(x => { return { id: x.id, message: x.body, user: x.user.login }; });
  }

  public async getCommentsWithIndicator(pr: PullRequest, indicator: string): Promise<Comment[]> {
    return (await this.getComments(pr)).filter(comment => comment.message.startsWith(indicator));
  }

  public async getOwnComments(pr: PullRequest): Promise<Comment[]> {
    const comments = await this.getComments(pr);
    return comments.filter(c => c.user === this.githubUserOfCI);
  }

  public async setComment(id: number, message: string): Promise<void> {
    await this.request.post(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/issues/comments/${id}`, { body: JSON.stringify({ body: message }) });
  }

  public async deleteComment(id: number): Promise<void> {
    await this.request.delete(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/issues/comments/${id}`);
  }

  public async tryDeleteComment(id: number): Promise<void> {
    try { await this.deleteComment(id); } catch { }
  }

  public async createComment(pr: PullRequest, message: string): Promise<number> {
    const res = await this.request.post(`https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/issues/${pr.number}/comments`, { body: JSON.stringify({ body: message }) });
    return JSON.parse(res).id;
  }

  public async isLastStatusOurs(pr: PullRequest): Promise<boolean> {
    const status = await this.getJobStatus(pr);
    return status && status.description.startsWith(this.statusPrefix);
  }

  public async wasUpdated(pr: PullRequest): Promise<boolean> {
    return (await this.getPullRequest(pr.number)).updatedAt.getTime() !== pr.updatedAt.getTime();
  }

  public get pullUrl(): string {
    return `https://${this.githubTokenOfCI}@github.com/${this.githubOwner}/${this.githubRepo}`;
  }

  public getPrUrl(pr: PullRequest): string {
    return `https://github.com/${this.githubOwner}/${this.githubRepo}/pull/${pr.number}`;
  }

  public getPrName(pr: PullRequest): string {
    return `${this.githubOwner}/${this.githubRepo}#${pr.number}`;
  }
}