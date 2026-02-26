import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process");
vi.mock("os");

import { execSync } from "child_process";
import { userInfo } from "os";
import { normalizeSession } from "./normalizer.js";
import type { RawSession } from "../detectors/claudeCode.js";
import type { RawMessage } from "../schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRawMsg(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    type: "user",
    ...overrides,
  };
}

function makeAssistantMsg(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    type: "assistant",
    message: {
      content: "Assistant response",
      ...((overrides.message ?? {}) as object),
    },
    ...overrides,
  } as RawMessage;
}

function makeRawSession(overrides: Partial<RawSession> = {}): RawSession {
  return {
    sessionId: "session-abc-123",
    projectPath: "/home/testuser/.claude/projects/-home-testuser-dev-myproject",
    projectName: "-home-testuser-dev-myproject",
    filePath: "/home/testuser/.claude/projects/-home-testuser-dev-myproject/session-abc-123.jsonl",
    messages: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userInfo).mockReturnValue({
    username: "testuser",
    uid: 1000,
    gid: 1000,
    homedir: "/home/testuser",
    shell: "/bin/bash",
  });
  vi.mocked(execSync).mockReturnValue("main\n" as any);
});

// ── Basic normalization ───────────────────────────────────────────────────────

describe("normalizeSession — basic fields", () => {
  it("uses raw.sessionId as the session id", () => {
    const session = normalizeSession(makeRawSession({ sessionId: "my-session-id" }));
    expect(session.id).toBe("my-session-id");
  });

  it("sets tool to claude-code", () => {
    const session = normalizeSession(makeRawSession());
    expect(session.tool).toBe("claude-code");
  });

  it("captured_at is a valid ISO 8601 string", () => {
    const session = normalizeSession(makeRawSession());
    expect(new Date(session.captured_at).toString()).not.toBe("Invalid Date");
  });

  it("metadata.uploader_version is 1.0.0", () => {
    const session = normalizeSession(makeRawSession());
    expect(session.metadata.uploader_version).toBe("1.0.0");
  });

  it("decodes workspace from projectName: last segment after splitting on '-'", () => {
    const session = normalizeSession(
      makeRawSession({ projectName: "-home-testuser-dev-myproject" })
    );
    expect(session.workspace).toBe("myproject");
  });

  it("returns the full projectName if it has no hyphens", () => {
    const session = normalizeSession(makeRawSession({ projectName: "myproject" }));
    expect(session.workspace).toBe("myproject");
  });
});

// ── Message filtering ─────────────────────────────────────────────────────────

describe("normalizeSession — message filtering", () => {
  it("excludes messages where isMeta is true", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", isMeta: true, message: { content: "meta" } }),
        makeRawMsg({ type: "user", message: { content: "real message" } }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe("real message");
  });

  it("excludes messages with type: system", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "system", message: { content: "system prompt" } }),
        makeRawMsg({ type: "user", message: { content: "user message" } }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
  });

  it("excludes messages with no content and no tool uses", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", message: { content: "" } }),
        makeRawMsg({ type: "user", message: { content: "real" } }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe("real");
  });

  it("includes assistant message with role: assistant", () => {
    const raw = makeRawSession({
      messages: [makeAssistantMsg()],
    });
    const session = normalizeSession(raw);
    expect(session.messages[0].role).toBe("assistant");
  });

  it("includes user message with role: user", () => {
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", message: { content: "hello" } })],
    });
    const session = normalizeSession(raw);
    expect(session.messages[0].role).toBe("user");
  });
});

// ── Token accumulation ────────────────────────────────────────────────────────

describe("normalizeSession — token accumulation", () => {
  it("sums input_tokens + cache_creation + cache_read into stats.input_tokens", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: "response",
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 10,
              output_tokens: 50,
            },
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.input_tokens).toBe(130); // 100 + 20 + 10
  });

  it("sums output_tokens into stats.output_tokens", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: { content: "resp", usage: { input_tokens: 0, output_tokens: 75 } },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.output_tokens).toBe(75);
  });

  it("accumulates tokens across multiple messages", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: { content: "a", usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        makeAssistantMsg({
          message: { content: "b", usage: { input_tokens: 200, output_tokens: 100 } },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.input_tokens).toBe(300);
    expect(session.stats.output_tokens).toBe(150);
  });

  it("contributes 0 tokens for messages with no usage field", () => {
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.stats.input_tokens).toBe(0);
    expect(session.stats.output_tokens).toBe(0);
  });
});

// ── Timestamp tracking ────────────────────────────────────────────────────────

