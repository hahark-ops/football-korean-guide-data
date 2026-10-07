/**
 * nflverse -> static JSON collector.
 *
 *   npm run collect -- [--season 2026] [--out DIR] [--offline]
 *                      [--max-age-minutes 30] [--skip-recaps]
 *
 * Writes index.json, seasons/{season}/games.json, seasons/{season}/standings.json,
 * seasons/{season}/concepts.json and games/{gameId}.json under the output
 * directory (default collector/out). The output mirrors the index it writes:
 * games/*.json without has_recap and seasons/{season}/ folders outside the
 * published range are removed, so --season with the default output folder
 * replaces the other seasons there.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  GameRecapFile,
  PublicDataIndex,
  PublicDataSource,
  PublicGameRow,
  SeasonIndexEntry,
} from "../src/data/publicData.ts";
import { computeCloseness, type Closeness } from "./closeness.ts";
import { buildConceptExamples } from "./concepts.ts";
import { assertPublishable } from "./forbidden.ts";
import {
  indexPath,
  pruneUnpublished,
  readJsonIfExists,
  recapPath,
  seasonConceptsPath,
  seasonGamesPath,
  seasonStandingsPath,
  writeJsonAtomic,
  type WriteJsonOptions,
} from "./output.ts";
import { groupPlaysByGame, parsePlayRows } from "./pbp.ts";
import { buildGameRecap, isRecapStillValid, type ExplainPlay } from "./recap.ts";
import {
  buildSeasonIndexEntry,
  isFinal,
  isOffseasonMonth,
  nflSeasonForDate,
  parseSchedule,
  placeholderKickoffIds,
  seasonRows,
  toPublicGameRow,
  type ScheduleRow,
} from "./schedule.ts";
import { SCHEDULE_URL, SourceNotFoundError, loadSourceText, playByPlayUrl, type SourceOptions } from "./sources.ts";
import { buildStandings } from "./standings.ts";
import { teamShortKo } from "./teams.ts";

const COLLECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SOURCE: PublicDataSource = {
  name: "nflverse",
  url: "https://github.com/nflverse",
  license: "CC-BY-4.0",
  attributionKo: "경기 데이터: nflverse (CC BY 4.0)",
};

export interface CollectorOptions {
  season: number | null;
  outDir: string;
  cacheDir: string;
  offline: boolean;
  maxAgeMinutes: number;
  skipRecaps: boolean;
}

export function parseArgs(argv: readonly string[]): CollectorOptions {
  const options: CollectorOptions = {
    season: null,
    outDir: path.join(COLLECTOR_DIR, "out"),
    cacheDir: path.join(COLLECTOR_DIR, ".cache"),
    offline: false,
    maxAgeMinutes: 30,
    skipRecaps: false,
  };
  const args = argv.flatMap((arg) => (arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg]));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    const integer = (min: number): number => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${arg}: expected an integer >= ${min}, got "${raw}"`);
      return parsed;
    };
    switch (arg) {
      case "--season":
        options.season = integer(1999);
        break;
      case "--out":
        options.outDir = path.resolve(value());
        break;
      case "--cache-dir":
        options.cacheDir = path.resolve(value());
        break;
      case "--offline":
        options.offline = true;
        break;
      case "--max-age-minutes":
        options.maxAgeMinutes = integer(0);
        break;
      case "--skip-recaps":
        options.skipRecaps = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return options;
}

/** Seasons to publish, newest first: the target season, plus the previous one from March through August. */
export function seasonsToPublish(target: number | null, now: Date): number[] {
  const season = target ?? nflSeasonForDate(now);
  return isOffseasonMonth(now) ? [season, season - 1] : [season];
}

export interface SeasonSummary {
  season: number;
  games: number;
  finals: number;
  recapsWritten: number;
  recapsKept: number;
  recapsSkipped: number;
  /** Finals the play-by-play file does not cover yet (it is rebuilt nightly). */
  recapsAwaitingData: number;
  withRecap: number;
  /** Finals whose closeness is still the margin-only estimate. */
  closenessProvisional: number;
  /** Glossary terms with at least one real example in concepts.json. */
  conceptTerms: number;
}

export interface CollectorResult {
  index: PublicDataIndex;
  seasons: SeasonSummary[];
  warnings: string[];
  /** Output paths removed because the new index no longer references them. */
  removed: string[];
}

export interface CollectorDependencies {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Defaults to explainPlay from ./explain.ts, loaded only when recaps are built. */
  explain?: ExplainPlay;
  log?: (message: string) => void;
}

const CLOSENESS_VALUES: ReadonlySet<string> = new Set<Closeness>(["close_to_end", "close_once", "decided_early"]);

/**
 * Closeness measured from play-by-play by an earlier run, reused when this run
 * did not read play-by-play (--skip-recaps or no file) and the result is unchanged.
 */
