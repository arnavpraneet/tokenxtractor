import chalk from "chalk";
import { Session } from "@tokenxtractor/core";
import type { OpenAgentSessionsMetadata } from "@tokenxtractor/core";

export type ReviewDecision = "upload" | "skip" | "edit";

export interface ReviewResult {
  decision: ReviewDecision;
  session: Session;
}

/**
 * Display a summary of a session and prompt the user to approve, skip, or edit.
 */
export async function reviewSession(session: Session): Promise<ReviewResult> {
  // Dynamic import for ESM inquirer
  const { default: inquirer } = await import("inquirer");

  printSessionSummary(session);

  const { decision } = await inquirer.prompt<{ decision: ReviewDecision }>([
    {
      type: "list",
      name: "decision",
      message: "What would you like to do with this session?",
      choices: [
        { name: "Upload  — approve and upload now", value: "upload" },
        { name: "Skip    — do not upload this session", value: "skip" },
        { name: "Edit    — open editor to modify content before upload", value: "edit" },
      ],
    },
  ]);

  if (decision === "edit") {
    const edited = await editSession(session);
    return { decision: "upload", session: edited };
  }

  return { decision, session };
}

/**
 * Allow the user to edit specific messages before upload.
 */
async function editSession(session: Session): Promise<Session> {
  const { default: inquirer } = await import("inquirer");

  const choices = session.messages.map((msg, i) => ({
    name: `[${i + 1}] ${msg.role.padEnd(9)} ${msg.content.slice(0, 80).replace(/\n/g, " ")}${msg.content.length > 80 ? "…" : ""}`,
    value: i,
  }));
  choices.push({ name: "Done — no more edits", value: -1 });

  let messages = [...session.messages];
  let editing = true;

  while (editing) {
    const { msgIndex } = await inquirer.prompt<{ msgIndex: number }>([
      {
        type: "list",
        name: "msgIndex",
        message: "Select a message to edit (or Done):",
        choices,
      },
    ]);

    if (msgIndex === -1) {
      editing = false;
      break;
    }

    const { newContent } = await inquirer.prompt<{ newContent: string }>([
      {
        type: "editor",
        name: "newContent",
        message: `Edit message [${msgIndex + 1}]:`,
        default: messages[msgIndex].content,
      },
    ]);

    messages = messages.map((m, i) =>
      i === msgIndex ? { ...m, content: newContent } : m
    );
  }

  return { ...session, messages };
}

/**
 * Prompt the user to review and optionally override the auto-detected
 * openagentsessions.org metadata (topic and tags).
 */
export async function promptOpenAgentSessionsMeta(
  _session: Session,
  defaults: OpenAgentSessionsMetadata
): Promise<OpenAgentSessionsMetadata> {
  const { default: inquirer } = await import("inquirer");

  console.log(chalk.bold.cyan("\n  openagentsessions.org metadata\n"));
  console.log(chalk.dim("  Edit topic and tags for the public gist, or press Enter to accept defaults.\n"));

  const { topic, tagsRaw } = await inquirer.prompt<{ topic: string; tagsRaw: string }>([
    {
      type: "input",
      name: "topic",
      message: "Topic:",
      default: defaults.topic,
    },
    {
      type: "input",
      name: "tagsRaw",
      message: "Tags (comma-separated):",
      default: defaults.tags.join(", "),
    },
  ]);

  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return { topic, tags, language: defaults.language };
}

/**
 * Print a human-readable summary of a session.
 */
export function printSessionSummary(session: Session): void {
  console.log("\n" + chalk.bold.cyan("━".repeat(60)));
  console.log(chalk.bold(`  Session: ${session.id}`));
  console.log(chalk.bold.cyan("━".repeat(60)));
  console.log(`  ${chalk.dim("Workspace:")}  ${session.workspace}`);
  if (session.model) console.log(`  ${chalk.dim("Model:")}      ${session.model}`);
  if (session.git_branch) console.log(`  ${chalk.dim("Branch:")}     ${session.git_branch}`);
  if (session.start_time) {
    const start = new Date(session.start_time).toLocaleString();
    const end = session.end_time ? new Date(session.end_time).toLocaleString() : "?";
    console.log(`  ${chalk.dim("Time:")}       ${start} → ${end}`);
  }
  console.log(`  ${chalk.dim("Messages:")}   ${session.stats.user_messages} user, ${session.stats.assistant_messages} assistant`);
  console.log(`  ${chalk.dim("Tool uses:")}  ${session.stats.tool_uses}`);
  console.log(
    `  ${chalk.dim("Tokens:")}     ${session.stats.input_tokens.toLocaleString()} in / ${session.stats.output_tokens.toLocaleString()} out`
  );
  if (session.metadata.files_touched.length > 0) {
    console.log(`  ${chalk.dim("Files:")}      ${session.metadata.files_touched.slice(0, 5).join(", ")}${session.metadata.files_touched.length > 5 ? ` (+${session.metadata.files_touched.length - 5} more)` : ""}`);
  }
  console.log(chalk.bold.cyan("━".repeat(60)) + "\n");
}
