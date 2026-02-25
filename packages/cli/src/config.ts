import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { TokenXtractorConfig, DEFAULT_CONFIG } from "@tokenxtractor/core";

export function getConfigDir(): string {
  return join(homedir(), ".tokenxtractor");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getStatePath(): string {
  return join(getConfigDir(), "state.json");
}

/**
 * Load config from disk, merging with defaults.
 */
export async function loadConfig(): Promise<TokenXtractorConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenXtractorConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      redaction: {
        ...DEFAULT_CONFIG.redaction,
        ...(parsed.redaction ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save config to disk with 0600 permissions (owner-only).
 */
export async function saveConfig(config: TokenXtractorConfig): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  const path = getConfigPath();
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  // Restrict permissions: only owner can read/write (contains tokens)
  await chmod(path, 0o600);
}
