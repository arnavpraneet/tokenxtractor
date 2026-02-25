import { IUploader, UploadFile, UploadResult } from "./index.js";

const HF_API_BASE = "https://huggingface.co/api";

export class HuggingFaceUploader implements IUploader {
  name = "huggingface";
  private token: string;
  private owner: string;
  private repo: string;

  constructor(token: string, repoSlug: string) {
    this.token = token;
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid HuggingFace repo slug: "${repoSlug}". Expected "owner/repo".`);
    }
    this.owner = owner;
    this.repo = repo;
  }

  private get repoId(): string {
    return `${this.owner}/${this.repo}`;
  }

  async upload(files: UploadFile[]): Promise<UploadResult> {
    const paths: string[] = [];
    const urls: string[] = [];

    // HuggingFace Hub API: commit multiple files at once
    const operations = files.map((file) => ({
      key: file.path,
      value: { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" },
    }));

    const commitPayload = {
      operations: operations.map((op) => ({
        key: op.key,
        value: op.value,
        _type: "addOrModifyFile",
      })),
      summary: `Add agent chat sessions (${files.length} file${files.length !== 1 ? "s" : ""})`,
    };

    const response = await fetch(
      `${HF_API_BASE}/datasets/${this.repoId}/commit/main`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commitPayload),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HuggingFace upload failed (${response.status}): ${text}`);
    }

    for (const file of files) {
      paths.push(file.path);
      urls.push(`https://huggingface.co/datasets/${this.repoId}/blob/main/${file.path}`);
    }

    return { destination: "huggingface", paths, urls };
  }

  /**
   * Create the dataset repository on HuggingFace if it doesn't exist.
   */
  async ensureRepoExists(): Promise<void> {
    const checkRes = await fetch(
      `${HF_API_BASE}/datasets/${this.repoId}`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
      }
    );

    if (checkRes.status === 404) {
      const createRes = await fetch(`${HF_API_BASE}/datasets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: this.repo,
          private: false,
          type: "dataset",
        }),
      });

      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Failed to create HuggingFace dataset (${createRes.status}): ${text}`);
      }
    } else if (!checkRes.ok) {
      throw new Error(`Failed to check HuggingFace dataset: ${checkRes.status}`);
    }
  }
}
