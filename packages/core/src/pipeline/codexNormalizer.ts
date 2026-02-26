import { execSync } from "child_process";
import { createHash } from "crypto";
import { basename } from "path";
import { v4 as uuidv4 } from "uuid";
import { RawCodexSession } from "../schema.js";
import { Message, Session, ToolUse } from "../schema.js";
import { detectUsernames } from "./usernameDetector.js";

const UPLOADER_VERSION = "1.0.0";

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
 * Summarize a Codex tool call's arguments into a short descriptive string.
 */
function summarizeCodexToolInput(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return argsJson.slice(0, 120);
  }

  const str = (v: unknown): string => {
    const s = String(v ?? "");
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  };

  switch (name) {
    case "exec_command":
      return typeof args.cmd === "string" ? str(args.cmd) : str(Object.values(args)[0]);
    case "apply_patch": {
      // Extract the target filename from the patch header (*** <filename> or +++ <filename>)
      const patch = typeof args.patch === "string" ? args.patch : "";
      const match = patch.match(/^\*\*\* (\S+)/m) ?? patch.match(/^\+\+\+ (\S+)/m);
      return match ? match[1] : str(args.patch ?? argsJson);
    }
    case "read_file":
    case "write_file":
      return typeof args.path === "string" ? str(args.path) : str(Object.values(args)[0]);
    default: {
      const keys = Object.keys(args).slice(0, 2);
      return keys.map((k) => str(args[k])).join(", ") || "(no input)";
    }
  }
}

/**
 * Normalize a raw Codex CLI session into the common Session schema.
 */
export function normalizeCodexSession(
  raw: RawCodexSession,
  options: { noThinking?: boolean; extraUsernames?: string[] } = {}
): Session {
  // Build the full list of strings to anonymize: OS user, homedir, git identity,
  // GitHub handle (auto-detected from cwd), plus any extras from config.
  const allUsernames = detectUsernames(raw.cwd || undefined, options.extraUsernames);

  function sanitize(s: string): string {
    let result = s;
    for (const username of allUsernames) {
      const hashed =
        "user_" + createHash("sha256").update(username).digest("hex").slice(0, 8);
      result = result.replaceAll(username, hashed);
      result = result.replaceAll(`-${username}-`, `-${hashed}-`);
    }
    return result;
  }

  // Build call_id → output map from function_call_output lines
  const callOutputMap = new Map<string, string>();
  for (const line of raw.lines) {
    if (line.type === "response_item") {
      const p = line.payload as Record<string, unknown>;
      if (p.type === "function_call_output") {
        const callId = p.call_id as string | undefined;
        const output = p.output as string | undefined;
        if (callId && output) {
          callOutputMap.set(callId, output);
        }
      }
    }
  }

  const messages: Message[] = [];
  let startTime: string | undefined;
  let endTime: string | undefined;

  // We process lines in order. function_call items get attached to the most
  // recent assistant message (they always follow the assistant turn that
  // issued them in the Codex JSONL).
  let currentAssistantMsg: Message | null = null;
  let currentReasoning: string[] = [];

  const flushAssistant = () => {
    if (!currentAssistantMsg) return;
    // Attach accumulated reasoning as thinking
    if (!options.noThinking && currentReasoning.length > 0) {
      currentAssistantMsg.thinking = currentReasoning.join("\n");
    }
    messages.push(currentAssistantMsg);
    currentAssistantMsg = null;
    currentReasoning = [];
  };

  for (const line of raw.lines) {
    if (!startTime) startTime = line.timestamp;
    endTime = line.timestamp;

    if (line.type === "event_msg") {
      const p = line.payload as Record<string, unknown>;
      if (p.type === "user_message") {
        // Flush any pending assistant message first
        flushAssistant();
        const content = sanitize(String(p.message ?? ""));
        if (content) {
          messages.push({ role: "user", content, timestamp: line.timestamp });
        }
      }
    } else if (line.type === "response_item") {
      const p = line.payload as Record<string, unknown>;

      if (p.type === "reasoning") {
        // Accumulate reasoning summaries for the upcoming/current assistant turn
        const summary = p.summary as Array<Record<string, unknown>> | undefined;
        if (summary) {
          for (const s of summary) {
            if (s.type === "summary_text" && typeof s.text === "string") {
              currentReasoning.push(s.text);
            }
          }
        }
      } else if (p.type === "message" && p.role === "assistant") {
        // Flush any previous assistant turn
        flushAssistant();
        const contentBlocks = p.content as Array<Record<string, unknown>> | undefined;
        const text = contentBlocks
          ?.filter((b) => b.type === "output_text")
          .map((b) => String(b.text ?? ""))
          .join("\n") ?? "";
        currentAssistantMsg = {
          role: "assistant",
          content: sanitize(text),
          timestamp: line.timestamp,
        };
      } else if (p.type === "function_call") {
        // Attach to the current assistant message (or create a synthetic one)
        if (!currentAssistantMsg) {
          currentAssistantMsg = {
            role: "assistant",
            content: "",
            timestamp: line.timestamp,
          };
        }
        const name = String(p.name ?? "unknown");
        const argsJson = String(p.arguments ?? "{}");
        const callId = String(p.call_id ?? "");
        const rawResult = callOutputMap.get(callId);

        const toolUse: ToolUse = {
          tool: name,
          input_summary: sanitize(summarizeCodexToolInput(name, argsJson)),
        };
        if (rawResult) toolUse.result = rawResult;

        if (!currentAssistantMsg.tool_uses) {
          currentAssistantMsg.tool_uses = [];
        }
        currentAssistantMsg.tool_uses.push(toolUse);
      }
      // Skip: function_call_output (already in map), message role=developer/user (system)
    }
  }

  // Flush any trailing assistant turn
  flushAssistant();

  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant").length;
  const totalToolUses = messages.reduce(
    (sum, m) => sum + (m.tool_uses?.length ?? 0),
    0
  );

  const workspaceName = raw.cwd ? sanitize(basename(raw.cwd)) : "unknown";
  const gitBranch = raw.cwd ? detectGitBranch(raw.cwd) : undefined;
  const sanitizedBranch = gitBranch ? sanitize(gitBranch) : undefined;

  // Extract files touched from exec_command tool calls is impractical; use
  // read_file/write_file tool calls instead.
  const fileTools = new Set(["read_file", "write_file", "apply_patch"]);
  const filesSet = new Set<string>();
  for (const msg of messages) {
    for (const tu of msg.tool_uses ?? []) {
      if (fileTools.has(tu.tool) && tu.input_summary && !tu.input_summary.includes("…")) {
        filesSet.add(tu.input_summary);
      }
    }
  }

  return {
    id: raw.sessionId || uuidv4(),
    tool: "codex",
    workspace: workspaceName,
    git_branch: sanitizedBranch,
    captured_at: new Date().toISOString(),
    start_time: startTime,
    end_time: endTime,
    model: raw.model,
    messages,
    stats: {
      user_messages: userMessages,
      assistant_messages: assistantMessages,
      tool_uses: totalToolUses,
      input_tokens: 0,
      output_tokens: 0,
    },
    metadata: {
      files_touched: Array.from(filesSet),
      uploader_version: UPLOADER_VERSION,
    },
  };
}
