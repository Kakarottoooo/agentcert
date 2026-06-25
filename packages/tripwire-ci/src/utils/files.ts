import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { force: true, recursive: true });
  await ensureDir(dir);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

export function relativePath(fromDir: string, target: string): string {
  return path.relative(fromDir, target).split(path.sep).join("/");
}

export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
