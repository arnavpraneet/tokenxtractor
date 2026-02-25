import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(),
}));

import { Octokit } from "@octokit/rest";
import { GitHubUploader } from "./github.js";

// ── Mock setup ────────────────────────────────────────────────────────────────

let mockGetContent: ReturnType<typeof vi.fn>;
let mockCreateOrUpdate: ReturnType<typeof vi.fn>;
let mockGet: ReturnType<typeof vi.fn>;
let mockCreateForUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  mockGetContent = vi.fn();
  mockCreateOrUpdate = vi.fn();
  mockGet = vi.fn();
  mockCreateForUser = vi.fn();

  vi.mocked(Octokit).mockImplementation(
    () =>
      ({
        repos: {
          getContent: mockGetContent,
          createOrUpdateFileContents: mockCreateOrUpdate,
          get: mockGet,
          createForAuthenticatedUser: mockCreateForUser,
        },
      }) as unknown as Octokit
  );
});

// ── Constructor validation ────────────────────────────────────────────────────

describe("GitHubUploader — constructor", () => {
  it("throws for a slug with no slash", () => {
    expect(() => new GitHubUploader("token", "nodeslash")).toThrow(
      /Invalid GitHub repo slug/
    );
  });

  it("throws for an empty slug", () => {
    expect(() => new GitHubUploader("token", "")).toThrow(
      /Invalid GitHub repo slug/
    );
  });

  it("throws when owner is empty (/repo)", () => {
    expect(() => new GitHubUploader("token", "/repo")).toThrow(
      /Invalid GitHub repo slug/
    );
  });

  it("throws when repo is empty (owner/)", () => {
    expect(() => new GitHubUploader("token", "owner/")).toThrow(
      /Invalid GitHub repo slug/
    );
  });

  it("does not throw for a valid owner/repo slug", () => {
    expect(() => new GitHubUploader("token", "owner/repo")).not.toThrow();
  });
});

// ── upload — new file (404 on getContent) ─────────────────────────────────────

describe("GitHubUploader — upload new file", () => {
  it("proceeds without sha when getContent returns 404", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({
      data: { content: { html_url: "https://github.com/owner/repo/blob/main/path.json" } },
    });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.upload([{ path: "2024/01/01/file.json", content: "hello" }]);

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sha: undefined })
    );
  });

  it("encodes file content as base64", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({
      data: { content: { html_url: null } },
    });

    const content = "hello world";
    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.upload([{ path: "path.json", content }]);

    const expectedBase64 = Buffer.from(content, "utf8").toString("base64");
    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: expectedBase64 })
    );
  });

  it("commit message is 'Add agent chat session: <file.path>'", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({ data: { content: {} } });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.upload([{ path: "2024/06/15/session.json", content: "" }]);

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Add agent chat session: 2024/06/15/session.json",
      })
    );
  });

  it("passes owner and repo to createOrUpdateFileContents", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({ data: { content: {} } });

    const uploader = new GitHubUploader("mytoken", "myowner/myrepo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "myowner", repo: "myrepo" })
    );
  });

  it("returns UploadResult with destination github and the file path", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({
      data: { content: { html_url: "https://github.com/owner/repo/blob/main/f.json" } },
    });

    const uploader = new GitHubUploader("token", "owner/repo");
    const result = await uploader.upload([{ path: "f.json", content: "data" }]);

    expect(result.destination).toBe("github");
    expect(result.paths).toContain("f.json");
  });

  it("uses html_url from response when present", async () => {
    const htmlUrl = "https://github.com/owner/repo/blob/main/f.json";
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({
      data: { content: { html_url: htmlUrl } },
    });

    const uploader = new GitHubUploader("token", "owner/repo");
    const result = await uploader.upload([{ path: "f.json", content: "" }]);

    expect(result.urls).toContain(htmlUrl);
  });

  it("falls back to constructed URL when html_url is absent", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockResolvedValue({ data: { content: {} } });

    const uploader = new GitHubUploader("token", "owner/repo");
    const result = await uploader.upload([{ path: "path/file.json", content: "" }]);

    expect(result.urls[0]).toContain("github.com/owner/repo");
    expect(result.urls[0]).toContain("path/file.json");
  });
});

