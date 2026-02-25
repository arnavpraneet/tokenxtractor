import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("readline");
vi.mock("fs/promises");
vi.mock("os");

import { createReadStream } from "fs";
import * as readline from "readline";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { parseJsonlFile, detectSessions, expandHome } from "./claudeCode.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mock readline.createInterface to yield the given lines as async iterable */
function mockLines(...lines: string[]): void {
  vi.mocked(readline.createInterface).mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      for (const line of lines) {
        yield line;
      }
    },
  } as unknown as ReturnType<typeof readline.createInterface>);
}

/** A minimal valid RawMessage in JSON */
const VALID_USER_MSG = JSON.stringify({
  type: "user",
  message: { content: "hello" },
});

const VALID_ASSISTANT_MSG = JSON.stringify({
  type: "assistant",
  message: { content: "hi there", role: "assistant" },
});

const VALID_SYSTEM_MSG = JSON.stringify({
  type: "system",
  message: { content: "system prompt" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(homedir).mockReturnValue("/home/testuser");
  // Default: createReadStream returns a dummy object (readline is mocked anyway)
  vi.mocked(createReadStream).mockReturnValue({} as ReturnType<typeof createReadStream>);
});

// ── expandHome ────────────────────────────────────────────────────────────────

describe("expandHome", () => {
  it("expands ~ alone to homedir()", () => {
    expect(expandHome("~")).toBe("/home/testuser");
  });

  it("expands ~/foo/bar to homedir()/foo/bar", () => {
    expect(expandHome("~/foo/bar")).toBe("/home/testuser/foo/bar");
  });

  it("returns path unchanged when it does not start with ~", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("relative/path")).toBe("relative/path");
  });

  it("does not expand ~word (tilde not followed by /)", () => {
    expect(expandHome("~foo/bar")).toBe("~foo/bar");
  });
});

// ── parseJsonlFile ────────────────────────────────────────────────────────────

describe("parseJsonlFile", () => {
  it("parses valid RawMessage lines and returns them", async () => {
    mockLines(VALID_USER_MSG, VALID_ASSISTANT_MSG);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe("user");
    expect(messages[1].type).toBe("assistant");
  });

  it("skips blank lines without error", async () => {
    mockLines(VALID_USER_MSG, "", "   ", VALID_ASSISTANT_MSG);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(2);
  });

  it("skips invalid JSON lines without throwing", async () => {
    mockLines(VALID_USER_MSG, "not valid json {{{{", VALID_ASSISTANT_MSG);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(2);
  });

  it("skips valid JSON that fails RawMessageSchema (missing type)", async () => {
    const invalidMsg = JSON.stringify({ message: { content: "hello" } });
    mockLines(VALID_USER_MSG, invalidMsg);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("user");
  });

  it("skips valid JSON with an invalid type enum value", async () => {
    const invalidType = JSON.stringify({ type: "unknown", message: { content: "hi" } });
    mockLines(VALID_USER_MSG, invalidType);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(1);
  });

  it("handles a mix: 1 valid, 1 blank, 1 invalid JSON → returns array of length 1", async () => {
    mockLines(VALID_USER_MSG, "", "{ bad json");
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(1);
  });

  it("returns empty array when all lines are invalid", async () => {
    mockLines("{ bad", "also bad", "");
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(0);
  });

  it("parses system type messages", async () => {
    mockLines(VALID_SYSTEM_MSG);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("system");
  });

  it("preserves optional fields like isMeta, cwd, timestamp", async () => {
    const fullMsg = JSON.stringify({
      type: "user",
      isMeta: true,
      cwd: "/home/testuser/project",
      timestamp: "2024-01-01T10:00:00.000Z",
      message: { content: "meta msg" },
    });
    mockLines(fullMsg);
    const messages = await parseJsonlFile("/fake/path.jsonl");
    expect(messages).toHaveLength(1);
    expect(messages[0].isMeta).toBe(true);
    expect(messages[0].cwd).toBe("/home/testuser/project");
  });
});

// ── detectSessions ────────────────────────────────────────────────────────────

describe("detectSessions", () => {
  it("returns empty array when readdir throws (directory does not exist)", async () => {
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const sessions = await detectSessions("/nonexistent");
    expect(sessions).toEqual([]);
  });

  it("skips entries that are not directories", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["notadir.txt"] as any)  // project dirs listing
    vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => false } as any);
    mockLines(); // no messages needed
    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(0);
  });

  it("skips non-.jsonl files within a project directory", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["myproject"] as any)
      .mockResolvedValueOnce(["notes.txt", "data.json"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(0);
  });

  it("skips .jsonl files that yield zero valid messages", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["myproject"] as any)
      .mockResolvedValueOnce(["session-abc.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    // All lines invalid → no messages
    mockLines("invalid json");
    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(0);
  });

  it("returns a RawSession for a valid project dir with a valid .jsonl file", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["myproject"] as any)
      .mockResolvedValueOnce(["session-abc-123.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(VALID_USER_MSG);
    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("session-abc-123");
    expect(sessions[0].projectName).toBe("myproject");
    expect(sessions[0].messages).toHaveLength(1);
  });

  it("sets filePath to the full path of the .jsonl file", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["-home-user-dev-proj"] as any)
      .mockResolvedValueOnce(["sess-xyz.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(VALID_USER_MSG);
    const sessions = await detectSessions("/projects");
    expect(sessions[0].filePath).toBe("/projects/-home-user-dev-proj/sess-xyz.jsonl");
  });

  it("handles multiple project directories with multiple .jsonl files", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["project-a", "project-b"] as any)
      .mockResolvedValueOnce(["sess-1.jsonl", "sess-2.jsonl"] as any)
      .mockResolvedValueOnce(["sess-3.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    // Each call to parseJsonlFile returns one message — mockLines called 3 times
    vi.mocked(readline.createInterface)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () { yield VALID_USER_MSG; },
      } as unknown as ReturnType<typeof readline.createInterface>)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () { yield VALID_USER_MSG; },
      } as unknown as ReturnType<typeof readline.createInterface>)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () { yield VALID_USER_MSG; },
      } as unknown as ReturnType<typeof readline.createInterface>);

    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(3);
    const sessionIds = sessions.map((s) => s.sessionId);
    expect(sessionIds).toContain("sess-1");
    expect(sessionIds).toContain("sess-2");
    expect(sessionIds).toContain("sess-3");
  });

  it("handles readdir failure on a specific project directory gracefully (skips it)", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["bad-project", "good-project"] as any)
      .mockRejectedValueOnce(new Error("Permission denied")) // bad-project
      .mockResolvedValueOnce(["sess.jsonl"] as any);          // good-project
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(VALID_USER_MSG);
    const sessions = await detectSessions("/projects");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectName).toBe("good-project");
  });
});
