#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-export.sh
#
# Dry-run a single session through the export pipeline and print a summary
# of the output files. Nothing is uploaded — files go to /tmp.
#
# Usage:
#   ./scripts/test-export.sh [SESSION_UUID]
#
# If SESSION_UUID is omitted, the script auto-picks the most recently modified
# session across all watched projects.
#
# Examples:
#   # Auto-pick the newest session
#   ./scripts/test-export.sh
#
#   # Test a specific session
#   ./scripts/test-export.sh adb6fd39-5fe0-4aa4-b647-fa01899d649e
#
# Output:
#   /tmp/agent-export-test/<uuid>.json
#   /tmp/agent-export-test/<uuid>.md
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.js"
OUT_DIR="/tmp/agent-export-test"
CLAUDE_PROJECTS="${HOME}/.claude/projects"

# ── 0. Make sure the CLI is built ─────────────────────────────────────────────
if [[ ! -f "$CLI" ]]; then
  echo "CLI not built — running pnpm build first…"
  (cd "$REPO_ROOT" && pnpm build)
fi

# ── 1. Resolve session UUID ───────────────────────────────────────────────────
SESSION_ID="${1:-}"

if [[ -z "$SESSION_ID" ]]; then
  echo "No session ID provided — finding the most recently modified session…"
  # Find the newest .jsonl file across all project dirs, extract its UUID
  NEWEST_FILE=$(find "$CLAUDE_PROJECTS" -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null \
    | sort -n | tail -1 | awk '{print $2}')

  if [[ -z "$NEWEST_FILE" ]]; then
    echo "ERROR: No .jsonl session files found under $CLAUDE_PROJECTS"
    exit 1
  fi

  SESSION_ID=$(basename "$NEWEST_FILE" .jsonl)
  echo "Auto-selected session: $SESSION_ID"
  echo "  File: $NEWEST_FILE"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Session: $SESSION_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 2. Clean output dir ───────────────────────────────────────────────────────
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# ── 3. Run export (no push, no review) ───────────────────────────────────────
echo ""
echo "▶ Running export pipeline…"
node "$CLI" export \
  --no-push \
  --no-review \
  --session "$SESSION_ID" \
  --out-dir "$OUT_DIR"

# ── 4. Find the output files ──────────────────────────────────────────────────
JSON_FILE=$(find "$OUT_DIR" -name "*.json" | head -1)
MD_FILE=$(find "$OUT_DIR" -name "*.md" | head -1)

if [[ -z "$JSON_FILE" ]]; then
  echo ""
  echo "ERROR: No output files found. The session may already be uploaded,"
  echo "       not exist, or be empty. Check the session ID and try again."
  exit 1
fi

# ── 5. File sizes ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Output files"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ls -lh "$OUT_DIR"
echo ""
echo "  Lines:  $(wc -l < "$JSON_FILE") JSON   /   $(wc -l < "$MD_FILE") Markdown"

# ── 6. JSON summary ───────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  JSON — top-level fields"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
# Print everything except the messages array (which is huge)
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$JSON_FILE', 'utf8'));
  const { messages, ...meta } = s;
  meta.message_count = messages.length;
  meta.sample_message = messages[0] ?? null;
  console.log(JSON.stringify(meta, null, 2));
"

# ── 7. Stats block ────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Stats"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$JSON_FILE', 'utf8'));
  console.log(JSON.stringify(s.stats, null, 2));
  console.log('files_touched:', s.metadata.files_touched.length);
"

# ── 8. Tool use breakdown ─────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tool use breakdown (top 10)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$JSON_FILE', 'utf8'));
  const counts = {};
  for (const msg of s.messages) {
    for (const tu of msg.tool_uses ?? []) {
      counts[tu.tool] = (counts[tu.tool] ?? 0) + 1;
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [tool, count] of sorted) {
    console.log('  ' + String(count).padStart(4) + '  ' + tool);
  }
"

# ── 9. Markdown preview (first 60 lines) ─────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Markdown preview (first 60 lines)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
head -60 "$MD_FILE"

# ── 10. Redaction check ───────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Redaction check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
REDACTED_COUNT=$(grep -oc '\[REDACTED:' "$JSON_FILE" || true)
if [[ "$REDACTED_COUNT" -gt 0 ]]; then
  echo "  ⚠  $REDACTED_COUNT redaction(s) found:"
  grep -o '\[REDACTED:[^]]*\]' "$JSON_FILE" | sort | uniq -c | sort -rn | \
    awk '{print "     " $0}'
else
  echo "  ✓  No redactions triggered"
fi

# ── 11. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Output written to: $OUT_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
