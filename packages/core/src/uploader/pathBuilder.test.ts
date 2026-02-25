import { describe, it, expect } from "vitest";
import { buildUploadPath } from "./pathBuilder.js";

describe("buildUploadPath", () => {
  it("returns YYYY/MM/DD/filename.json format for json extension", () => {
    const date = new Date("2024-06-15T12:00:00Z");
    const result = buildUploadPath("my-session", "json", date);
    expect(result).toBe("2024/06/15/my-session.json");
  });

  it("returns YYYY/MM/DD/filename.md format for md extension", () => {
    const date = new Date("2024-06-15T12:00:00Z");
    const result = buildUploadPath("my-session", "md", date);
    expect(result).toBe("2024/06/15/my-session.md");
  });

  it("zero-pads month for January (month 1 → '01')", () => {
    const date = new Date("2024-01-20T00:00:00Z");
    const result = buildUploadPath("file", "json", date);
    expect(result).toMatch(/^2024\/01\//);
  });

  it("zero-pads day for first of month (day 1 → '01')", () => {
    const date = new Date("2024-06-01T00:00:00Z");
    const result = buildUploadPath("file", "json", date);
    expect(result).toMatch(/^2024\/06\/01\//);
  });

  it("handles December 31", () => {
    const date = new Date("2024-12-31T23:59:59Z");
    const result = buildUploadPath("session", "md", date);
    expect(result).toBe("2024/12/31/session.md");
  });

  it("uses UTC date, not local time", () => {
    // Jan 1, 2024 at 23:00 UTC is still Jan 1 in UTC
    const date = new Date("2024-01-01T23:00:00Z");
    const result = buildUploadPath("f", "json", date);
    expect(result).toMatch(/^2024\/01\/01\//);
  });

  it("uses current UTC date when no date argument is provided", () => {
    const result = buildUploadPath("file", "json");
    expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2}\/file\.json$/);
  });

  it("passes filename through verbatim with hyphens and underscores", () => {
    const date = new Date("2024-03-10T00:00:00Z");
    const result = buildUploadPath("claude-code_abc-123-def", "json", date);
    expect(result).toBe("2024/03/10/claude-code_abc-123-def.json");
  });

  it("handles a UUID-style filename", () => {
    const date = new Date("2024-07-04T00:00:00Z");
    const filename = "claude-code_550e8400-e29b-41d4-a716-446655440000";
    const result = buildUploadPath(filename, "md", date);
    expect(result).toBe(`2024/07/04/${filename}.md`);
  });

  it("path has exactly 4 segments separated by slashes", () => {
    const date = new Date("2024-09-22T00:00:00Z");
    const result = buildUploadPath("session", "json", date);
    const parts = result.split("/");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("2024");
    expect(parts[1]).toBe("09");
    expect(parts[2]).toBe("22");
    expect(parts[3]).toBe("session.json");
  });

  it("handles leap year date (Feb 29, 2024)", () => {
    const date = new Date("2024-02-29T00:00:00Z");
    const result = buildUploadPath("f", "json", date);
    expect(result).toBe("2024/02/29/f.json");
  });
});
