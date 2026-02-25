import { describe, it, expect } from "vitest";
import { formatSession } from "./formatter.js";
import type { Session } from "../schema.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-id-abc123",
    tool: "claude-code",
    workspace: "myproject",
    captured_at: "2024-06-15T12:00:00.000Z",
    messages: [],
    stats: {
      user_messages: 0,
      assistant_messages: 0,
      tool_uses: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    metadata: {
      files_touched: [],
      uploader_version: "1.0.0",
    },
    ...overrides,
  };
}

// ── Return shape ──────────────────────────────────────────────────────────────

describe("formatSession — return shape", () => {
  it("returns an object with json, markdown, and filename keys", () => {
    const result = formatSession(makeSession());
    expect(result).toHaveProperty("json");
    expect(result).toHaveProperty("markdown");
    expect(result).toHaveProperty("filename");
  });

  it("filename is claude-code_<session.id>", () => {
    const result = formatSession(makeSession({ id: "abc-123" }));
    expect(result.filename).toBe("claude-code_abc-123");
  });

  it("json round-trips via JSON.parse to the original session", () => {
    const session = makeSession({ git_branch: "main", model: "claude-sonnet-4-6" });
    const result = formatSession(session);
    const parsed = JSON.parse(result.json);
    expect(parsed.id).toBe(session.id);
    expect(parsed.workspace).toBe(session.workspace);
    expect(parsed.git_branch).toBe("main");
    expect(parsed.model).toBe("claude-sonnet-4-6");
  });

  it("json is pretty-printed (contains newlines)", () => {
    const result = formatSession(makeSession());
    expect(result.json).toContain("\n");
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe("formatSession — JSON output", () => {
  it("contains all required session fields", () => {
    const session = makeSession();
    const parsed = JSON.parse(formatSession(session).json);
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("tool");
    expect(parsed).toHaveProperty("workspace");
    expect(parsed).toHaveProperty("captured_at");
    expect(parsed).toHaveProperty("messages");
    expect(parsed).toHaveProperty("stats");
    expect(parsed).toHaveProperty("metadata");
  });

  it("contains all five stats fields", () => {
    const session = makeSession({
      stats: {
        user_messages: 3,
        assistant_messages: 3,
        tool_uses: 5,
        input_tokens: 1200,
        output_tokens: 600,
      },
    });
    const parsed = JSON.parse(formatSession(session).json);
    expect(parsed.stats.user_messages).toBe(3);
    expect(parsed.stats.assistant_messages).toBe(3);
    expect(parsed.stats.tool_uses).toBe(5);
    expect(parsed.stats.input_tokens).toBe(1200);
    expect(parsed.stats.output_tokens).toBe(600);
  });

  it("contains metadata.uploader_version", () => {
    const parsed = JSON.parse(formatSession(makeSession()).json);
    expect(parsed.metadata.uploader_version).toBe("1.0.0");
  });
});

// ── Markdown header and metadata table ────────────────────────────────────────

describe("formatSession — markdown header", () => {
  it("starts with # Agent Chat — <workspace>", () => {
    const result = formatSession(makeSession({ workspace: "myproject" }));
    expect(result.markdown).toMatch(/^# Agent Chat — myproject/);
  });

  it("contains a metadata table header row", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).toContain("| Field | Value |");
  });

  it("always includes Tool row", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).toContain("| Tool | claude-code |");
  });

  it("always includes Session ID row with backtick-wrapped id", () => {
    const result = formatSession(makeSession({ id: "abc-123" }));
    expect(result.markdown).toContain("| Session ID | `abc-123` |");
  });

  it("includes Model row when model is present", () => {
    const result = formatSession(makeSession({ model: "claude-sonnet-4-6" }));
    expect(result.markdown).toContain("| Model | claude-sonnet-4-6 |");
  });

  it("omits Model row when model is absent", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).not.toContain("| Model |");
  });

  it("includes Branch row when git_branch is present", () => {
    const result = formatSession(makeSession({ git_branch: "feat/my-feature" }));
    expect(result.markdown).toContain("| Branch | feat/my-feature |");
  });

  it("omits Branch row when git_branch is absent", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).not.toContain("| Branch |");
  });

  it("includes Started row when start_time is present", () => {
    const result = formatSession(makeSession({ start_time: "2024-06-15T10:00:00.000Z" }));
    expect(result.markdown).toContain("| Started |");
  });

  it("omits Started row when start_time is absent", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).not.toContain("| Started |");
  });

  it("includes Ended row when end_time is present", () => {
    const result = formatSession(makeSession({ end_time: "2024-06-15T11:00:00.000Z" }));
    expect(result.markdown).toContain("| Ended |");
  });

  it("omits Ended row when end_time is absent", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).not.toContain("| Ended |");
  });

  it("always includes Captured row", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).toContain("| Captured |");
  });
});

