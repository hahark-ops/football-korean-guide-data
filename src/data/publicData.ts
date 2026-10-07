/**
 * Public data contract (schema version 1) between the collector and the app.
 *
 * The collector (`collector/`) turns free nflverse data into static JSON files.
 * The app only reads them. Files live under one base URL:
 *
 *   index.json                          PublicDataIndex
 *   seasons/{season}/games.json         SeasonGamesFile
 *   seasons/{season}/standings.json     StandingsFile
 *   games/{gameId}.json                 GameRecapFile (final games with play data only)
 *   seasons/{season}/concepts.json      ConceptExamplesFile
 *
 * Rules every producer and consumer must keep:
 * - Never include English play descriptions (`desc`) or player names. Korean
 *   explanations are generated from structured fields only.
 * - Never publish win probability, odds, spreads, totals or any betting-like
 *   number, not even inside Korean sentences. Win probability change is used
 *   only inside the collector to choose turning points (Apps in Toss review
 *   risk: post-game probabilities can read like odds). `verify:data` fails on
 *   such keys or phrases.
 * - Times are ISO 8601 UTC strings. The app formats them in Korea time.
 * - `source_updated_at` means a time the source itself states. nflverse does
 *   not state per-game update times, so it stays null unless known.
 *   `source_checked_at` is when the collector read the source. `updated_at` is
 *   when this record's content last changed in our output.
 * - A game is `final` only when both scores are present in the source. A game
 *   past kickoff without scores stays `scheduled`; the app must not invent a
 *   live state.
 */

export const PUBLIC_DATA_SCHEMA_VERSION = 1;

export interface PublicDataSource {
  name: "nflverse";
  url: string;
  license: "CC-BY-4.0";
  /** Shown in the app, e.g. "경기 데이터: nflverse (CC BY 4.0)". */
  attributionKo: string;
}

export type PublicSeasonType = "REG" | "POST";
export type PostseasonRound = "WC" | "DIV" | "CON" | "SB";

export interface SeasonIndexEntry {
  season: number;
  /** Week the app should open by default: the earliest week that still has a non-final game, else the last week. */
  current: { seasonType: PublicSeasonType; week: number };
  /** Weeks that exist in the schedule, ascending. POST weeks use nflverse numbering (19..22). */
  weeks: { REG: number[]; POST: number[] };
  gamesPath: string;
  standingsPath: string;
  conceptsPath: string;
  sourceCheckedAt: string;
}

export interface PublicDataIndex {
  schemaVersion: 1;
  generatedAt: string;
  source: PublicDataSource;
  /** Newest first. Phase 1 publishes the current season, plus the previous one only during the off-season. */
  seasons: SeasonIndexEntry[];
  latestSeason: number;
}

/**
 * One schedule row. Same snake_case shape as the former Supabase `games`
 * table so the app's existing validation (`mapPublishedGame`) keeps working.
 */
export interface PublicGameRow {
  id: string;
  season: number;
  week: number;
  season_type: PublicSeasonType;
  kickoff_at: string;
  /** Source abbreviation as published by nflverse (Rams = "LA"). */
  away_team_abbr: string;
  away_team_name_ko: string;
  home_team_abbr: string;
  home_team_name_ko: string;
  away_score: number | null;
  home_score: number | null;
  status: "scheduled" | "final";
  venue: string | null;
  /** Short Korean label such as "와일드카드" or "연장전", else null. */
  headline_ko: string | null;
  is_published: true;
  source_updated_at: string | null;
  source_checked_at: string;
  updated_at: string;
  postseason_round: PostseasonRound | null;
  overtime: boolean;
  neutral_site: boolean;
  /** True when games/{id}.json exists. */
  has_recap: boolean;
  /**
   * True while the source still shows a placeholder kickoff (nflverse lists
   * every week-18 game at the same time until the league sets the slate).
   * The app shows the date only and "시간 미정".
   */
  kickoff_tbd: boolean;
  /**
   * One Korean sentence about the result built from scores only, e.g.
   * "애틀랜타가 21점 차로 이겼어요." or "연장 끝에 3점 차로 끝났어요.".
   * Spoiler content; null unless final.
   */
  result_line_ko: string | null;
  /**
   * How watchable the game was, for the spoiler-safe "볼 만한 경기" hint.
   * close_to_end: the lead changed hands or the score became tied during the
   *   4th quarter or overtime, AND the final margin is 8 points or less
   *   (about a third of games; 2025: 33%, 2026 weeks 1-4: 36%);
   * close_once: otherwise within one score (8 points) at some point from the
   *   3rd quarter on;
   * decided_early: neither.
   * Without play data (closeness_provisional): overtime -> close_to_end,
   * final margin <= 8 -> close_once, else decided_early.
   * Null unless final. Revealing it is itself a spoiler.
   */
  closeness: "close_to_end" | "close_once" | "decided_early" | null;
  /** True when closeness was estimated from the final margin only because play data has not arrived yet. */
  closeness_provisional: boolean;
}

export interface SeasonGamesFile {
  schemaVersion: 1;
  season: number;
  generatedAt: string;
  sourceCheckedAt: string;
  games: PublicGameRow[];
}

export interface TeamStanding {
  abbr: string;
  nameKo: string;
  wins: number;
  losses: number;
  ties: number;
  /** (wins + ties / 2) / games, 3 decimals; 0 when no games. */
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  /** e.g. "W2", "L1", "T1"; null before the first game. */
  streak: string | null;
  divisionRecord: string;
  /**
   * 1-based rank inside the division by win pct only. Teams with the same win
   * pct share a rank (1, 2, 2, 4) and are listed by Korean name; official
   * tiebreakers are not simulated.
   */
  divisionRank: number;
  /** True when another team in the division has the same win pct. */
  tied: boolean;
  /**
   * Division rank change versus the standings before the most recent
   * completed week (positive = moved up). Null before week 2 or when the team
   * did not play since.
   */
  rankChange: number | null;
}

