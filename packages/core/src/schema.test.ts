import { describe, it, expect } from "vitest";
import {
  RawMessageSchema,
  RawToolUseSchema,
  RawToolResultSchema,
  RawTextBlockSchema,
  RawThinkingBlockSchema,
  ToolUseSchema,
  MessageSchema,
  SessionSchema,
} from "./schema.js";

// ── RawToolUseSchema ──────────────────────────────────────────────────────────

describe("RawToolUseSchema", () => {
  it("parses a valid tool_use block", () => {
    const result = RawToolUseSchema.safeParse({
      type: "tool_use",
      id: "tu_1",
      name: "Read",
      input: { file_path: "/foo/bar.ts" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty input object", () => {
    const result = RawToolUseSchema.safeParse({
      type: "tool_use",
      id: "tu_2",
      name: "Bash",
      input: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects when type is not tool_use", () => {
    const result = RawToolUseSchema.safeParse({
      type: "text",
      id: "tu_1",
      name: "Read",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects when id is missing", () => {
    const result = RawToolUseSchema.safeParse({
      type: "tool_use",
      name: "Read",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects when name is missing", () => {
    const result = RawToolUseSchema.safeParse({
      type: "tool_use",
      id: "tu_1",
      input: {},
    });
    expect(result.success).toBe(false);
  });
});

// ── RawToolResultSchema ───────────────────────────────────────────────────────

describe("RawToolResultSchema", () => {
  it("parses with string content", () => {
    const result = RawToolResultSchema.safeParse({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "output text",
    });
    expect(result.success).toBe(true);
  });

  it("parses with array content", () => {
    const result = RawToolResultSchema.safeParse({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{ type: "text", text: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  it("parses without content (optional)", () => {
    const result = RawToolResultSchema.safeParse({
      type: "tool_result",
      tool_use_id: "tu_1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when type is not tool_result", () => {
    const result = RawToolResultSchema.safeParse({
      type: "tool_use",
      tool_use_id: "tu_1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when tool_use_id is missing", () => {
    const result = RawToolResultSchema.safeParse({
      type: "tool_result",
    });
    expect(result.success).toBe(false);
  });
});

// ── RawTextBlockSchema ────────────────────────────────────────────────────────

describe("RawTextBlockSchema", () => {
  it("parses a valid text block", () => {
    const result = RawTextBlockSchema.safeParse({ type: "text", text: "hello" });
    expect(result.success).toBe(true);
  });

  it("rejects non-text type", () => {
    const result = RawTextBlockSchema.safeParse({ type: "thinking", text: "x" });
    expect(result.success).toBe(false);
  });
});

// ── RawThinkingBlockSchema ────────────────────────────────────────────────────

describe("RawThinkingBlockSchema", () => {
  it("parses a valid thinking block", () => {
    const result = RawThinkingBlockSchema.safeParse({ type: "thinking", thinking: "thoughts" });
    expect(result.success).toBe(true);
  });

  it("rejects non-thinking type", () => {
    const result = RawThinkingBlockSchema.safeParse({ type: "text", thinking: "x" });
    expect(result.success).toBe(false);
  });
});

// ── RawMessageSchema ──────────────────────────────────────────────────────────

describe("RawMessageSchema", () => {
  it("parses a minimal valid user message", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
      message: { content: "hello" },
    });
    expect(result.success).toBe(true);
  });

  it("parses type: assistant", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(result.success).toBe(true);
  });

  it("parses type: system", () => {
    const result = RawMessageSchema.safeParse({
      type: "system",
      message: { content: "system prompt" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects when type is missing", () => {
    const result = RawMessageSchema.safeParse({
      message: { content: "hello" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when type is unknown enum value", () => {
    const result = RawMessageSchema.safeParse({
      type: "unknown",
      message: { content: "hello" },
    });
    expect(result.success).toBe(false);
  });

  it("parses without optional fields (uuid, sessionId, timestamp, isMeta, cwd)", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
    });
    expect(result.success).toBe(true);
  });

  it("parses with isMeta: true", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
      isMeta: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses with all optional top-level fields", () => {
    const result = RawMessageSchema.safeParse({
      uuid: "abc-123",
      parentUuid: null,
      sessionId: "sess-1",
      type: "assistant",
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: "/home/user/project",
      isMeta: false,
      costUSD: 0.005,
      durationMs: 1500,
      requestId: "req_123",
      message: { content: "hello" },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.content as plain string", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
      message: { content: "plain string content" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.content).toBe("plain string content");
    }
  });

  it("parses message.content as array with text blocks", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "response text" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.content as array with thinking blocks", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "let me think..." }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.content as array with tool_use blocks", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.content as array with tool_result blocks", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "output" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses message without usage field (optional)", () => {
    const result = RawMessageSchema.safeParse({
      type: "user",
      message: { content: "hello" },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.usage with all four token fields", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        content: "response",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 10,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.usage?.input_tokens).toBe(100);
    }
  });

  it("parses message.usage with some token fields missing (all optional)", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        content: "response",
        usage: { output_tokens: 50 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses message.usage as empty object", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: { content: "response", usage: {} },
    });
    expect(result.success).toBe(true);
  });

  it("parses with model field on message", () => {
    const result = RawMessageSchema.safeParse({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: "hello",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.model).toBe("claude-sonnet-4-6");
    }
  });
});

// ── ToolUseSchema (normalized) ────────────────────────────────────────────────

describe("ToolUseSchema", () => {
  it("parses a valid tool use", () => {
    const result = ToolUseSchema.safeParse({
      tool: "Read",
      input_summary: "/foo/bar.ts",
    });
    expect(result.success).toBe(true);
  });

  it("parses with optional result field", () => {
    const result = ToolUseSchema.safeParse({
      tool: "Bash",
      input_summary: "run tests",
      result: "All tests passed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBe("All tests passed");
    }
  });

  it("parses without result field (optional)", () => {
    const result = ToolUseSchema.safeParse({ tool: "Glob", input_summary: "*.ts" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBeUndefined();
    }
  });

  it("rejects when tool is missing", () => {
    const result = ToolUseSchema.safeParse({ input_summary: "/foo" });
    expect(result.success).toBe(false);
  });

  it("rejects when input_summary is missing", () => {
    const result = ToolUseSchema.safeParse({ tool: "Read" });
    expect(result.success).toBe(false);
  });
});

// ── MessageSchema (normalized) ────────────────────────────────────────────────

describe("MessageSchema", () => {
  it("parses a minimal user message", () => {
    const result = MessageSchema.safeParse({ role: "user", content: "hello" });
    expect(result.success).toBe(true);
  });

  it("parses role: assistant", () => {
    const result = MessageSchema.safeParse({ role: "assistant", content: "hi" });
    expect(result.success).toBe(true);
  });

  it("parses role: system", () => {
    const result = MessageSchema.safeParse({ role: "system", content: "system prompt" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown role values", () => {
    const result = MessageSchema.safeParse({ role: "bot", content: "hi" });
    expect(result.success).toBe(false);
  });

  it("parses with optional thinking field", () => {
    const result = MessageSchema.safeParse({
      role: "assistant",
      content: "response",
      thinking: "my reasoning",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking).toBe("my reasoning");
    }
  });

  it("parses with optional timestamp field", () => {
    const result = MessageSchema.safeParse({
      role: "user",
      content: "hi",
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("parses with optional tool_uses array", () => {
    const result = MessageSchema.safeParse({
      role: "assistant",
      content: "",
      tool_uses: [{ tool: "Read", input_summary: "/foo.ts" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_uses).toHaveLength(1);
    }
  });

  it("rejects when role is missing", () => {
    const result = MessageSchema.safeParse({ content: "hello" });
    expect(result.success).toBe(false);
  });

  it("rejects when content is missing", () => {
    const result = MessageSchema.safeParse({ role: "user" });
    expect(result.success).toBe(false);
  });
});

// ── SessionSchema ─────────────────────────────────────────────────────────────

function makeValidSession() {
  return {
    id: "session-abc-123",
    tool: "claude-code",
    workspace: "myproject",
    captured_at: "2024-01-15T12:00:00.000Z",
    messages: [],
    stats: {
      user_messages: 3,
      assistant_messages: 3,
      tool_uses: 7,
      input_tokens: 1000,
      output_tokens: 500,
    },
    metadata: {
      files_touched: ["src/index.ts", "README.md"],
      uploader_version: "1.0.0",
    },
  };
}

describe("SessionSchema", () => {
  it("parses a complete valid session", () => {
    const result = SessionSchema.safeParse(makeValidSession());
    expect(result.success).toBe(true);
  });

  it("parses with optional git_branch", () => {
    const result = SessionSchema.safeParse({ ...makeValidSession(), git_branch: "main" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.git_branch).toBe("main");
  });

  it("parses with optional model", () => {
    const result = SessionSchema.safeParse({ ...makeValidSession(), model: "claude-sonnet-4-6" });
    expect(result.success).toBe(true);
  });

  it("parses with optional start_time and end_time", () => {
    const result = SessionSchema.safeParse({
      ...makeValidSession(),
      start_time: "2024-01-15T10:00:00.000Z",
      end_time: "2024-01-15T11:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("parses with messages array containing valid messages", () => {
    const result = SessionSchema.safeParse({
      ...makeValidSession(),
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.messages).toHaveLength(2);
  });

  it("rejects when id is missing", () => {
    const { id: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when tool is missing", () => {
    const { tool: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when workspace is missing", () => {
    const { workspace: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when captured_at is missing", () => {
    const { captured_at: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when messages is missing", () => {
    const { messages: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when stats is missing", () => {
    const { stats: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when metadata is missing", () => {
    const { metadata: _, ...rest } = makeValidSession();
    expect(SessionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when a required stats field is missing", () => {
    const session = makeValidSession();
    const { input_tokens: _, ...statsWithout } = session.stats;
    const result = SessionSchema.safeParse({ ...session, stats: statsWithout });
    expect(result.success).toBe(false);
  });

  it("rejects when files_touched is missing from metadata", () => {
    const session = makeValidSession();
    const result = SessionSchema.safeParse({
      ...session,
      metadata: { uploader_version: "1.0.0" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when uploader_version is missing from metadata", () => {
    const session = makeValidSession();
    const result = SessionSchema.safeParse({
      ...session,
      metadata: { files_touched: [] },
    });
    expect(result.success).toBe(false);
  });
});