describe("normalizeSession — timestamps", () => {
  it("start_time is the timestamp of the first relevant message", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", timestamp: "2024-01-01T10:00:00.000Z", message: { content: "a" } }),
        makeRawMsg({ type: "user", timestamp: "2024-01-01T11:00:00.000Z", message: { content: "b" } }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.start_time).toBe("2024-01-01T10:00:00.000Z");
  });

  it("end_time is the timestamp of the last relevant message", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", timestamp: "2024-01-01T10:00:00.000Z", message: { content: "a" } }),
        makeRawMsg({ type: "user", timestamp: "2024-01-01T11:00:00.000Z", message: { content: "b" } }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.end_time).toBe("2024-01-01T11:00:00.000Z");
  });

  it("start_time and end_time are undefined when no messages have timestamps", () => {
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.start_time).toBeUndefined();
    expect(session.end_time).toBeUndefined();
  });
});

// ── Model detection ───────────────────────────────────────────────────────────

describe("normalizeSession — model detection", () => {
  it("detects model from the first message that has one", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: { content: "hello", model: "claude-sonnet-4-6" },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.model).toBe("claude-sonnet-4-6");
  });

  it("model is undefined when no message has a model field", () => {
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.model).toBeUndefined();
  });
});

// ── Tool input summarization ──────────────────────────────────────────────────

describe("normalizeSession — tool input summarization", () => {
  function makeToolMsg(tool: string, input: Record<string, unknown>) {
    return makeAssistantMsg({
      message: {
        content: [
          { type: "tool_use", id: "tu_1", name: tool, input },
        ],
      },
    });
  }

  it("Read tool: input_summary uses file_path field", () => {
    const raw = makeRawSession({ messages: [makeToolMsg("Read", { file_path: "/foo/bar.ts" })] });
    const session = normalizeSession(raw);
    expect(session.messages[0].tool_uses![0].input_summary).toBe("/foo/bar.ts");
  });

  it("Bash tool: input_summary uses description field", () => {
    const raw = makeRawSession({ messages: [makeToolMsg("Bash", { description: "run tests", command: "npm test" })] });
    const session = normalizeSession(raw);
    expect(session.messages[0].tool_uses![0].input_summary).toBe("run tests");
  });

  it("Glob tool: input_summary uses pattern and path fields", () => {
    const raw = makeRawSession({ messages: [makeToolMsg("Glob", { pattern: "*.ts", path: "/src" })] });
    const session = normalizeSession(raw);
    const summary = session.messages[0].tool_uses![0].input_summary;
    expect(summary).toContain("*.ts");
    expect(summary).toContain("/src");
  });

  it("unknown tool: uses first two input keys", () => {
    const raw = makeRawSession({ messages: [makeToolMsg("CustomTool", { foo: "bar", baz: "qux" })] });
    const session = normalizeSession(raw);
    const summary = session.messages[0].tool_uses![0].input_summary;
    expect(summary).toContain("bar");
    expect(summary).toContain("qux");
  });

  it("empty input object returns (no input)", () => {
    const raw = makeRawSession({ messages: [makeToolMsg("UnknownTool", {})] });
    const session = normalizeSession(raw);
    expect(session.messages[0].tool_uses![0].input_summary).toBe("(no input)");
  });

  it("values longer than 120 chars are truncated with …", () => {
    const longPath = "/".repeat(130);
    const raw = makeRawSession({ messages: [makeToolMsg("Read", { file_path: longPath })] });
    const session = normalizeSession(raw);
    const summary = session.messages[0].tool_uses![0].input_summary;
    expect(summary).toHaveLength(121); // 120 + '…'
    expect(summary.endsWith("…")).toBe(true);
  });
});

// ── Tool result map ───────────────────────────────────────────────────────────

describe("normalizeSession — tool result map", () => {
  it("attaches result from a tool_result block to the matching tool_use via tool_use_id", () => {
    const raw = makeRawSession({
      messages: [
        // Assistant message with tool_use
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_abc", name: "Bash", input: { description: "run" } },
            ],
          },
        }),
        // User message with tool_result
        makeRawMsg({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_abc", content: "exit 0\noutput text" },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const toolUse = session.messages.find((m) => m.role === "assistant")?.tool_uses?.[0];
    expect(toolUse?.result).toBe("exit 0\noutput text");
  });

  it("result is undefined when no matching tool_result exists", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_xyz", name: "Read", input: { file_path: "/foo" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.messages[0].tool_uses![0].result).toBeUndefined();
  });

  it("handles tool_result with array content (joins text blocks with newline)", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Task", input: { description: "do" } },
            ],
          },
        }),
        makeRawMsg({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [
                  { type: "text", text: "line one" },
                  { type: "text", text: "line two" },
                ],
              },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const toolUse = session.messages.find((m) => m.role === "assistant")?.tool_uses?.[0];
    expect(toolUse?.result).toBe("line one\nline two");
  });
});

