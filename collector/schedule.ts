import type {
  PostseasonRound,
  PublicGameRow,
  PublicSeasonType,
  SeasonIndexEntry,
} from "../src/data/publicData.ts";
import { estimateCloseness, type Closeness } from "./closeness.ts";
import { iterateSelectedColumns } from "./csv.ts";
import { josa } from "./korean.ts";
import { teamNameKo, teamShortKo } from "./teams.ts";
import { stadiumNameForSeason } from "./stadiums.ts";

/**
 * Only these games.csv columns are read. The file also carries quarterback,
 * coach and referee names; they are never copied.
 */
export const SCHEDULE_COLUMNS = [
  "game_id",
  "season",
  "game_type",
  "week",
  "gameday",
  "gametime",
  "away_team",
  "away_score",
  "home_team",
  "home_score",
  "location",
  "overtime",
  "stadium",
] as const;

export interface ScheduleRow {
  gameId: string;
  season: number;
  gameType: string;
  week: number;
  /** YYYY-MM-DD, US Eastern date. */
  gameday: string;
  /** HH:MM, US Eastern time; null when not yet set. */
  gametime: string | null;
  awayTeam: string;
  awayScore: number | null;
  homeTeam: string;
  homeScore: number | null;
  location: string | null;
  overtime: boolean;
  stadium: string | null;
}

const POSTSEASON_ROUNDS: Readonly<Record<string, PostseasonRound>> = {
  WC: "WC",
  DIV: "DIV",
  CON: "CON",
  SB: "SB",
};

const ROUND_HEADLINE_KO: Record<PostseasonRound, string> = {
  WC: "와일드카드",
  DIV: "디비저널 라운드",
  CON: "콘퍼런스 챔피언십",
  SB: "슈퍼볼",
};

function toInteger(value: string | null, column: string, gameId: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`games.csv ${gameId}: invalid ${column} "${value}"`);
  return parsed;
}

function toNullableScore(value: string | null, column: string, gameId: string): number | null {
  return value === null ? null : toInteger(value, column, gameId);
}

export function parseSchedule(text: string): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const record of iterateSelectedColumns(text, SCHEDULE_COLUMNS)) {
    const gameId = record.game_id;
    if (gameId === null) continue;
    if (record.away_team === null || record.home_team === null || record.gameday === null || record.game_type === null) {
      throw new Error(`games.csv ${gameId}: missing team, date or game type`);
    }
    rows.push({
      gameId,
      season: toInteger(record.season, "season", gameId),
      gameType: record.game_type,
      week: toInteger(record.week, "week", gameId),
      gameday: record.gameday,
      gametime: record.gametime,
      awayTeam: record.away_team,
      awayScore: toNullableScore(record.away_score, "away_score", gameId),
      homeTeam: record.home_team,
      homeScore: toNullableScore(record.home_score, "home_score", gameId),
      location: record.location,
      overtime: record.overtime !== null && Number(record.overtime) === 1,
      stadium: record.stadium,
    });
  }
  return rows;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at the instant `utcMs`, in milliseconds (EDT -> -4h). */
export function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock date and time in `timeZone` to a UTC ISO string. The
 * offset is looked up twice so times next to a DST switch resolve correctly.
 */
export function zonedTimeToUtcIso(date: string, time: string, timeZone = "America/New_York"): string {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error(`Invalid date/time "${date} ${time}"`);
  const wallAsUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? 0),
  );
  let utc = wallAsUtc - timeZoneOffsetMs(wallAsUtc, timeZone);
  utc = wallAsUtc - timeZoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

export function kickoffAtUtc(row: ScheduleRow): string {
  // A game without a published start time is placed at midnight Eastern so it still sorts by date.
  return zonedTimeToUtcIso(row.gameday, row.gametime ?? "00:00");
}

export function seasonTypeOf(row: ScheduleRow): PublicSeasonType | null {
  if (row.gameType === "REG") return "REG";
  return POSTSEASON_ROUNDS[row.gameType] ? "POST" : null;
}

export function postseasonRoundOf(row: ScheduleRow): PostseasonRound | null {
  return POSTSEASON_ROUNDS[row.gameType] ?? null;
}

export function isFinal(row: ScheduleRow): boolean {
  return row.awayScore !== null && row.homeScore !== null;
}

