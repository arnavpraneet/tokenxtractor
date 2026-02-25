import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HuggingFaceUploader } from "./huggingface.js";

// ── Mock fetch ────────────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Helper to create a mock fetch response */
function mockResponse(
  status: number,
  body: string | object = "",
  ok?: boolean
): Response {
  const isOk = ok !== undefined ? ok : status >= 200 && status < 300;
  return {
    ok: isOk,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "object" ? body : JSON.parse(body)),
  } as Response;
}

// ── Constructor validation ────────────────────────────────────────────────────

describe("HuggingFaceUploader — constructor", () => {
  it("throws for a slug with no slash", () => {
    expect(() => new HuggingFaceUploader("token", "nodeslash")).toThrow(
      /Invalid HuggingFace repo slug/
    );
  });

  it("throws for an empty slug", () => {
    expect(() => new HuggingFaceUploader("token", "")).toThrow(
      /Invalid HuggingFace repo slug/
    );
  });

  it("throws when owner is empty (/repo)", () => {
    expect(() => new HuggingFaceUploader("token", "/repo")).toThrow(
      /Invalid HuggingFace repo slug/
    );
  });

  it("throws when repo is empty (owner/)", () => {
    expect(() => new HuggingFaceUploader("token", "owner/")).toThrow(
      /Invalid HuggingFace repo slug/
    );
  });

  it("does not throw for a valid owner/repo slug", () => {
    expect(() => new HuggingFaceUploader("token", "owner/repo")).not.toThrow();
  });
});

// ── upload — success ──────────────────────────────────────────────────────────

describe("HuggingFaceUploader — upload success", () => {
  it("POSTs to the correct HuggingFace commit URL", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("hf_token", "myowner/myrepo");
    await uploader.upload([{ path: "f.json", content: "data" }]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://huggingface.co/api/datasets/myowner/myrepo/commit/main",
      expect.any(Object)
    );
  });

  it("sends Authorization: Bearer <token> header", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("hf_mytoken", "owner/repo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer hf_mytoken"
    );
  });

  it("sends Content-Type: application/json header", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("request body contains operations array with addOrModifyFile type", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.upload([{ path: "2024/01/01/file.json", content: "hello" }]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0]._type).toBe("addOrModifyFile");
    expect(body.operations[0].key).toBe("2024/01/01/file.json");
  });

  it("encodes file content as base64 in the operation value", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const content = "hello world content";
    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.upload([{ path: "f.json", content }]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);
    const expectedBase64 = Buffer.from(content, "utf8").toString("base64");
    expect(body.operations[0].value.content).toBe(expectedBase64);
    expect(body.operations[0].value.encoding).toBe("base64");
  });

  it("summary is singular for 1 file", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.upload([{ path: "f.json", content: "" }]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);
    expect(body.summary).toContain("1 file");
    expect(body.summary).not.toContain("1 files");
  });

  it("summary is plural for multiple files", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.upload([
      { path: "a.json", content: "" },
      { path: "a.md", content: "" },
    ]);

    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);
    expect(body.summary).toContain("2 files");
  });

  it("returns UploadResult with destination huggingface", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    const result = await uploader.upload([{ path: "f.json", content: "" }]);

    expect(result.destination).toBe("huggingface");
  });

  it("returns paths array containing each uploaded file path", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    const result = await uploader.upload([
      { path: "a.json", content: "" },
      { path: "b.md", content: "" },
    ]);

    expect(result.paths).toContain("a.json");
    expect(result.paths).toContain("b.md");
  });

  it("returns URLs in the format https://huggingface.co/datasets/<owner>/<repo>/blob/main/<path>", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "myowner/myrepo");
    const result = await uploader.upload([{ path: "2024/01/01/sess.json", content: "" }]);

    expect(result.urls[0]).toBe(
      "https://huggingface.co/datasets/myowner/myrepo/blob/main/2024/01/01/sess.json"
    );
  });
});

// ── upload — failure ──────────────────────────────────────────────────────────

describe("HuggingFaceUploader — upload failure", () => {
  it("throws with status and body text when response.ok is false", async () => {
    mockFetch.mockResolvedValue(mockResponse(422, "Validation error", false));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await expect(
      uploader.upload([{ path: "f.json", content: "" }])
    ).rejects.toThrow(/422/);
  });

  it("error message includes the response body text", async () => {
    mockFetch.mockResolvedValue(mockResponse(500, "Internal server error", false));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await expect(
      uploader.upload([{ path: "f.json", content: "" }])
    ).rejects.toThrow(/Internal server error/);
  });
});

// ── ensureRepoExists — repo exists ────────────────────────────────────────────

describe("HuggingFaceUploader — ensureRepoExists (repo exists)", () => {
  it("makes a GET request to check if dataset exists", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("hf_token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://huggingface.co/api/datasets/owner/repo",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer hf_token" }),
      })
    );
  });

  it("makes only one fetch call when repo already exists (200)", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── ensureRepoExists — repo does not exist (404) ──────────────────────────────

describe("HuggingFaceUploader — ensureRepoExists (404 — create)", () => {
  it("makes a second POST fetch when GET returns 404", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(404, "Not Found", false))
      .mockResolvedValueOnce(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("POSTs to the datasets endpoint when 404", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(404, "", false))
      .mockResolvedValueOnce(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await uploader.ensureRepoExists();

    const createCall = mockFetch.mock.calls[1];
    expect(createCall[0]).toBe("https://huggingface.co/api/datasets");
    expect(createCall[1].method).toBe("POST");
  });

  it("POST body has correct dataset creation payload", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(404, "", false))
      .mockResolvedValueOnce(mockResponse(200));

    const uploader = new HuggingFaceUploader("token", "owner/myrepo");
    await uploader.ensureRepoExists();

    const createCallArgs = mockFetch.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(createCallArgs.body as string);
    expect(body.name).toBe("myrepo");
    expect(body.private).toBe(false);
    expect(body.type).toBe("dataset");
  });

  it("throws when the create POST fails", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(404, "", false))
      .mockResolvedValueOnce(mockResponse(403, "Forbidden", false));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await expect(uploader.ensureRepoExists()).rejects.toThrow(/403/);
  });
});

// ── ensureRepoExists — non-404 GET error ──────────────────────────────────────

describe("HuggingFaceUploader — ensureRepoExists (non-404 GET error)", () => {
  it("throws with the status code when GET returns a non-404 error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403, "Forbidden", false));

    const uploader = new HuggingFaceUploader("token", "owner/repo");
    await expect(uploader.ensureRepoExists()).rejects.toThrow(/403/);
  });
});
