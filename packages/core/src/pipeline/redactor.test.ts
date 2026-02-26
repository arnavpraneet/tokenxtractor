import { describe, it, expect } from "vitest";
import { redactText, redactSession, findHighEntropyTokens, scanForRemaining } from "./redactor.js";
import type { Session } from "../schema.js";

const BASE_OPTS = {
  enabled: true,
  customPatterns: [],
  redactUsernames: [],
  redactStrings: [],
};

// ── redactText: disabled ──────────────────────────────────────────────────────

describe("redactText — disabled", () => {
  it("returns text unchanged when enabled is false", () => {
    const text = "my secret token ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const { text: out, redactedCount } = redactText(text, { ...BASE_OPTS, enabled: false });
    expect(out).toBe(text);
    expect(redactedCount).toBe(0);
  });
});

// ── redactText: built-in patterns ────────────────────────────────────────────

describe("redactText — built-in patterns", () => {
  it("redacts GitHub personal access tokens (ghp_)", () => {
    const text = "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("ghp_");
    expect(types).toContain("github-token");
  });

  it("redacts GitHub OAuth tokens (gho_)", () => {
    const text = "oauth: gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("gho_");
    expect(types).toContain("github-oauth");
  });

  it("redacts Anthropic API keys (sk-ant-)", () => {
    const text = "key: sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890-AAAA";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("sk-ant-");
    expect(types).toContain("anthropic-key");
  });

  it("redacts OpenAI API keys (sk-)", () => {
    const text = "OPENAI_API_KEY=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRs";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("sk-aB");
    expect(types).toContain("openai-key");
  });

  it("redacts HuggingFace tokens (hf_)", () => {
    const text = "HF_TOKEN=hf_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFg";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("hf_");
    expect(types).toContain("huggingface-token");
  });

  it("preserves non-secret text around redacted tokens", () => {
    const text = "before ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc after";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("[REDACTED");
  });

  it("increments redactedCount when secrets are found", () => {
    const text = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc and ghp_XYZaBcDeFgHiJkLmNoPqRsTuVwXyZ123";
    const { redactedCount } = redactText(text, BASE_OPTS);
    expect(redactedCount).toBeGreaterThanOrEqual(1);
  });
});

// ── redactText: new secret patterns ──────────────────────────────────────────

describe("redactText — new secret patterns", () => {
  it("redacts JWT tokens (eyJ...)", () => {
    // Use JWT directly without Bearer prefix so bearer-token pattern doesn't fire first
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { text: out, types } = redactText(`token: ${token}`, BASE_OPTS);
    expect(out).not.toContain("eyJhbGci");
    expect(types).toContain("jwt");
  });

  it("redacts PyPI tokens (pypi-...)", () => {
    const text = "PYPI_TOKEN=pypi-AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEy";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("pypi-Ag");
    expect(types).toContain("pypi-token");
  });

  it("redacts NPM tokens (npm_...)", () => {
    const text = "NPM_TOKEN=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmN";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("npm_aB");
    expect(types).toContain("npm-token");
  });

  it("redacts Slack webhook URLs", () => {
    // Assembled to avoid triggering secret scanning on a fake test URL
    const fakeWebhook = ["https://hooks.slack.com", "services", "T12345678", "B12345678", "abcdefghijklmnopqrstuvwx"].join("/");
    const text = `webhook: ${fakeWebhook}`;
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("hooks.slack.com");
    expect(types).toContain("slack-webhook");
  });

  it("redacts Discord webhook URLs", () => {
    const text = "https://discord.com/api/webhooks/123456789/ABCDEFGHIJKLMNOPabcdefghijklmnop";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("discord.com/api/webhooks");
    expect(types).toContain("discord-webhook");
  });

  it("redacts CLI flag secrets (--token VALUE)", () => {
    const text = "git clone --token ghMySecretToken123456 https://github.com/org/repo";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("ghMySecretToken123456");
    expect(out).toContain("--token");
    expect(types).toContain("cli-secret");
  });

  it("redacts CLI flag secrets (--api-key VALUE)", () => {
    const text = "curl --api-key MyApiKeyABCDEFGH12345678 https://api.example.com";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("MyApiKeyABCDEFGH12345678");
    expect(out).toContain("--api-key");
    expect(types).toContain("cli-secret");
  });

  it("redacts URL query parameter secrets (?token=VALUE)", () => {
    const text = "https://api.example.com/data?token=MySecretToken12345678&format=json";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("MySecretToken12345678");
    expect(out).toContain("?token=");
    expect(types).toContain("url-secret");
  });

  it("redacts URL query parameter secrets (&api_key=VALUE)", () => {
    const text = "https://api.example.com/search?q=hello&api_key=SuperSecretKey9876&v=2";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("SuperSecretKey9876");
    expect(out).toContain("&api_key=");
    expect(types).toContain("url-secret");
  });

  it("redacts shell env var assignments (export TOKEN=VALUE)", () => {
    const text = "export API_TOKEN=MySecretApiToken12345678";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("MySecretApiToken12345678");
    expect(out).toContain("API_TOKEN=");
    expect(types).toContain("env-secret");
  });

  it("redacts shell env var assignments (SECRET_KEY=VALUE command)", () => {
    const text = "MY_SECRET_KEY=AbCdEfGhIjKlMnOp1234 ./run.sh";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("AbCdEfGhIjKlMnOp1234");
    expect(types).toContain("env-secret");
  });
});

