import { Octokit } from "@octokit/rest";
import { IUploader, UploadFile, UploadResult } from "./index.js";

export class GitHubUploader implements IUploader {
  name = "github";
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string, repoSlug: string) {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo slug: "${repoSlug}". Expected "owner/repo".`);
    }
    this.owner = owner;
    this.repo = repo;
  }

  async upload(files: UploadFile[]): Promise<UploadResult> {
    const paths: string[] = [];
    const urls: string[] = [];

    for (const file of files) {
      const content = Buffer.from(file.content, "utf8").toString("base64");

      // Check if file already exists (to get its SHA for updating)
      let sha: string | undefined;
      try {
        const { data } = await this.octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: file.path,
        });
        if (!Array.isArray(data) && data.type === "file") {
          sha = data.sha;
        }
      } catch (err: unknown) {
        // 404 means file doesn't exist yet — that's fine
        if ((err as { status?: number }).status !== 404) throw err;
      }

      const { data } = await this.octokit.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: file.path,
        message: `Add agent chat session: ${file.path}`,
        content,
        sha,
      });

      paths.push(file.path);
      const url = data.content?.html_url ?? `https://github.com/${this.owner}/${this.repo}/blob/main/${file.path}`;
      urls.push(url);
    }

    return { destination: "github", paths, urls };
  }

  /**
   * Create the dataset repository if it doesn't exist.
   */
  async ensureRepoExists(description = "Agent chat sessions dataset"): Promise<void> {
    try {
      await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        await this.octokit.repos.createForAuthenticatedUser({
          name: this.repo,
          description,
          private: false,
          auto_init: true,
        });
      } else {
        throw err;
      }
    }
  }
}