function previousMeasuredCloseness(previous: PublicGameRow | undefined, row: ScheduleRow): Closeness | null {
  if (!previous || previous.status !== "final" || previous.closeness_provisional !== false) return null;
  if (previous.away_score !== row.awayScore || previous.home_score !== row.homeScore || previous.overtime !== row.overtime) {
    return null;
  }
  return typeof previous.closeness === "string" && CLOSENESS_VALUES.has(previous.closeness) ? previous.closeness : null;
}

/** Writes one output file after the betting/probability guard. */
async function publish(file: string, value: unknown, options?: WriteJsonOptions): Promise<void> {
  assertPublishable(file, value);
  await writeJsonAtomic(file, value, options);
}

function previousRows(value: unknown): Map<string, PublicGameRow> {
  const rows = new Map<string, PublicGameRow>();
  const games = (value as { games?: unknown } | null)?.games;
  if (!Array.isArray(games)) return rows;
  for (const game of games) {
    if (game && typeof game.id === "string" && typeof game.updated_at === "string") rows.set(game.id, game as PublicGameRow);
  }
  return rows;
}

async function loadExplainer(deps: CollectorDependencies): Promise<ExplainPlay> {
  if (deps.explain) return deps.explain;
  const module = (await import("./explain.ts")) as { explainPlay?: ExplainPlay };
  if (typeof module.explainPlay !== "function") throw new Error("collector/explain.ts does not export explainPlay");
  return module.explainPlay;
}

