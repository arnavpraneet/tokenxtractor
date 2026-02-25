import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import * as readline from "readline";
import { CodexLineSchema, RawCodexSession } from "../schema.js";

/**
 * Parse a single Codex JSONL file into typed lines.
 * Lines that fail schema validation are silently skipped.
 */
async function parseCodexFile(filePath: string): Promise<RawCodexSession["lines"]> {
  const lines: RawCodexSession["lines"] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const result = CodexLineSchema.safeParse(parsed);
      if (result.success) {
        lines.push(result.data);
      }
    } catch {
      // skip malformed lines
    }
  }

  return lines;
}

/**
 * Extract the UUID session ID from a Codex filename.
 * Filename format: rollout-2026-02-25T08-11-26-019c93da-57c3-78f1-b9e7-8b42dce50db4.jsonl
 * The UUID is the last 5 hyphen-delimited segments (UUID v7 with 5 groups).
 */
function extractSessionId(filename: string): string {
  const stem = basename(filename, ".jsonl");
  const parts = stem.split("-");
  if (parts.length >= 5) {
    return parts.slice(-5).join("-");
  }
  return stem;
}

/**
 * Scan a Codex sessions directory and return all sessions.
 * Directory structure: <sessionsDir>/YYYY/MM/DD/<name>-<uuid>.jsonl
 */
export async function detectCodexSessions(
  sessionsDir: string
): Promise<RawCodexSession[]> {
  const sessions: RawCodexSession[] = [];

  let yearDirs: string[];
  try {
    yearDirs = await readdir(sessionsDir);
  } catch {
    return sessions;
  }

  for (const year of yearDirs) {
    const yearPath = join(sessionsDir, year);
    if (!(await stat(yearPath).then((s) => s.isDirectory()).catch(() => false))) continue;

    let monthDirs: string[];
    try {
      monthDirs = await readdir(yearPath);
    } catch {
      continue;
    }

    for (const month of monthDirs) {
      const monthPath = join(yearPath, month);
      if (!(await stat(monthPath).then((s) => s.isDirectory()).catch(() => false))) continue;

      let dayDirs: string[];
      try {
        dayDirs = await readdir(monthPath);
      } catch {
        continue;
      }

      for (const day of dayDirs) {
        const dayPath = join(monthPath, day);
        if (!(await stat(dayPath).then((s) => s.isDirectory()).catch(() => false))) continue;

        let files: string[];
        try {
          files = await readdir(dayPath);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(dayPath, file);
          const sessionId = extractSessionId(file);

          const lines = await parseCodexFile(filePath);
          if (lines.length === 0) continue;

          // Extract metadata from session_meta and first turn_context lines
          let cwd = "";
          let model: string | undefined;
          let cli_version: string | undefined;

          for (const line of lines) {
            if (line.type === "session_meta") {
              const p = line.payload as Record<string, unknown>;
              if (typeof p.cwd === "string") cwd = p.cwd;
              if (typeof p.cli_version === "string") cli_version = p.cli_version;
            } else if (line.type === "turn_context" && !model) {
              const p = line.payload as Record<string, unknown>;
              if (typeof p.model === "string") model = p.model;
            }
            if (cwd && model && cli_version) break;
          }

          sessions.push({ sessionId, filePath, cwd, model, cli_version, lines });
        }
      }
    }
  }

  return sessions;
}
