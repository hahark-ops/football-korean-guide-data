import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const SCHEDULE_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv";

export function playByPlayUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
}

export interface SourceOptions {
  cacheDir: string;
  /** Reuse a cached copy younger than this. */
  maxAgeMs: number;
  /** Never touch the network; fail when the cache has no copy. */
  offline: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export interface SourceText {
  url: string;
  text: string;
  /** When the bytes were downloaded from the source (cache file time for cache hits). */
  fetchedAt: string;
  fromCache: boolean;
}

export class SourceNotFoundError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Source not found (404): ${url}`);
    this.url = url;
  }
}

export function cacheFileName(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const base = (url.split("/").pop() ?? "source").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${hash}-${base}`;
}

function decode(url: string, bytes: Buffer): string {
  const gz = url.endsWith(".gz") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  return (gz ? gunzipSync(bytes) : bytes).toString("utf8");
}

async function readCache(file: string): Promise<{ bytes: Buffer; mtimeMs: number } | null> {
  try {
    const info = await stat(file);
    return { bytes: await readFile(file), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Downloads `url` through a disk cache keyed by URL. A fresh cache hit skips
 * the network; a failed download falls back to an older cached copy with a
 * warning so a flaky connection does not block a run.
 */
export async function loadSourceText(url: string, options: SourceOptions): Promise<SourceText> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const file = path.join(options.cacheDir, cacheFileName(url));
  const cached = await readCache(file);

  const fromCache = (entry: { bytes: Buffer; mtimeMs: number }): SourceText => ({
    url,
    text: decode(url, entry.bytes),
    fetchedAt: new Date(entry.mtimeMs).toISOString(),
    fromCache: true,
  });

  if (options.offline) {
    if (!cached) throw new Error(`--offline: no cached copy of ${url}`);
    return fromCache(cached);
  }
  // A cache file dated in the future (clock change) is treated as stale.
  const age = cached ? now() - cached.mtimeMs : Number.NaN;
  if (cached && age >= 0 && age < options.maxAgeMs) return fromCache(cached);

  const fetchImpl = options.fetchImpl ?? fetch;
  let bytes: Buffer;
  try {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (response.status === 404) throw new SourceNotFoundError(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof SourceNotFoundError || !cached) throw error;
    log(`download failed, using cached copy from ${new Date(cached.mtimeMs).toISOString()}: ${String(error)}`);
    return fromCache(cached);
  }

  const text = decode(url, bytes);
  await mkdir(options.cacheDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, file);
  return { url, text, fetchedAt: new Date(now()).toISOString(), fromCache: false };
}