export interface DivisionStanding {
  conference: "AFC" | "NFC";
  division: "East" | "North" | "South" | "West";
  /** e.g. "AFC 동부" */
  nameKo: string;
  teams: TeamStanding[];
}

export interface StandingsFile {
  schemaVersion: 1;
  season: number;
  generatedAt: string;
  sourceCheckedAt: string;
  /** Regular-season games counted so far. */
  gamesCounted: number;
  /** Korean note shown with the table, e.g. "승률 순으로 정렬했어요. 승률이 같으면 동률로 표시하고, 공식 순위 결정 방식(맞대결 등)은 반영하지 않았어요." */
  methodNoteKo: string;
  divisions: DivisionStanding[];
}

export type PlayKind =
  | "pass"
  | "run"
  | "sack"
  | "interception"
  | "fumble"
  | "field_goal"
  | "punt"
  | "kickoff"
  | "extra_point"
  | "two_point"
  | "penalty"
  | "safety"
  | "other";

/**
 * fourth_down: the offense ran a play (pass, run, sack, interception, fumble)
 * on 4th down instead of punting or kicking, so the app can call it a
 * "4번째 공격 도전". red_zone: same play kinds snapped at yardline100 <= 20.
 * Punts, field goals and no-play penalties never carry these two tags.
 */
export type PlayTag =
  | "touchdown"
  | "first_down"
  | "turnover"
  | "fourth_down"
  | "scoring"
  | "big_play"
  | "penalty"
  | "red_zone"
  | "lead_change";

export interface RecapPlay {
  /** nflverse play_id as a string. */
  id: string;
  /** 1-4, 5+ for overtime. */
  period: number;
  /** Game clock at the snap, "MM:SS". */
  clock: string;
  /** Seconds since kickoff (0..3600, more in overtime). */
  elapsedSeconds: number;
  offense: string | null;
  defense: string | null;
  down: number | null;
  distance: number | null;
  /** Yards from the offense to the opponent's end zone (nflverse yardline_100). */
  yardline100: number | null;
  /** e.g. "3rd & 4 · 상대 진영 38야드"; null for kickoffs and tries. */
  situationKo: string | null;
  kind: PlayKind;
  tags: PlayTag[];
  yards: number | null;
  /** Short headline, e.g. "애틀랜타, 12야드 터치다운 패스". No player names. */
  titleKo: string;
  /** One or two beginner sentences generated from structured fields only. */
  explanationKo: string;
  /** Glossary slugs (src/content/glossary.ts) the explanation relies on. */
  termSlugs: string[];
  scoreAfter: { away: number; home: number };
  /**
   * Data for a simple field bar, all in the offense's frame as yards from the
   * opponent end zone (0 = goal line to score on, 100 = own goal line).
   * Null for kickoffs, tries and rows where the ball spot is unknown.
   * end is null when the play did not count (no-play penalty), on turnovers
   * and when the spot after the play cannot be derived exactly.
   */
  fieldBar: { start: number; end: number | null; firstDownLine: number | null } | null;
}

export interface ScoreBreakdown {
  touchdowns: number;
  extraPoints: number;
  twoPointConversions: number;
  fieldGoals: number;
  safeties: number;
  /** Rare points that fit none of the above (e.g. defensive two-point return). Keeps the sum exact. */
  other: number;
}

export interface QuarterScore {
  period: number;
  /** "1Q".."4Q", "연장" (and "연장2" if ever needed). */
  label: string;
  away: number;
  home: number;
}

export interface GameRecapFile {
  schemaVersion: 1;
  gameId: string;
  season: number;
  week: number;
  seasonType: PublicSeasonType;
  generatedAt: string;
  sourceCheckedAt: string;
  away: { abbr: string; nameKo: string };
  home: { abbr: string; nameKo: string };
  final: { away: number; home: number; overtime: boolean };
  /** Points scored in each period (not running totals). Sums equal the final score. */
  quarterScores: QuarterScore[];
  /** 6*touchdowns + extraPoints + 2*twoPointConversions + 3*fieldGoals + 2*safeties + other equals the final score for each side. */
  scoreBreakdown: { away: ScoreBreakdown; home: ScoreBreakdown };
  /**
   * Turning points chosen inside the collector by absolute win-probability
   * change, sorted by time: 5 when available, at least 3 when the game has 3
   * or more candidates. No-play penalties, timeouts, kneels, spikes and
   * aborted snaps are never candidates.
   */
  keyPlays: RecapPlay[];
  /** Every scoring play in time order. */
  scoringPlays: RecapPlay[];
  /** Two or three deterministic Korean sentences summarizing how the game was won, with no probabilities. Spoiler content. */
  summaryKo: string;
}

/** One real play that illustrates a glossary term. */
export interface ConceptExample {
  gameId: string;
  week: number;
  seasonType: PublicSeasonType;
  /** Teams of that game, so the app can skip examples from games the user is hiding. */
  away: string;
  home: string;
  play: RecapPlay;
}

export interface ConceptExamplesFile {
  schemaVersion: 1;
  season: number;
  generatedAt: string;
  /** Up to 3 most recent examples per glossary slug, newest first. Slugs with no example yet are omitted. */
  examples: Record<string, ConceptExample[]>;
}
