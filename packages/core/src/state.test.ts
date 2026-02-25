import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises");

import { readFile, writeFile, mkdir } from "fs/promises";
import {
  loadState,
  saveState,
  isUploaded,
  recordUpload,
  getUploadedSessionIds,
  addPendingConfirmation,
  isPendingConfirmation,
  isConfirmed,
  confirmSessions,
  clearConfirmed,
} from "./state.js";
import type { UploadRecord, UploadState, PendingConfirmation } from "./schema.js";

const EMPTY_STATE: UploadState = { version: 1, uploads: [] };

function makeRecord(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    sessionId: "session-abc",
    uploadedAt: "2024-01-01T00:00:00.000Z",
    destination: "github",
    paths: ["2024/01/01/claude-code_abc.json"],
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingConfirmation> = {}): PendingConfirmation {
  return {
    sessionId: "session-abc",
    exportedAt: "2024-01-01T00:00:00.000Z",
    localPath: "/tmp/claude-code_abc.json",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── loadState ─────────────────────────────────────────────────────────────────

describe("loadState", () => {
  it("returns empty state when file does not exist (readFile throws)", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const state = await loadState("/some/path/state.json");
    expect(state).toEqual(EMPTY_STATE);
  });

  it("returns empty state when JSON is malformed", async () => {
    vi.mocked(readFile).mockResolvedValue("not valid json {{{{" as any);
    const state = await loadState("/some/path/state.json");
    expect(state).toEqual(EMPTY_STATE);
  });

  it("returns empty state when parsed object has no version field", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ uploads: [] }) as any);
    const state = await loadState("/some/path/state.json");
    expect(state).toEqual(EMPTY_STATE);
  });

  it("returns the parsed state when file exists and is valid", async () => {
    const stored: UploadState = {
      version: 1,
      uploads: [makeRecord()],
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(stored) as any);
    const state = await loadState("/some/path/state.json");
    expect(state).toEqual(stored);
  });

  it("preserves optional pendingConfirmation field", async () => {
    const stored: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending()],
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(stored) as any);
    const state = await loadState("/some/path/state.json");
    expect(state.pendingConfirmation).toHaveLength(1);
    expect(state.pendingConfirmation![0].sessionId).toBe("session-abc");
  });

  it("preserves optional confirmedForUpload field", async () => {
    const stored: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["session-abc", "session-def"],
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(stored) as any);
    const state = await loadState("/some/path/state.json");
    expect(state.confirmedForUpload).toEqual(["session-abc", "session-def"]);
  });
});

// ── saveState ─────────────────────────────────────────────────────────────────

describe("saveState", () => {
  it("calls mkdir with the dirname of the path and { recursive: true }", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    await saveState("/home/user/.tokenxtractor/state.json", EMPTY_STATE);
    expect(mkdir).toHaveBeenCalledWith("/home/user/.tokenxtractor", { recursive: true });
  });

  it("calls writeFile with the state path and utf8 encoding", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const state: UploadState = { version: 1, uploads: [makeRecord()] };
    await saveState("/home/user/.tokenxtractor/state.json", state);
    expect(writeFile).toHaveBeenCalledWith(
      "/home/user/.tokenxtractor/state.json",
      expect.any(String),
      "utf8"
    );
  });

  it("writes pretty-printed JSON", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    await saveState("/tmp/state.json", EMPTY_STATE);
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(written).toContain("\n");
    expect(JSON.parse(written)).toEqual(EMPTY_STATE);
  });
});

// ── isUploaded ────────────────────────────────────────────────────────────────

describe("isUploaded", () => {
  it("returns false for empty uploads array", () => {
    expect(isUploaded(EMPTY_STATE, "session-abc", "github")).toBe(false);
  });

  it("returns false when session exists but destination differs", () => {
    const state: UploadState = { version: 1, uploads: [makeRecord({ destination: "github" })] };
    expect(isUploaded(state, "session-abc", "huggingface")).toBe(false);
  });

  it("returns false when destination matches but session ID differs", () => {
    const state: UploadState = { version: 1, uploads: [makeRecord({ sessionId: "other-session" })] };
    expect(isUploaded(state, "session-abc", "github")).toBe(false);
  });

  it("returns true when both session ID and destination match", () => {
    const state: UploadState = { version: 1, uploads: [makeRecord()] };
    expect(isUploaded(state, "session-abc", "github")).toBe(true);
  });

  it("returns true when match exists alongside other uploads", () => {
    const state: UploadState = {
      version: 1,
      uploads: [
        makeRecord({ sessionId: "other-session" }),
        makeRecord({ sessionId: "session-abc" }),
      ],
    };
    expect(isUploaded(state, "session-abc", "github")).toBe(true);
  });
});

