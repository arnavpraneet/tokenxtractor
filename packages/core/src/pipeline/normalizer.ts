import { execSync } from "child_process";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { RawSession } from "../detectors/claudeCode.js";
import {
  Message,
  RawMessage,
  Session,
  ToolUse,
} from "../schema.js";
import { detectUsernames } from "./usernameDetector.js";

const UPLOADER_VERSION = "1.0.0";

/**
 * Summarize tool input to a short string for storage.
 * Never stores full content — only key identifiers.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // For common tools, extract the most relevant field
  const keyFields: Record<string, string[]> = {
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    Glob: ["pattern", "path"],
    Grep: ["pattern", "path"],
    Bash: ["description"],
    Task: ["description", "subagent_type"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    NotebookEdit: ["notebook_path"],
  };

  const fields = keyFields[toolName] ?? Object.keys(input).slice(0, 2);
  const parts: string[] = [];
  for (const field of fields) {
    const val = input[field];
    if (val !== undefined && val !== null) {
      const str = String(val);
      parts.push(str.length > 120 ? str.slice(0, 120) + "…" : str);
    }
  }
  return parts.join(", ") || Object.keys(input).slice(0, 4).join(", ") || "(no input)";
}

/**
 * Extract text content from a message's content field.
 */
function extractTextContent(msg: RawMessage): string {
  const content = msg.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract thinking content from a message.
 */
function extractThinkingContent(msg: RawMessage): string | undefined {
  const content = msg.message?.content;
  if (!content || typeof content === "string") return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "thinking") {
      parts.push(block.thinking);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Build a map of tool_use_id → result text from all messages in the session.
 * tool_result blocks appear in user messages immediately after the assistant
 * message that contained the matching tool_use.
 */
function buildToolResultMap(messages: RawMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    const content = msg.message?.content;
    if (!content || typeof content === "string") continue;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      if (!id) continue;
      // content can be a string or an array of text blocks
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = (block.content as unknown[])
          .filter((b): b is { type: "text"; text: string } =>
            typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
          )
          .map((b) => b.text)
          .join("\n");
      }
      if (text) map.set(id, text);
    }
  }
  return map;
}

/**
 * Extract tool uses from a message, attaching results from the result map.
 */
function extractToolUses(msg: RawMessage, toolResultMap: Map<string, string>): ToolUse[] {
  const content = msg.message?.content;
  if (!content || typeof content === "string") return [];

  const uses: ToolUse[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const use: ToolUse = {
        tool: block.name,
        input_summary: summarizeToolInput(block.name, block.input as Record<string, unknown>),
      };
      const result = toolResultMap.get(block.id);
      if (result) use.result = result;
      uses.push(use);
    }
  }
  return uses;
}

/**
 * Extract unique file paths mentioned in tool uses (Read, Write, Edit, Glob).
 * Strips the workspace root prefix so only relative paths are stored.
 */
