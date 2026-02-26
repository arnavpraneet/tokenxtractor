import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process");
vi.mock("os");

import { execSync } from "child_process";
import { userInfo } from "os";
import { normalizeCodexSession } from "./codexNormalizer.js";
import type { RawCodexSession } from "../schema.js";
import type { CodexLine } from "../schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLine(type: string, payload: Record<string, unknown>, timestamp = "2026-02-25T08:00:00.000Z"): CodexLine {
  return { timestamp, type, payload };
}

function userMsgLine(message: string, timestamp = "2026-02-25T08:00:00.000Z"): CodexLine {
  return makeLine("event_msg", { type: "user_message", message }, timestamp);
}

function assistantMsgLine(text: string, timestamp = "2026-02-25T08:01:00.000Z"): CodexLine {
  return makeLine(
    "response_item",
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
    timestamp
  );
}

function functionCallLine(name: string, args: string, callId: string, timestamp = "2026-02-25T08:01:30.000Z"): CodexLine {
  return makeLine("response_item", { type: "function_call", name, arguments: args, call_id: callId }, timestamp);
}

function functionCallOutputLine(callId: string, output: string, timestamp = "2026-02-25T08:01:31.000Z"): CodexLine {
  return makeLine("response_item", { type: "function_call_output", call_id: callId, output }, timestamp);
}

function reasoningLine(summaryTexts: string[], timestamp = "2026-02-25T08:00:59.000Z"): CodexLine {
  return makeLine(
    "response_item",
    {
      type: "reasoning",
      summary: summaryTexts.map((text) => ({ type: "summary_text", text })),
    },
    timestamp
  );
}

function makeRaw(overrides: Partial<RawCodexSession> = {}): RawCodexSession {
  return {
    sessionId: "test-session-id",
    filePath: "/home/testuser/.codex/sessions/2026/02/25/rollout.jsonl",
    cwd: "/home/testuser/project",
    model: "codex-mini-latest",
    cli_version: "1.2.3",
    lines: [],
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

// ── Basic fields ──────────────────────────────────────────────────────────────

describe("normalizeCodexSession — basic fields", () => {
  it("uses raw.sessionId as the session id", () => {
    const session = normalizeCodexSession(makeRaw({ sessionId: "my-session-id" }));
    expect(session.id).toBe("my-session-id");
  });

  it("generates a UUID when sessionId is empty string", () => {
    const session = normalizeCodexSession(makeRaw({ sessionId: "" }));
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets tool to codex", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi")] }));
    expect(session.tool).toBe("codex");
  });

  it("captured_at is a valid ISO 8601 string", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi")] }));
    expect(new Date(session.captured_at).toString()).not.toBe("Invalid Date");
  });

  it("metadata.uploader_version is 1.0.0", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi")] }));
    expect(session.metadata.uploader_version).toBe("1.0.0");
  });

  it("uses the model from raw", () => {
    const session = normalizeCodexSession(makeRaw({ model: "codex-mini-latest", lines: [userMsgLine("hi")] }));
    expect(session.model).toBe("codex-mini-latest");
  });

  it("model is undefined when raw.model is not set", () => {
    const session = normalizeCodexSession(makeRaw({ model: undefined, lines: [userMsgLine("hi")] }));
    expect(session.model).toBeUndefined();
  });

  it("workspace is the basename of raw.cwd", () => {
    const session = normalizeCodexSession(makeRaw({ cwd: "/home/testuser/myproject", lines: [userMsgLine("hi")] }));
    expect(session.workspace).toBe("myproject");
  });

  it("workspace is 'unknown' when cwd is empty", () => {
    const session = normalizeCodexSession(makeRaw({ cwd: "", lines: [userMsgLine("hi")] }));
    expect(session.workspace).toBe("unknown");
  });

  it("stats always has input_tokens and output_tokens as 0", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi")] }));
    expect(session.stats.input_tokens).toBe(0);
    expect(session.stats.output_tokens).toBe(0);
  });
});

