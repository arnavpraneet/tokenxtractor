#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import {
  detectSessions,
  detectCodexSessions,
  expandHome,
  normalizeSession,
  normalizeCodexSession,
  redactSession,
  scanForRemaining,
  formatSession,
  loadState,
  saveState,
  recordUpload,
  isUploaded,
  addPendingConfirmation,
  isConfirmed,
  confirmSessions,
  clearConfirmed,
  GitHubUploader,
  HuggingFaceUploader,
  GistUploader,
  inferOpenAgentSessionsMeta,
  buildUploadPath,
  TokenXtractorConfig,
  Session,
  RawSession,
  RawCodexSession,
} from "@tokenxtractor/core";
import { loadConfig, saveConfig, getStatePath, getConfigPath, getConfigDir } from "./config.js";
import { reviewSession, printSessionSummary, promptOpenAgentSessionsMeta } from "./review.js";

const VERSION = "1.0.0";

type TaggedSession =
  | { type: "claude"; raw: RawSession }
  | { type: "codex"; raw: RawCodexSession };

/** Returns true when a watch path points to a Codex sessions directory. */
function isCodexSessionsDir(p: string): boolean {
  return p.includes(".codex/sessions") || p.includes(".codex/archived_sessions");
}

/**
 * Detect all sessions (both Claude Code and Codex) from a single watch path.
 * Returns a unified list of raw sessions tagged with their normalizer type.
 */
async function detectAllSessions(watchPath: string): Promise<TaggedSession[]> {
  const expanded = expandHome(watchPath);
  if (isCodexSessionsDir(expanded)) {
    const raws = await detectCodexSessions(expanded);
    return raws.map((raw) => ({ type: "codex" as const, raw }));
  } else {
    const raws = await detectSessions(expanded);
    return raws.map((raw) => ({ type: "claude" as const, raw }));
  }
}

const program = new Command();