// ── redactText: IPv4 allowlist ─────────────────────────────────────────────────

describe("redactText — IPv4 allowlist", () => {
  it("does NOT redact private range 192.168.x.x", () => {
    const text = "connect to 192.168.1.100 for local dev";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("192.168.1.100");
  });

  it("does NOT redact private range 10.x.x.x", () => {
    const text = "server at 10.0.0.1";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("10.0.0.1");
  });

  it("does NOT redact private range 172.16.x.x", () => {
    const text = "host 172.16.0.5 is internal";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("172.16.0.5");
  });

  it("does NOT redact well-known public DNS 8.8.8.8", () => {
    const text = "nameserver 8.8.8.8";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("8.8.8.8");
  });

  it("does NOT redact well-known public DNS 1.1.1.1", () => {
    const text = "nameserver 1.1.1.1";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("1.1.1.1");
  });

  it("does NOT redact loopback 127.0.0.1", () => {
    const text = "listening on 127.0.0.1:3000";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("127.0.0.1");
  });

  it("DOES redact public non-DNS IPs", () => {
    const text = "server is at 203.0.113.42";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("203.0.113.42");
    expect(types).toContain("ipv4");
  });
});

// ── redactText: email allowlist ───────────────────────────────────────────────

describe("redactText — email allowlist", () => {
  it("does NOT redact @example.com emails", () => {
    const text = "contact user@example.com for docs";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("user@example.com");
  });

  it("does NOT redact @github.com bot emails", () => {
    const text = "commit author: noreply@github.com";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("noreply@github.com");
  });

  it("does NOT redact @dependabot.com emails", () => {
    const text = "from: bot@dependabot.com";
    const { text: out } = redactText(text, BASE_OPTS);
    expect(out).toContain("bot@dependabot.com");
  });

  it("DOES redact real user emails", () => {
    const text = "user: john.doe@acmecorp.io signed in";
    const { text: out, types } = redactText(text, BASE_OPTS);
    expect(out).not.toContain("john.doe@acmecorp.io");
    expect(types).toContain("email");
  });
});

// ── redactText: username redaction ───────────────────────────────────────────

