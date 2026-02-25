import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("readline");
vi.mock("fs/promises");

import { createReadStream } from "fs";
import * as readline from "readline";
import { readdir, stat } from "fs/promises";
import { detectCodexSessions } from "./codex.js";

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

/** A valid session_meta line */
const SESSION_META = JSON.stringify({
  timestamp: "2026-02-25T08:00:00.000Z",
  type: "session_meta",
  payload: { cwd: "/home/testuser/project", cli_version: "1.2.3" },
});

/** A valid turn_context line with model info */
const TURN_CONTEXT = JSON.stringify({
  timestamp: "2026-02-25T08:00:01.000Z",
  type: "turn_context",
  payload: { model: "codex-mini-latest" },
});

/** A valid user event line */
const USER_EVENT = JSON.stringify({
  timestamp: "2026-02-25T08:00:02.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "hello" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createReadStream).mockReturnValue({} as ReturnType<typeof createReadStream>);
});

// ── parseCodexFile (via detectCodexSessions) ──────────────────────────────────

describe("detectCodexSessions — file parsing", () => {
  it("skips blank lines without error", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-2026-02-25T08-11-26-019c93da-57c3-78f1-b9e7-8b42dce50db4.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(SESSION_META, "", "   ", USER_EVENT);

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(1);
  });

  it("skips invalid JSON lines without throwing", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(SESSION_META, "not valid json {{{", USER_EVENT);

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(1);
    // 2 valid lines (SESSION_META + USER_EVENT)
    expect(sessions[0].lines).toHaveLength(2);
  });

  it("skips lines that pass JSON parse but fail CodexLineSchema (missing timestamp)", async () => {
    const missingTimestamp = JSON.stringify({ type: "event_msg", payload: { type: "user_message" } });
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(SESSION_META, missingTimestamp);

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].lines).toHaveLength(1);
  });

  it("returns empty array when a file yields zero valid lines", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines("bad json", "", "also bad");

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(0);
  });
});

// ── extractSessionId (via detectCodexSessions) ────────────────────────────────

describe("detectCodexSessions — session ID extraction", () => {
  function setupSingleFile(filename: string) {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce([filename] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(SESSION_META, USER_EVENT);
  }

  it("extracts the last 5 hyphen-delimited segments as the UUID session ID", async () => {
    setupSingleFile("rollout-2026-02-25T08-11-26-019c93da-57c3-78f1-b9e7-8b42dce50db4.jsonl");
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].sessionId).toBe("019c93da-57c3-78f1-b9e7-8b42dce50db4");
  });

  it("falls back to full stem when filename has fewer than 5 hyphen segments", async () => {
    setupSingleFile("short.jsonl");
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].sessionId).toBe("short");
  });

  it("uses the correct filePath including full directory path", async () => {
    setupSingleFile("rollout-abc-0000-0000-0000-0000-000000000001.jsonl");
    const sessions = await detectCodexSessions("/home/testuser/.codex/sessions");
    expect(sessions[0].filePath).toBe(
      "/home/testuser/.codex/sessions/2026/02/25/rollout-abc-0000-0000-0000-0000-000000000001.jsonl"
    );
  });
});

// ── detectCodexSessions — directory traversal ─────────────────────────────────

describe("detectCodexSessions — directory traversal", () => {
  it("returns empty array when the sessions directory does not exist", async () => {
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const sessions = await detectCodexSessions("/nonexistent");
    expect(sessions).toEqual([]);
  });

  it("skips year entries that are not directories", async () => {
    vi.mocked(readdir).mockResolvedValueOnce(["README.txt"] as any);
    vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => false } as any);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(0);
  });

  it("skips month entries that are not directories", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["notes.txt"] as any);
    vi.mocked(stat)
      .mockResolvedValueOnce({ isDirectory: () => true } as any)  // 2026 is dir
      .mockResolvedValueOnce({ isDirectory: () => false } as any); // notes.txt is not
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(0);
  });

  it("skips day entries that are not directories", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["junk.bin"] as any);
    vi.mocked(stat)
      .mockResolvedValueOnce({ isDirectory: () => true } as any)  // 2026
      .mockResolvedValueOnce({ isDirectory: () => true } as any)  // 02
      .mockResolvedValueOnce({ isDirectory: () => false } as any); // junk.bin
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(0);
  });

  it("skips non-.jsonl files in the day directory", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["notes.txt", "data.json"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(0);
  });

  it("gracefully skips a year directory when readdir throws on it", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2025", "2026"] as any)
      .mockRejectedValueOnce(new Error("Permission denied")) // 2025 months
      .mockResolvedValueOnce(["02"] as any)                  // 2026 months
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(SESSION_META, USER_EVENT);

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(1);
  });

  it("returns sessions from multiple years, months, and days", async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["01", "02"] as any)             // months
      .mockResolvedValueOnce(["31"] as any)                   // jan days
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any)
      .mockResolvedValueOnce(["25"] as any)                   // feb days
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000002.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(readline.createInterface)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () { yield SESSION_META; yield USER_EVENT; },
      } as unknown as ReturnType<typeof readline.createInterface>)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () { yield SESSION_META; yield USER_EVENT; },
      } as unknown as ReturnType<typeof readline.createInterface>);

    const sessions = await detectCodexSessions("/sessions");
    expect(sessions).toHaveLength(2);
  });
});

// ── detectCodexSessions — metadata extraction ────────────────────────────────

describe("detectCodexSessions — metadata extraction", () => {
  function setupWithLines(...lines: string[]) {
    vi.mocked(readdir)
      .mockResolvedValueOnce(["2026"] as any)
      .mockResolvedValueOnce(["02"] as any)
      .mockResolvedValueOnce(["25"] as any)
      .mockResolvedValueOnce(["rollout-abc-0000-0000-0000-0000-000000000001.jsonl"] as any);
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    mockLines(...lines);
  }

  it("extracts cwd from session_meta payload", async () => {
    setupWithLines(SESSION_META, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].cwd).toBe("/home/testuser/project");
  });

  it("extracts cli_version from session_meta payload", async () => {
    setupWithLines(SESSION_META, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].cli_version).toBe("1.2.3");
  });

  it("extracts model from the first turn_context payload", async () => {
    setupWithLines(SESSION_META, TURN_CONTEXT, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].model).toBe("codex-mini-latest");
  });

  it("uses the first turn_context only (ignores subsequent ones)", async () => {
    const secondTurnCtx = JSON.stringify({
      timestamp: "2026-02-25T08:00:05.000Z",
      type: "turn_context",
      payload: { model: "other-model" },
    });
    setupWithLines(SESSION_META, TURN_CONTEXT, secondTurnCtx, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].model).toBe("codex-mini-latest");
  });

  it("model is undefined when no turn_context line exists", async () => {
    setupWithLines(SESSION_META, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].model).toBeUndefined();
  });

  it("cwd is empty string when no session_meta line exists", async () => {
    setupWithLines(USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].cwd).toBe("");
  });

  it("all parsed lines are stored on the session", async () => {
    setupWithLines(SESSION_META, TURN_CONTEXT, USER_EVENT);
    const sessions = await detectCodexSessions("/sessions");
    expect(sessions[0].lines).toHaveLength(3);
  });
});
