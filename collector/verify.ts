/**
 * Independent check of the collector output against the raw nflverse files.
 *
 *   npm run verify:data -- [--out collector/out] [--cache-dir collector/.cache]
 *
 * Re-reads the cached raw sources (games.csv and play_by_play_{season}.csv.gz)
 * with its own CSV parser, time-zone rule and arithmetic. It deliberately does
 * not import the collector's transform modules, so a bug there cannot hide
 * itself. Only the public contract (types and glossary slugs) is shared.
 * Exits with code 1 when any check fails.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { GLOSSARY, GLOSSARY_SLUGS } from "../src/content/glossary.ts";
import { stadiumNameForSeason } from "./stadiums.ts";
import type {
  ConceptExamplesFile,
  GameRecapFile,
  PlayKind,
  PlayTag,
  PublicDataIndex,
  PublicGameRow,
  RecapPlay,
  ScoreBreakdown,
  SeasonGamesFile,
  StandingsFile,
} from "../src/data/publicData.ts";

const COLLECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Report

interface CheckResult {
  checked: number;
  failures: string[];
}

export class Report {
  readonly checks = new Map<string, CheckResult>();
  readonly notes: string[] = [];

  private entry(name: string): CheckResult {
    let result = this.checks.get(name);
    if (!result) {
      result = { checked: 0, failures: [] };
      this.checks.set(name, result);
    }
    return result;
  }

  /** Records one checked item; a false condition adds the message as a failure. */
  expect(name: string, condition: boolean, message: () => string): boolean {
    const result = this.entry(name);
    result.checked += 1;
    if (!condition) result.failures.push(message());
    return condition;
  }

  fail(name: string, message: string): void {
    this.expect(name, false, () => message);
  }

  get failed(): boolean {
    return [...this.checks.values()].some((result) => result.failures.length > 0);
  }

  /** Names of the checks that failed. */
  get failedChecks(): string[] {
    return [...this.checks].filter(([, result]) => result.failures.length > 0).map(([name]) => name);
  }

  format(): string {
    const lines: string[] = [];
    for (const [name, result] of this.checks) {
      if (result.failures.length === 0) {
        lines.push(`ok    ${name} (${result.checked})`);
        continue;
      }
      lines.push(`FAIL  ${name} (${result.failures.length} of ${result.checked})`);
      for (const failure of result.failures.slice(0, SAMPLE_LIMIT)) lines.push(`        - ${failure}`);
      if (result.failures.length > SAMPLE_LIMIT) lines.push(`        ... ${result.failures.length - SAMPLE_LIMIT} more`);
    }
    for (const note of this.notes) lines.push(`note  ${note}`);
    lines.push(this.failed ? "verify:data FAILED" : "verify:data passed");
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Raw CSV (own parser, RFC 4180 quoting)

type Cell = string | null;

export interface CsvTable {
  header: string[];
  column: (name: string) => number;
  rows: Cell[][];
}

/** Parses CSV text. Empty cells and "NA" become null. Keeps only `keep` columns when given. */
export function parseCsv(text: string, keep?: (column: string) => boolean): CsvTable {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const readRow = (): string[] => {
    const fields: string[] = [];
    for (;;) {
      let field: string;
      if (text[i] === '"') {
        field = "";
        i += 1;
        for (;;) {
          const quote = text.indexOf('"', i);
          if (quote === -1) throw new Error("CSV: unterminated quoted field");
          field += text.slice(i, quote);
          i = quote + 1;
          if (text[i] !== '"') break;
          field += '"';
          i += 1;
        }
      } else {
        let j = i;
        while (j < n) {
          const code = text.charCodeAt(j);
          if (code === 44 || code === 10 || code === 13) break;
          j += 1;
        }
        field = text.slice(i, j);
        i = j;
      }
      fields.push(field);
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "\r") i += 1;
      if (text[i] === "\n") i += 1;
      return fields;
    }
  };

  const fullHeader = readRow();
  const kept = fullHeader.map((name, index) => ({ name, index })).filter(({ name }) => !keep || keep(name));
  const header = kept.map(({ name }) => name);
  const position = new Map(header.map((name, index) => [name, index]));
  const rows: Cell[][] = [];
  while (i < n) {
    const fields = readRow();
    if (fields.length === 1 && fields[0] === "") continue;
    rows.push(kept.map(({ index }) => {
      const value = fields[index];
      return value === undefined || value === "" || value === "NA" ? null : value;
    }));
  }
  return {
    header,
    rows,
    column: (name) => {
      const index = position.get(name);
      if (index === undefined) throw new Error(`CSV: missing column "${name}"`);
      return index;
    },
  };
}

function num(value: Cell): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flag(value: Cell): boolean {
  return value !== null && (value === "1" || value.toUpperCase() === "TRUE" || Number(value) === 1);
}

// ---------------------------------------------------------------------------
// US Eastern time -> UTC from the written DST rule (no Intl, no tz database)

function nthSunday(year: number, month0: number, nth: number): number {
  const firstWeekday = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((7 - firstWeekday) % 7) + 7 * (nth - 1);
}

function lastSunday(year: number, month0: number): number {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return days - new Date(Date.UTC(year, month0, days)).getUTCDay();
}

/**
 * Daylight saving time in US Eastern: since 2007 from the second Sunday of
 * March to the first Sunday of November, 1987-2006 from the first Sunday of
 * April to the last Sunday of October, switching at 02:00 local time.
 */
export function easternUtcOffsetHours(year: number, month0: number, day: number, hour: number): -4 | -5 {
  const [startMonth, startDay, endMonth, endDay] =
    year >= 2007
      ? [2, nthSunday(year, 2, 2), 10, nthSunday(year, 10, 1)]
      : [3, nthSunday(year, 3, 1), 9, lastSunday(year, 9)];
  const key = (m: number, d: number, h: number) => (m * 32 + d) * 24 + h;
  const now = key(month0, day, hour);
  return now >= key(startMonth, startDay, 2) && now < key(endMonth, endDay, 2) ? -4 : -5;
}