// ── Message normalization ─────────────────────────────────────────────────────

describe("normalizeCodexSession — message normalization", () => {
  it("creates user message from event_msg/user_message lines", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hello world")] }));
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("hello world");
  });

  it("creates assistant message from response_item/message/role=assistant", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi"), assistantMsgLine("hello back")] }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("hello back");
  });

  it("joins multiple output_text blocks with newline", () => {
    const line = makeLine("response_item", {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "first" },
        { type: "output_text", text: "second" },
      ],
    });
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi"), line] }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.content).toBe("first\nsecond");
  });

  it("skips empty user messages", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine(""), userMsgLine("real")] }));
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe("real");
  });

  it("preserves message timestamps", () => {
    const ts = "2026-02-25T09:30:00.000Z";
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi", ts)] }));
    expect(session.messages[0].timestamp).toBe(ts);
  });

  it("flushes pending assistant message when a new user message arrives", () => {
    const lines = [
      userMsgLine("question 1", "2026-02-25T08:00:00.000Z"),
      assistantMsgLine("answer 1", "2026-02-25T08:01:00.000Z"),
      userMsgLine("question 2", "2026-02-25T08:02:00.000Z"),
      assistantMsgLine("answer 2", "2026-02-25T08:03:00.000Z"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.messages).toHaveLength(4);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("handles developer/system role response_item messages (skips them)", () => {
    const devLine = makeLine("response_item", {
      type: "message",
      role: "developer",
      content: [{ type: "output_text", text: "system message" }],
    });
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("hi"), devLine] }));
    // developer role messages are skipped
    expect(session.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });
});

// ── Tool use handling ─────────────────────────────────────────────────────────

describe("normalizeCodexSession — tool uses", () => {
  it("attaches function_call to the current assistant message", () => {
    const lines = [
      userMsgLine("do something"),
      assistantMsgLine("ok"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "ls" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses).toHaveLength(1);
    expect(assistantMsg!.tool_uses![0].tool).toBe("exec_command");
  });

  it("creates a synthetic assistant message for function_call with no preceding assistant turn", () => {
    const lines = [
      userMsgLine("do something"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "ls" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_uses).toHaveLength(1);
  });

  it("attaches tool result from function_call_output via call_id", () => {
    const lines = [
      userMsgLine("run ls"),
      functionCallOutputLine("call_42", "file1.ts\nfile2.ts"),
      assistantMsgLine("ok"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "ls" }), "call_42"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].result).toBe("file1.ts\nfile2.ts");
  });

  it("result is undefined when no matching function_call_output exists", () => {
    const lines = [
      userMsgLine("run ls"),
      assistantMsgLine("ok"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "ls" }), "call_99"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].result).toBeUndefined();
  });

  it("accumulates multiple function_calls on a single assistant message", () => {
    const lines = [
      userMsgLine("do two things"),
      assistantMsgLine("sure"),
      functionCallLine("read_file", JSON.stringify({ path: "/a.ts" }), "call_1"),
      functionCallLine("write_file", JSON.stringify({ path: "/b.ts" }), "call_2"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses).toHaveLength(2);
  });
});

// ── summarizeCodexToolInput ───────────────────────────────────────────────────

