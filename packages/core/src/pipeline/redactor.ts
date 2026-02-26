import { createHash } from "crypto";
import { userInfo } from "os";
import { Message, Session } from "../schema.js";

// ── IPv4 allowlist ─────────────────────────────────────────────────────────────

/** Returns true for IPs that should NOT be redacted. */
function isAllowedIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b, c, d] = parts;

  // Loopback
  if (a === 127) return true;
  // Unspecified
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  // RFC 1918 private ranges
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local
  if (a === 169 && b === 254) return true;
  // Well-known public DNS
  const str = ip;
  if (
    str === "8.8.8.8" ||
    str === "8.8.4.4" ||
    str === "1.1.1.1" ||
    str === "1.0.0.1"
  )
    return true;

  return false;
}

// ── Email allowlist ───────────────────────────────────────────────────────────

const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.io",
  "test.com",
  "test.org",
  "localhost.com",
  // Known bot / service domains
  "github.com",
  "dependabot.com",
  "users.noreply.github.com",
  "noreply.github.com",
  "renovatebot.com",
  "snyk.io",
]);

function isAllowedEmail(email: string): boolean {
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.has(domain);
}

// ── Secret patterns ────────────────────────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
  placeholder: (match: string) => string;
  /** Optional per-match allowlist predicate — if it returns true, skip redaction. */
  allow?: (match: string) => boolean;
}