export function easternToUtcIso(date: string, time: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) throw new Error(`bad date/time "${date} ${time}"`);
  const [year, month0, day, hour, minute] = [Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])];
  const offset = easternUtcOffsetHours(year, month0, day, hour);
  return new Date(Date.UTC(year, month0, day, hour, minute) - offset * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Raw schedule

interface RawGame {
  id: string;
  season: number;
  gameType: string;
  week: number;
  gameday: string;
  gametime: string | null;
  away: string;
  home: string;
  awayScore: number | null;
  homeScore: number | null;
  location: string | null;
  overtime: boolean;
  divGame: boolean;
  stadium: string | null;
}

const ROUND_BY_TYPE: Readonly<Record<string, string>> = { WC: "WC", DIV: "DIV", CON: "CON", SB: "SB" };
const SCHEDULE_NAME_COLUMNS = ["away_qb_name", "home_qb_name", "away_coach", "home_coach", "referee"];

function readSchedule(text: string): { games: RawGame[]; names: Map<number, Set<string>> } {
  const table = parseCsv(text);
  const c = (name: string) => table.column(name);
  const names = new Map<number, Set<string>>();
  const games = table.rows.map((row): RawGame => {
    const season = Number(row[c("season")]);
    const set = names.get(season) ?? new Set<string>();
    names.set(season, set);
    for (const column of SCHEDULE_NAME_COLUMNS) {
      const value = row[c(column)];
      if (value !== null) set.add(value);
    }
    return {
      id: row[c("game_id")] ?? "",
      season,
      gameType: row[c("game_type")] ?? "",
      week: Number(row[c("week")]),
      gameday: row[c("gameday")] ?? "",
      gametime: row[c("gametime")],
      away: row[c("away_team")] ?? "",
      home: row[c("home_team")] ?? "",
      awayScore: num(row[c("away_score")]),
      homeScore: num(row[c("home_score")]),
      location: row[c("location")],
      overtime: flag(row[c("overtime")]),
      divGame: flag(row[c("div_game")]),
      stadium: row[c("stadium")],
    };
  });
  return { games, names };
}

function rawFinal(game: RawGame): boolean {
  return game.awayScore !== null && game.homeScore !== null;
}

// ---------------------------------------------------------------------------
// Raw play-by-play

interface RawPlay {
  order: number;
  playId: string;
  qtr: number;
  time: string | null;
  posteam: string | null;
  defteam: string | null;
  down: number | null;
  ydstogo: number | null;
  goalToGo: boolean;
  yardline100: number | null;
  playType: string | null;
  yardsGained: number | null;
  homeWp: number | null;
  homeWpPost: number | null;
  totalAway: number | null;
  totalHome: number | null;
  timeout: boolean;
  aborted: boolean;
  touchdown: boolean;
  tdTeam: string | null;
  penalty: boolean;
  interception: boolean;
  fumble: boolean;
  fumbleLost: boolean;
  lateral: boolean;
  safety: boolean;
  extraPointResult: string | null;
  twoPointResult: string | null;
  fieldGoalResult: string | null;
}

interface RawPlayByPlay {
  plays: Map<string, RawPlay[]>;
  playerNames: Set<string>;
  descTrigrams: Set<string>;
  descFragments: Set<string>;
}

const PLAY_COLUMNS = [
  "game_id", "play_id", "qtr", "time", "posteam", "defteam", "down", "ydstogo", "goal_to_go", "yardline_100",
  "play_type", "yards_gained", "home_wp", "home_wp_post", "total_away_score", "total_home_score", "timeout",
  "aborted_play", "touchdown", "td_team", "penalty", "interception", "fumble", "fumble_lost", "lateral_reception",
  "lateral_rush", "safety", "extra_point_result", "two_point_conv_result", "field_goal_result", "desc",
];

function isPlayerNameColumn(column: string): boolean {
  return column.endsWith("_player_name") || ["passer", "rusher", "receiver", "name", "fantasy"].includes(column);
}

function latinWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []);
}

function trigrams(words: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i + 2 < words.length; i += 1) result.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return result;
}

function readPlayByPlay(text: string): RawPlayByPlay {
  const table = parseCsv(text, (column) => PLAY_COLUMNS.includes(column) || isPlayerNameColumn(column));
  const c = (name: string) => table.column(name);
  const nameColumns = table.header.map((name, index) => ({ name, index })).filter(({ name }) => isPlayerNameColumn(name));
  const plays = new Map<string, RawPlay[]>();
  const playerNames = new Set<string>();
  const descTrigrams = new Set<string>();
  const descFragments = new Set<string>();

  table.rows.forEach((row, order) => {
    for (const { index } of nameColumns) {
      const value = row[index];
      if (value !== null) playerNames.add(value);
    }
    const desc = row[c("desc")];
    if (desc !== null) {
      for (const gram of trigrams(latinWords(desc))) descTrigrams.add(gram);
      for (const fragment of desc.split(/[()]|\.\s/)) {
        const trimmed = fragment.trim();
        if (trimmed.length >= 8 && /[A-Za-z]{3}/.test(trimmed)) descFragments.add(trimmed);
      }
    }
    const gameId = row[c("game_id")];
    if (gameId === null) return;
    const list = plays.get(gameId) ?? [];
    plays.set(gameId, list);
    list.push({
      order,
      playId: String(num(row[c("play_id")])),
      qtr: Number(row[c("qtr")]),
      time: row[c("time")],
      posteam: row[c("posteam")],
      defteam: row[c("defteam")],
      down: num(row[c("down")]),
      ydstogo: num(row[c("ydstogo")]),
      goalToGo: flag(row[c("goal_to_go")]),
      yardline100: num(row[c("yardline_100")]),
      playType: row[c("play_type")],
      yardsGained: num(row[c("yards_gained")]),
      homeWp: num(row[c("home_wp")]),
      homeWpPost: num(row[c("home_wp_post")]),
      totalAway: num(row[c("total_away_score")]),
      totalHome: num(row[c("total_home_score")]),
      timeout: flag(row[c("timeout")]),
      aborted: flag(row[c("aborted_play")]),
      touchdown: flag(row[c("touchdown")]),
      tdTeam: row[c("td_team")],
      penalty: flag(row[c("penalty")]),
      interception: flag(row[c("interception")]),
      fumble: flag(row[c("fumble")]),
      fumbleLost: flag(row[c("fumble_lost")]),
      lateral: flag(row[c("lateral_reception")]) || flag(row[c("lateral_rush")]),
      safety: flag(row[c("safety")]),
      extraPointResult: row[c("extra_point_result")],
      twoPointResult: row[c("two_point_conv_result")],
      fieldGoalResult: row[c("field_goal_result")],
    });
  });
  return { plays, playerNames, descTrigrams, descFragments };
}

interface Score {
  away: number;
  home: number;
}

/** Running score after each raw row; a missing total keeps the previous value. */
function runningScores(plays: readonly RawPlay[]): Score[] {
  let score: Score = { away: 0, home: 0 };
  return plays.map((play) => {
    score = { away: play.totalAway ?? score.away, home: play.totalHome ?? score.home };
    return score;
  });
}

/** A real snap or kick with win probability on both sides (the turning-point candidates). */
function isCandidate(play: RawPlay): boolean {
  return (
    play.playType !== null &&
    play.playType !== "no_play" &&
    play.playType !== "qb_kneel" &&
    play.playType !== "qb_spike" &&
    !play.timeout &&
    !play.aborted &&
    play.homeWp !== null &&
    play.homeWpPost !== null
  );
}

type Closeness = NonNullable<PublicGameRow["closeness"]>;

/**
 * Closeness from raw rows and the raw final score.
 * close_to_end: some row in the 4th quarter or overtime moves the sign of
 * home minus away (lead change, lead -> tie or tie -> lead) and the final
 * margin is 8 or less. close_once: otherwise the margin is 8 or less in the
 * score in effect when the 3rd quarter opens or after any row from there on.
 */
function rawCloseness(plays: readonly RawPlay[], finalAway: number, finalHome: number): Closeness {
  const scores = runningScores(plays);
  const sign = (score: Score) => (score.home > score.away ? 1 : score.home < score.away ? -1 : 0);
  const oneScore = (score: Score) => Math.abs(score.away - score.home) <= 8;
  let swing = false;
  for (let i = 0; i < plays.length; i += 1) {
    const before = i === 0 ? { away: 0, home: 0 } : scores[i - 1];
    if (plays[i].qtr >= 4 && sign(before) !== sign(scores[i])) swing = true;
  }
  if (swing && Math.abs(finalAway - finalHome) <= 8) return "close_to_end";
  const third = plays.findIndex((play) => play.qtr >= 3);
  if (third < 0) return "decided_early";
  const fromThird = [third === 0 ? { away: 0, home: 0 } : scores[third - 1], ...scores.slice(third)];
  return fromThird.some(oneScore) ? "close_once" : "decided_early";
}