function extractFilesTouched(messages: Message[], workspaceRoot?: string): string[] {
  const files = new Set<string>();
  const fileTools = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

  for (const msg of messages) {
    for (const tu of msg.tool_uses ?? []) {
      if (fileTools.has(tu.tool)) {
        const summary = tu.input_summary;
        if (!summary || summary.includes("…")) continue;
        const relative = workspaceRoot && summary.startsWith(workspaceRoot)
          ? summary.slice(workspaceRoot.length).replace(/^\//, "")
          : summary;
        files.add(relative);
      }
    }
  }
  return Array.from(files);
}

/**
 * Try to detect the git branch for a workspace directory.
 */
function detectGitBranch(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw Claude Code session into the common Session schema.
 * @param options.noThinking - Strip extended thinking blocks
 * @param options.extraUsernames - Additional usernames to anonymize beyond the OS user
 */
export function normalizeSession(
  raw: RawSession,
  options: { noThinking?: boolean; extraUsernames?: string[] } = {}
): Session {
  const messages: Message[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;

  // Build result map up front so we can attach results to each tool_use
  const toolResultMap = buildToolResultMap(raw.messages);

  // Filter out meta/system messages for the normalized output
  const relevantMessages = raw.messages.filter(
    (m) => !m.isMeta && m.type !== "system"
  );

  for (const rawMsg of relevantMessages) {
    const role = rawMsg.type === "assistant" ? "assistant" : "user";
    const content = extractTextContent(rawMsg);
    const thinking = options.noThinking
      ? undefined
      : extractThinkingContent(rawMsg);
    const toolUses = extractToolUses(rawMsg, toolResultMap);

    // Track timestamps
    if (rawMsg.timestamp) {
      if (!startTime) startTime = rawMsg.timestamp;
      endTime = rawMsg.timestamp;
    }

    // Accumulate token usage.
    // input_tokens only counts uncached tokens; the full picture requires
    // adding cache_creation_input_tokens and cache_read_input_tokens.
    const usage = rawMsg.message?.usage;
    if (usage) {
      inputTokens +=
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      outputTokens += usage.output_tokens ?? 0;
    }

    // Detect model
    if (!model && rawMsg.message?.model) {
      model = rawMsg.message.model;
    }

    // Only add messages that have some content or tool uses
    if (content || toolUses.length > 0) {
      const msg: Message = { role, content };
      if (thinking) msg.thinking = thinking;
      if (rawMsg.timestamp) msg.timestamp = rawMsg.timestamp;
      if (toolUses.length > 0) msg.tool_uses = toolUses;
      messages.push(msg);
    }
  }

  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant").length;
  const totalToolUses = messages.reduce(
    (sum, m) => sum + (m.tool_uses?.length ?? 0),
    0
  );

  // Derive workspace name from the project directory name
  // The project dirs in ~/.claude/projects/ are encoded paths
  const workspaceName = decodeProjectDirName(raw.projectName);

  // Try to detect git branch from the cwd found in the first user message
  const firstCwd = raw.messages.find((m) => m.cwd)?.cwd;
  const gitBranch = firstCwd ? detectGitBranch(firstCwd) : undefined;

  // Build the full list of strings to anonymize: OS user, homedir, git identity,
  // GitHub handle (auto-detected from cwd), plus any extras from config.
  const allUsernames = detectUsernames(firstCwd, options.extraUsernames);

  /**
   * Replace every tracked username with its stable hash in a string.
   * Also handles hyphen-encoded forms that Claude Code uses in project dir names,
   * e.g. "-home-user-dev-" → "-home-user_<hash>-dev-"
   */
  function sanitize(s: string): string {
    let result = s;
    for (const username of allUsernames) {
      const hashed = "user_" + createHash("sha256").update(username).digest("hex").slice(0, 8);
      // Plain replacement (paths, text)
      result = result.replaceAll(username, hashed);
      // Hyphen-encoded form: -username- (Claude Code project dir encoding)
      result = result.replaceAll(`-${username}-`, `-${hashed}-`);
    }
    return result;
  }

  const sanitizedBranch = gitBranch ? sanitize(gitBranch) : undefined;

  const rawFiles = extractFilesTouched(messages, firstCwd);
  const filesTouched = rawFiles.map(sanitize);

  // Apply username sanitization to tool input_summary fields unconditionally.
  // This ensures paths like /home/<user>/... are hashed regardless of whether
  // the redactor is enabled.
  const sanitizedMessages = messages.map((msg) => {
    if (!msg.tool_uses?.length) return msg;
    return {
      ...msg,
      tool_uses: msg.tool_uses.map((tu) => ({
        ...tu,
        input_summary: sanitize(tu.input_summary),
      })),
    };
  });

  return {
    id: raw.sessionId || uuidv4(),
    tool: "claude-code",
    workspace: workspaceName,
    git_branch: sanitizedBranch,
    captured_at: new Date().toISOString(),
    start_time: startTime,
    end_time: endTime,
    model,
    messages: sanitizedMessages,
    stats: {
      user_messages: userMessages,
      assistant_messages: assistantMessages,
      tool_uses: totalToolUses,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    metadata: {
      files_touched: filesTouched,
      uploader_version: UPLOADER_VERSION,
    },
  };
}

/**
 * Claude Code encodes project paths as directory names by replacing / with -.
 * Try to extract a human-readable project name from the encoded path.
 */
function decodeProjectDirName(dirName: string): string {
  // Claude Code uses the full path with / replaced by - as the dir name
  // e.g. "-home-user-dev-myproject" -> "myproject"
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length > 0) {
    return parts[parts.length - 1];
  }
  return dirName;
}
