import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WriteJsonOptions {
  /** 2-space indentation for small files people read; compact for large data files. */
  pretty?: boolean;
}

/**
 * Serializes with keys in the order the objects were built. The builders
 * construct every object in contract field order, so output is stable.
 */
export function serializeJson(value: unknown, options: WriteJsonOptions = {}): string {
  return `${JSON.stringify(value, null, options.pretty ? 2 : undefined)}\n`;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows can briefly refuse a rename while another process reads the target.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Writes JSON atomically: a temp file in the same directory, then a rename over the target. */
export async function writeJsonAtomic(file: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(temp, serializeJson(value, options), "utf8");
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Parsed JSON, or null when the file is missing or unreadable. */
export async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export function seasonGamesPath(outDir: string, season: number): string {
  return path.join(outDir, "seasons", String(season), "games.json");
}

export function seasonStandingsPath(outDir: string, season: number): string {
  return path.join(outDir, "seasons", String(season), "standings.json");
}

export function seasonConceptsPath(outDir: string, season: number): string {
  return path.join(outDir, "seasons", String(season), "concepts.json");
}

export function recapPath(outDir: string, gameId: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(gameId)) throw new Error(`Unsafe game id for a file name: "${gameId}"`);
  return path.join(outDir, "games", `${gameId}.json`);
}

export function indexPath(outDir: string): string {
  return path.join(outDir, "index.json");
}

export interface PublishedSet {
  /** Seasons listed in the index this run writes. */
  seasons: ReadonlySet<number>;
  /** Game ids whose row in a published season has has_recap=true. */
  recapIds: ReadonlySet<string>;
}

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Removes collector-shaped outputs the new index no longer references:
 * games/<id>.json without has_recap in a published season, and seasons/<year>/
 * folders for seasons that left the published range. The output folder is
 * deployed as a whole and carried between CI runs, so anything left behind
 * would stay public and fail verify. Only these two shapes are touched; other
 * files in the output folder are left alone. Returns the removed paths
 * (relative, posix).
 */
export async function pruneUnpublished(outDir: string, published: PublishedSet): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await listDir(path.join(outDir, "games"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (published.recapIds.has(entry.name.slice(0, -".json".length))) continue;
    await rm(path.join(outDir, "games", entry.name), { force: true });
    removed.push(`games/${entry.name}`);
  }
  for (const entry of await listDir(path.join(outDir, "seasons"))) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    if (published.seasons.has(Number(entry.name))) continue;
    await rm(path.join(outDir, "seasons", entry.name), { recursive: true, force: true });
    removed.push(`seasons/${entry.name}/`);
  }
  return removed.sort();
}