function marginEstimate(away: number, home: number, overtime: boolean): Closeness {
  if (overtime) return "close_to_end";
  return Math.abs(away - home) <= 8 ? "close_once" : "decided_early";
}

// ---------------------------------------------------------------------------
// Output files

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function insideOut(outDir: string, relative: string): string | null {
  const resolved = path.resolve(outDir, relative);
  return resolved.startsWith(path.resolve(outDir) + path.sep) ? resolved : null;
}

async function findCached(cacheDir: string, suffix: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return null;
  }
  const matches = await Promise.all(
    names
      .filter((name) => name.endsWith(`-${suffix}`))
      .map(async (name) => ({ file: path.join(cacheDir, name), mtime: (await stat(path.join(cacheDir, name))).mtimeMs })),
  );
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.file ?? null;
}

async function readCachedText(file: string): Promise<string> {
  const bytes = await readFile(file);
  return (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
}

function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (test(items[i])) return i;
  return -1;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ---------------------------------------------------------------------------
// Checks: schedule rows

/**
 * Placeholder kickoffs the collector must flag with kickoff_tbd: no start
 * time in the source, or a regular-season week 18+ whose two or more games
 * all share one gameday and gametime.
 */
function placeholderIds(raw: readonly RawGame[]): Set<string> {
  const ids = new Set(raw.filter((game) => game.gametime === null).map((game) => game.id));
  const weeks = new Map<number, RawGame[]>();
  for (const game of raw) {
    if (game.gameType !== "REG" || game.week < 18) continue;
    weeks.set(game.week, [...(weeks.get(game.week) ?? []), game]);
  }
  for (const games of weeks.values()) {
    const slots = new Set(games.map((game) => `${game.gameday}|${game.gametime}`));
    if (games.length >= 2 && slots.size === 1) for (const game of games) ids.add(game.id);
  }
  return ids;
}

function checkResultLine(report: Report, name: (check: string) => string, game: PublicGameRow, r: RawGame): void {
  const final = rawFinal(r);
  if (!report.expect(name("result_line_ko present iff final"), final === (game.result_line_ko !== null), () =>
    `${game.id}: final ${final}, result_line_ko ${JSON.stringify(game.result_line_ko)}`) || !final) {
    return;
  }
  const line = game.result_line_ko as string;
  const away = r.awayScore as number;
  const home = r.homeScore as number;
  const tie = away === home;
  const content = tie
    ? line.includes(`${away}-${home}`) && line.includes("무승부") && !line.includes("이겼어요")
    : line.includes(`${Math.abs(away - home)}점 차로 이겼어요.`);
  report.expect(name("result_line_ko states the raw margin, overtime and nothing else numeric"),
    content && line.includes("연장") === r.overtime && /요\.$/.test(line) &&
    (line.match(/\d+/g) ?? []).every((digits) => tie ? Number(digits) === away : Number(digits) === Math.abs(away - home)), () =>
    `${game.id}: "${line}" raw ${away}-${home} ot ${r.overtime}`);
}

function checkGames(
  report: Report,
  season: number,
  file: SeasonGamesFile,
  raw: readonly RawGame[],
  plays: ReadonlyMap<string, RawPlay[]> | null,
): void {
  const name = (check: string) => `${season} games: ${check}`;
  const rawById = new Map(raw.map((game) => [game.id, game]));
  const placeholders = placeholderIds(raw);
  report.expect(name("row count equals raw schedule"), file.games.length === raw.length, () =>
    `games.json ${file.games.length}, raw ${raw.length}`);
  const ids = new Set(file.games.map((game) => game.id));
  report.expect(name("unique ids"), ids.size === file.games.length, () => `${file.games.length - ids.size} duplicates`);
  for (const game of raw) {
    report.expect(name("every raw game present"), ids.has(game.id), () => `${game.id} missing`);
  }

  for (const game of file.games) {
    const source = rawById.get(game.id);
    if (!report.expect(name("row exists in raw schedule"), source !== undefined, () => `${game.id} not in raw`)) continue;
    const r = source as RawGame;
    const final = rawFinal(r);
    const seasonType = r.gameType === "REG" ? "REG" : ROUND_BY_TYPE[r.gameType] ? "POST" : null;
    report.expect(name("identity matches raw"), game.season === r.season && game.week === r.week &&
      game.season_type === seasonType && game.away_team_abbr === r.away && game.home_team_abbr === r.home &&
      game.postseason_round === (ROUND_BY_TYPE[r.gameType] ?? null), () =>
      `${game.id}: ${game.season}/${game.week}/${game.season_type}/${game.away_team_abbr}@${game.home_team_abbr}`);
    report.expect(name("status final iff raw has both scores"), (game.status === "final") === final, () =>
      `${game.id}: status ${game.status}, raw ${r.awayScore}-${r.homeScore}`);
    if (final) {
      report.expect(name("final scores equal raw"), game.away_score === r.awayScore && game.home_score === r.homeScore, () =>
        `${game.id}: ${game.away_score}-${game.home_score}, raw ${r.awayScore}-${r.homeScore}`);
    } else {
      report.expect(name("scheduled rows have no scores"), game.away_score === null && game.home_score === null, () =>
        `${game.id}: ${game.away_score}-${game.home_score}`);
    }
    if (r.gametime === null) report.notes.push(`${game.id}: raw gametime is NA; compared with 00:00 ET`);
    const expected = easternToUtcIso(r.gameday, r.gametime ?? "00:00");
    report.expect(name("kickoff_at equals independent ET->UTC"), game.kickoff_at === expected, () =>
      `${game.id}: ${game.kickoff_at}, expected ${expected} (${r.gameday} ${r.gametime} ET)`);
    report.expect(name("kickoff_tbd only under the documented placeholder pattern"), game.kickoff_tbd === placeholders.has(game.id), () =>
      `${game.id}: kickoff_tbd ${game.kickoff_tbd}, raw ${r.gameday} ${r.gametime} week ${r.week}`);
    report.expect(name("venue (renamed stadiums updated), site and overtime match raw"), game.venue === stadiumNameForSeason(r.stadium, r.season) &&
      game.neutral_site === (r.location === "Neutral") && game.overtime === (final && r.overtime), () =>
      `${game.id}: venue ${game.venue}/${r.stadium}, neutral ${game.neutral_site}/${r.location}, ot ${game.overtime}/${r.overtime}`);
    report.expect(name("timestamps are ISO UTC"), [game.kickoff_at, game.updated_at, game.source_checked_at]
      .every((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)), () => `${game.id}`);
    checkResultLine(report, name, game, r);

    if (!final) {
      report.expect(name("closeness null and not provisional unless final"), game.closeness === null && game.closeness_provisional === false, () =>
        `${game.id}: ${game.closeness} provisional ${game.closeness_provisional}`);
      continue;
    }
    const rows = plays?.get(game.id);
    const scores = rows ? runningScores(rows) : [];
    const last = scores[scores.length - 1];
    const measurable = rows !== undefined && last !== undefined && last.away === r.awayScore && last.home === r.homeScore;
    if (measurable) {
      const expectedCloseness = rawCloseness(rows as RawPlay[], r.awayScore as number, r.homeScore as number);
      report.expect(name("closeness recomputed from raw play-by-play"), game.closeness === expectedCloseness && game.closeness_provisional === false, () =>
        `${game.id}: ${game.closeness} provisional ${game.closeness_provisional}, raw ${expectedCloseness}`);
    } else {
      const estimate = marginEstimate(r.awayScore as number, r.homeScore as number, r.overtime);
      report.expect(name("closeness is the provisional margin estimate without play-by-play"), game.closeness === estimate && game.closeness_provisional === true, () =>
        `${game.id}: ${game.closeness} provisional ${game.closeness_provisional}, estimate ${estimate}`);
    }
  }
}

function checkIndexEntry(report: Report, entry: PublicDataIndex["seasons"][number], raw: readonly RawGame[]): void {
  const name = `${entry.season} index: weeks and current week match raw`;
  const typed = raw
    .map((game) => ({ type: game.gameType === "REG" ? "REG" : "POST", week: game.week, final: rawFinal(game) }))
    .sort((a, b) => (a.type === b.type ? a.week - b.week : a.type === "REG" ? -1 : 1));
  const weeks = (type: string) => [...new Set(typed.filter((game) => game.type === type).map((game) => game.week))].sort((a, b) => a - b);
  const open = typed.find((game) => !game.final) ?? typed[typed.length - 1];
  report.expect(name, JSON.stringify(entry.weeks.REG) === JSON.stringify(weeks("REG")) &&
    JSON.stringify(entry.weeks.POST) === JSON.stringify(weeks("POST")), () => `weeks ${JSON.stringify(entry.weeks)}`);
  report.expect(name, open !== undefined && entry.current.seasonType === open.type && entry.current.week === open.week, () =>
    `current ${entry.current.seasonType} ${entry.current.week}, raw ${open?.type} ${open?.week}`);
  report.expect(`${entry.season} index: season file paths`,
    entry.gamesPath === `seasons/${entry.season}/games.json` && entry.standingsPath === `seasons/${entry.season}/standings.json` &&
    entry.conceptsPath === `seasons/${entry.season}/concepts.json`, () =>
    `${entry.gamesPath} ${entry.standingsPath} ${entry.conceptsPath}`);
}

// ---------------------------------------------------------------------------
// Checks: standings

interface Tally {
  w: number;
  l: number;
  t: number;
  pf: number;
  pa: number;
  dw: number;
  dl: number;
  dt: number;
  results: string[];
}

function tallyRaw(finals: readonly RawGame[]): Map<string, Tally> {
  const tally = new Map<string, Tally>();
  const of = (abbr: string) => {
    let entry = tally.get(abbr);
    if (!entry) {
      entry = { w: 0, l: 0, t: 0, pf: 0, pa: 0, dw: 0, dl: 0, dt: 0, results: [] };
      tally.set(abbr, entry);
    }
    return entry;
  };
  for (const game of finals) {
    const sides: Array<[string, number, number]> = [
      [game.away, game.awayScore as number, game.homeScore as number],
      [game.home, game.homeScore as number, game.awayScore as number],
    ];
    for (const [abbr, scored, allowed] of sides) {
      const entry = of(abbr);
      const result = scored > allowed ? "W" : scored < allowed ? "L" : "T";
      if (result === "W") entry.w += 1;
      else if (result === "L") entry.l += 1;
      else entry.t += 1;
      if (game.divGame) {
        if (result === "W") entry.dw += 1;
        else if (result === "L") entry.dl += 1;
        else entry.dt += 1;
      }
      entry.pf += scored;
      entry.pa += allowed;
      entry.results.push(result);
    }
  }
  return tally;
}

function pctOf(entry: Tally | undefined): number {
  if (!entry) return 0;
  const games = entry.w + entry.l + entry.t;
  return games === 0 ? 0 : round3((entry.w + entry.t / 2) / games);
}

/** Competition rank by win pct inside each division: 1 + teams with a higher pct. */
function divisionRanks(divisions: ReadonlyArray<readonly string[]>, tally: ReadonlyMap<string, Tally>): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const teams of divisions) {
    for (const abbr of teams) {
      const pct = pctOf(tally.get(abbr));
      ranks.set(abbr, 1 + teams.filter((other) => pctOf(tally.get(other)) > pct).length);
    }
  }
  return ranks;
}