// ── upload — existing file (sha from getContent) ──────────────────────────────

describe("GitHubUploader — upload existing file", () => {
  it("passes sha to createOrUpdateFileContents when getContent returns a file", async () => {
    mockGetContent.mockResolvedValue({
      data: { type: "file", sha: "abc123def456" },
    });
    mockCreateOrUpdate.mockResolvedValue({ data: { content: {} } });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123def456" })
    );
  });

  it("does not set sha when getContent returns a directory (array)", async () => {
    mockGetContent.mockResolvedValue({ data: [] }); // array = directory listing
    mockCreateOrUpdate.mockResolvedValue({ data: { content: {} } });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sha: undefined })
    );
  });
});

// ── upload — error handling ───────────────────────────────────────────────────

describe("GitHubUploader — upload error handling", () => {
  it("rethrows non-404 error from getContent", async () => {
    mockGetContent.mockRejectedValue({ status: 403, message: "Forbidden" });

    const uploader = new GitHubUploader("token", "owner/repo");
    await expect(
      uploader.upload([{ path: "f.json", content: "" }])
    ).rejects.toMatchObject({ status: 403 });
  });

  it("propagates errors from createOrUpdateFileContents", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate.mockRejectedValue(new Error("API error"));

    const uploader = new GitHubUploader("token", "owner/repo");
    await expect(
      uploader.upload([{ path: "f.json", content: "" }])
    ).rejects.toThrow("API error");
  });
});

// ── upload — multiple files ───────────────────────────────────────────────────

describe("GitHubUploader — upload multiple files", () => {
  it("uploads each file and returns all paths and urls", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    mockCreateOrUpdate
      .mockResolvedValueOnce({ data: { content: { html_url: "https://github.com/o/r/blob/main/a.json" } } })
      .mockResolvedValueOnce({ data: { content: { html_url: "https://github.com/o/r/blob/main/a.md" } } });

    const uploader = new GitHubUploader("token", "o/r");
    const result = await uploader.upload([
      { path: "a.json", content: "json content" },
      { path: "a.md", content: "md content" },
    ]);

    expect(result.paths).toHaveLength(2);
    expect(result.paths).toContain("a.json");
    expect(result.paths).toContain("a.md");
    expect(result.urls).toHaveLength(2);
    expect(mockCreateOrUpdate).toHaveBeenCalledTimes(2);
  });
});

// ── ensureRepoExists ──────────────────────────────────────────────────────────

describe("GitHubUploader — ensureRepoExists", () => {
  it("does not call createForAuthenticatedUser when repo exists (get resolves)", async () => {
    mockGet.mockResolvedValue({ data: { full_name: "owner/repo" } });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockCreateForUser).not.toHaveBeenCalled();
  });

  it("calls createForAuthenticatedUser when repo does not exist (404)", async () => {
    mockGet.mockRejectedValue({ status: 404 });
    mockCreateForUser.mockResolvedValue({ data: {} });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockCreateForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "repo",
        private: false,
        auto_init: true,
      })
    );
  });

  it("uses the provided description in createForAuthenticatedUser", async () => {
    mockGet.mockRejectedValue({ status: 404 });
    mockCreateForUser.mockResolvedValue({ data: {} });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.ensureRepoExists("My custom description");

    expect(mockCreateForUser).toHaveBeenCalledWith(
      expect.objectContaining({ description: "My custom description" })
    );
  });

  it("uses default description 'Agent chat sessions dataset' when not specified", async () => {
    mockGet.mockRejectedValue({ status: 404 });
    mockCreateForUser.mockResolvedValue({ data: {} });

    const uploader = new GitHubUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockCreateForUser).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Agent chat sessions dataset" })
    );
  });

  it("rethrows non-404 error from repos.get", async () => {
    mockGet.mockRejectedValue({ status: 403, message: "Forbidden" });

    const uploader = new GitHubUploader("token", "owner/repo");
    await expect(uploader.ensureRepoExists()).rejects.toMatchObject({ status: 403 });
  });
});
