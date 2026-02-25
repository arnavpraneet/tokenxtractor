/**
 * Build the upload path for a session file.
 * Format: YYYY/MM/DD/<filename>.<ext>
 */
export function buildUploadPath(
  filename: string,
  ext: "json" | "md",
  date: Date = new Date()
): string {
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}/${filename}.${ext}`;
}
