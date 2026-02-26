import { Octokit } from "@octokit/rest";
import { Session } from "../schema.js";
import { IUploader, UploadFile, UploadResult } from "./index.js";

export interface OpenAgentSessionsMetadata {
  topic: string;
  tags: string[];
  language: string;
}

/**
 * Infer openagentsessions.org metadata from a session.
 * These are used as defaults that the user can edit during interactive review.
 */
export function inferOpenAgentSessionsMeta(session: Session): OpenAgentSessionsMetadata {
  const language = inferLanguage(session.metadata.files_touched);
  const topic = session.workspace
    ? language
      ? `${session.workspace} — ${language}`
      : session.workspace
    : "agent session";

  const tags = inferTags(session);

  return { topic, tags, language };
}

function inferLanguage(filesTouched: string[]): string {
  if (filesTouched.length === 0) return "";

  const extCounts: Record<string, number> = {};
  for (const f of filesTouched) {
    const dot = f.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = f.slice(dot + 1).toLowerCase();
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }

  const extMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "css",
  };

  let best = "";
  let bestCount = 0;
  for (const [ext, count] of Object.entries(extCounts)) {
    if (count > bestCount) {
      best = extMap[ext] ?? ext;
      bestCount = count;
    }
  }

  return best;
}

function inferTags(session: Session): string[] {
  const tags = new Set<string>();

  // Add tool names from all messages
  for (const msg of session.messages) {
    if (msg.tool_uses) {
      for (const tu of msg.tool_uses) {
        const toolName = tu.tool.toLowerCase().replace(/_/g, "-");
        tags.add(toolName);
      }
    }
  }

  // Add a shortened model tag if available
  if (session.model) {
    // e.g. "claude-sonnet-4-6-20251022" -> "claude-sonnet"
    const parts = session.model.split("-");
    if (parts.length >= 2) {
      tags.add(`${parts[0]}-${parts[1]}`);
    } else {
      tags.add(session.model);
    }
  }

  // Add agent type
  if (session.tool) {
    tags.add(session.tool);
  }

  return Array.from(tags).slice(0, 10); // cap at 10 tags
}

/**
 * Uploads a session to openagentsessions.org by creating a public GitHub Gist.
 * The gist contains:
 *   - session.md  (the human-readable transcript)
 *   - openagentsessions.json  (required metadata file)
 */
export class GistUploader implements IUploader {
  name = "openagentsessions";
  private octokit: Octokit;
  private session: Session;
  private meta: OpenAgentSessionsMetadata;

  constructor(token: string, session: Session, meta: OpenAgentSessionsMetadata) {
    this.octokit = new Octokit({ auth: token });
    this.session = session;
    this.meta = meta;
  }

  async upload(files: UploadFile[]): Promise<UploadResult> {
    const mdFile = files.find((f) => f.path.endsWith(".md") || f.path === "session.md");
    if (!mdFile) {
      throw new Error("GistUploader: no markdown file found in upload files");
    }

    const metadataJson = this.buildMetadataJson();

    const { data } = await this.octokit.gists.create({
      public: true,
      description: "Open agent session (CC0)",
      files: {
        "session.md": { content: mdFile.content },
        "openagentsessions.json": { content: metadataJson },
      },
    });

    const gistUrl = data.html_url ?? `https://gist.github.com/${data.id}`;

    return {
      destination: "openagentsessions",
      paths: ["session.md", "openagentsessions.json"],
      urls: [gistUrl],
    };
  }

  private buildMetadataJson(): string {
    const metadata = {
      schema_version: "1.0",
      license: "CC0-1.0",
      consent_confirmed: true,
      redaction_done: true,
      created_at: this.session.captured_at,
      session: {
        agent: this.session.tool,
        model: this.session.model ?? "unknown",
        language: this.meta.language || "unknown",
        topic: this.meta.topic,
      },
      tags: this.meta.tags,
    };
    return JSON.stringify(metadata, null, 2);
  }
}
