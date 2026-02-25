export interface UploadFile {
  path: string;
  content: string;
}

export interface UploadResult {
  destination: string;
  paths: string[];
  urls: string[];
}

export interface IUploader {
  name: string;
  upload(files: UploadFile[]): Promise<UploadResult>;
}

export { GitHubUploader } from "./github.js";
export { HuggingFaceUploader } from "./huggingface.js";
export { buildUploadPath } from "./pathBuilder.js";
