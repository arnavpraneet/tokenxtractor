import { execSync } from "child_process";
import { userInfo } from "os";

/**
 * Try to run a git command in the given cwd and return its trimmed stdout.
 * Returns undefined if the command fails or produces no output.
 */
function tryGit(args: string, cwd: string): string | undefined {
  try {
    const out = execSync(`git ${args}`, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a GitHub username from a remote URL.
 * Supports HTTPS: https://github.com/USER/repo[.git]
 * Supports SSH:   git@github.com:USER/repo[.git]
 */
function extractGitHubHandle(remoteUrl: string): string | undefined {
  // HTTPS form
  const https = remoteUrl.match(/github\.com\/([^/]+)\//);
  if (https) return https[1];
  // SSH form: git@github.com:USER/repo
  const ssh = remoteUrl.match(/github\.com:([^/]+)\//);
  if (ssh) return ssh[1];
  return undefined;
}

/**
 * Collect all usernames and paths that should be anonymized.
 *
 * Always includes:
 *   - OS username
 *   - homedir (so `/home/user/...` paths are caught as a substring)
 *
 * When `cwd` is provided, also tries:
 *   - `git config user.name`
 *   - local part of `git config user.email` (before the @)
 *   - GitHub handle from `git remote get-url origin`
 *
 * @param cwd     Working directory for git commands (optional)
 * @param extra   Additional names from user config (`redactUsernames`)
 * @returns Deduplicated list of non-empty strings to anonymize
 */
export function detectUsernames(cwd?: string, extra?: string[]): string[] {
  const { username: osUsername, homedir } = userInfo();
  const candidates: string[] = [osUsername, homedir];

  if (cwd) {
    // git config user.name
    const gitName = tryGit("config user.name", cwd);
    if (gitName) candidates.push(gitName);

    // local part of git config user.email
    const gitEmail = tryGit("config user.email", cwd);
    if (gitEmail) {
      const localPart = gitEmail.split("@")[0];
      if (localPart) candidates.push(localPart);
    }

    // GitHub handle from origin remote URL
    const remoteUrl = tryGit("remote get-url origin", cwd);
    if (remoteUrl) {
      const handle = extractGitHubHandle(remoteUrl);
      if (handle) candidates.push(handle);
    }
  }

  // Append user-supplied extras
  for (const name of extra ?? []) {
    if (name) candidates.push(name);
  }

  // Deduplicate and drop empty strings, preserving insertion order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of candidates) {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}
