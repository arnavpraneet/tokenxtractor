import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import * as readline from "readline";
import { RawMessage, RawMessageSchema } from "../schema.js";

export interface RawSession {
  sessionId: string;
  projectPath: string;
  projectName: string;
  filePath: string;
  messages: RawMessage[];
}

/**
 * Parse a single JSONL file into raw messages.
 * Lines that fail to parse are silently skipped.
 */
export async function parseJsonlFile(filePath: string): Promise<RawMessage[]> {
  const messages: RawMessage[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const result = RawMessageSchema.safeParse(parsed);
      if (result.success) {
        messages.push(result.data);
      }
    } catch {
      // skip malformed lines
    }
  }

  return messages;
}

/**
 * Scan a Claude Code projects directory and return all sessions.
 * Directory structure: <projectsDir>/<project-hash>/<session-uuid>.jsonl
 */
export async function detectSessions(
  projectsDir: string
): Promise<RawSession[]> {
  const sessions: RawSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, file);
      const sessionId = basename(file, ".jsonl");

      const messages = await parseJsonlFile(filePath);
      if (messages.length === 0) continue;

      sessions.push({
        sessionId,
        projectPath,
        projectName: projectDir,
        filePath,
        messages,
      });
    }
  }

  return sessions;
}

/**
 * Expand ~ to home directory.
 */
export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}