function checkStandings(report: Report, season: number, file: StandingsFile, raw: readonly RawGame[]): void {
  const name = (check: string) => `${season} standings: ${check}`;
  const regular = raw.filter((game) => game.gameType === "REG");
  // Week order for streaks: a team plays at most once per week.
  const finals = regular.filter(rawFinal).sort((a, b) => a.week - b.week || a.id.localeCompare(b.id));
  const tally = tallyRaw(finals);

  report.expect(name("gamesCounted equals raw regular-season finals"), file.gamesCounted === finals.length, () =>
    `${file.gamesCounted}, raw ${finals.length}`);
  report.expect(name("method note says ties are shown, not broken"), /승률/.test(file.methodNoteKo) && /동률/.test(file.methodNoteKo), () =>
    file.methodNoteKo);
  const allTeams = file.divisions.flatMap((division) => division.teams.map((team) => team.abbr));
  const rawTeams = new Set(regular.flatMap((game) => [game.away, game.home]));
  report.expect(name("8 divisions of 4, every raw team exactly once"), file.divisions.length === 8 &&
    file.divisions.every((division) => division.teams.length === 4) && new Set(allTeams).size === 32 &&
    allTeams.every((abbr) => rawTeams.has(abbr)), () => `teams ${allTeams.join(",")}`);

  const divisionOf = new Map(file.divisions.flatMap((division) => division.teams.map((team) => [team.abbr, division.nameKo] as const)));
  for (const game of regular) {
    const same = divisionOf.get(game.away) === divisionOf.get(game.home);
    report.expect(name("division alignment agrees with raw div_game"), same === game.divGame, () =>
      `${game.id}: same division ${same}, raw div_game ${game.divGame}`);
  }

  // rankChange baseline: finals before the latest week whose raw games are all final.
  const weekDone = new Map<number, boolean>();
  for (const game of regular) weekDone.set(game.week, (weekDone.get(game.week) ?? true) && rawFinal(game));
  const doneWeeks = [...weekDone].filter(([, done]) => done).map(([week]) => week);
  const baselineWeek = doneWeeks.length === 0 ? null : Math.max(...doneWeeks);
  const groups = file.divisions.map((division) => division.teams.map((team) => team.abbr));
  const current = divisionRanks(groups, tally);
  const baseline = baselineWeek !== null && baselineWeek >= 2
    ? divisionRanks(groups, tallyRaw(finals.filter((game) => game.week < baselineWeek)))
    : null;
  const playedSince = new Set(baselineWeek === null ? [] :
    finals.filter((game) => game.week >= baselineWeek).flatMap((game) => [game.away, game.home]));

  const record = (w: number, l: number, t: number) => (t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`);
  for (const division of file.divisions) {
    division.teams.forEach((team, index) => {
      const entry = tally.get(team.abbr) ?? { w: 0, l: 0, t: 0, pf: 0, pa: 0, dw: 0, dl: 0, dt: 0, results: [] };
      const streakLength = entry.results.length === 0 ? 0 :
        entry.results.length - lastIndexWhere(entry.results, (result) => result !== entry.results[entry.results.length - 1]) - 1;
      const streak = entry.results.length === 0 ? null : `${entry.results[entry.results.length - 1]}${streakLength}`;
      report.expect(name("W-L-T recomputed from raw finals"), team.wins === entry.w && team.losses === entry.l && team.ties === entry.t, () =>
        `${team.abbr}: ${team.wins}-${team.losses}-${team.ties}, raw ${entry.w}-${entry.l}-${entry.t}`);
      report.expect(name("points, pct, streak and division record"), team.pointsFor === entry.pf && team.pointsAgainst === entry.pa &&
        team.pointDiff === entry.pf - entry.pa && team.winPct === pctOf(entry) &&
        team.streak === streak && team.divisionRecord === record(entry.dw, entry.dl, entry.dt), () =>
        `${team.abbr}: ${team.pointsFor}/${team.pointsAgainst} ${team.winPct} ${team.streak} ${team.divisionRecord}, ` +
        `raw ${entry.pf}/${entry.pa} ${streak} ${record(entry.dw, entry.dl, entry.dt)}`);

      const sharing = division.teams.filter((other) => other !== team && pctOf(tally.get(other.abbr)) === pctOf(entry)).length;
      report.expect(name("shared rank by win pct only (1, 2, 2, 4) and tied flag"),
        team.divisionRank === current.get(team.abbr) && team.tied === (sharing > 0), () =>
        `${division.nameKo} ${team.abbr}: rank ${team.divisionRank} tied ${team.tied}, raw rank ${current.get(team.abbr)} sharing ${sharing}`);
      const previous = division.teams[index - 1];
      report.expect(name("listed by win pct, ties by Korean name"), !previous || previous.winPct > team.winPct ||
        (previous.winPct === team.winPct && previous.nameKo.localeCompare(team.nameKo, "ko") < 0), () =>
        `${division.nameKo} #${index + 1} ${team.abbr} after ${previous?.abbr}`);

      const before = baseline?.get(team.abbr);
      const expectedChange = before !== undefined && playedSince.has(team.abbr) ? before - (current.get(team.abbr) as number) : null;
      report.expect(name("rankChange vs standings before the latest completed week"), team.rankChange === expectedChange, () =>
        `${team.abbr}: ${team.rankChange}, raw ${expectedChange} (baseline before week ${baselineWeek})`);
    });
  }
}