// ── recordUpload ──────────────────────────────────────────────────────────────

describe("recordUpload", () => {
  it("adds a new record to an empty state", () => {
    const record = makeRecord();
    const newState = recordUpload(EMPTY_STATE, record);
    expect(newState.uploads).toHaveLength(1);
    expect(newState.uploads[0]).toEqual(record);
  });

  it("deduplicates: replacing existing record for same session+destination", () => {
    const old = makeRecord({ uploadedAt: "2024-01-01T00:00:00.000Z" });
    const state: UploadState = { version: 1, uploads: [old] };
    const updated = makeRecord({ uploadedAt: "2024-06-01T00:00:00.000Z" });
    const newState = recordUpload(state, updated);
    expect(newState.uploads).toHaveLength(1);
    expect(newState.uploads[0].uploadedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("does not mutate the original state", () => {
    const state: UploadState = { version: 1, uploads: [] };
    recordUpload(state, makeRecord());
    expect(state.uploads).toHaveLength(0);
  });

  it("keeps records for different destinations (no cross-destination dedup)", () => {
    const ghRecord = makeRecord({ destination: "github" });
    const hfRecord = makeRecord({ destination: "huggingface" });
    let state: UploadState = { version: 1, uploads: [] };
    state = recordUpload(state, ghRecord);
    state = recordUpload(state, hfRecord);
    expect(state.uploads).toHaveLength(2);
  });

  it("keeps records for different session IDs", () => {
    const rec1 = makeRecord({ sessionId: "session-1" });
    const rec2 = makeRecord({ sessionId: "session-2" });
    let state: UploadState = { version: 1, uploads: [] };
    state = recordUpload(state, rec1);
    state = recordUpload(state, rec2);
    expect(state.uploads).toHaveLength(2);
  });
});

// ── getUploadedSessionIds ─────────────────────────────────────────────────────

describe("getUploadedSessionIds", () => {
  it("returns empty Set for empty uploads", () => {
    const ids = getUploadedSessionIds(EMPTY_STATE, "github");
    expect(ids.size).toBe(0);
  });

  it("returns only IDs matching the given destination", () => {
    const state: UploadState = {
      version: 1,
      uploads: [
        makeRecord({ sessionId: "session-gh", destination: "github" }),
        makeRecord({ sessionId: "session-hf", destination: "huggingface" }),
      ],
    };
    const ghIds = getUploadedSessionIds(state, "github");
    expect(ghIds).toContain("session-gh");
    expect(ghIds).not.toContain("session-hf");
    expect(ghIds.size).toBe(1);
  });

  it("returns a Set (deduplicates duplicate session IDs for same destination)", () => {
    const state: UploadState = {
      version: 1,
      uploads: [
        makeRecord({ sessionId: "session-abc" }),
        makeRecord({ sessionId: "session-abc" }), // duplicate
      ],
    };
    const ids = getUploadedSessionIds(state, "github");
    expect(ids.size).toBe(1);
  });
});

// ── addPendingConfirmation ────────────────────────────────────────────────────

describe("addPendingConfirmation", () => {
  it("adds to a state with no pendingConfirmation field (undefined)", () => {
    const newState = addPendingConfirmation(EMPTY_STATE, makePending());
    expect(newState.pendingConfirmation).toHaveLength(1);
    expect(newState.pendingConfirmation![0].sessionId).toBe("session-abc");
  });

  it("is idempotent: updating existing record for same sessionId (length stays 1)", () => {
    let state = addPendingConfirmation(EMPTY_STATE, makePending({ localPath: "/tmp/old.json" }));
    state = addPendingConfirmation(state, makePending({ localPath: "/tmp/new.json" }));
    expect(state.pendingConfirmation).toHaveLength(1);
    expect(state.pendingConfirmation![0].localPath).toBe("/tmp/new.json");
  });

  it("does not affect records for other session IDs", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending({ sessionId: "other-session" })],
    };
    const newState = addPendingConfirmation(state, makePending({ sessionId: "session-abc" }));
    expect(newState.pendingConfirmation).toHaveLength(2);
  });

  it("does not mutate the original state", () => {
    const state: UploadState = { version: 1, uploads: [] };
    addPendingConfirmation(state, makePending());
    expect(state.pendingConfirmation).toBeUndefined();
  });
});