/** Round name for postseason games, plus "연장전" for finals that went to overtime. */
export function headlineKo(row: ScheduleRow): string | null {
  const round = postseasonRoundOf(row);
  const parts: string[] = [];
  if (round) parts.push(ROUND_HEADLINE_KO[round]);
  if (isFinal(row) && row.overtime) parts.push("연장전");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * One Korean sentence about the result from the scores only, e.g.
 * "애틀랜타가 21점 차로 이겼어요." Null unless the game is final.
 */
export function resultLineKo(row: ScheduleRow): string | null {
  if (row.awayScore === null || row.homeScore === null) return null;
  const overtime = row.overtime ? "연장 끝에 " : "";
  if (row.awayScore === row.homeScore) {
    const score = `${row.awayScore}-${row.homeScore}`;
    return row.overtime ? `연장전에서도 승부가 나지 않아 ${score} 무승부로 끝났어요.` : `${score} 무승부로 끝났어요.`;
  }
  const winner = teamShortKo(row.homeScore > row.awayScore ? row.homeTeam : row.awayTeam);
  return `${overtime}${josa(winner, "이/가")} ${Math.abs(row.homeScore - row.awayScore)}점 차로 이겼어요.`;
}

/**
 * Game ids whose source kickoff is a placeholder (`kickoff_tbd`). Two
 * documented patterns:
 * 1. The source has no start time, so `kickoff_at` falls back to 00:00 ET.
 * 2. A regular-season week 18 or later with two or more games that all share
 *    one gameday and gametime. nflverse lists the whole final-week slate at a
 *    single slot (2026: every week-18 game at 2027-01-10 13:00) until the
 *    league sets the Saturday and Sunday times; a real final-week slate always
 *    uses several slots (2023-2025 each used five).
 */
export function placeholderKickoffIds(rows: readonly ScheduleRow[]): Set<string> {
  const ids = new Set<string>();
  const lateWeeks = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    if (row.gametime === null) ids.add(row.gameId);
    if (row.gameType === "REG" && row.week >= 18) {
      const key = `${row.season}-${row.week}`;
      const list = lateWeeks.get(key);
      if (list) list.push(row);
      else lateWeeks.set(key, [row]);
    }
  }
  for (const week of lateWeeks.values()) {
    const slots = new Set(week.map((row) => `${row.gameday} ${row.gametime ?? ""}`));
    if (week.length >= 2 && slots.size === 1) for (const row of week) ids.add(row.gameId);
  }
  return ids;
}

/** Fields that define a row's content; used to decide whether `updated_at` moves. */
type RowContent = Omit<PublicGameRow, "source_checked_at" | "updated_at">;

function contentKey(row: RowContent | PublicGameRow): string {
  const { source_checked_at: _checked, updated_at: _updated, ...content } = row as PublicGameRow;
  return JSON.stringify(Object.keys(content).sort().map((key) => [key, content[key as keyof RowContent]]));
}

export interface GameRowContext {
  checkedAt: string;
  runAt: string;
  hasRecap: boolean;
  previous?: PublicGameRow;
  /** From placeholderKickoffIds. */
  kickoffTbd?: boolean;
  /** Closeness computed from play-by-play; without it a final game gets the provisional margin estimate. */
  closeness?: Closeness | null;
}