program
  .name("tokenxtractor")
  .description("Upload AI agent chat sessions to GitHub / HuggingFace")
  .version(VERSION);

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("First-time setup wizard")
  .action(async () => {
    await runInit();
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all discovered sessions")
  .action(async () => {
    const config = await loadConfig();
    const state = await loadState(getStatePath());
    const spinner = ora("Scanning for sessions…").start();

    const sessions: Array<{ sessionId: string; label: string; uploaded: boolean }> = [];
    for (const watchPath of config.watchPaths) {
      const tagged = await detectAllSessions(watchPath);
      for (const { type, raw } of tagged) {
        const uploaded = isUploaded(state, raw.sessionId, config.destination);
        const label = type === "codex"
          ? chalk.cyan("[codex]")
          : chalk.dim("[claude]");
        const name = "projectName" in raw ? raw.projectName : raw.cwd ?? raw.sessionId;
        sessions.push({ sessionId: raw.sessionId, label: `${label} ${name}`, uploaded });
      }
    }

    spinner.stop();

    if (sessions.length === 0) {
      console.log(chalk.yellow("No sessions found."));
      return;
    }

    console.log(`\nFound ${sessions.length} session(s):\n`);
    for (const { sessionId, label, uploaded } of sessions) {
      const uploadStatus = uploaded ? chalk.green("✓ uploaded") : chalk.yellow("○ pending");
      const excluded = config.exclude.includes(sessionId) ? chalk.red(" [excluded]") : "";
      console.log(`  ${uploadStatus}  ${sessionId}  ${label}${excluded}`);
    }
    console.log("");
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show current pipeline stage and next steps (JSON)")
  .action(async () => {
    const config = await loadConfig();
    const state = await loadState(getStatePath());

    const allSessions: string[] = [];
    const uploadedSessions: string[] = [];

    for (const watchPath of config.watchPaths) {
      const tagged = await detectAllSessions(watchPath);
      for (const { raw } of tagged) {
        allSessions.push(raw.sessionId);
        if (isUploaded(state, raw.sessionId, config.destination)) {
          uploadedSessions.push(raw.sessionId);
        }
      }
    }

    const pendingConfirmCount = (state.pendingConfirmation ?? []).length;
    const confirmedCount = (state.confirmedForUpload ?? []).length;

    const notConfigured = !config.github?.token && !config.huggingface?.token && !config.openagentsessions?.githubToken;
    const allUploaded = allSessions.length === uploadedSessions.length;

    let next_step: string;
    if (notConfigured) {
      next_step = "Run `tokenxtractor init` to configure";
    } else if (allUploaded) {
      next_step = "All sessions uploaded";
    } else if (pendingConfirmCount > 0) {
      next_step = `Run \`tokenxtractor confirm\` to review ${pendingConfirmCount} exported file(s), then \`tokenxtractor export\` to upload`;
    } else if (confirmedCount > 0) {
      next_step = `Run \`tokenxtractor export\` to upload ${confirmedCount} confirmed session(s)`;
    } else {
      next_step = "Run `tokenxtractor export` to export and review pending sessions";
    }

    const status = {
      version: VERSION,
      config_path: getConfigPath(),
      state_path: getStatePath(),
      destination: config.destination,
      total_sessions: allSessions.length,
      uploaded_sessions: uploadedSessions.length,
      pending_sessions: allSessions.length - uploadedSessions.length,
      awaiting_confirmation: pendingConfirmCount,
      confirmed_ready: confirmedCount,
      next_step,
    };

    console.log(JSON.stringify(status, null, 2));
  });

// ── config ────────────────────────────────────────────────────────────────────

program
  .command("config")
  .description("Show current configuration")
  .action(async () => {
    const config = await loadConfig();
    // Mask tokens for display
    const display = JSON.parse(JSON.stringify(config)) as TokenXtractorConfig;
    if (display.github?.token) display.github.token = "ghp_***";
    if (display.huggingface?.token) display.huggingface.token = "hf_***";
    console.log(JSON.stringify(display, null, 2));
  });

// ── export ────────────────────────────────────────────────────────────────────

program
  .command("export")
  .description("Process and upload pending sessions")
  .option("--no-push", "Export locally only, do not upload")
  .option("--no-thinking", "Exclude extended thinking blocks")
  .option("--no-review", "Skip interactive review (auto-approve all)")
  .option("--out-dir <dir>", "Output directory for local copy", "./exports")
  .option("--session <id>", "Only export a single session by ID")
  .action(async (opts: { push: boolean; thinking: boolean; review: boolean; outDir: string; session?: string }) => {
    const config = await loadConfig();
    await runExport(config, {
      push: opts.push,
      noThinking: !opts.thinking,
      noReview: !opts.review,
      outDir: opts.outDir,
      sessionFilter: opts.session,
    });
  });

// ── review ────────────────────────────────────────────────────────────────────

program
  .command("review")
  .description("Review pending sessions without uploading")
  .action(async () => {
    const config = await loadConfig();
    const state = await loadState(getStatePath());

    for (const watchPath of config.watchPaths) {
      const tagged = await detectAllSessions(watchPath);
      for (const entry of tagged) {
        if (config.exclude.includes(entry.raw.sessionId)) continue;
        if (isUploaded(state, entry.raw.sessionId, config.destination)) continue;

        const session = entry.type === "codex"
          ? normalizeCodexSession(entry.raw, { noThinking: config.noThinking })
          : normalizeSession(entry.raw, { noThinking: config.noThinking });
        const { session: redacted } = redactSession(session, config.redaction);
        printSessionSummary(redacted);
      }
    }
  });

// ── confirm ───────────────────────────────────────────────────────────────────

program
  .command("confirm")
  .description("Review locally-exported sessions and attest they are PII-free before upload")
  .action(async () => {
    await runConfirm();
  });

// ── watch ─────────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Watch for new sessions and upload automatically")
  .action(async () => {
    const config = await loadConfig();
    console.log(chalk.cyan("Watching for new sessions…"));
    console.log(chalk.dim(`Paths: ${config.watchPaths.join(", ")}`));
    console.log(chalk.dim("Press Ctrl+C to stop.\n"));

    // Dynamic import for ESM chokidar
    const { default: chokidar } = await import("chokidar");

    const patterns = config.watchPaths.map(
      (p) => join(expandHome(p), "**", "*.jsonl")
    );

    const watcher = chokidar.watch(patterns, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
    });

    watcher.on("add", async (filePath) => {
      // For Codex files (rollout-...-<uuid>.jsonl) extract the UUID portion;
      // for Claude Code files the stem is already the session UUID.
      const stem = basename(filePath, ".jsonl");
      const parts = stem.split("-");
      const sessionId = parts.length >= 5 ? parts.slice(-5).join("-") : stem;
      console.log(chalk.cyan(`\nNew session detected: ${sessionId}`));
      try {
        await runExport(config, {
          push: true,
          noThinking: false,
          noReview: true,
          outDir: "./exports",
          sessionFilter: sessionId,
        });
      } catch (err) {
        console.error(chalk.red(`Failed to process ${sessionId}: ${String(err)}`));
      }
    });

    watcher.on("change", async (filePath) => {
      // Session files grow as the conversation continues; skip re-processing
      // since runExport skips already-uploaded sessions anyway.
      console.log(chalk.dim(`Session updated (already queued): ${basename(filePath, ".jsonl")}`));
    });

    // Keep process alive
    process.on("SIGINT", () => {
      console.log("\n" + chalk.dim("Stopping watcher…"));
      watcher.close();
      process.exit(0);
    });
  });

// ── Default action (one-shot) ─────────────────────────────────────────────────

program
  .option("--watch", "Run in daemon/watch mode")
  .option("--no-thinking", "Exclude extended thinking blocks")
  .action(async (opts: { watch?: boolean; thinking: boolean }) => {
    if (opts.watch) {
      await program.parseAsync(["watch"], { from: "user" });
      return;
    }

    const config = await loadConfig();

    if (!config.github?.token && !config.huggingface?.token) {
      console.log(
        chalk.yellow(
          "No upload destination configured. Run `tokenxtractor init` first."
        )
      );
      process.exit(1);
    }

    await runExport(config, {
      push: true,
      noThinking: !opts.thinking,
      noReview: false,
      outDir: "./agent-chats-export",
    });
  });

// ── Core export logic ─────────────────────────────────────────────────────────

async function runExport(
  config: TokenXtractorConfig,
  opts: { push: boolean; noThinking: boolean; noReview: boolean; outDir: string; sessionFilter?: string }
): Promise<void> {
  const state = await loadState(getStatePath());
  let currentState = state;

  if (opts.noReview && opts.push) {
    console.log(
      chalk.yellow(
        "  ⚠  Review gate skipped (--no-review). Ensure you have inspected the exported files before sharing."
      )
    );
  }

  const spinner = ora("Scanning for sessions…").start();
  const allTagged: TaggedSession[] = [];

  for (const watchPath of config.watchPaths) {
    const tagged = await detectAllSessions(watchPath);
    allTagged.push(...tagged);
  }

  const pending = allTagged.filter(
    ({ raw }) =>
      !config.exclude.includes(raw.sessionId) &&
      !isUploaded(currentState, raw.sessionId, config.destination) &&
      (opts.sessionFilter ? raw.sessionId === opts.sessionFilter : true)
  );

  spinner.stop();

  if (pending.length === 0) {
    console.log(chalk.green("All sessions already uploaded. Nothing to do."));
    return;
  }

  console.log(chalk.cyan(`Found ${pending.length} pending session(s).\n`));

  // Build uploaders (only needed when pushing to github/huggingface).
  // openagentsessions uses a per-session GistUploader constructed inside the loop.
  const uploaders = opts.push && config.destination !== "openagentsessions" ? buildUploaders(config) : [];

  for (const tagged of pending) {
    const normalizeOpts = { noThinking: opts.noThinking, extraUsernames: config.redaction.redactUsernames };
    const session = tagged.type === "codex"
      ? normalizeCodexSession(tagged.raw, normalizeOpts)
      : normalizeSession(tagged.raw, normalizeOpts);
    const raw = tagged.raw;
    const { session: redacted, totalRedacted, types } = redactSession(
      session,
      config.redaction
    );

    if (totalRedacted > 0) {
      console.log(
        chalk.yellow(`  ⚠  Redacted ${totalRedacted} secret(s): ${types.join(", ")}`)
      );
    }

    let finalSession: Session = redacted;

    if (!opts.noReview) {
      const result = await reviewSession(redacted);
      if (result.decision === "skip") {
        console.log(chalk.dim(`  Skipped: ${raw.sessionId}`));
        continue;
      }
      finalSession = result.session;
    }

    const formatted = formatSession(finalSession);
    const date = finalSession.captured_at
      ? new Date(finalSession.captured_at)
      : new Date();

    // ── Phase 4: Post-redaction PII re-scan ────────────────────────────────
    const remainingHits = scanForRemaining(formatted.json);
    if (remainingHits.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠  Post-redaction scan found ${remainingHits.length} suspicious string(s) — review before uploading:`
        )
      );
      remainingHits.slice(0, 5).forEach((h) => console.log(chalk.dim(`     • ${h}`)));
      if (remainingHits.length > 5) {
        console.log(chalk.dim(`     … and ${remainingHits.length - 5} more`));
      }
    }

    // Always write a local copy
    await mkdir(opts.outDir, { recursive: true });
    const localJsonPath = join(opts.outDir, `${formatted.filename}.json`);
    await writeFile(localJsonPath, formatted.json, "utf8");
    await writeFile(join(opts.outDir, `${formatted.filename}.md`), formatted.markdown, "utf8");

    // Track this export in the pending-confirmation queue
    currentState = addPendingConfirmation(currentState, {
      sessionId: raw.sessionId,
      exportedAt: new Date().toISOString(),
      localPath: localJsonPath,
    });
    await saveState(getStatePath(), currentState);

    if (!opts.push) {
      console.log(chalk.green(`  ✓ Saved locally: ${formatted.filename}`));
      console.log(chalk.dim(`     Run \`tokenxtractor confirm\` to attest the file is PII-free before uploading.`));
      continue;
    }

    // ── Review gate ────────────────────────────────────────────────────────
    // When interactive review is enabled (default), require the user to run
    // `tokenxtractor confirm` before any upload goes out. Watch mode /
    // --no-review bypasses this gate intentionally.
    if (!opts.noReview && !isConfirmed(currentState, raw.sessionId)) {
      console.log(chalk.yellow(`  ⚠  Session ${raw.sessionId.slice(0, 8)} is queued for review.`));
      console.log(chalk.dim(`     Open ${localJsonPath} to inspect it, then run:`));
      console.log(chalk.cyan(`     tokenxtractor confirm`));
      console.log(chalk.dim(`     After confirming, re-run \`tokenxtractor export\` to upload.`));
      continue;
    }

    // Upload to configured destinations
    const uploadSpinner = ora(`  Uploading ${raw.sessionId.slice(0, 8)}…`).start();
    try {
      const files = [
        { path: buildUploadPath(formatted.filename, "json", date), content: formatted.json },
        { path: buildUploadPath(formatted.filename, "md", date), content: formatted.markdown },
      ];

      const allPaths: string[] = [];

      // GitHub / HuggingFace uploaders
      for (const uploader of uploaders) {
        const result = await uploader.upload(files);
        allPaths.push(...result.paths);
      }

      // openagentsessions.org — public GitHub Gist
      if (config.destination === "openagentsessions" && config.openagentsessions?.githubToken) {
        uploadSpinner.stop();
        const defaultMeta = inferOpenAgentSessionsMeta(finalSession);
        const meta = !opts.noReview
          ? await promptOpenAgentSessionsMeta(finalSession, defaultMeta)
          : defaultMeta;
        uploadSpinner.start(`  Creating gist for ${raw.sessionId.slice(0, 8)}…`);

        const gistUploader = new GistUploader(config.openagentsessions.githubToken, finalSession, meta);
        const gistResult = await gistUploader.upload([
          { path: "session.md", content: formatted.markdown },
        ]);
        allPaths.push(...gistResult.paths);
        uploadSpinner.stop();
        console.log(chalk.green(`  ✓ Gist created: ${gistResult.urls[0]}`));
        console.log(chalk.dim(`     Submit at: https://openagentsessions.org/submit`));
        uploadSpinner.start(); // restart for the state-save spinner text
      }

      currentState = recordUpload(currentState, {
        sessionId: raw.sessionId,
        uploadedAt: new Date().toISOString(),
        destination: config.destination,
        paths: allPaths,
      });
      // Clear from confirmed queue now that it's uploaded
      currentState = clearConfirmed(currentState, raw.sessionId);

      await saveState(getStatePath(), currentState);
      uploadSpinner.succeed(`  Uploaded: ${raw.sessionId.slice(0, 8)}…`);
    } catch (err) {
      uploadSpinner.fail(`  Failed to upload ${raw.sessionId.slice(0, 8)}: ${String(err)}`);
    }
  }

  console.log("\n" + chalk.green("Done."));
}

// ── Confirm wizard ─────────────────────────────────────────────────────────────

async function runConfirm(): Promise<void> {
  const { default: inquirer } = await import("inquirer");
  const { readFile: readFileFs } = await import("fs/promises");

  const state = await loadState(getStatePath());
  const pending = state.pendingConfirmation ?? [];

  if (pending.length === 0) {
    console.log(chalk.green("No sessions awaiting confirmation."));
    console.log(chalk.dim("Run `tokenxtractor export --no-push` first to export sessions locally."));
    return;
  }

  console.log(chalk.bold.cyan(`\n  Agent Upload — Confirm ${pending.length} export(s)\n`));
  console.log("  The following files have been exported locally. Please open and review each one:");
  console.log("");

  for (const record of pending) {
    console.log(chalk.cyan(`  Session: ${record.sessionId}`));
    console.log(chalk.white(`  File:    ${record.localPath}`));

    // Run a second-pass PII scan and surface any remaining hits
    let fileContent: string;
    try {
      fileContent = await readFileFs(record.localPath, "utf8");
    } catch {
      console.log(chalk.yellow(`  ⚠  Could not read file (may have been moved or deleted)`));
      console.log("");
      continue;
    }

    const hits = scanForRemaining(fileContent);
    if (hits.length > 0) {
      console.log(
        chalk.yellow(`  ⚠  ${hits.length} suspicious string(s) detected in this file:`)
      );
      hits.slice(0, 5).forEach((h) => console.log(chalk.dim(`     • ${h}`)));
      if (hits.length > 5) {
        console.log(chalk.dim(`     … and ${hits.length - 5} more`));
      }
      console.log(chalk.dim("  Please review and manually edit the file if needed before confirming."));
    } else {
      console.log(chalk.green("  ✓ No suspicious strings detected."));
    }
    console.log("");
  }

  const { attested } = await inquirer.prompt<{ attested: boolean }>([
    {
      type: "confirm",
      name: "attested",
      message: `I have reviewed all ${pending.length} exported file(s) and confirm they do not contain personal or sensitive information.`,
      default: false,
    },
  ]);

  if (!attested) {
    console.log(chalk.yellow("\n  Confirmation declined. No sessions marked as confirmed."));
    console.log(chalk.dim("  Edit the exported files to remove any sensitive data, then re-run `tokenxtractor confirm`."));
    return;
  }

  let currentState = state;
  const confirmedIds = pending.map((r) => r.sessionId);
  currentState = confirmSessions(currentState, confirmedIds);
  await saveState(getStatePath(), currentState);

  console.log(chalk.green(`\n  ✓ ${confirmedIds.length} session(s) confirmed and ready to upload.`));
  console.log(chalk.dim("  Run `tokenxtractor export` to upload them."));
  console.log("");
}


function buildUploaders(config: TokenXtractorConfig) {
  const uploaders: Array<GitHubUploader | HuggingFaceUploader> = [];

  if (
    (config.destination === "github" || config.destination === "both") &&
    config.github?.token &&
    config.github?.repo
  ) {
    uploaders.push(new GitHubUploader(config.github.token, config.github.repo));
  }

  if (
    (config.destination === "huggingface" || config.destination === "both") &&
    config.huggingface?.token &&
    config.huggingface?.repo
  ) {
    uploaders.push(
      new HuggingFaceUploader(config.huggingface.token, config.huggingface.repo)
    );
  }

  if (uploaders.length === 0) {
    throw new Error(
      "No upload destination configured. Run `tokenxtractor init` first."
    );
  }

  return uploaders;
}

// ── Init wizard ───────────────────────────────────────────────────────────────

async function runInit(): Promise<void> {
  const { default: inquirer } = await import("inquirer");

  console.log(chalk.bold.cyan("\n  Agent Upload — Setup Wizard\n"));

  const existing = await loadConfig();

  const { destination } = await inquirer.prompt<{ destination: "github" | "huggingface" | "both" | "openagentsessions" }>([
    {
      type: "list",
      name: "destination",
      message: "Where would you like to upload your sessions?",
      choices: [
        { name: "GitHub repository", value: "github" },
        { name: "HuggingFace dataset", value: "huggingface" },
        { name: "Both (GitHub + HuggingFace)", value: "both" },
        { name: "openagentsessions.org (public gist, CC0)", value: "openagentsessions" },
      ],
      default: existing.destination,
    },
  ]);

  let githubConfig = existing.github;
  let huggingfaceConfig = existing.huggingface;
  let openAgentSessionsConfig = existing.openagentsessions;

  if (destination === "github" || destination === "both") {
    console.log(chalk.dim("\n  GitHub setup:"));
    console.log(chalk.dim("  Create a PAT at: https://github.com/settings/tokens\n"));

    const ghAnswers = await inquirer.prompt<{ token: string; repo: string }>([
      {
        type: "password",
        name: "token",
        message: "GitHub Personal Access Token (repo scope required):",
        default: existing.github?.token ?? "",
        validate: (v: string) => (v.startsWith("ghp_") || v.startsWith("github_pat_") ? true : "Token should start with ghp_ or github_pat_"),
      },
      {
        type: "input",
        name: "repo",
        message: "Target repository (owner/repo):",
        default: existing.github?.repo ?? "",
        validate: (v: string) => (v.includes("/") ? true : "Format must be owner/repo"),
      },
    ]);

    githubConfig = { token: ghAnswers.token, repo: ghAnswers.repo };
  }

  if (destination === "huggingface" || destination === "both") {
    console.log(chalk.dim("\n  HuggingFace setup:"));
    console.log(chalk.dim("  Create a token at: https://huggingface.co/settings/tokens\n"));

    const hfAnswers = await inquirer.prompt<{ token: string; repo: string }>([
      {
        type: "password",
        name: "token",
        message: "HuggingFace access token:",
        default: existing.huggingface?.token ?? "",
        validate: (v: string) => (v.startsWith("hf_") ? true : "Token should start with hf_"),
      },
      {
        type: "input",
        name: "repo",
        message: "Target dataset repository (owner/repo):",
        default: existing.huggingface?.repo ?? "",
        validate: (v: string) => (v.includes("/") ? true : "Format must be owner/repo"),
      },
    ]);

    huggingfaceConfig = { token: hfAnswers.token, repo: hfAnswers.repo };
  }

  if (destination === "openagentsessions") {
    console.log(chalk.dim("\n  openagentsessions.org setup:"));
    console.log(chalk.dim("  Sessions are uploaded as public GitHub Gists (CC0 license)."));
    console.log(chalk.dim("  You will need a GitHub PAT with the 'gist' scope.\n"));
    console.log(chalk.dim("  Create a PAT at: https://github.com/settings/tokens\n"));

    const oasAnswers = await inquirer.prompt<{ githubToken: string }>([
      {
        type: "password",
        name: "githubToken",
        message: "GitHub Personal Access Token (gist scope required):",
        default: existing.openagentsessions?.githubToken ?? existing.github?.token ?? "",
        validate: (v: string) => (v.startsWith("ghp_") || v.startsWith("github_pat_") ? true : "Token should start with ghp_ or github_pat_"),
      },
    ]);

    openAgentSessionsConfig = { githubToken: oasAnswers.githubToken };
  }

  const { redactionEnabled, noThinking } = await inquirer.prompt<{
    redactionEnabled: boolean;
    noThinking: boolean;
  }>([
    {
      type: "confirm",
      name: "redactionEnabled",
      message: "Enable automatic secret redaction?",
      default: existing.redaction.enabled,
    },
    {
      type: "confirm",
      name: "noThinking",
      message: "Exclude extended thinking blocks from uploads?",
      default: existing.noThinking,
    },
  ]);

  console.log(chalk.dim("\n  Username anonymization:"));
  console.log(chalk.dim("  Your OS username and home directory are always anonymized automatically."));
  console.log(chalk.dim("  Add any additional names (e.g. your GitHub handle) that may appear in sessions.\n"));

  const { extraUsernamesRaw } = await inquirer.prompt<{ extraUsernamesRaw: string }>([
    {
      type: "input",
      name: "extraUsernamesRaw",
      message: "Additional usernames to anonymize (comma-separated, leave blank to skip):",
      default: existing.redaction.redactUsernames.join(", "),
    },
  ]);

  const extraUsernames = extraUsernamesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const newConfig: TokenXtractorConfig = {
    destination,
    github: githubConfig,
    huggingface: huggingfaceConfig,
    openagentsessions: openAgentSessionsConfig,
    watchPaths: existing.watchPaths,
    redaction: {
      ...existing.redaction,
      enabled: redactionEnabled,
      redactUsernames: extraUsernames,
    },
    exclude: existing.exclude,
    noThinking,
  };

  await saveConfig(newConfig);

  const configDir = getConfigDir();
  console.log(
    chalk.green(`\n  Configuration saved to ${configDir}/config.json (permissions: 600)\n`)
  );
  console.log("  Next steps:");
  console.log(chalk.dim("  • Run `tokenxtractor list` to see discovered sessions"));
  console.log(chalk.dim("  • Run `tokenxtractor export` to upload pending sessions"));
  if (destination === "openagentsessions") {
    console.log(chalk.dim("  • After export, paste the gist URL at https://openagentsessions.org/submit"));
  }
  console.log(
    chalk.dim("  • Add to ~/.claude/settings.json hooks to run automatically after each session\n")
  );
  console.log("  Claude Code hook snippet:");
  console.log(
    chalk.dim(
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: "command", command: "tokenxtractor" }] }] } },
        null,
        2
      )
    )
  );
  console.log("");
}

program.parse(process.argv);