// ---------------------------------------------------------------------------
// Checks: recaps

const GLOSSARY_SET = new Set<string>(GLOSSARY_SLUGS);
const GLOSSARY_WITH_ENTRY = new Set<string>(GLOSSARY.map((term) => term.slug));

const PLAY_KINDS: Record<PlayKind, true> = {
  pass: true, run: true, sack: true, interception: true, fumble: true, field_goal: true, punt: true, kickoff: true,
  extra_point: true, two_point: true, penalty: true, safety: true, other: true,
};
const PLAY_TAGS: Record<PlayTag, true> = {
  touchdown: true, first_down: true, turnover: true, fourth_down: true, scoring: true, big_play: true, penalty: true,
  red_zone: true, lead_change: true,
};

/** Enum fields hold contract vocabulary (e.g. "two-point-conversion"), never source text. */
function isContractVocabulary(key: string, text: string): boolean {
  if (key === "termSlugs") return GLOSSARY_SET.has(text);
  if (key === "kind") return Object.hasOwn(PLAY_KINDS, text);
  if (key === "tags") return Object.hasOwn(PLAY_TAGS, text);
  return false;
}

/**
 * Expected field bar from raw columns. Whole bar null for kickoffs, tries and
 * rows without a spot. `end` only for counted pass/run snaps (sacks are pass
 * rows) without interception, any fumble, lateral, aborted snap or enforced
 * penalty, because only then does yards_gained give the next spot exactly.
 */
function expectedFieldBar(play: RawPlay): RecapPlay["fieldBar"] {
  const kickOrTry = play.playType === "kickoff" || play.playType === "extra_point" ||
    play.extraPointResult !== null || play.twoPointResult !== null;
  if (play.yardline100 === null || kickOrTry) return null;
  const start = play.yardline100;
  const exact = (play.playType === "pass" || play.playType === "run") && play.down !== null && play.yardsGained !== null &&
    !play.interception && !play.fumbleLost && !play.fumble && !play.lateral && !play.aborted && !play.penalty;
  return {
    start,
    end: exact ? Math.min(100, Math.max(0, start - (play.yardsGained as number))) : null,
    firstDownLine: play.down === null || play.ydstogo === null ? null : play.goalToGo ? 0 : Math.max(0, start - play.ydstogo),
  };
}

type Breakdown = Record<"away" | "home", ScoreBreakdown>;

/** Score breakdown from game-wide flag totals; `other` is whatever the final score has left over. */
function rawBreakdown(plays: readonly RawPlay[], raw: RawGame): Breakdown {
  const empty = (): ScoreBreakdown => ({ touchdowns: 0, extraPoints: 0, twoPointConversions: 0, fieldGoals: 0, safeties: 0, other: 0 });
  const result: Breakdown = { away: empty(), home: empty() };
  const scores = runningScores(plays);
  const side = (abbr: string | null): "away" | "home" | null => (abbr === raw.home ? "home" : abbr === raw.away ? "away" : null);
  plays.forEach((play, index) => {
    const before = index === 0 ? { away: 0, home: 0 } : scores[index - 1];
    const gain = { away: scores[index].away - before.away, home: scores[index].home - before.home };
    const rose = (points: number) => (gain.home === points ? "home" : gain.away === points ? "away" : null);
    if (play.touchdown) {
      const s = side(play.tdTeam) ?? (gain.home >= 6 ? "home" : gain.away >= 6 ? "away" : null);
      if (s) result[s].touchdowns += 1;
    }
    const kicking = side(play.posteam);
    if (kicking && play.extraPointResult === "good") result[kicking].extraPoints += 1;
    if (kicking && play.twoPointResult === "success") result[kicking].twoPointConversions += 1;
    if (kicking && (play.fieldGoalResult === "made" || play.fieldGoalResult === "good")) result[kicking].fieldGoals += 1;
    if (play.safety) {
      const s = rose(2) ?? side(play.defteam);
      if (s) result[s].safeties += 1;
    }
  });
  for (const s of ["away", "home"] as const) {
    const b = result[s];
    const final = (s === "away" ? raw.awayScore : raw.homeScore) as number;
    b.other = final - (6 * b.touchdowns + b.extraPoints + 2 * b.twoPointConversions + 3 * b.fieldGoals + 2 * b.safeties);
  }
  return result;
}