// ── Markdown stats section ────────────────────────────────────────────────────

describe("formatSession — markdown stats section", () => {
  it("contains ## Stats heading", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).toContain("## Stats");
  });

  it("contains message counts", () => {
    const result = formatSession(makeSession({
      stats: { user_messages: 4, assistant_messages: 4, tool_uses: 6, input_tokens: 0, output_tokens: 0 },
    }));
    expect(result.markdown).toContain("4 user");
    expect(result.markdown).toContain("4 assistant");
  });

  it("contains tool uses count", () => {
    const result = formatSession(makeSession({
      stats: { user_messages: 1, assistant_messages: 1, tool_uses: 9, input_tokens: 0, output_tokens: 0 },
    }));
    expect(result.markdown).toContain("**Tool uses:** 9");
  });

  it("contains token counts", () => {
    const result = formatSession(makeSession({
      stats: { user_messages: 0, assistant_messages: 0, tool_uses: 0, input_tokens: 1500, output_tokens: 750 },
    }));
    expect(result.markdown).toContain("in");
    expect(result.markdown).toContain("out");
  });
});

// ── Markdown files touched section ───────────────────────────────────────────

describe("formatSession — markdown files touched section", () => {
  it("includes ## Files Touched section when files_touched is non-empty", () => {
    const result = formatSession(makeSession({
      metadata: { files_touched: ["src/index.ts", "README.md"], uploader_version: "1.0.0" },
    }));
    expect(result.markdown).toContain("## Files Touched");
    expect(result.markdown).toContain("`src/index.ts`");
    expect(result.markdown).toContain("`README.md`");
  });

  it("omits ## Files Touched section when files_touched is empty", () => {
    const result = formatSession(makeSession({
      metadata: { files_touched: [], uploader_version: "1.0.0" },
    }));
    expect(result.markdown).not.toContain("## Files Touched");
  });
});

// ── Markdown conversation section ─────────────────────────────────────────────

describe("formatSession — markdown conversation", () => {
  it("contains ## Conversation heading", () => {
    const result = formatSession(makeSession());
    expect(result.markdown).toContain("## Conversation");
  });

  it("renders user message as ### **User**", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "user", content: "Hello there!" }],
    }));
    expect(result.markdown).toContain("### **User**");
    expect(result.markdown).toContain("Hello there!");
  });

  it("renders assistant message as ### **Assistant**", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "assistant", content: "Hi!" }],
    }));
    expect(result.markdown).toContain("### **Assistant**");
    expect(result.markdown).toContain("Hi!");
  });

  it("appends timestamp suffix when message has a timestamp", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "user", content: "hi", timestamp: "2024-06-15T10:00:00.000Z" }],
    }));
    // Should contain the formatted date inside italics
    expect(result.markdown).toMatch(/###\s+\*\*User\*\*.*_\(/);
  });

  it("does not append timestamp suffix when message has no timestamp", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "user", content: "hi" }],
    }));
    const userHeadingLine = result.markdown
      .split("\n")
      .find((l) => l.startsWith("### **User**"));
    expect(userHeadingLine).toBe("### **User**");
  });

  it("each message ends with --- separator", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(result.markdown).toContain("\n---\n");
  });
});

// ── Markdown thinking block ───────────────────────────────────────────────────