describe("redactText — username redaction", () => {
  it("replaces a username supplied via redactUsernames with a stable hash", () => {
    const text = "path: /home/testuser123/projects/myapp/src/index.ts";
    const { text: out, types } = redactText(text, {
      ...BASE_OPTS,
      redactUsernames: ["testuser123"],
    });
    expect(out).not.toContain("testuser123");
    expect(out).toContain("user_");
    expect(types).toContain("username");
  });

  it("produces a stable hash (same username always maps to same hash)", () => {
    const text = "hello testuser123 world";
    const opts = { ...BASE_OPTS, redactUsernames: ["testuser123"] };
    const { text: out1 } = redactText(text, opts);
    const { text: out2 } = redactText(text, opts);
    expect(out1).toBe(out2);
  });

  it("hash starts with user_", () => {
    const text = "/home/testuser123/file.txt";
    const { text: out } = redactText(text, { ...BASE_OPTS, redactUsernames: ["testuser123"] });
    expect(out).toMatch(/user_[0-9a-f]{8}/);
  });

  it("redacts the hyphen-encoded form of a username (-username-) in message content", () => {
    // Claude Code encodes project paths as -home-user-dev-myproject in JSONL content
    const text = "working on project at -home-testuser123-dev-myproject";
    const { text: out, types } = redactText(text, {
      ...BASE_OPTS,
      redactUsernames: ["testuser123"],
    });
    expect(out).not.toContain("testuser123");
    expect(types).toContain("username");
  });

  it("redacts the homedir path in message content (auto-included via OS userInfo)", () => {
    // The homedir is always added to the redact list alongside the OS username.
    // We simulate this by supplying it via redactUsernames (same code path in redactor).
    const text = "file saved to /home/testuser123/notes.txt";
    const { text: out, types } = redactText(text, {
      ...BASE_OPTS,
      redactUsernames: ["/home/testuser123"],
    });
    expect(out).not.toContain("/home/testuser123");
    expect(types).toContain("username");
  });
});

// ── redactText: custom patterns ──────────────────────────────────────────────

describe("redactText — customPatterns", () => {
  it("redacts text matching a custom regex", () => {
    const text = "my project ID is PROJ-12345 and another PROJ-99999";
    const { text: out, types } = redactText(text, {
      ...BASE_OPTS,
      customPatterns: ["PROJ-\\d+"],
    });
    expect(out).not.toContain("PROJ-12345");
    expect(out).not.toContain("PROJ-99999");
    expect(out).toContain("[REDACTED:custom]");
    expect(types).toContain("custom");
  });

  it("ignores invalid regex patterns without throwing", () => {
    expect(() =>
      redactText("some text", { ...BASE_OPTS, customPatterns: ["[invalid"] })
    ).not.toThrow();
  });
});

// ── redactText: redactStrings ─────────────────────────────────────────────────

describe("redactText — redactStrings", () => {
  it("redacts an exact string match", () => {
    const secret = "my-super-secret-value";
    const text = `config: ${secret} is used here`;
    const { text: out, types } = redactText(text, {
      ...BASE_OPTS,
      redactStrings: [secret],
    });
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:user-specified]");
    expect(types).toContain("user-specified");
  });
});

// ── findHighEntropyTokens ─────────────────────────────────────────────────────

describe("findHighEntropyTokens", () => {
  it("does not flag UUIDs", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const tokens = findHighEntropyTokens(uuid);
    expect(tokens).not.toContain(uuid);
  });

  it("does not flag version strings", () => {
    // Version strings have too many dots
    const tokens = findHighEntropyTokens("react@18.2.0.something.else.extra");
    expect(tokens.length).toBe(0);
  });

  it("does not flag lowercase-only or uppercase-only strings", () => {
    // No character diversity → not a secret
    const tokens = findHighEntropyTokens("abcdefghijklmnopqrstuvwxyzabcde12");
    // May or may not match depending on entropy, but diversity check should help
    // This test ensures the diversity check is applied
    for (const t of tokens) {
      const hasUpper = /[A-Z]/.test(t);
      const hasLower = /[a-z]/.test(t);
      const hasDigit = /[0-9]/.test(t);
      expect(hasUpper && hasLower && hasDigit).toBe(true);
    }
  });

  it("flags actual high-entropy mixed-character tokens", () => {
    // A realistic-looking random token
    const token = "xK9mP2nQ8rL5wJ3vF7tH1uD4sA6bC0eG";
    const tokens = findHighEntropyTokens(token);
    expect(tokens).toContain(token);
  });
});