function checkRecap(report: Report, recap: GameRecapFile, row: PublicGameRow, raw: RawGame, plays: readonly RawPlay[]): void {
  const name = (check: string) => `recaps: ${check}`;
  const id = recap.gameId;
  report.expect(name("final equals raw schedule"), recap.final.away === raw.awayScore && recap.final.home === raw.homeScore &&
    recap.final.overtime === raw.overtime && recap.away.abbr === raw.away && recap.home.abbr === raw.home &&
    recap.season === raw.season && recap.week === raw.week && recap.seasonType === row.season_type, () =>
    `${id}: ${recap.final.away}-${recap.final.home} ot ${recap.final.overtime}, raw ${raw.awayScore}-${raw.homeScore} ot ${raw.overtime}`);

  const sum = recap.quarterScores.reduce((total, quarter) => ({ away: total.away + quarter.away, home: total.home + quarter.home }), { away: 0, home: 0 });
  report.expect(name("quarterScores sum to the final score"), sum.away === recap.final.away && sum.home === recap.final.home, () =>
    `${id}: ${sum.away}-${sum.home} vs ${recap.final.away}-${recap.final.home}`);

  const scores = runningScores(plays);
  const lastPeriod = Math.max(4, ...plays.map((play) => play.qtr));
  const expectedQuarters: string[] = [];
  let previous: Score = { away: 0, home: 0 };
  for (let period = 1; period <= lastPeriod; period += 1) {
    const lastIndex = lastIndexWhere(plays, (play) => play.qtr === period);
    const end = lastIndex === -1 ? previous : scores[lastIndex];
    const label = period <= 4 ? `${period}Q` : period === 5 ? "연장" : `연장${period - 4}`;
    expectedQuarters.push(`${period}:${label}:${end.away - previous.away}-${end.home - previous.home}`);
    previous = end;
  }
  const actualQuarters = recap.quarterScores.map((quarter) => `${quarter.period}:${quarter.label}:${quarter.away}-${quarter.home}`);
  report.expect(name("quarterScores equal raw play-by-play periods"), actualQuarters.join(",") === expectedQuarters.join(","), () =>
    `${id}: ${actualQuarters.join(",")} vs raw ${expectedQuarters.join(",")}`);

  const expectedBreakdown = rawBreakdown(plays, raw);
  for (const side of ["away", "home"] as const) {
    const b = recap.scoreBreakdown?.[side];
    const final = side === "away" ? raw.awayScore : raw.homeScore;
    const fields = ["touchdowns", "extraPoints", "twoPointConversions", "fieldGoals", "safeties", "other"] as const;
    const valid = b !== undefined && fields.every((field) => Number.isInteger(b[field]) && b[field] >= 0);
    report.expect(name("scoreBreakdown equation equals the raw final score"), valid &&
      6 * b.touchdowns + b.extraPoints + 2 * b.twoPointConversions + 3 * b.fieldGoals + 2 * b.safeties + b.other === final, () =>
      `${id} ${side}: ${JSON.stringify(b)} vs final ${final}`);
    report.expect(name("scoreBreakdown counts equal raw scoring flags"), valid &&
      fields.every((field) => b[field] === expectedBreakdown[side][field]), () =>
      `${id} ${side}: ${JSON.stringify(b)} vs raw ${JSON.stringify(expectedBreakdown[side])}`);
  }

  const byId = new Map(plays.map((play, index) => [play.playId, { play, index }]));
  const candidates = plays.filter(isCandidate);
  const keyCount = recap.keyPlays.length;
  report.expect(name("3-5 key plays (all candidates when fewer than 3)"),
    candidates.length >= 3 ? keyCount >= 3 && keyCount <= 5 : keyCount === candidates.length, () =>
    `${id}: ${keyCount} key plays, ${candidates.length} candidates`);
  for (const play of recap.keyPlays) {
    const found = byId.get(play.id);
    report.expect(name("key plays are candidates (no no-play penalties, timeouts, kneels, spikes)"),
      found !== undefined && isCandidate(found.play), () => `${id} play ${play.id}: ${found?.play.playType}`);
  }

  // Selection uses raw win probability internally; the output never carries it.
  const swing = (play: RawPlay) => Math.abs((play.homeWpPost as number) - (play.homeWp as number));
  const selected = new Set(recap.keyPlays.map((play) => play.id));
  const minSelected = Math.min(...recap.keyPlays.map((play) => {
    const found = byId.get(play.id);
    return found && isCandidate(found.play) ? swing(found.play) : -1;
  }));
  const maxOther = Math.max(0, ...candidates.filter((play) => !selected.has(play.playId)).map(swing));
  report.expect(name("key plays are the largest win-probability swings"), minSelected >= 0 && minSelected + 1e-9 >= maxOther, () =>
    `${id}: smallest selected swing ${minSelected.toFixed(4)}, largest skipped ${maxOther.toFixed(4)}`);

  const ordered = (list: readonly RecapPlay[]) => list.every((play, index) => {
    if (index === 0) return true;
    const before = list[index - 1];
    const a = byId.get(before.id)?.index ?? -1;
    const b = byId.get(play.id)?.index ?? -1;
    return play.elapsedSeconds >= before.elapsedSeconds && b > a;
  });
  report.expect(name("keyPlays and scoringPlays sorted by time"), ordered(recap.keyPlays) && ordered(recap.scoringPlays), () => `${id}`);

  const expectedScoring = plays
    .filter((_, index) => {
      const before = index === 0 ? { away: 0, home: 0 } : scores[index - 1];
      return scores[index].away > before.away || scores[index].home > before.home;
    })
    .map((play) => play.playId);
  report.expect(name("scoringPlays are exactly the raw score changes"),
    recap.scoringPlays.map((play) => play.id).join(",") === expectedScoring.join(","), () =>
    `${id}: ${recap.scoringPlays.length} vs raw ${expectedScoring.length}`);

  for (const play of [...recap.keyPlays, ...recap.scoringPlays]) {
    const found = byId.get(play.id);
    if (!report.expect(name("plays exist in raw play-by-play"), found !== undefined, () => `${id} play ${play.id}`)) continue;
    const { play: source, index } = found as { play: RawPlay; index: number };
    const after = scores[index];
    const before = index === 0 ? { away: 0, home: 0 } : scores[index - 1];
    const period = source.qtr;
    report.expect(name("play fields equal raw"), play.period === period && (source.time === null || play.clock === source.time) &&
      play.offense === source.posteam && play.defense === source.defteam && play.down === source.down &&
      play.distance === source.ydstogo && play.yardline100 === source.yardline100 && play.yards === source.yardsGained &&
      play.scoreAfter.away === after.away && play.scoreAfter.home === after.home &&
      (period > 4 || (play.elapsedSeconds >= (period - 1) * 900 && play.elapsedSeconds <= period * 900)), () =>
      `${id} play ${play.id}: Q${play.period} ${play.clock} ${play.offense} ${play.scoreAfter.away}-${play.scoreAfter.home}`);

    const expectedBar = expectedFieldBar(source);
    const bar = play.fieldBar;
    const inRange = (value: number | null) => value === null || (Number.isInteger(value) && value >= 0 && value <= 100);
    report.expect(name("fieldBar ranges (0-100, end and firstDownLine nullable)"), bar === null ||
      (bar !== undefined && inRange(bar.start) && bar.start !== null && inRange(bar.end) && inRange(bar.firstDownLine) &&
        (bar.firstDownLine === null || bar.firstDownLine <= bar.start)), () =>
      `${id} play ${play.id}: ${JSON.stringify(bar)}`);
    report.expect(name("fieldBar equals raw spot, gain and line to gain under the null rules"),
      JSON.stringify(bar === undefined ? "missing" : bar) === JSON.stringify(expectedBar), () =>
      `${id} play ${play.id} (${source.playType}): ${JSON.stringify(bar)} vs raw ${JSON.stringify(expectedBar)}`);

    const scored = after.away > before.away || after.home > before.home;
    const leader = (score: Score) => Math.sign(score.home - score.away);
    const leadChange = leader(before) !== 0 && leader(after) !== 0 && leader(before) !== leader(after);
    report.expect(name("touchdown/scoring/penalty/lead_change tags agree with raw"),
      play.tags.includes("touchdown") === source.touchdown && play.tags.includes("scoring") === scored &&
      play.tags.includes("penalty") === source.penalty && play.tags.includes("lead_change") === leadChange, () =>
      `${id} play ${play.id}: tags ${play.tags.join("|")}`);
    const offensiveSnap = (source.playType === "pass" || source.playType === "run") && source.down !== null && source.twoPointResult === null;
    report.expect(name("fourth_down and red_zone tags only on offensive snaps"),
      play.tags.includes("fourth_down") === (offensiveSnap && source.down === 4) &&
      play.tags.includes("red_zone") === (offensiveSnap && source.yardline100 !== null && source.yardline100 <= 20), () =>
      `${id} play ${play.id} (${source.playType}, down ${source.down}, yardline ${source.yardline100}): tags ${play.tags.join("|")}`);
    report.expect(name("termSlugs are glossary slugs with entries"),
      play.termSlugs.every((slug) => GLOSSARY_SET.has(slug) && GLOSSARY_WITH_ENTRY.has(slug)) && new Set(play.termSlugs).size === play.termSlugs.length, () =>
      `${id} play ${play.id}: ${play.termSlugs.join(",")}`);
  }
}