describe("formatSession — thinking block", () => {
  it("renders thinking as <details><summary>Extended thinking</summary> collapsible", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "assistant", content: "response", thinking: "my reasoning here" }],
    }));
    expect(result.markdown).toContain("<details>");
    expect(result.markdown).toContain("<summary>Extended thinking</summary>");
    expect(result.markdown).toContain("my reasoning here");
    expect(result.markdown).toContain("</details>");
  });

  it("omits thinking collapsible when message has no thinking", () => {
    const result = formatSession(makeSession({
      messages: [{ role: "assistant", content: "response" }],
    }));
    expect(result.markdown).not.toContain("Extended thinking");
  });
});

// ── Markdown tool uses ────────────────────────────────────────────────────────

describe("formatSession — tool uses", () => {
  it("renders outer collapsible with tool count", () => {
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [
          { tool: "Read", input_summary: "/foo.ts" },
          { tool: "Glob", input_summary: "*.ts" },
        ],
      }],
    }));
    expect(result.markdown).toContain("<summary>Tool uses (2)</summary>");
  });

  it("renders tools without result in a compact table", () => {
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{ tool: "Read", input_summary: "/foo.ts" }],
      }],
    }));
    expect(result.markdown).toContain("| Tool | Input |");
    expect(result.markdown).toContain("| `Read` |");
    expect(result.markdown).toContain("/foo.ts");
  });

  it("escapes pipe characters in input_summary in the table", () => {
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{ tool: "Bash", input_summary: "echo foo | grep bar" }],
      }],
    }));
    expect(result.markdown).toContain("echo foo \\| grep bar");
  });

  it("renders tools with result in a nested collapsible", () => {
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{ tool: "Task", input_summary: "do something", result: "Done!" }],
      }],
    }));
    expect(result.markdown).toContain("<code>Task</code>");
    expect(result.markdown).toContain("Done!");
  });

  it("truncates long input_summary to 80 chars with … in result collapsible title", () => {
    const longSummary = "a".repeat(100);
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{ tool: "Task", input_summary: longSummary, result: "output" }],
      }],
    }));
    expect(result.markdown).toContain("a".repeat(80) + "…");
  });

  it("does not truncate input_summary of 80 chars or fewer in result collapsible title", () => {
    const summary = "a".repeat(80);
    const result = formatSession(makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{ tool: "Task", input_summary: summary, result: "output" }],
      }],
    }));
    expect(result.markdown).not.toContain("…");
  });
});

// ── Markdown footer ───────────────────────────────────────────────────────────

describe("formatSession — footer", () => {
  it("ends with _Generated by tokenxtractor v<version>_", () => {
    const result = formatSession(makeSession({
      metadata: { files_touched: [], uploader_version: "1.0.0" },
    }));
    expect(result.markdown).toContain("_Generated by tokenxtractor v1.0.0_");
  });

  it("uses the uploader_version from metadata", () => {
    const result = formatSession(makeSession({
      metadata: { files_touched: [], uploader_version: "2.3.4" },
    }));
    expect(result.markdown).toContain("_Generated by tokenxtractor v2.3.4_");
  });
});

// ── formatDate (exercised indirectly) ────────────────────────────────────────

describe("formatSession — date formatting", () => {
  it("formats a valid ISO date into a human-readable string (not raw ISO)", () => {
    const result = formatSession(makeSession({ start_time: "2024-06-15T10:00:00.000Z" }));
    // Should not contain the raw ISO string in the metadata table
    const startedRow = result.markdown.split("\n").find((l) => l.includes("| Started |"));
    expect(startedRow).toBeDefined();
    expect(startedRow).not.toContain("2024-06-15T10:00:00.000Z");
  });

  it("does not throw for an invalid date string (falls back gracefully)", () => {
    // formatDate uses try/catch: for truly invalid ISO that toLocaleString can't handle
    // it returns the raw string. For "not-a-date", JS returns "Invalid Date" string.
    // Either way, formatSession must not throw.
    expect(() =>
      formatSession(makeSession({ captured_at: "not-a-date" }))
    ).not.toThrow();
    // The Captured row is always present — either with "Invalid Date" or the original string
    const result = formatSession(makeSession({ captured_at: "not-a-date" }));
    expect(result.markdown).toContain("| Captured |");
  });
});