export function toPublicGameRow(row: ScheduleRow, context: GameRowContext): PublicGameRow {
  const seasonType = seasonTypeOf(row);
  if (!seasonType) throw new Error(`${row.gameId}: unsupported game_type "${row.gameType}"`);
  const final = isFinal(row);
  const measured = final ? context.closeness ?? null : null;
  const closeness: Closeness | null = !final
    ? null
    : measured ?? estimateCloseness(row.awayScore as number, row.homeScore as number, row.overtime);
  const content: RowContent = {
    id: row.gameId,
    season: row.season,
    week: row.week,
    season_type: seasonType,
    kickoff_at: kickoffAtUtc(row),
    away_team_abbr: row.awayTeam,
    away_team_name_ko: teamNameKo(row.awayTeam),
    home_team_abbr: row.homeTeam,
    home_team_name_ko: teamNameKo(row.homeTeam),
    away_score: row.awayScore,
    home_score: row.homeScore,
    status: final ? "final" : "scheduled",
    venue: stadiumNameForSeason(row.stadium, row.season),
    headline_ko: headlineKo(row),
    is_published: true,
    source_updated_at: null,
    postseason_round: postseasonRoundOf(row),
    overtime: final && row.overtime,
    neutral_site: row.location === "Neutral",
    has_recap: context.hasRecap,
    kickoff_tbd: context.kickoffTbd === true,
    result_line_ko: resultLineKo(row),
    closeness,
    closeness_provisional: final && measured === null,
  };
  const unchanged = context.previous !== undefined && contentKey(context.previous) === contentKey(content);
  return {
    id: content.id,
    season: content.season,
    week: content.week,
    season_type: content.season_type,
    kickoff_at: content.kickoff_at,
    away_team_abbr: content.away_team_abbr,
    away_team_name_ko: content.away_team_name_ko,
    home_team_abbr: content.home_team_abbr,
    home_team_name_ko: content.home_team_name_ko,
    away_score: content.away_score,
    home_score: content.home_score,
    status: content.status,
    venue: content.venue,
    headline_ko: content.headline_ko,
    is_published: true,
    source_updated_at: content.source_updated_at,
    source_checked_at: context.checkedAt,
    updated_at: unchanged && context.previous ? context.previous.updated_at : context.runAt,
    postseason_round: content.postseason_round,
    overtime: content.overtime,
    neutral_site: content.neutral_site,
    has_recap: content.has_recap,
    kickoff_tbd: content.kickoff_tbd,
    result_line_ko: content.result_line_ko,
    closeness: content.closeness,
    closeness_provisional: content.closeness_provisional,
  };
}

/** Schedule rows of one season in a stable order: kickoff, then game id. */
export function seasonRows(rows: readonly ScheduleRow[], season: number): ScheduleRow[] {
  return rows
    .filter((row) => row.season === season && seasonTypeOf(row) !== null)
    .map((row) => ({ row, kickoff: kickoffAtUtc(row) }))
    .sort((a, b) => (a.kickoff === b.kickoff ? a.row.gameId.localeCompare(b.row.gameId) : a.kickoff < b.kickoff ? -1 : 1))
    .map(({ row }) => row);
}

/**
 * The NFL season a date belongs to. January and February games finish the
 * previous year's season. `date` is read in US Eastern time.
 */
export function nflSeasonForDate(date: Date): number {
  const { year, month } = easternYearMonth(date);
  return month <= 2 ? year - 1 : year;
}

/** From March through August the previous season is still worth showing. */
export function isOffseasonMonth(date: Date): boolean {
  const { month } = easternYearMonth(date);
  return month >= 3 && month <= 8;
}

function easternYearMonth(date: Date): { year: number; month: number } {
  const offset = timeZoneOffsetMs(date.getTime(), "America/New_York");
  const eastern = new Date(date.getTime() + offset);
  return { year: eastern.getUTCFullYear(), month: eastern.getUTCMonth() + 1 };
}

function compareWeek(
  a: { seasonType: PublicSeasonType; week: number },
  b: { seasonType: PublicSeasonType; week: number },
): number {
  if (a.seasonType !== b.seasonType) return a.seasonType === "REG" ? -1 : 1;
  return a.week - b.week;
}

export function buildSeasonIndexEntry(
  season: number,
  games: readonly PublicGameRow[],
  sourceCheckedAt: string,
): SeasonIndexEntry {
  const weeks = { REG: new Set<number>(), POST: new Set<number>() };
  for (const game of games) weeks[game.season_type].add(game.week);
  const ordered = games
    .map((game) => ({ seasonType: game.season_type, week: game.week, final: game.status === "final" }))
    .sort(compareWeek);
  const firstOpen = ordered.find((entry) => !entry.final);
  const last = ordered[ordered.length - 1];
  const current = firstOpen ?? last ?? { seasonType: "REG" as const, week: 1 };
  return {
    season,
    current: { seasonType: current.seasonType, week: current.week },
    weeks: {
      REG: [...weeks.REG].sort((a, b) => a - b),
      POST: [...weeks.POST].sort((a, b) => a - b),
    },
    gamesPath: `seasons/${season}/games.json`,
    standingsPath: `seasons/${season}/standings.json`,
    conceptsPath: `seasons/${season}/concepts.json`,
    sourceCheckedAt,
  };
}