// ---------------------------------------------------------------------------
// Checks: concept examples

function checkConcepts(
  report: Report,
  season: number,
  file: ConceptExamplesFile,
  games: SeasonGamesFile,
  recaps: ReadonlyMap<string, GameRecapFile>,
): void {
  const name = (check: string) => `${season} concepts: ${check}`;
  report.expect(name("season matches"), file.season === season && typeof file.examples === "object" && file.examples !== null, () =>
    `season ${file.season}`);
  const rows = new Map(games.games.map((game) => [game.id, game]));
  const gamesWithTerm = new Map<string, Set<string>>();
  for (const [gameId, recap] of recaps) {
    for (const play of [...recap.keyPlays, ...recap.scoringPlays]) {
      for (const slug of play.termSlugs) {
        const set = gamesWithTerm.get(slug) ?? new Set<string>();
        set.add(gameId);
        gamesWithTerm.set(slug, set);
      }
    }
  }

  for (const [slug, examples] of Object.entries(file.examples ?? {})) {
    report.expect(name("keys are glossary slugs"), GLOSSARY_SET.has(slug), () => slug);
    if (!report.expect(name("1 to 3 examples per term"), Array.isArray(examples) && examples.length >= 1 && examples.length <= 3, () =>
      `${slug}: ${Array.isArray(examples) ? examples.length : typeof examples}`)) continue;
    const available = gamesWithTerm.get(slug)?.size ?? 0;
    report.expect(name("as many examples as games allow (up to 3, one per game)"),
      examples.length === Math.min(3, available) && new Set(examples.map((example) => example.gameId)).size === examples.length, () =>
      `${slug}: ${examples.length} examples, ${available} games with the term`);
    const key = (gameId: string) => `${rows.get(gameId)?.kickoff_at ?? ""}|${gameId}`;
    report.expect(name("newest first"), examples.every((example, index) => index === 0 || key(examples[index - 1].gameId) > key(example.gameId)), () =>
      `${slug}: ${examples.map((example) => example.gameId).join(",")}`);

    for (const example of examples) {
      const row = rows.get(example.gameId);
      report.expect(name("examples come from final games with a recap"), row !== undefined && row.status === "final" && row.has_recap &&
        row.week === example.week && row.season_type === example.seasonType && row.away_team_abbr === example.away &&
        row.home_team_abbr === example.home, () => `${slug}: ${example.gameId}`);
      const recap = recaps.get(example.gameId);
      const original = recap ? [...recap.keyPlays, ...recap.scoringPlays].find((play) => play.id === example.play?.id) : undefined;
      report.expect(name("example play equals the published recap play and uses the term"),
        original !== undefined && JSON.stringify(original) === JSON.stringify(example.play) && example.play.termSlugs.includes(slug), () =>
        `${slug}: ${example.gameId} play ${example.play?.id}`);
    }
  }
  for (const slug of gamesWithTerm.keys()) {
    report.expect(name("every term used by a published play has examples"), Object.hasOwn(file.examples ?? {}, slug), () => slug);
  }
}

// ---------------------------------------------------------------------------
// Forbidden content: win probability and betting-like numbers

function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** wp, wpa, winProb*, *odds*, *spread*, *moneyline*, *total_line*, vegas* (any case or separator). */
export function isForbiddenKey(key: string): boolean {
  const words = keyWords(key);
  const joined = words.join("");
  return words.includes("wp") || words.includes("wpa") || joined.includes("winprob") || joined.startsWith("vegas") ||
    ["odds", "spread", "moneyline", "totalline"].some((fragment) => joined.includes(fragment));
}

const FORBIDDEN_PHRASES: readonly RegExp[] = [/확률/, /%p/, /\d\s*%/, /배당/, /win\s*prob/i, /moneyline/i, /point spread/i];

function visitJson(value: unknown, onKey: (key: string) => void, onText: (text: string) => void): void {
  if (typeof value === "string") onText(value);
  else if (Array.isArray(value)) for (const item of value) visitJson(item, onKey, onText);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      onKey(key);
      visitJson(child, onKey, onText);
    }
  }
}