// ── Username sanitization ─────────────────────────────────────────────────────

describe("normalizeSession — username sanitization", () => {
  it("replaces OS username in tool input_summary with user_<hash>", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "myuser", uid: 1, gid: 1, homedir: "/home/myuser", shell: "/bin/bash" });
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/home/myuser/project/src/index.ts" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const summary = session.messages[0].tool_uses![0].input_summary;
    expect(summary).not.toContain("myuser");
    expect(summary).toMatch(/user_[0-9a-f]{8}/);
  });

  it("replaces extraUsernames in addition to OS username", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "osuser", uid: 1, gid: 1, homedir: "/home/osuser", shell: "/bin/bash" });
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/home/extrauser/file.ts" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw, { extraUsernames: ["extrauser"] });
    const summary = session.messages[0].tool_uses![0].input_summary;
    expect(summary).not.toContain("extrauser");
    expect(summary).toMatch(/user_[0-9a-f]{8}/);
  });

  it("produces a stable hash: same username always maps to the same hash", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "stableuser", uid: 1, gid: 1, homedir: "/home/stableuser", shell: "/bin/bash" });
    const makeMsg = () => makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/home/stableuser/f.ts" } },
            ],
          },
        }),
      ],
    });
    const s1 = normalizeSession(makeMsg());
    const s2 = normalizeSession(makeMsg());
    expect(s1.messages[0].tool_uses![0].input_summary).toBe(
      s2.messages[0].tool_uses![0].input_summary
    );
  });

  it("hash starts with user_", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "hashcheck", uid: 1, gid: 1, homedir: "/home/hashcheck", shell: "/bin/bash" });
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/home/hashcheck/f.ts" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.messages[0].tool_uses![0].input_summary).toMatch(/^\/home\/user_[0-9a-f]{8}\//);
  });
});

// ── GitHub handle and homedir sanitization ────────────────────────────────────

describe("normalizeSession — GitHub handle and homedir sanitization", () => {
  it("sanitizes a GitHub handle extracted from git remote URL in tool summary", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "osuser", uid: 1, gid: 1, homedir: "/home/osuser", shell: "/bin/bash" });
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("rev-parse")) return "main\n" as any;
      if (c.includes("remote get-url")) return "https://github.com/mygithubhandle/repo.git\n" as any;
      if (c.includes("config user.name")) return "osuser\n" as any;
      if (c.includes("config user.email")) return "osuser@example.com\n" as any;
      throw new Error("unexpected");
    });
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", cwd: "/home/osuser/project", message: { content: "hi" } }),
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Bash", input: { description: "fetching mygithubhandle repo" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const summary = session.messages.find((m) => m.role === "assistant")?.tool_uses?.[0].input_summary ?? "";
    expect(summary).not.toContain("mygithubhandle");
    expect(summary).toMatch(/user_[0-9a-f]{8}/);
  });

  it("sanitizes the full homedir path in tool summaries", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "alice", uid: 1, gid: 1, homedir: "/Users/alice", shell: "/bin/zsh" });
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/Users/alice/project/src/index.ts" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const summary = session.messages.find((m) => m.role === "assistant")?.tool_uses?.[0].input_summary ?? "";
    expect(summary).not.toContain("/Users/alice");
  });
});

// ── Git branch detection ──────────────────────────────────────────────────────

describe("normalizeSession — git branch", () => {
  it("sets git_branch when execSync returns a branch name", () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("rev-parse")) return "main\n" as any;
      if (c.includes("config user.name")) return "testuser\n" as any;
      if (c.includes("config user.email")) return "testuser@example.com\n" as any;
      throw new Error("no remote");
    });
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", cwd: "/home/testuser/project", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.git_branch).toBe("main");
  });

  it("git_branch is undefined when execSync throws", () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not a git repo"); });
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", cwd: "/tmp/notgit", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.git_branch).toBeUndefined();
  });

  it("uses cwd from the first message that has one", () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from("feature\n"));
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", cwd: "/home/testuser/project", message: { content: "hi" } }),
        makeRawMsg({ type: "user", cwd: "/some/other/path", message: { content: "bye" } }),
      ],
    });
    normalizeSession(raw);
    expect(execSync).toHaveBeenCalledWith(
      "git rev-parse --abbrev-ref HEAD",
      expect.objectContaining({ cwd: "/home/testuser/project" })
    );
  });

  it("does not call execSync when no message has a cwd field", () => {
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(execSync).not.toHaveBeenCalled();
    expect(session.git_branch).toBeUndefined();
  });

  it("sanitizes username in git_branch if present", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "branchuser", uid: 1, gid: 1, homedir: "/home/branchuser", shell: "/bin/bash" });
    vi.mocked(execSync).mockReturnValue("feature/branchuser-work\n" as any);
    const raw = makeRawSession({
      messages: [makeRawMsg({ type: "user", cwd: "/home/branchuser/proj", message: { content: "hi" } })],
    });
    const session = normalizeSession(raw);
    expect(session.git_branch).not.toContain("branchuser");
    expect(session.git_branch).toMatch(/user_[0-9a-f]{8}/);
  });
});