describe("normalizeCodexSession — tool input summarization", () => {
  function sessionWithTool(name: string, argsJson: string) {
    const lines = [
      userMsgLine("do it"),
      assistantMsgLine("ok"),
      functionCallLine(name, argsJson, "call_1"),
    ];
    return normalizeCodexSession(makeRaw({ lines }));
  }

  it("exec_command: uses cmd field", () => {
    const session = sessionWithTool("exec_command", JSON.stringify({ cmd: "npm test" }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("npm test");
  });

  it("exec_command: falls back to first value when cmd is absent", () => {
    const session = sessionWithTool("exec_command", JSON.stringify({ command: "git status" }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("git status");
  });

  it("read_file: uses path field", () => {
    const session = sessionWithTool("read_file", JSON.stringify({ path: "/src/index.ts" }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("/src/index.ts");
  });

  it("write_file: uses path field", () => {
    const session = sessionWithTool("write_file", JSON.stringify({ path: "/out/bundle.js" }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("/out/bundle.js");
  });

  it("apply_patch: extracts filename from *** patch header", () => {
    const patch = "*** src/foo.ts\n--- src/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n";
    const session = sessionWithTool("apply_patch", JSON.stringify({ patch }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("src/foo.ts");
  });

  it("apply_patch: extracts filename from +++ patch header if *** not found", () => {
    const patch = "+++ src/bar.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const session = sessionWithTool("apply_patch", JSON.stringify({ patch }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("src/bar.ts");
  });

  it("default: joins first two input key values", () => {
    const session = sessionWithTool("custom_tool", JSON.stringify({ foo: "bar", baz: "qux", extra: "ignored" }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("bar, qux");
  });

  it("default: returns (no input) for empty args object", () => {
    const session = sessionWithTool("custom_tool", JSON.stringify({}));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("(no input)");
  });

  it("truncates values longer than 120 chars with …", () => {
    const longPath = "/".repeat(130);
    const session = sessionWithTool("read_file", JSON.stringify({ path: longPath }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    const summary = assistantMsg!.tool_uses![0].input_summary;
    expect(summary).toHaveLength(121); // 120 + '…'
    expect(summary.endsWith("…")).toBe(true);
  });

  it("handles invalid JSON args by slicing raw string", () => {
    const session = sessionWithTool("exec_command", "not json");
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).toBe("not json");
  });
});

// ── Reasoning / thinking ──────────────────────────────────────────────────────

describe("normalizeCodexSession — reasoning/thinking", () => {
  it("attaches reasoning summaries as thinking to the following assistant message", () => {
    const lines = [
      userMsgLine("question"),
      reasoningLine(["I should think about this", "and also consider that"]),
      assistantMsgLine("my answer"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.thinking).toContain("I should think about this");
    expect(assistantMsg!.thinking).toContain("and also consider that");
  });

  it("omits thinking when noThinking is true", () => {
    const lines = [
      userMsgLine("question"),
      reasoningLine(["private reasoning"]),
      assistantMsgLine("my answer"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }), { noThinking: true });
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.thinking).toBeUndefined();
  });

  it("includes thinking when noThinking is false (default)", () => {
    const lines = [
      userMsgLine("question"),
      reasoningLine(["public reasoning"]),
      assistantMsgLine("my answer"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }), { noThinking: false });
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.thinking).toBe("public reasoning");
  });

  it("joins multiple reasoning summaries with newline", () => {
    const lines = [
      userMsgLine("question"),
      reasoningLine(["thought one", "thought two"]),
      assistantMsgLine("answer"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.thinking).toBe("thought one\nthought two");
  });

  it("skips reasoning entries without summary_text type", () => {
    const line = makeLine("response_item", {
      type: "reasoning",
      summary: [{ type: "other_type", text: "irrelevant" }],
    });
    const lines = [userMsgLine("hi"), line, assistantMsgLine("reply")];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.thinking).toBeUndefined();
  });
});

// ── Username sanitization ─────────────────────────────────────────────────────

describe("normalizeCodexSession — username sanitization", () => {
  it("replaces OS username in user message content", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "testuser", uid: 1, gid: 1, homedir: "/home/testuser", shell: "/bin/bash" });
    const session = normalizeCodexSession(makeRaw({ lines: [userMsgLine("message from testuser")] }));
    expect(session.messages[0].content).not.toContain("testuser");
    expect(session.messages[0].content).toMatch(/user_[0-9a-f]{8}/);
  });

  it("replaces OS username in tool input_summary", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "testuser", uid: 1, gid: 1, homedir: "/home/testuser", shell: "/bin/bash" });
    const lines = [
      userMsgLine("read a file"),
      assistantMsgLine("ok"),
      functionCallLine("read_file", JSON.stringify({ path: "/home/testuser/project/src/index.ts" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_uses![0].input_summary).not.toContain("testuser");
    expect(assistantMsg!.tool_uses![0].input_summary).toMatch(/user_[0-9a-f]{8}/);
  });

  it("replaces extraUsernames in addition to OS username", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "osuser", uid: 1, gid: 1, homedir: "/home/osuser", shell: "/bin/bash" });
    const session = normalizeCodexSession(
      makeRaw({ lines: [userMsgLine("message from extrauser")] }),
      { extraUsernames: ["extrauser"] }
    );
    expect(session.messages[0].content).not.toContain("extrauser");
    expect(session.messages[0].content).toMatch(/user_[0-9a-f]{8}/);
  });

  it("produces a stable hash across calls", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "stableuser", uid: 1, gid: 1, homedir: "/home/stableuser", shell: "/bin/bash" });
    const raw = makeRaw({ lines: [userMsgLine("hello stableuser")] });
    const s1 = normalizeCodexSession(raw);
    const s2 = normalizeCodexSession(raw);
    expect(s1.messages[0].content).toBe(s2.messages[0].content);
  });

  it("replaces username in workspace when cwd contains the username", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "testuser", uid: 1, gid: 1, homedir: "/home/testuser", shell: "/bin/bash" });
    const session = normalizeCodexSession(
      makeRaw({ cwd: "/home/testuser/myproject", lines: [userMsgLine("hi")] })
    );
    expect(session.workspace).not.toContain("testuser");
  });
});