// ── isPendingConfirmation ─────────────────────────────────────────────────────

describe("isPendingConfirmation", () => {
  it("returns false when pendingConfirmation is undefined", () => {
    expect(isPendingConfirmation(EMPTY_STATE, "session-abc")).toBe(false);
  });

  it("returns false when session is not in the list", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending({ sessionId: "other" })],
    };
    expect(isPendingConfirmation(state, "session-abc")).toBe(false);
  });

  it("returns true when session is in the list", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending()],
    };
    expect(isPendingConfirmation(state, "session-abc")).toBe(true);
  });
});

// ── isConfirmed ───────────────────────────────────────────────────────────────

describe("isConfirmed", () => {
  it("returns false when confirmedForUpload is undefined", () => {
    expect(isConfirmed(EMPTY_STATE, "session-abc")).toBe(false);
  });

  it("returns false when session is not in the confirmed list", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["other-session"],
    };
    expect(isConfirmed(state, "session-abc")).toBe(false);
  });

  it("returns true when session is in the confirmed list", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["session-abc"],
    };
    expect(isConfirmed(state, "session-abc")).toBe(true);
  });
});

// ── confirmSessions ───────────────────────────────────────────────────────────

describe("confirmSessions", () => {
  it("moves sessions from pendingConfirmation to confirmedForUpload", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending(), makePending({ sessionId: "session-xyz" })],
    };
    const newState = confirmSessions(state, ["session-abc"]);
    expect(newState.pendingConfirmation).toHaveLength(1);
    expect(newState.pendingConfirmation![0].sessionId).toBe("session-xyz");
    expect(newState.confirmedForUpload).toContain("session-abc");
  });

  it("sessions not in the confirmed IDs list remain in pendingConfirmation", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [
        makePending({ sessionId: "sess-1" }),
        makePending({ sessionId: "sess-2" }),
      ],
    };
    const newState = confirmSessions(state, ["sess-1"]);
    expect(newState.pendingConfirmation).toHaveLength(1);
    expect(newState.pendingConfirmation![0].sessionId).toBe("sess-2");
  });

  it("is idempotent: confirming an already-confirmed session does not duplicate it", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["session-abc"],
    };
    const newState = confirmSessions(state, ["session-abc"]);
    expect(newState.confirmedForUpload!.filter((id) => id === "session-abc")).toHaveLength(1);
  });

  it("works when confirmedForUpload was previously undefined", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending()],
    };
    const newState = confirmSessions(state, ["session-abc"]);
    expect(newState.confirmedForUpload).toContain("session-abc");
  });

  it("does not mutate the original state", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      pendingConfirmation: [makePending()],
    };
    const originalLength = state.pendingConfirmation!.length;
    confirmSessions(state, ["session-abc"]);
    expect(state.pendingConfirmation).toHaveLength(originalLength);
  });
});

// ── clearConfirmed ────────────────────────────────────────────────────────────

describe("clearConfirmed", () => {
  it("removes the session from confirmedForUpload", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["session-abc", "session-xyz"],
    };
    const newState = clearConfirmed(state, "session-abc");
    expect(newState.confirmedForUpload).not.toContain("session-abc");
    expect(newState.confirmedForUpload).toContain("session-xyz");
  });

  it("is safe when session is not in confirmedForUpload (no error)", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["session-xyz"],
    };
    expect(() => clearConfirmed(state, "session-abc")).not.toThrow();
    const newState = clearConfirmed(state, "session-abc");
    expect(newState.confirmedForUpload).toContain("session-xyz");
  });

  it("works when confirmedForUpload is undefined", () => {
    expect(() => clearConfirmed(EMPTY_STATE, "session-abc")).not.toThrow();
    const newState = clearConfirmed(EMPTY_STATE, "session-abc");
    expect(newState.confirmedForUpload).toEqual([]);
  });

  it("does not affect other entries in confirmedForUpload", () => {
    const state: UploadState = {
      version: 1,
      uploads: [],
      confirmedForUpload: ["sess-1", "sess-2", "sess-3"],
    };
    const newState = clearConfirmed(state, "sess-2");
    expect(newState.confirmedForUpload).toEqual(["sess-1", "sess-3"]);
  });
});
