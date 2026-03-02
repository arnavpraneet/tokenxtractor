# tokenxtractor

Capture your coding agent sessions, redact secrets automatically, review them interactively, and upload them as structured datasets to GitHub or Hugging Face.

## Why

We believe free, open source (or even open weight) large language models and artificial intelligence models in general are important for continued technological progress.

Every agentic coding session is a record of how an AI coding a1ssistant thinks and acts. `tokenxtractor` makes it easy to contribute those sessions to a shared, privacy-safe dataset — useful for AI training, personal archiving, and open research - this can potentially go a long way towards helping open source (or weight) LLM companies to train/improve their models - the philosophy behind this is that as the user, you have already paid whatever coding agent of your choice for the tokens, they are now yours to do with as you please - and in this case, it would please you to freely contribute them to an open source model training dataset.

## Features

- **Automatic secret detection** — 25+ patterns (API keys, tokens, connection strings, PEM blocks, and more) with allowlists for safe values
- **Interactive review** — approve, skip, or edit sessions before anything leaves your machine
- **Two upload backends** — GitHub (via Octokit) and Hugging Face Hub; configurable per-session
- **Watch mode** — run as a daemon and upload sessions as they are created
- **Hook integration** — trigger automatically at the end of every session
- **Privacy-first** — workspace paths stripped, tool results summarized (never verbatim), tokens stored with 600 permissions

## Installation

```bash
npm install -g tokenxtractor
# or
npx tokenxtractor init
```

Requires Node.js >= 18 and a GitHub personal access token or Hugging Face token.

## Quick Start

```bash
# First-time setup
tokenxtractor init

# Review and upload new sessions
tokenxtractor export

# Export locally without pushing (review first)
tokenxtractor export --no-push
tokenxtractor confirm
tokenxtractor export

# Watch for new sessions automatically
tokenxtractor --watch
```

## Claude Code Hook

To upload automatically at the end of every Claude Code session, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "tokenxtractor" }] }]
  }
}
```

## All Commands

| Command | Description |
|---|---|
| `tokenxtractor init` | Interactive setup wizard |
| `tokenxtractor list` | List projects and their exclusion status |
| `tokenxtractor export` | Export and upload new sessions |
| `tokenxtractor export --no-push` | Export locally only |
| `tokenxtractor confirm` | Attest review, unlock pushing |
| `tokenxtractor review` | Review pending queue without uploading |
| `tokenxtractor status` | Show pipeline stage and next steps |
| `tokenxtractor config` | Show or edit configuration |
| `tokenxtractor --watch` | Daemon mode: watch for new sessions |

## Configuration

Config is stored at `~/.tokenxtractor/config.json` (owner-only permissions):

```json
{
  "destination": "github",
  "github": {
    "token": "ghp_...",
    "repo": "username/agent-chats-dataset"
  },
  "huggingface": {
    "token": "hf_...",
    "repo": "username/my-codex-data"
  },
  "openagentsessions": {
    "githubToken": "ghp_..."
  },
  "redaction": {
    "enabled": true,
    "customPatterns": [],
    "redactUsernames": [],
    "redactStrings": []
  },
  "noThinking": false
}
```

`destination` can be `"github"`, `"huggingface"`, `"both"`, or `"openagentsessions"`.

### openagentsessions.org

Setting `destination` to `"openagentsessions"` uploads each session as a **public GitHub Gist** containing:

- `session.md` — the human-readable transcript
- `openagentsessions.json` — required CC0 metadata

The metadata is auto-detected from the session (workspace, model, files touched, tool names) and you can edit it during the interactive review step. After upload, you will see the gist URL and a link to paste it at [openagentsessions.org/submit](https://openagentsessions.org/submit).

**Requirements:**
- A GitHub PAT with the `gist` scope (the same PAT used for GitHub repository uploads works fine)
- The gist must be public (enforced automatically) and owned by the GitHub account you sign in with at openagentsessions.org

## Dataset Format

Sessions are uploaded as:

```
YYYY/MM/DD/claude-code_<uuid>.json
YYYY/MM/DD/claude-code_<uuid>.md
```

Each JSON file follows a [documented schema](plan.md#json-schema-per-session) with messages, tool uses (summarized, never full content), timestamps, token counts, and metadata.

## Privacy Model

1. **Auto-redaction first** — secrets scanned before anything is shown to you
2. **Review always required** — no upload without explicit approval
3. **Workspace path stripped** — only the project name is stored, never the full filesystem path
4. **Tool results summarized** — tool names, summarized inputs, and brief results are kept; full file contents and raw command output are never stored verbatim
5. **Tokens stored safely** — config file uses 600 permissions; tokens never appear in logs
6. **You control the destination** — you configure your own repo; nobody else receives the data

## Monorepo Structure

```
packages/
  core/   — shared pipeline (detector, normalizer, redactor, formatter, uploader, state)
  cli/    — tokenxtractor CLI (commander.js + inquirer.js)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
