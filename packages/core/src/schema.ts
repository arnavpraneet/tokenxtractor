import { z } from "zod";

// ── Raw Claude Code JSONL format ──────────────────────────────────────────────

export const RawToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

export const RawToolResultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});

export const RawTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const RawThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const RawContentBlockSchema = z.discriminatedUnion("type", [
  RawTextBlockSchema,
  RawThinkingBlockSchema,
  RawToolUseSchema,
  RawToolResultSchema,
]);

export const RawMessageSchema = z.object({
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  type: z.enum(["user", "assistant", "system"]),
  timestamp: z.string().optional(),
  message: z
    .object({
      id: z.string().optional(),
      type: z.string().optional(),
      role: z.enum(["user", "assistant"]).optional(),
      model: z.string().optional(),
      content: z.union([
        z.string(),
        z.array(RawContentBlockSchema),
      ]),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  userType: z.string().optional(),
  cwd: z.string().optional(),
  isMeta: z.boolean().optional(),
  costUSD: z.number().optional(),
  durationMs: z.number().optional(),
  requestId: z.string().optional(),
});

export type RawMessage = z.infer<typeof RawMessageSchema>;

// ── Normalized common schema ──────────────────────────────────────────────────

export const ToolUseSchema = z.object({
  tool: z.string(),
  input_summary: z.string(),
  result: z.string().optional(),
});

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  thinking: z.string().optional(),
  timestamp: z.string().optional(),
  tool_uses: z.array(ToolUseSchema).optional(),
});

export const SessionStatsSchema = z.object({
  user_messages: z.number(),
  assistant_messages: z.number(),
  tool_uses: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
});

export const SessionMetadataSchema = z.object({
  files_touched: z.array(z.string()),
  uploader_version: z.string(),
});

export const SessionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  workspace: z.string(),
  git_branch: z.string().optional(),
  captured_at: z.string(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(MessageSchema),
  stats: SessionStatsSchema,
  metadata: SessionMetadataSchema,
});

export type ToolUse = z.infer<typeof ToolUseSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type SessionStats = z.infer<typeof SessionStatsSchema>;
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;
export type Session = z.infer<typeof SessionSchema>;

// ── Codex CLI JSONL format ────────────────────────────────────────────────────

export const CodexLineSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.record(z.unknown()),
});

export type CodexLine = z.infer<typeof CodexLineSchema>;

export interface RawCodexSession {
  sessionId: string;
  filePath: string;
  cwd: string;
  model?: string;
  cli_version?: string;
  lines: CodexLine[];
}

// ── Upload state ──────────────────────────────────────────────────────────────

export interface UploadRecord {
  sessionId: string;
  uploadedAt: string;
  destination: string;
  paths: string[];
}

/**
 * A session that has been exported locally but not yet confirmed or uploaded.
 * The `confirm` command moves sessions from this list to `confirmedForUpload`.
 */
export interface PendingConfirmation {
  sessionId: string;
  exportedAt: string;
  /** Absolute path to the locally-exported JSON file for human review. */
  localPath: string;
}

export interface UploadState {
  version: number;
  uploads: UploadRecord[];
  /** Sessions exported locally, awaiting human review + confirmation. */
  pendingConfirmation?: PendingConfirmation[];
  /** Sessions confirmed by the user as safe to upload. */
  confirmedForUpload?: string[];
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface GitHubConfig {
  token: string;
  repo: string;
}

export interface HuggingFaceConfig {
  token: string;
  repo: string;
}

export interface OpenAgentSessionsConfig {
  /** GitHub PAT with gist scope (same token as GitHub destination is fine). */
  githubToken: string;
}

export type Destination = "github" | "huggingface" | "both" | "openagentsessions";

export interface RedactionConfig {
  enabled: boolean;
  customPatterns: string[];
  redactUsernames: string[];
  redactStrings: string[];
}

export interface TokenXtractorConfig {
  destination: Destination;
  github?: GitHubConfig;
  huggingface?: HuggingFaceConfig;
  openagentsessions?: OpenAgentSessionsConfig;
  watchPaths: string[];
  redaction: RedactionConfig;
  exclude: string[];
  noThinking: boolean;
}

export const DEFAULT_CONFIG: TokenXtractorConfig = {
  destination: "github",
  watchPaths: ["~/.claude/projects/", "~/.codex/sessions/"],
  redaction: {
    enabled: true,
    customPatterns: [],
    redactUsernames: [],
    redactStrings: [],
  },
  exclude: [],
  noThinking: false,
};