export async function runCollector(options: CollectorOptions, deps: CollectorDependencies = {}): Promise<CollectorResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.log(message));
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    log(`warning: ${message}`);
  };
  const sourceOptions: SourceOptions = {
    cacheDir: options.cacheDir,
    maxAgeMs: options.maxAgeMinutes * 60_000,
    offline: options.offline,
    fetchImpl: deps.fetchImpl,
    now: () => now().getTime(),
    log: warn,
  };

  const schedule = await loadSourceText(SCHEDULE_URL, sourceOptions);
  // Taken after the schedule download so a record is never older than the source check it reflects.
  const runAt = now().toISOString();
  const scheduleRows = parseSchedule(schedule.text);
  const entries: SeasonIndexEntry[] = [];
  const summaries: SeasonSummary[] = [];
  const publishedRecapIds = new Set<string>();

  for (const season of seasonsToPublish(options.season, now())) {
    const rows = seasonRows(scheduleRows, season);
    if (rows.length === 0) {
      warn(`season ${season}: the schedule has no games yet; not published`);
      continue;
    }
    const untimed = rows.filter((row) => row.gametime === null).map((row) => row.gameId);
    if (untimed.length > 0) warn(`season ${season}: no start time in the source for ${untimed.join(", ")}; kickoff_at uses 00:00 ET`);
    const gamesFile = seasonGamesPath(options.outDir, season);
    const previous = previousRows(await readJsonIfExists(gamesFile));
    const placeholderKickoffs = placeholderKickoffIds(rows);
    const measuredCloseness = new Map<string, Closeness>();
    const rowFor = (row: ScheduleRow, hasRecap: boolean) =>
      toPublicGameRow(row, {
        checkedAt: schedule.fetchedAt,
        runAt,
        hasRecap,
        previous: previous.get(row.gameId),
        kickoffTbd: placeholderKickoffs.has(row.gameId),
        closeness: measuredCloseness.get(row.gameId) ?? null,
      });

    const finals = rows.filter(isFinal);
    const hasRecap = new Map<string, boolean>();
    const recaps = new Map<string, GameRecapFile>();
    let playByPlayRead = false;
    const summary: SeasonSummary = {
      season,
      games: rows.length,
      finals: finals.length,
      recapsWritten: 0,
      recapsKept: 0,
      recapsSkipped: 0,
      recapsAwaitingData: 0,
      withRecap: 0,
      closenessProvisional: 0,
      conceptTerms: 0,
    };

    if (!options.skipRecaps && finals.length > 0) {
      let pbp: Awaited<ReturnType<typeof loadSourceText>> | null = null;
      try {
        pbp = await loadSourceText(playByPlayUrl(season), sourceOptions);
      } catch (error) {
        if (error instanceof SourceNotFoundError) warn(`season ${season}: no play-by-play file published yet`);
        else if (options.offline) warn(`season ${season}: ${error instanceof Error ? error.message : String(error)}`);
        else throw error;
      }
      if (pbp) {
        playByPlayRead = true;
        const finalIds = new Set(finals.map((row) => row.gameId));
        const playsByGame = groupPlaysByGame(parsePlayRows(pbp.text, (id) => finalIds.has(id)));
        const explain = await loadExplainer(deps);
        for (const row of finals) {
          const plays = playsByGame.get(row.gameId);
          if (!plays) {
            summary.recapsAwaitingData += 1;
            continue;
          }
          const closeness = computeCloseness(rowFor(row, false), plays);
          if (closeness) measuredCloseness.set(row.gameId, closeness);
          let result: ReturnType<typeof buildGameRecap>;
          try {
            result = buildGameRecap(rowFor(row, false), plays, {
              explain,
              teamShortKo,
              generatedAt: runAt,
              sourceCheckedAt: pbp.fetchedAt,
              warn,
            });
          } catch (error) {
            result = { ok: false, reason: `recap builder failed: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (result.ok) {
            await publish(recapPath(options.outDir, row.gameId), result.recap);
            hasRecap.set(row.gameId, true);
            recaps.set(row.gameId, result.recap);
            summary.recapsWritten += 1;
          } else {
            warn(`${row.gameId}: recap skipped (${result.reason})`);
            summary.recapsSkipped += 1;
          }
        }
      }
    }

    if (!playByPlayRead) {
      for (const row of finals) {
        const kept = previousMeasuredCloseness(previous.get(row.gameId), row);
        if (kept) measuredCloseness.set(row.gameId, kept);
      }
    }

    for (const row of finals) {
      if (hasRecap.has(row.gameId)) continue;
      const file = recapPath(options.outDir, row.gameId);
      const existing = await readJsonIfExists(file);
      if (existing === null) continue;
      const valid = isRecapStillValid(existing, rowFor(row, true));
      if (valid) {
        summary.recapsKept += 1;
        recaps.set(row.gameId, existing as GameRecapFile);
      } else {
        // Older files may carry win probability or miss contract fields; never leave them published.
        await rm(file, { force: true });
        warn(`${row.gameId}: existing recap no longer matches the schedule or the data contract; removed, has_recap=false`);
      }
      hasRecap.set(row.gameId, valid);
    }

    const games = rows.map((row) => rowFor(row, hasRecap.get(row.gameId) === true));
    for (const game of games) if (game.has_recap) publishedRecapIds.add(game.id);
    summary.withRecap = games.filter((game) => game.has_recap).length;
    summary.closenessProvisional = games.filter((game) => game.closeness_provisional).length;
    await publish(gamesFile, {
      schemaVersion: 1,
      season,
      generatedAt: runAt,
      sourceCheckedAt: schedule.fetchedAt,
      games,
    });
    await publish(
      seasonStandingsPath(options.outDir, season),
      buildStandings(season, games, { generatedAt: runAt, sourceCheckedAt: schedule.fetchedAt }),
      { pretty: true },
    );
    const concepts = buildConceptExamples(season, games, recaps, runAt);
    summary.conceptTerms = Object.keys(concepts.examples).length;
    await publish(seasonConceptsPath(options.outDir, season), concepts);
    entries.push(buildSeasonIndexEntry(season, games, schedule.fetchedAt));
    summaries.push(summary);
  }

  if (entries.length === 0) throw new Error("No season had schedule data; nothing was published.");
  entries.sort((a, b) => b.season - a.season);
  // A season that left the published range (2026 on 2027-09-01) or a recap that
  // lost has_recap would otherwise stay in the carried-over output and fail verify.
  const removed = await pruneUnpublished(options.outDir, {
    seasons: new Set(entries.map((entry) => entry.season)),
    recapIds: publishedRecapIds,
  });
  if (removed.length > 0) {
    const shown = removed.length > 10 ? `${removed.slice(0, 10).join(", ")} and ${removed.length - 10} more` : removed.join(", ");
    log(`removed ${removed.length} output path(s) the new index no longer references: ${shown}`);
  }
  const index: PublicDataIndex = {
    schemaVersion: 1,
    generatedAt: runAt,
    source: SOURCE,
    seasons: entries,
    latestSeason: entries[0].season,
  };
  await publish(indexPath(options.outDir), index, { pretty: true });
  return { index, seasons: summaries, warnings, removed };
}

export function formatSummary(result: CollectorResult, options: CollectorOptions): string {
  const lines = [`nflverse collector -> ${options.outDir}`];
  for (const season of result.seasons) {
    const entry = result.index.seasons.find((item) => item.season === season.season);
    const recaps = options.skipRecaps
      ? `recaps skipped by flag (${season.recapsKept} existing kept)`
      : `recaps written ${season.recapsWritten}, kept ${season.recapsKept}, skipped ${season.recapsSkipped}, awaiting play data ${season.recapsAwaitingData}`;
    lines.push(
      `  ${season.season}: games ${season.games}, finals ${season.finals}, ${recaps}, has_recap ${season.withRecap}` +
        `, closeness provisional ${season.closenessProvisional}, concept terms ${season.conceptTerms}` +
        (entry ? `, current ${entry.current.seasonType} week ${entry.current.week}` : ""),
    );
  }
  lines.push(
    `  latestSeason ${result.index.latestSeason}, warnings ${result.warnings.length}, removed unreferenced outputs ${result.removed.length}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCollector(options);
  console.log(formatSummary(result, options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
