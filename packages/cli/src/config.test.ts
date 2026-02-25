import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises");
vi.mock("os");

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { homedir } from "os";
import { getConfigDir, getConfigPath, getStatePath, loadConfig, saveConfig } from "./config.js";
import { DEFAULT_CONFIG } from "@tokenxtractor/core";
import type { TokenXtractorConfig } from "@tokenxtractor/core";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(homedir).mockReturnValue("/home/testuser");
});

// ── Path helpers ──────────────────────────────────────────────────────────────

describe("getConfigDir", () => {
  it("returns /home/testuser/.tokenxtractor", () => {
    expect(getConfigDir()).toBe("/home/testuser/.tokenxtractor");
  });
});

describe("getConfigPath", () => {
  it("returns /home/testuser/.tokenxtractor/config.json", () => {
    expect(getConfigPath()).toBe("/home/testuser/.tokenxtractor/config.json");
  });
});

describe("getStatePath", () => {
  it("returns /home/testuser/.tokenxtractor/state.json", () => {
    expect(getStatePath()).toBe("/home/testuser/.tokenxtractor/state.json");
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG when file does not exist (readFile rejects)", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    const config = await loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns DEFAULT_CONFIG when JSON is malformed", async () => {
    vi.mocked(readFile).mockResolvedValue("not valid json" as any);
    const config = await loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial override: destination overrides DEFAULT_CONFIG.destination", async () => {
    const partial: Partial<TokenXtractorConfig> = { destination: "huggingface" };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(partial) as any);
    const config = await loadConfig();
    expect(config.destination).toBe("huggingface");
    // Other defaults preserved
    expect(config.redaction).toEqual(DEFAULT_CONFIG.redaction);
    expect(config.watchPaths).toEqual(DEFAULT_CONFIG.watchPaths);
  });

  it("deep-merges partial redaction override with DEFAULT_CONFIG.redaction", async () => {
    const partial: Partial<TokenXtractorConfig> = {
      redaction: { enabled: false, customPatterns: [], redactUsernames: [], redactStrings: [] },
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(partial) as any);
    const config = await loadConfig();
    expect(config.redaction.enabled).toBe(false);
    // Other redaction fields from DEFAULT_CONFIG preserved
    expect(config.redaction.customPatterns).toEqual([]);
  });

  it("deep-merges partial redaction (only enabled specified)", async () => {
    const partial = { redaction: { enabled: false } };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(partial) as any);
    const config = await loadConfig();
    expect(config.redaction.enabled).toBe(false);
    expect(config.redaction.customPatterns).toEqual(DEFAULT_CONFIG.redaction.customPatterns);
    expect(config.redaction.redactUsernames).toEqual(DEFAULT_CONFIG.redaction.redactUsernames);
  });

  it("returns the full config when file is a complete valid config", async () => {
    const fullConfig: TokenXtractorConfig = {
      destination: "both",
      github: { token: "ghp_token", repo: "owner/repo" },
      huggingface: { token: "hf_token", repo: "owner/dataset" },
      watchPaths: ["~/custom/path"],
      redaction: {
        enabled: true,
        customPatterns: ["SECRET-\\d+"],
        redactUsernames: ["alice"],
        redactStrings: ["my-company-internal"],
      },
      exclude: ["old-session-id"],
      noThinking: true,
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(fullConfig) as any);
    const config = await loadConfig();
    expect(config.destination).toBe("both");
    expect(config.github?.token).toBe("ghp_token");
    expect(config.huggingface?.repo).toBe("owner/dataset");
    expect(config.noThinking).toBe(true);
    expect(config.exclude).toEqual(["old-session-id"]);
    expect(config.redaction.customPatterns).toEqual(["SECRET-\\d+"]);
  });

  it("returns a copy (not the exact DEFAULT_CONFIG reference)", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig();
    expect(config).not.toBe(DEFAULT_CONFIG);
  });
});

// ── saveConfig ────────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(chmod).mockResolvedValue(undefined);
  });

  it("calls mkdir with the config directory and { recursive: true }", async () => {
    await saveConfig(DEFAULT_CONFIG);
    expect(mkdir).toHaveBeenCalledWith(
      "/home/testuser/.tokenxtractor",
      { recursive: true }
    );
  });

  it("calls writeFile with the config path and utf8 encoding", async () => {
    await saveConfig(DEFAULT_CONFIG);
    expect(writeFile).toHaveBeenCalledWith(
      "/home/testuser/.tokenxtractor/config.json",
      expect.any(String),
      "utf8"
    );
  });

  it("writes pretty-printed JSON (contains newlines)", async () => {
    await saveConfig(DEFAULT_CONFIG);
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(written).toContain("\n");
  });

  it("written JSON round-trips back to the config", async () => {
    const config: TokenXtractorConfig = {
      ...DEFAULT_CONFIG,
      destination: "huggingface",
      noThinking: true,
    };
    await saveConfig(config);
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.destination).toBe("huggingface");
    expect(parsed.noThinking).toBe(true);
  });

  it("calls chmod with the config path and 0o600", async () => {
    await saveConfig(DEFAULT_CONFIG);
    expect(chmod).toHaveBeenCalledWith(
      "/home/testuser/.tokenxtractor/config.json",
      0o600
    );
  });

  it("calls mkdir before writeFile (order matters for directory creation)", async () => {
    const callOrder: string[] = [];
    vi.mocked(mkdir).mockImplementation(async () => {
      callOrder.push("mkdir");
      return undefined;
    });
    vi.mocked(writeFile).mockImplementation(async () => {
      callOrder.push("writeFile");
    });
    vi.mocked(chmod).mockImplementation(async () => {
      callOrder.push("chmod");
    });

    await saveConfig(DEFAULT_CONFIG);

    expect(callOrder[0]).toBe("mkdir");
    expect(callOrder[1]).toBe("writeFile");
    expect(callOrder[2]).toBe("chmod");
  });
});
