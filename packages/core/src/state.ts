import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { PendingConfirmation, UploadRecord, UploadState } from "./schema.js";

const STATE_VERSION = 1;

function emptyState(): UploadState {
  return { version: STATE_VERSION, uploads: [] };
}

/**
 * Load state from disk. Returns empty state if file doesn't exist.
 */
export async function loadState(statePath: string): Promise<UploadState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as UploadState;
    if (typeof parsed.version !== "number") return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

/**
 * Persist state to disk, creating parent directories as needed.
 */
export async function saveState(
  statePath: string,
  state: UploadState
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Check whether a session has already been uploaded to a given destination.
 */
export function isUploaded(
  state: UploadState,
  sessionId: string,
  destination: string
): boolean {
  return state.uploads.some(
    (r) => r.sessionId === sessionId && r.destination === destination
  );
}

/**
 * Record a successful upload.
 */
export function recordUpload(
  state: UploadState,
  record: UploadRecord
): UploadState {
  // Deduplicate: remove any existing record for same session+destination
  const filtered = state.uploads.filter(
    (r) =>
      !(r.sessionId === record.sessionId && r.destination === record.destination)
  );
  return {
    ...state,
    uploads: [...filtered, record],
  };
}

/**
 * Get all session IDs that have been uploaded to a given destination.
 */
export function getUploadedSessionIds(
  state: UploadState,
  destination: string
): Set<string> {
  return new Set(
    state.uploads
      .filter((r) => r.destination === destination)
      .map((r) => r.sessionId)
  );
}

// ── Pending confirmation helpers ──────────────────────────────────────────────

/**
 * Add a session to the pending-confirmation queue.
 * Idempotent: if the session is already queued, updates its record.
 */
export function addPendingConfirmation(
  state: UploadState,
  record: PendingConfirmation
): UploadState {
  const existing = (state.pendingConfirmation ?? []).filter(
    (r) => r.sessionId !== record.sessionId
  );
  return {
    ...state,
    pendingConfirmation: [...existing, record],
  };
}

/**
 * Check whether a session is in the pending-confirmation queue.
 */
export function isPendingConfirmation(
  state: UploadState,
  sessionId: string
): boolean {
  return (state.pendingConfirmation ?? []).some((r) => r.sessionId === sessionId);
}

/**
 * Check whether a session has been confirmed by the user as safe to upload.
 */
export function isConfirmed(state: UploadState, sessionId: string): boolean {
  return (state.confirmedForUpload ?? []).includes(sessionId);
}

/**
 * Move sessions from pendingConfirmation → confirmedForUpload.
 * Called after the user attests the exports are PII-free.
 */
export function confirmSessions(
  state: UploadState,
  sessionIds: string[]
): UploadState {
  const idSet = new Set(sessionIds);
  const stillPending = (state.pendingConfirmation ?? []).filter(
    (r) => !idSet.has(r.sessionId)
  );
  const alreadyConfirmed = new Set(state.confirmedForUpload ?? []);
  for (const id of sessionIds) alreadyConfirmed.add(id);
  return {
    ...state,
    pendingConfirmation: stillPending,
    confirmedForUpload: Array.from(alreadyConfirmed),
  };
}

/**
 * Remove a session from the confirmed list (e.g. after it has been uploaded).
 */
export function clearConfirmed(state: UploadState, sessionId: string): UploadState {
  return {
    ...state,
    confirmedForUpload: (state.confirmedForUpload ?? []).filter((id) => id !== sessionId),
  };
}
