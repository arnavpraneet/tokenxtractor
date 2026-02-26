import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process");
vi.mock("os");

import { execSync } from "child_process";
import { userInfo } from "os";
import { detectUsernames } from "./usernameDetector.js";

function mockUserInfo(username = "osuser", homedir = "/home/osuser") {
  vi.mocked(userInfo).mockReturnValue({
    username,
    homedir,
    uid: 1000,
    gid: 1000,
    shell: "/bin/bash",
  });
}

function mockGit(responses: Record<string, string | Error>) {
  vi.mocked(execSync).mockImplementation((cmd: unknown) => {
    const cmdStr = String(cmd);
    for (const [key, val] of Object.entries(responses)) {
      if (cmdStr.includes(key)) {
        if (val instanceof Error) throw val;
        return val as any;
      }
    }
    throw new Error(`unexpected git command: ${cmdStr}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserInfo();
});

// ── Always-included values ────────────────────────────────────────────────────

describe("detectUsernames — always-included values", () => {
  it("always includes OS username", () => {
    mockUserInfo("alice", "/home/alice");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const names = detectUsernames();
    expect(names).toContain("alice");
  });

  it("always includes homedir", () => {
    mockUserInfo("alice", "/home/alice");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const names = detectUsernames();
    expect(names).toContain("/home/alice");
  });

  it("works with no cwd (no git commands run)", () => {
    mockUserInfo("nouser", "/home/nouser");
    const names = detectUsernames();
    expect(execSync).not.toHaveBeenCalled();
    expect(names).toContain("nouser");
    expect(names).toContain("/home/nouser");
  });
});

// ── Git config detection ──────────────────────────────────────────────────────

describe("detectUsernames — git config", () => {
  it("includes git user.name when it differs from OS username", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "Alice Smith\n",
      "config user.email": "alice@example.com\n",
      "remote get-url origin": new Error("no remote"),
    });
    const names = detectUsernames("/some/cwd");
    expect(names).toContain("Alice Smith");
  });

  it("includes local part of git user.email", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "osuser\n",
      "config user.email": "mygithub@users.noreply.github.com\n",
      "remote get-url origin": new Error("no remote"),
    });
    const names = detectUsernames("/some/cwd");
    expect(names).toContain("mygithub");
  });

  it("gracefully handles git config user.name failure", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": new Error("not configured"),
      "config user.email": new Error("not configured"),
      "remote get-url origin": new Error("no remote"),
    });
    const names = detectUsernames("/some/cwd");
    // Should still return OS username and homedir
    expect(names).toContain("osuser");
    expect(names).toContain("/home/osuser");
  });
});

// ── GitHub handle detection from remote URL ───────────────────────────────────

describe("detectUsernames — GitHub handle from remote URL", () => {
  it("extracts handle from HTTPS remote URL", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "osuser\n",
      "config user.email": "osuser@example.com\n",
      "remote get-url origin": "https://github.com/myhandle/myrepo.git\n",
    });
    const names = detectUsernames("/some/cwd");
    expect(names).toContain("myhandle");
  });

  it("extracts handle from SSH remote URL (git@github.com:USER/repo)", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "osuser\n",
      "config user.email": "osuser@example.com\n",
      "remote get-url origin": "git@github.com:myhandle/myrepo.git\n",
    });
    const names = detectUsernames("/some/cwd");
    expect(names).toContain("myhandle");
  });

  it("gracefully handles no remote", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "osuser\n",
      "config user.email": "osuser@example.com\n",
      "remote get-url origin": new Error("fatal: No such remote 'origin'"),
    });
    const names = detectUsernames("/some/cwd");
    expect(names).toContain("osuser");
    expect(names).not.toContain(undefined);
  });

  it("does not extract handle from non-GitHub remote URLs", () => {
    mockUserInfo("osuser", "/home/osuser");
    mockGit({
      "config user.name": "osuser\n",
      "config user.email": "osuser@example.com\n",
      "remote get-url origin": "https://gitlab.com/myhandle/repo.git\n",
    });
    const names = detectUsernames("/some/cwd");
    // myhandle is from a GitLab URL, should NOT be extracted
    expect(names).not.toContain("myhandle");
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe("detectUsernames — deduplication", () => {
  it("deduplicates when OS username equals git user.name", () => {
    mockUserInfo("alice", "/home/alice");
    mockGit({
      "config user.name": "alice\n",
      "config user.email": "alice@example.com\n",
      "remote get-url origin": new Error("no remote"),
    });
    const names = detectUsernames("/some/cwd");
    const count = names.filter((n) => n === "alice").length;
    expect(count).toBe(1);
  });

  it("deduplicates extra usernames that match auto-detected ones", () => {
    mockUserInfo("alice", "/home/alice");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const names = detectUsernames(undefined, ["alice", "alice"]);
    const count = names.filter((n) => n === "alice").length;
    expect(count).toBe(1);
  });
});

// ── Extra usernames ───────────────────────────────────────────────────────────

describe("detectUsernames — extra usernames from config", () => {
  it("includes extra usernames in the result", () => {
    mockUserInfo("osuser", "/home/osuser");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const names = detectUsernames(undefined, ["myhandle", "workuser"]);
    expect(names).toContain("myhandle");
    expect(names).toContain("workuser");
  });

  it("filters out empty extra usernames", () => {
    mockUserInfo("osuser", "/home/osuser");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("no git"); });
    const names = detectUsernames(undefined, ["", "  ", "valid"]);
    expect(names).toContain("valid");
    // empty / whitespace-only should not be in list
    expect(names).not.toContain("");
    expect(names).not.toContain("  ");
  });
});
