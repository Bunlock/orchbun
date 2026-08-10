import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function newRunId(agent: string): string {
  return `${compactTimestamp()}-${agent}-${randomBytes(3).toString("hex")}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n[…truncated by Orchbun…]";
  return `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}

export function safeWorkspacePath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Context path must be relative: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Context path leaves workspace: ${relativePath}`);
  }
  return resolved;
}

export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "item";
}