// ── Git branch detection ──────────────────────────────────────────────────────

describe("normalizeCodexSession — git branch", () => {
  it("sets git_branch when execSync returns a branch name", () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("rev-parse")) return "main\n" as any;
      if (c.includes("config user.name")) return "testuser\n" as any;
      if (c.includes("config user.email")) return "testuser@example.com\n" as any;
      throw new Error("no remote");
    });
    const session = normalizeCodexSession(makeRaw({ cwd: "/home/testuser/project", lines: [userMsgLine("hi")] }));
    expect(session.git_branch).toBe("main");
  });

  it("git_branch is undefined when execSync throws", () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not a git repo"); });
    const session = normalizeCodexSession(makeRaw({ cwd: "/tmp/notgit", lines: [userMsgLine("hi")] }));
    expect(session.git_branch).toBeUndefined();
  });

  it("git_branch is undefined when cwd is empty", () => {
    const session = normalizeCodexSession(makeRaw({ cwd: "", lines: [userMsgLine("hi")] }));
    expect(execSync).not.toHaveBeenCalled();
    expect(session.git_branch).toBeUndefined();
  });

  it("sanitizes username in git_branch", () => {
    vi.mocked(userInfo).mockReturnValue({ username: "testuser", uid: 1, gid: 1, homedir: "/home/testuser", shell: "/bin/bash" });
    vi.mocked(execSync).mockReturnValue("feature/testuser-work\n" as any);
    const session = normalizeCodexSession(makeRaw({ cwd: "/home/testuser/proj", lines: [userMsgLine("hi")] }));
    expect(session.git_branch).not.toContain("testuser");
    expect(session.git_branch).toMatch(/user_[0-9a-f]{8}/);
  });

  it("passes cwd to execSync", () => {
    vi.mocked(execSync).mockReturnValue("develop\n" as any);
    normalizeCodexSession(makeRaw({ cwd: "/home/testuser/myrepo", lines: [userMsgLine("hi")] }));
    expect(execSync).toHaveBeenCalledWith(
      "git rev-parse --abbrev-ref HEAD",
      expect.objectContaining({ cwd: "/home/testuser/myrepo" })
    );
  });
});

// ── Timestamps ────────────────────────────────────────────────────────────────