// ── scanForRemaining ──────────────────────────────────────────────────────────

describe("scanForRemaining", () => {
  it("finds remaining secrets in already-processed text", () => {
    const text = '{"content": "my token is ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc"}';
    const hits = scanForRemaining(text);
    expect(hits.some((h) => h.includes("github-token"))).toBe(true);
  });

  it("returns empty array for clean text", () => {
    const text = '{"content": "this is a clean message with no secrets"}';
    const hits = scanForRemaining(text);
    expect(hits.length).toBe(0);
  });

  it("respects allowlists (private IPs not reported)", () => {
    const text = '{"host": "192.168.1.1"}';
    const hits = scanForRemaining(text);
    expect(hits.some((h) => h.includes("ipv4"))).toBe(false);
  });
});

// ── redactSession ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-id",
    tool: "claude-code",
    workspace: "myproject",
    captured_at: new Date().toISOString(),
    messages: [],
    stats: {
      user_messages: 0,
      assistant_messages: 0,
      tool_uses: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    metadata: {
      files_touched: [],
      uploader_version: "1.0.0",
    },
    ...overrides,
  };
}

describe("redactSession", () => {
  it("returns session unchanged when enabled is false", () => {
    const session = makeSession({
      messages: [{ role: "user", content: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc" }],
    });
    const { session: out, totalRedacted } = redactSession(session, { ...BASE_OPTS, enabled: false });
    expect(out.messages[0].content).toContain("ghp_");
    expect(totalRedacted).toBe(0);
  });

  it("redacts secrets in message content", () => {
    const session = makeSession({
      messages: [{ role: "user", content: "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc" }],
    });
    const { session: out, totalRedacted } = redactSession(session, BASE_OPTS);
    expect(out.messages[0].content).not.toContain("ghp_");
    expect(totalRedacted).toBeGreaterThan(0);
  });

  it("redacts secrets in tool_use input_summary", () => {
    const session = makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{
          tool: "Bash",
          input_summary: "run: export TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc",
        }],
      }],
    });
    const { session: out } = redactSession(session, BASE_OPTS);
    expect(out.messages[0].tool_uses![0].input_summary).not.toContain("ghp_");
  });

  it("redacts secrets in tool_use result", () => {
    const session = makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{
          tool: "Bash",
          input_summary: "list env vars",
          result: "ANTHROPIC_KEY=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890-AAAA",
        }],
      }],
    });
    const { session: out } = redactSession(session, BASE_OPTS);
    expect(out.messages[0].tool_uses![0].result).not.toContain("sk-ant-");
  });

  it("redacts username in input_summary when supplied via redactUsernames", () => {
    const session = makeSession({
      messages: [{
        role: "assistant",
        content: "",
        tool_uses: [{
          tool: "Read",
          input_summary: "/home/testuser123/project/src/app.ts",
        }],
      }],
    });
    const { session: out } = redactSession(session, {
      ...BASE_OPTS,
      redactUsernames: ["testuser123"],
    });
    expect(out.messages[0].tool_uses![0].input_summary).not.toContain("testuser123");
    expect(out.messages[0].tool_uses![0].input_summary).toContain("user_");
  });

  it("does not mutate the original session", () => {
    const session = makeSession({
      messages: [{ role: "user", content: "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc" }],
    });
    const original = session.messages[0].content;
    redactSession(session, BASE_OPTS);
    expect(session.messages[0].content).toBe(original);
  });

  it("accumulates types from all fields", () => {
    const session = makeSession({
      messages: [{
        role: "user",
        content: "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFg",
        tool_uses: [{
          tool: "Bash",
          input_summary: "run with TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc",
        }],
      }],
    });
    const { types } = redactSession(session, BASE_OPTS);
    expect(types).toContain("huggingface-token");
    expect(types).toContain("github-token");
  });
});