const BUILT_IN_PATTERNS: SecretPattern[] = [
  // GitHub tokens
  {
    name: "github-token",
    regex: /\bghp_[A-Za-z0-9]{36,}\b/g,
    placeholder: () => "[REDACTED:github-token]",
  },
  {
    name: "github-oauth",
    regex: /\bgho_[A-Za-z0-9]{36,}\b/g,
    placeholder: () => "[REDACTED:github-oauth-token]",
  },
  {
    name: "github-app-token",
    regex: /\bghs_[A-Za-z0-9]{36,}\b/g,
    placeholder: () => "[REDACTED:github-app-token]",
  },
  // Anthropic API keys
  {
    name: "anthropic-key",
    regex: /\bsk-ant-[A-Za-z0-9\-_]{32,}\b/g,
    placeholder: () => "[REDACTED:anthropic-api-key]",
  },
  // OpenAI API keys
  {
    name: "openai-key",
    regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
    placeholder: () => "[REDACTED:openai-api-key]",
  },
  // HuggingFace tokens
  {
    name: "huggingface-token",
    regex: /\bhf_[A-Za-z0-9]{32,}\b/g,
    placeholder: () => "[REDACTED:huggingface-token]",
  },
  // AWS access key IDs
  {
    name: "aws-access-key",
    regex: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    placeholder: () => "[REDACTED:aws-access-key]",
  },
  // AWS secret access keys (heuristic: 40-char base64-ish after "aws_secret")
  {
    name: "aws-secret-key",
    regex: /aws[_\-]?secret[_\-]?(?:access[_\-]?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
    placeholder: () => "[REDACTED:aws-secret-key]",
  },
  // Generic bearer tokens in Authorization headers
  {
    name: "bearer-token",
    regex: /\bBearer\s+([A-Za-z0-9\-._~+/]+=*){20,}/gi,
    placeholder: () => "Bearer [REDACTED:bearer-token]",
  },
  // Private keys, certificates, and PGP blocks (PEM)
  {
    name: "private-key",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----/g,
    placeholder: () => "[REDACTED:private-key]",
  },
  // Generic password= assignments (heuristic) — quoted or unquoted
  {
    name: "password",
    regex: /(?:password|passwd|pwd)\s*[:=]\s*(?:["']([^"'\s]{8,})["']|([^\s"',;}{]{8,}))/gi,
    placeholder: () => "[REDACTED:password]",
  },
  // Connection strings with credentials
  {
    name: "connection-string",
    regex: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^:]+:[^@\s]+@[^\s"')]+/gi,
    placeholder: () => "[REDACTED:connection-string]",
  },
  // ── New patterns ──────────────────────────────────────────────────────────
  // JWT tokens (base64url header.payload.signature)
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    placeholder: () => "[REDACTED:jwt]",
  },
  // PyPI API tokens
  {
    name: "pypi-token",
    regex: /\bpypi-[A-Za-z0-9\-_]{32,}\b/g,
    placeholder: () => "[REDACTED:pypi-token]",
  },
  // NPM tokens
  {
    name: "npm-token",
    regex: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    placeholder: () => "[REDACTED:npm-token]",
  },
  // Slack incoming webhook URLs
  {
    name: "slack-webhook",
    regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    placeholder: () => "[REDACTED:slack-webhook]",
  },
  // Discord webhook URLs
  {
    name: "discord-webhook",
    regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9\-_]+/g,
    placeholder: () => "[REDACTED:discord-webhook]",
  },
  // CLI flag secrets: --token VALUE, --api-key VALUE, etc.
  {
    name: "cli-secret",
    regex:
      /--(?:token|api[_-]?key|secret|password|passwd|api[_-]?secret)\s+([^\s'"]{8,})/gi,
    placeholder: (m) => {
      // Keep the flag name, redact only the value
      const flagEnd = m.indexOf(" ");
      return m.slice(0, flagEnd + 1) + "[REDACTED:cli-secret]";
    },
  },
  // URL query parameter secrets: ?token=abc, &api_key=xyz
  {
    name: "url-secret",
    regex:
      /([?&](?:token|api[_-]?key|secret|password|access[_-]?token)=)([^&\s'"]{8,})/gi,
    placeholder: (m) => {
      const eqIdx = m.indexOf("=");
      return m.slice(0, eqIdx + 1) + "[REDACTED:url-secret]";
    },
  },
  // Shell env var assignments: export TOKEN=abc, TOKEN=abc command (any case)
  {
    name: "env-secret",
    regex:
      /\b(?:export\s+)?[A-Za-z][A-Za-z0-9_]{2,}(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_API_KEY|_CREDENTIAL(?:S)?|_ACCESS_TOKEN|_PRIVATE_KEY)\s*=\s*([^\s'"]{8,})/g,
    placeholder: (m) => {
      const eqIdx = m.indexOf("=");
      return m.slice(0, eqIdx + 1) + "[REDACTED:env-secret]";
    },
  },
  // Email addresses — with allowlist applied via `allow`
  {
    name: "email",
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    placeholder: () => "[REDACTED:email]",
    allow: isAllowedEmail,
  },
  // IPv4 addresses — with allowlist applied via `allow`
  {
    name: "ipv4",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    placeholder: () => "[REDACTED:ipv4]",
    allow: isAllowedIP,
  },
  // Phone numbers (E.164 and US formats)
  {
    name: "phone",
    regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    placeholder: () => "[REDACTED:phone]",
  },
  // Credit card numbers (major networks, heuristic)
  {
    name: "credit-card",
    regex:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    placeholder: () => "[REDACTED:credit-card]",
  },
];

// ── Entropy-based detection ────────────────────────────────────────────────────

/**
 * Shannon entropy of a string, in bits per character.
 */
function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  const len = s.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Lowered threshold — catches more secrets while secondary checks reduce false positives
const ENTROPY_THRESHOLD = 3.5;
const MIN_HIGH_ENTROPY_LENGTH = 32;

// UUID pattern — allow-listed to avoid flagging common identifiers
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Secondary validation for a candidate high-entropy token.
 * Returns true only if the token looks like an actual secret.
 */
function looksLikeSecret(token: string): boolean {
  // Reject UUIDs (common identifiers, not secrets)
  if (UUID_REGEX.test(token)) return false;

  // Reject strings with more than 2 dots — likely version strings or domain names
  if ((token.match(/\./g) ?? []).length > 2) return false;

  // Require character diversity: must have mixed case AND at least one digit
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (!(hasUpper && hasLower && hasDigit)) return false;

  return true;
}

/**
 * Find high-entropy tokens that look like secrets.
 * Only flags strings that look like base64/hex (not prose).
 */
export function findHighEntropyTokens(text: string): string[] {
  const tokenRegex = /[A-Za-z0-9+/=_\-]{32,}/g;
  const suspicious: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    const token = match[0];
    if (
      token.length >= MIN_HIGH_ENTROPY_LENGTH &&
      shannonEntropy(token) >= ENTROPY_THRESHOLD &&
      looksLikeSecret(token)
    ) {
      suspicious.push(token);
    }
  }

  return suspicious;
}

// ── Post-redaction scanner ────────────────────────────────────────────────────

/**
 * Scan text for remaining suspicious strings after redaction has already run.
 * Does NOT modify the text — only reports what it finds.
 * Used for the second-pass PII re-scan in the CLI before upload.
 */
export function scanForRemaining(text: string): string[] {
  const hits: string[] = [];

  for (const pattern of BUILT_IN_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const match = m[0];
      if (pattern.allow && pattern.allow(match)) continue;
      hits.push(`[${pattern.name}] ${match.slice(0, 80)}`);
    }
  }

  const highEntropyTokens = findHighEntropyTokens(text);
  for (const token of highEntropyTokens) {
    hits.push(`[high-entropy] ${token.slice(0, 80)}`);
  }

  return hits;
}

// ── Username redaction ─────────────────────────────────────────────────────────

/**
 * Replace a username with a stable hash so that sessions from the same user
 * are linkable without revealing the actual username.
 */
function hashUsername(username: string): string {
  return "user_" + createHash("sha256").update(username).digest("hex").slice(0, 8);
}

// ── Main redactor ─────────────────────────────────────────────────────────────

export interface RedactionOptions {
  enabled: boolean;
  customPatterns?: string[];
  redactUsernames?: string[];
  redactStrings?: string[];
  redactHighEntropy?: boolean;
}

export interface RedactionResult {
  text: string;
  redactedCount: number;
  types: string[];
}

/**
 * Redact secrets from a single string.
 */
export function redactText(
  text: string,
  options: RedactionOptions
): RedactionResult {
  if (!options.enabled) return { text, redactedCount: 0, types: [] };

  let result = text;
  let redactedCount = 0;
  const types: string[] = [];

  // Apply built-in patterns
  for (const pattern of BUILT_IN_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    result = result.replace(re, (match) => {
      if (pattern.allow && pattern.allow(match)) return match;
      redactedCount++;
      if (!types.includes(pattern.name)) types.push(pattern.name);
      return pattern.placeholder(match);
    });
  }

  // Apply custom user-provided regex patterns
  for (const patternStr of options.customPatterns ?? []) {
    try {
      const re = new RegExp(patternStr, "g");
      result = result.replace(re, () => {
        redactedCount++;
        if (!types.includes("custom")) types.push("custom");
        return "[REDACTED:custom]";
      });
    } catch {
      // ignore invalid regex
    }
  }

  // Redact specific strings provided by user
  for (const s of options.redactStrings ?? []) {
    if (result.includes(s)) {
      result = result.split(s).join("[REDACTED:user-specified]");
      redactedCount++;
      if (!types.includes("user-specified")) types.push("user-specified");
    }
  }

  // Redact usernames (replace with stable hashes).
  // Always include the current OS username + homedir to catch paths like /home/<user>/...
  const { username: osUsername, homedir } = userInfo();
  const usernamesToRedact = Array.from(
    new Set([osUsername, homedir, ...(options.redactUsernames ?? [])])
  ).filter(Boolean);

  for (const username of usernamesToRedact) {
    if (result.includes(username)) {
      const hashed = hashUsername(username);
      result = result.split(username).join(hashed);
      // Also redact the hyphen-encoded form: -username- (appears in Claude Code
      // project directory names embedded in conversation text)
      result = result.split(`-${username}-`).join(`-${hashed}-`);
      redactedCount++;
      if (!types.includes("username")) types.push("username");
    }
  }

  // High-entropy detection (opt-in, disabled by default to avoid false positives)
  if (options.redactHighEntropy) {
    const highEntropyTokens = findHighEntropyTokens(result);
    for (const token of highEntropyTokens) {
      result = result.split(token).join("[REDACTED:high-entropy]");
      redactedCount++;
      if (!types.includes("high-entropy")) types.push("high-entropy");
    }
  }

  return { text: result, redactedCount, types };
}

/**
 * Apply redaction to all message content in a session.
 * Returns a new session object (does not mutate the input).
 */
export function redactSession(
  session: Session,
  options: RedactionOptions
): { session: Session; totalRedacted: number; types: string[] } {
  if (!options.enabled) {
    return { session, totalRedacted: 0, types: [] };
  }

  let totalRedacted = 0;
  const allTypes = new Set<string>();

  const redactedMessages: Message[] = session.messages.map((msg) => {
    const contentResult = redactText(msg.content, options);
    totalRedacted += contentResult.redactedCount;
    contentResult.types.forEach((t) => allTypes.add(t));

    let thinking = msg.thinking;
    if (thinking) {
      const thinkingResult = redactText(thinking, options);
      thinking = thinkingResult.text;
      totalRedacted += thinkingResult.redactedCount;
      thinkingResult.types.forEach((t) => allTypes.add(t));
    }

    const toolUses = msg.tool_uses?.map((tu) => {
      const summaryResult = redactText(tu.input_summary, options);
      totalRedacted += summaryResult.redactedCount;
      summaryResult.types.forEach((t) => allTypes.add(t));

      let result = tu.result;
      if (result) {
        const resultRedaction = redactText(result, options);
        result = resultRedaction.text;
        totalRedacted += resultRedaction.redactedCount;
        resultRedaction.types.forEach((t) => allTypes.add(t));
      }

      return { ...tu, input_summary: summaryResult.text, result };
    });

    return {
      ...msg,
      content: contentResult.text,
      thinking,
      tool_uses: toolUses,
    };
  });

  return {
    session: { ...session, messages: redactedMessages },
    totalRedacted,
    types: Array.from(allTypes),
  };
}