describe("normalizeCodexSession — timestamps", () => {
  it("start_time is the timestamp of the first line", () => {
    const lines = [
      userMsgLine("first", "2026-02-25T08:00:00.000Z"),
      assistantMsgLine("reply", "2026-02-25T08:01:00.000Z"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.start_time).toBe("2026-02-25T08:00:00.000Z");
  });

  it("end_time is the timestamp of the last line", () => {
    const lines = [
      userMsgLine("first", "2026-02-25T08:00:00.000Z"),
      assistantMsgLine("reply", "2026-02-25T08:01:00.000Z"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.end_time).toBe("2026-02-25T08:01:00.000Z");
  });

  it("start_time and end_time are undefined when there are no lines", () => {
    const session = normalizeCodexSession(makeRaw({ lines: [] }));
    expect(session.start_time).toBeUndefined();
    expect(session.end_time).toBeUndefined();
  });
});

// ── Stats counting ────────────────────────────────────────────────────────────

describe("normalizeCodexSession — stats", () => {
  it("counts user_messages correctly", () => {
    const lines = [
      userMsgLine("msg 1"),
      userMsgLine("msg 2"),
      assistantMsgLine("reply"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.stats.user_messages).toBe(2);
  });

  it("counts assistant_messages correctly", () => {
    const lines = [
      userMsgLine("msg"),
      assistantMsgLine("reply 1"),
      userMsgLine("follow-up"),
      assistantMsgLine("reply 2"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.stats.assistant_messages).toBe(2);
  });

  it("counts total tool_uses across all messages", () => {
    const lines = [
      userMsgLine("do stuff"),
      assistantMsgLine("ok"),
      functionCallLine("read_file", JSON.stringify({ path: "/a.ts" }), "call_1"),
      functionCallLine("write_file", JSON.stringify({ path: "/b.ts" }), "call_2"),
      userMsgLine("more"),
      assistantMsgLine("sure"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "npm test" }), "call_3"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.stats.tool_uses).toBe(3);
  });
});

// ── Files touched ─────────────────────────────────────────────────────────────

describe("normalizeCodexSession — files touched", () => {
  it("collects files from read_file tool calls", () => {
    const lines = [
      userMsgLine("read"),
      assistantMsgLine("ok"),
      functionCallLine("read_file", JSON.stringify({ path: "/src/index.ts" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.metadata.files_touched).toContain("/src/index.ts");
  });

  it("collects files from write_file tool calls", () => {
    const lines = [
      userMsgLine("write"),
      assistantMsgLine("ok"),
      functionCallLine("write_file", JSON.stringify({ path: "/out/bundle.js" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.metadata.files_touched).toContain("/out/bundle.js");
  });

  it("collects files from apply_patch tool calls", () => {
    const patch = "*** src/foo.ts\n--- src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const lines = [
      userMsgLine("patch"),
      assistantMsgLine("ok"),
      functionCallLine("apply_patch", JSON.stringify({ patch }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.metadata.files_touched).toContain("src/foo.ts");
  });

  it("does not collect files from exec_command tool calls", () => {
    const lines = [
      userMsgLine("run"),
      assistantMsgLine("ok"),
      functionCallLine("exec_command", JSON.stringify({ cmd: "npm test" }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.metadata.files_touched).toHaveLength(0);
  });

  it("deduplicates repeated file paths", () => {
    const lines = [
      userMsgLine("read twice"),
      assistantMsgLine("ok"),
      functionCallLine("read_file", JSON.stringify({ path: "/src/index.ts" }), "call_1"),
      functionCallLine("read_file", JSON.stringify({ path: "/src/index.ts" }), "call_2"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    const count = session.metadata.files_touched.filter((f) => f === "/src/index.ts").length;
    expect(count).toBe(1);
  });

  it("excludes truncated summaries (containing …) from files touched", () => {
    const longPath = "/".repeat(130);
    const lines = [
      userMsgLine("read long"),
      assistantMsgLine("ok"),
      functionCallLine("read_file", JSON.stringify({ path: longPath }), "call_1"),
    ];
    const session = normalizeCodexSession(makeRaw({ lines }));
    expect(session.metadata.files_touched).toHaveLength(0);
  });
});