export function checkForbidden(report: Report, files: readonly OutputFile[]): void {
  for (const file of files) {
    visitJson(
      file.json,
      (key) => report.expect("forbidden: no win-probability or betting keys", !isForbiddenKey(key), () => `${file.relative}: "${key}"`),
      (text) => {
        const hit = FORBIDDEN_PHRASES.find((pattern) => pattern.test(text));
        report.expect("forbidden: no probability, percentage or odds wording", hit === undefined, () =>
          `${file.relative}: "${text}" (${String(hit)})`);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Leak and language checks over every output file

const ENGLISH_PATTERNS: ReadonlyArray<string | RegExp> = [
  " for ", " yards", "pass short", "pass deep", "pass incomplete", "up the middle", "TOUCHDOWN", "PENALTY on",
  "Shotgun", "No Huddle", "Timeout #", "END QUARTER", "END GAME", "INTERCEPTED", "FUMBLES", "sacked", "kicks ", "punts ",
  /\b(left|right) (end|tackle|guard)\b/,
];

/**
 * Latin text allowed inside Korean fields: the "LA" of the two Los Angeles
 * team names, conference names ("AFC 동부"), the contract's down notation
 * ("3rd & 4") and the source attribution.
 */
function stripAllowedLatin(text: string): string {
  return text
    .replace(/\bLA (?=램스|차저스)/g, "")
    .replace(/\b[AN]FC (?=동부|북부|남부|서부)/g, "")
    .replace(/\b(1st|2nd|3rd|4th)(?= &)/g, "")
    .replace("nflverse (CC BY 4.0)", "");
}

function visitStrings(value: unknown, visit: (text: string, key: string) => void, key = ""): void {
  if (typeof value === "string") visit(value, key);
  else if (Array.isArray(value)) value.forEach((item) => visitStrings(item, visit, key));
  else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) visitStrings(child, visit, childKey);
  }
}

export interface OutputFile {
  relative: string;
  text: string;
  json: unknown;
}

export function checkLeaks(
  report: Report,
  files: readonly OutputFile[],
  sources: { names: ReadonlySet<string>; descTrigrams: ReadonlySet<string>; descFragments: ReadonlySet<string> },
): void {
  const latinLeaves = new Map<string, string>();
  for (const file of files) {
    for (const pattern of ENGLISH_PATTERNS) {
      const hit = typeof pattern === "string" ? file.text.includes(pattern) : pattern.test(file.text);
      report.expect("leaks: no English play-text patterns", !hit, () => `${file.relative}: "${String(pattern)}"`);
    }
    visitStrings(file.json, (text, key) => {
      if (key === "termSlugs" || key === "kind" || key === "tags") {
        report.expect("contract: enum fields hold contract values", isContractVocabulary(key, text), () =>
          `${file.relative} ${key}: "${text}"`);
        return;
      }
      if (/[A-Za-z]/.test(text) && !latinLeaves.has(text)) latinLeaves.set(text, file.relative);
      if (key.endsWith("Ko") || key.endsWith("_ko")) {
        const rest = stripAllowedLatin(text);
        report.expect("language: Korean fields have Hangul and no other Latin text",
          /[가-힣]/.test(text) && !/[A-Za-z]/.test(rest), () => `${file.relative} ${key}: "${text}"`);
      }
    });
  }

  const allText = files.map((file) => file.text).join("\n");
  let shortNames = 0;
  for (const name of sources.names) {
    if (name.length < 4) {
      shortNames += 1;
      continue;
    }
    const hit = allText.includes(name);
    report.expect("leaks: no player, coach or referee names", !hit, () =>
      `"${name}" in ${files.find((file) => file.text.includes(name))?.relative}`);
  }
  if (shortNames > 0) report.notes.push(`${shortNames} name values shorter than 4 characters were not searched`);

  const leafText = [...latinLeaves.keys()].join("\n");
  for (const fragment of sources.descFragments) {
    report.expect("leaks: no desc fragments", !leafText.includes(fragment), () => `"${fragment}"`);
  }
  for (const [text, relative] of latinLeaves) {
    const gram = trigrams(latinWords(text)).find((candidate) => sources.descTrigrams.has(candidate));
    report.expect("leaks: no desc word sequences (3 words)", gram === undefined, () => `${relative}: "${text}" shares "${gram}"`);
  }
}

// ---------------------------------------------------------------------------
// Driver

export interface VerifyOptions {
  outDir: string;
  cacheDir: string;
}

export function parseArgs(argv: readonly string[]): VerifyOptions {
  const options: VerifyOptions = { outDir: path.join(COLLECTOR_DIR, "out"), cacheDir: path.join(COLLECTOR_DIR, ".cache") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if ((arg === "--out" || arg === "--cache-dir") && value !== undefined) {
      if (arg === "--out") options.outDir = path.resolve(value);
      else options.cacheDir = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument "${arg}"`);
    }
  }
  return options;
}

export async function verify(options: VerifyOptions): Promise<Report> {
  const report = new Report();
  const outputs: OutputFile[] = [];
  const load = async <T>(relative: string): Promise<T | null> => {
    const file = insideOut(options.outDir, relative);
    if (!report.expect("files: every referenced path exists inside the output", file !== null && (await exists(file)), () => relative)) {
      return null;
    }
    const text = await readFile(file as string, "utf8");
    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      report.fail("files: valid JSON", relative);
      return null;
    }
    outputs.push({ relative, text, json });
    report.expect("files: schemaVersion 1", (json as { schemaVersion?: unknown }).schemaVersion === 1, () => relative);
    return json;
  };

  const index = await load<PublicDataIndex>("index.json");
  if (!index) return report;
  report.expect("index: seasons newest first, latestSeason first", index.seasons.length > 0 &&
    index.latestSeason === index.seasons[0].season &&
    index.seasons.every((entry, i) => i === 0 || entry.season < index.seasons[i - 1].season), () =>
    `${index.seasons.map((entry) => entry.season).join(",")} latest ${index.latestSeason}`);

  const scheduleFile = await findCached(options.cacheDir, "games.csv");
  if (!scheduleFile) {
    report.fail("raw: cached games.csv found", options.cacheDir);
    return report;
  }
  const schedule = readSchedule(await readCachedText(scheduleFile));
  const names = new Set<string>();
  const descTrigrams = new Set<string>();
  const descFragments = new Set<string>();
  const publishedRecaps = new Set<string>();

  for (const entry of index.seasons) {
    const raw = schedule.games.filter((game) => game.season === entry.season);
    for (const name of schedule.names.get(entry.season) ?? []) names.add(name);
    checkIndexEntry(report, entry, raw);
    const games = await load<SeasonGamesFile>(entry.gamesPath);
    const standings = await load<StandingsFile>(entry.standingsPath);
    const concepts = await load<ConceptExamplesFile>(entry.conceptsPath);

    // Play-by-play is needed for closeness of any final and for recaps.
    let pbp: RawPlayByPlay | null = null;
    if (raw.some(rawFinal)) {
      const pbpFile = await findCached(options.cacheDir, `play_by_play_${entry.season}.csv.gz`);
      if (pbpFile) {
        pbp = readPlayByPlay(await readCachedText(pbpFile));
        for (const name of pbp.playerNames) names.add(name);
        for (const gram of pbp.descTrigrams) descTrigrams.add(gram);
        for (const fragment of pbp.descFragments) descFragments.add(fragment);
      } else {
        report.notes.push(`${entry.season}: no cached play-by-play; closeness must be provisional`);
      }
    }
    if (games) checkGames(report, entry.season, games, raw, pbp?.plays ?? null);
    if (standings) checkStandings(report, entry.season, standings, raw);
    if (!games) continue;

    const withRecap = games.games.filter((game) => game.has_recap);
    const finalsWithout = games.games.filter((game) => game.status === "final" && !game.has_recap).map((game) => game.id);
    if (finalsWithout.length > 0) report.notes.push(`${entry.season}: finals without a recap: ${finalsWithout.join(", ")}`);
    const recaps = new Map<string, GameRecapFile>();
    if (withRecap.length > 0 &&
      report.expect("raw: cached play-by-play for seasons with recaps", pbp !== null, () => `${entry.season}`)) {
      const rawById = new Map(raw.map((game) => [game.id, game]));
      for (const row of withRecap) {
        publishedRecaps.add(`${row.id}.json`);
        const recap = await load<GameRecapFile>(`games/${row.id}.json`);
        const plays = pbp?.plays.get(row.id);
        const source = rawById.get(row.id);
        if (!recap || !source) continue;
        recaps.set(row.id, recap);
        if (!report.expect("recaps: raw play-by-play exists for the game", plays !== undefined, () => row.id)) continue;
        report.expect("recaps: only final games", row.status === "final" && recap.gameId === row.id, () => row.id);
        checkRecap(report, recap, row, source, plays as RawPlay[]);
      }
    }
    if (concepts) checkConcepts(report, entry.season, concepts, games, recaps);
  }

  let recapFiles: string[] = [];
  try {
    recapFiles = (await readdir(path.join(options.outDir, "games"))).filter((name) => name.endsWith(".json"));
  } catch {
    // No games directory yet.
  }
  for (const file of recapFiles) {
    report.expect("files: every recap file is referenced by has_recap", publishedRecaps.has(file), () => `games/${file}`);
  }
  // The whole output folder is deployed, so a season folder outside the index would stay public unlisted.
  let seasonDirs: string[] = [];
  try {
    seasonDirs = (await readdir(path.join(options.outDir, "seasons"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No seasons directory yet.
  }
  const listedSeasons = new Set(index.seasons.map((entry) => String(entry.season)));
  for (const dir of seasonDirs) {
    report.expect("files: every season folder is listed in index.json", listedSeasons.has(dir), () => `seasons/${dir}/`);
  }

  checkForbidden(report, outputs);
  checkLeaks(report, outputs, { names, descTrigrams, descFragments });
  report.notes.push(`raw sources: ${path.basename(scheduleFile)}; ${outputs.length} output files checked`);
  return report;
}

async function main(): Promise<void> {
  const report = await verify(parseArgs(process.argv.slice(2)));
  console.log(report.format());
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