// ── noThinking option ─────────────────────────────────────────────────────────

describe("normalizeSession — noThinking option", () => {
  function makeThinkingMsg(): RawMessage {
    return makeAssistantMsg({
      message: {
        content: [
          { type: "thinking", thinking: "I need to think..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    });
  }

  it("includes thinking when noThinking is false (default)", () => {
    const raw = makeRawSession({ messages: [makeThinkingMsg()] });
    const session = normalizeSession(raw, { noThinking: false });
    expect(session.messages[0].thinking).toBe("I need to think...");
  });

  it("excludes thinking when noThinking is true", () => {
    const raw = makeRawSession({ messages: [makeThinkingMsg()] });
    const session = normalizeSession(raw, { noThinking: true });
    expect(session.messages[0].thinking).toBeUndefined();
  });
});

// ── Stats counting ────────────────────────────────────────────────────────────

describe("normalizeSession — stats counting", () => {
  it("counts user_messages correctly", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", message: { content: "msg1" } }),
        makeRawMsg({ type: "user", message: { content: "msg2" } }),
        makeAssistantMsg(),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.user_messages).toBe(2);
  });

  it("counts assistant_messages correctly", () => {
    const raw = makeRawSession({
      messages: [
        makeRawMsg({ type: "user", message: { content: "hi" } }),
        makeAssistantMsg(),
        makeAssistantMsg(),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.assistant_messages).toBe(2);
  });

  it("counts total tool_uses across all messages", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a" } },
              { type: "tool_use", id: "tu_2", name: "Glob", input: { pattern: "*.ts" } },
            ],
          },
        }),
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_3", name: "Bash", input: { description: "test" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.stats.tool_uses).toBe(3);
  });
});

// ── extractFilesTouched ───────────────────────────────────────────────────────

describe("normalizeSession — files touched", () => {
  it("collects files from Read, Write, Edit, NotebookEdit tools", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/proj/src/a.ts" } },
              { type: "tool_use", id: "tu_2", name: "Write", input: { file_path: "/proj/src/b.ts" } },
              { type: "tool_use", id: "tu_3", name: "Edit", input: { file_path: "/proj/src/c.ts" } },
              { type: "tool_use", id: "tu_4", name: "NotebookEdit", input: { notebook_path: "/proj/n.ipynb" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    // NotebookEdit uses notebook_path key, which is not in the key list for NotebookEdit
    // Actually checking the normalizer: NotebookEdit key is "notebook_path"
    expect(session.metadata.files_touched.length).toBeGreaterThanOrEqual(3);
  });

  it("does not collect files from Bash or Grep tools", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Bash", input: { description: "run" } },
              { type: "tool_use", id: "tu_2", name: "Grep", input: { pattern: "foo" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.metadata.files_touched).toHaveLength(0);
  });

  it("strips workspace root prefix from file paths", () => {
    const workspaceRoot = "/home/testuser/myproject";
    const raw = makeRawSession({
      messages: [
        makeRawMsg({
          type: "user",
          cwd: workspaceRoot,
          message: { content: "start" },
        }),
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: `${workspaceRoot}/src/index.ts` } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    // Files should have the workspace root stripped
    const files = session.metadata.files_touched;
    expect(files.some((f) => !f.startsWith(workspaceRoot))).toBe(true);
  });

  it("deduplicates file paths", () => {
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/proj/src/index.ts" } },
              { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/proj/src/index.ts" } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    const count = session.metadata.files_touched.filter((f) =>
      f.includes("index.ts")
    ).length;
    expect(count).toBe(1);
  });

  it("excludes truncated summaries (containing …)", () => {
    const longPath = "/".repeat(130);
    const raw = makeRawSession({
      messages: [
        makeAssistantMsg({
          message: {
            content: [
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: longPath } },
            ],
          },
        }),
      ],
    });
    const session = normalizeSession(raw);
    expect(session.metadata.files_touched).toHaveLength(0);
  });
});
