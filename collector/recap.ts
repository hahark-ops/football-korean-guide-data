import type {
  GameRecapFile,
  PlayKind,
  PlayTag,
  PublicGameRow,
  QuarterScore,
  RecapPlay,
  ScoreBreakdown,
} from "../src/data/publicData.ts";
import { isGlossarySlug } from "../src/content/glossary.ts";
import { findForbiddenContent } from "./forbidden.ts";
import { hasFinalConsonant, josa, joinKo } from "./korean.ts";
import type { NextSnap, PlayContext, PlayExplanation, PlayRow } from "./types.ts";

export type ExplainPlay = (play: PlayRow, context: PlayContext) => PlayExplanation;

export interface RecapDependencies {
  explain: ExplainPlay;
  teamShortKo: (abbr: string) => string;
  generatedAt: string;
  sourceCheckedAt: string;
  warn?: (message: string) => void;
}

export type RecapResult = { ok: true; recap: GameRecapFile } | { ok: false; reason: string };

export const MAX_KEY_PLAYS = 5;

export interface Score {
  away: number;
  home: number;
}

type Side = keyof Score;

/** Per-row facts derived from the whole game, aligned with the source rows. */
export interface Timeline {
  scoreBefore: Score[];
  scoreAfter: Score[];
  elapsed: number[];
}

function clockSeconds(time: string | null): number | null {
  if (time === null) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/** Overtime period length: 10 minutes in the regular season since 2017, 15 in the postseason. */
function overtimeLength(game: PublicGameRow, plays: readonly PlayRow[]): number {
  let length = game.season_type === "POST" ? 900 : 600;
  for (const play of plays) {
    if (play.qtr >= 5 && play.game_seconds_remaining !== null) {
      length = Math.max(length, play.game_seconds_remaining);
    }
  }
  return length;
}

/** Seconds left in the row's period. nflverse counts overtime down from the period length. */
function periodSecondsLeft(play: PlayRow): number | null {
  if (play.game_seconds_remaining !== null) {
    return play.qtr <= 4 ? play.game_seconds_remaining - (4 - play.qtr) * 900 : play.game_seconds_remaining;
  }
  return clockSeconds(play.time);
}

/**
 * Builds running scores and elapsed time for every row. Missing totals carry
 * the previous score forward; elapsed time never moves backwards.
 */
export function buildTimeline(game: PublicGameRow, plays: readonly PlayRow[]): Timeline {
  const otLength = overtimeLength(game, plays);
  const scoreBefore: Score[] = [];
  const scoreAfter: Score[] = [];
  const elapsed: number[] = [];
  let score: Score = { away: 0, home: 0 };
  let lastElapsed = 0;

  for (const play of plays) {
    scoreBefore.push(score);
    score = {
      away: play.total_away_score ?? score.away,
      home: play.total_home_score ?? score.home,
    };
    scoreAfter.push(score);

    const left = periodSecondsLeft(play);
    let value = lastElapsed;
    if (left !== null) {
      value =
        play.qtr <= 4
          ? (play.qtr - 1) * 900 + (900 - left)
          : 3600 + (play.qtr - 5) * otLength + Math.max(0, otLength - left);
    }
    lastElapsed = Math.max(lastElapsed, Math.round(value));
    elapsed.push(lastElapsed);
  }
  return { scoreBefore, scoreAfter, elapsed };
}

export function periodLabel(period: number): string {
  if (period <= 4) return `${period}Q`;
  return period === 5 ? "연장" : `연장${period - 4}`;
}

/**
 * Points scored in each period from the running totals at the end of each
 * period. Returns null when the periods do not add up to the final score.
 */
export function computeQuarterScores(
  plays: readonly PlayRow[],
  final: Score,
  timeline: Pick<Timeline, "scoreAfter"> = { scoreAfter: runningScores(plays) },
): QuarterScore[] | null {
  if (plays.length === 0) return null;
  const lastPeriod = Math.max(4, ...plays.map((play) => play.qtr));
  const endOfPeriod = new Map<number, Score>();
  plays.forEach((play, index) => endOfPeriod.set(play.qtr, timeline.scoreAfter[index]));

  const quarters: QuarterScore[] = [];
  let previous: Score = { away: 0, home: 0 };
  for (let period = 1; period <= lastPeriod; period += 1) {
    const end = endOfPeriod.get(period);
    if (!end) return null;
    const away = end.away - previous.away;
    const home = end.home - previous.home;
    if (away < 0 || home < 0) return null;
    quarters.push({ period, label: periodLabel(period), away, home });
    previous = end;
  }
  const awayTotal = quarters.reduce((sum, quarter) => sum + quarter.away, 0);
  const homeTotal = quarters.reduce((sum, quarter) => sum + quarter.home, 0);
  return awayTotal === final.away && homeTotal === final.home ? quarters : null;
}

function runningScores(plays: readonly PlayRow[]): Score[] {
  const scores: Score[] = [];
  let score: Score = { away: 0, home: 0 };
  for (const play of plays) {
    score = { away: play.total_away_score ?? score.away, home: play.total_home_score ?? score.home };
    scores.push(score);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Turning points (win probability is used here only, never published)

/**
 * Plays that can be turning points: real snaps and kicks with win probability
 * on both sides. No-play penalties (and timeouts, which nflverse also files as
 * `no_play`), kneels, spikes and aborted snaps are never candidates.
 */
export function isKeyPlayCandidate(play: PlayRow): boolean {
  return (
    play.play_type !== null &&
    play.play_type !== "no_play" &&
    play.play_type !== "qb_kneel" &&
    play.play_type !== "qb_spike" &&
    !play.timeout &&
    !play.qb_kneel &&
    !play.qb_spike &&
    !play.aborted_play &&
    play.home_wp !== null &&
    play.home_wp_post !== null
  );
}

/** Absolute change in home win probability on a candidate row. Internal only. */
function winProbabilitySwing(play: PlayRow): number {
  return Math.abs((play.home_wp_post as number) - (play.home_wp as number));
}

/**
 * Indexes of the turning points: the largest absolute changes in home win
 * probability (up to five), returned in game order.
 */
export function selectKeyPlayIndexes(
  plays: readonly PlayRow[],
  elapsed: readonly number[],
  limit = MAX_KEY_PLAYS,
): number[] {
  return rankBySwing(plays)
    .slice(0, limit)
    .sort((a, b) => elapsed[a] - elapsed[b] || a - b);
}

/** Candidate indexes, largest win-probability swing first (earlier row on ties). */
function rankBySwing(plays: readonly PlayRow[]): number[] {
  const candidates: Array<{ index: number; swing: number }> = [];
  plays.forEach((play, index) => {
    if (isKeyPlayCandidate(play)) candidates.push({ index, swing: winProbabilitySwing(play) });
  });
  return candidates.sort((a, b) => b.swing - a.swing || a.index - b.index).map((candidate) => candidate.index);
}

function leader(score: Score): -1 | 0 | 1 {
  return score.home > score.away ? 1 : score.home < score.away ? -1 : 0;
}

/** The lead moved from one team to the other (a tie on either side is not a lead change). */
export function isLeadChange(before: Score, after: Score): boolean {
  const from = leader(before);
  const to = leader(after);
  return from !== 0 && to !== 0 && from !== to;
}

function scoreIncreased(before: Score, after: Score): boolean {
  return after.away > before.away || after.home > before.home;
}

function mergeTags(explained: readonly PlayTag[], extra: readonly PlayTag[]): PlayTag[] {
  return [...new Set([...explained, ...extra])];
}

// ---------------------------------------------------------------------------
// Field bar

/** Kickoffs (free kicks included) and tries have no line of scrimmage to draw. */
function isKickoffOrTry(play: PlayRow): boolean {
  return (
    play.play_type === "kickoff" ||
    play.play_type === "extra_point" ||
    hasText(play.extra_point_result) ||
    hasText(play.two_point_conv_result)
  );
}

/**
 * Spot after the play in the offense's frame, only when `yards_gained` gives
 * it exactly: a counted pass or run snap (sacks are pass rows) with no
 * turnover. Null when nflverse `yards_gained` does not cover the whole play
 * (any fumble, a lateral, an aborted snap) or an enforced penalty moved the
 * ball. Checked against the next snap on 2025-2026 data: 7016 of 7033 clean
 * plays match, while penalty plays match 1 in 124.
 */
function exactEndSpot(play: PlayRow, start: number): number | null {
  if (play.play_type !== "pass" && play.play_type !== "run") return null;
  if (play.down === null || play.yards_gained === null) return null;
  if (play.interception || play.fumble_lost || play.fumble || play.lateral_reception || play.lateral_rush) return null;
  if (play.aborted_play || play.penalty) return null;
  return Math.min(100, Math.max(0, start - play.yards_gained));
}

/**
 * Field-bar data in the offense's frame (yards to the opponent end zone):
 * start is the snap spot; firstDownLine is the line to gain (0 when the
 * offense must reach the end zone). Null for kickoffs, tries and rows without
 * a ball spot.
 */
export function buildFieldBar(play: PlayRow): RecapPlay["fieldBar"] {
  if (play.yardline_100 === null || isKickoffOrTry(play)) return null;
  const start = play.yardline_100;
  const firstDownLine =
    play.down === null || play.ydstogo === null ? null : play.goal_to_go ? 0 : Math.max(0, start - play.ydstogo);
  return { start, end: exactEndSpot(play, start), firstDownLine };
}

// ---------------------------------------------------------------------------
// Score breakdown

function emptyBreakdown(): ScoreBreakdown {
  return { touchdowns: 0, extraPoints: 0, twoPointConversions: 0, fieldGoals: 0, safeties: 0, other: 0 };
}

/** 6*TD + XP + 2*2PT + 3*FG + 2*safety + other (the contract equation). */
export function breakdownPoints(breakdown: ScoreBreakdown): number {
  return (
    6 * breakdown.touchdowns +
    breakdown.extraPoints +
    2 * breakdown.twoPointConversions +
    3 * breakdown.fieldGoals +
    2 * breakdown.safeties +
    breakdown.other
  );
}

export type ScoreBreakdownResult =
  | { ok: true; breakdown: { away: ScoreBreakdown; home: ScoreBreakdown } }
  | { ok: false; reason: string };

/**
 * Credits every scoring flag to a side and checks it against the running
 * score change on the same row. Points a row added that no flag explains
 * (e.g. a defensive two-point return) go to `other`. A flag worth more than
 * the row's score change, or totals that miss the final score, fail.
 */
export function computeScoreBreakdown(
  plays: readonly PlayRow[],
  timeline: Pick<Timeline, "scoreBefore" | "scoreAfter">,
  final: Score,
): ScoreBreakdownResult {
  const breakdown = { away: emptyBreakdown(), home: emptyBreakdown() };
  for (let index = 0; index < plays.length; index += 1) {
    const play = plays[index];
    const before = timeline.scoreBefore[index];
    const after = timeline.scoreAfter[index];
    const delta: Score = { away: after.away - before.away, home: after.home - before.home };
    const credited: Score = { away: 0, home: 0 };
    const sideOf = (abbr: string | null): Side | null =>
      abbr === null ? null : abbr === play.home_team ? "home" : abbr === play.away_team ? "away" : null;
    // The only side whose score rose by at least `points`.
    const risenBy = (points: number): Side | null =>
      delta.home >= points && delta.away < points ? "home" : delta.away >= points && delta.home < points ? "away" : null;
    const credit = (side: Side | null, field: Exclude<keyof ScoreBreakdown, "other">, points: number) => {
      if (side === null) return;
      breakdown[side][field] += 1;
      credited[side] += points;
    };

    if (play.touchdown) credit(sideOf(play.td_team) ?? risenBy(6), "touchdowns", 6);
    if (play.extra_point_result === "good") credit(sideOf(play.posteam), "extraPoints", 1);
    if (play.two_point_conv_result === "success") credit(sideOf(play.posteam), "twoPointConversions", 2);
    if (play.field_goal_result === "made" || play.field_goal_result === "good") credit(sideOf(play.posteam), "fieldGoals", 3);
    if (play.safety) credit(risenBy(2) ?? sideOf(play.defteam), "safeties", 2);

    for (const side of ["away", "home"] as const) {
      const rest = delta[side] - credited[side];
      if (rest < 0) {
        return {
          ok: false,
          reason: `play ${play.play_id}: scoring flags credit ${side} ${credited[side]} points but the score rose by ${delta[side]}`,
        };
      }
      breakdown[side].other += rest;
    }
  }
  for (const side of ["away", "home"] as const) {
    const total = breakdownPoints(breakdown[side]);
    if (total !== final[side]) {
      return { ok: false, reason: `score breakdown for ${side} adds up to ${total}, final is ${final[side]}` };
    }
  }
  return { ok: true, breakdown };
}

// ---------------------------------------------------------------------------
// Recap plays

/** Halves keep possession across quarters; overtime starts over (in pairs of periods in the postseason). */
function halfOf(period: number): number {
  return period <= 2 ? 1 : period <= 4 ? 2 : 3 + Math.floor((period - 5) / 2);
}

/**
 * The first snap after row `index` in the same half: a later row with a down
 * and an offense (no-play penalty rows count, timeouts and markers do not),
 * before any kickoff. Null when the half or the game ended first.
 */
export function findNextSnap(plays: readonly PlayRow[], index: number): NextSnap | null {
  const half = halfOf(plays[index].qtr);
  for (let next = index + 1; next < plays.length; next += 1) {
    const row = plays[next];
    if (halfOf(row.qtr) !== half || row.play_type === "kickoff") return null;
    if (row.down === null || row.posteam === null || row.play_type === "extra_point" || hasText(row.two_point_conv_result)) continue;
    return { posteam: row.posteam, yardline100: row.yardline_100 };
  }
  return null;
}

function toRecapPlay(
  game: PublicGameRow,
  plays: readonly PlayRow[],
  index: number,
  timeline: Timeline,
  deps: RecapDependencies,
): RecapPlay {
  const play = plays[index];
  const before = timeline.scoreBefore[index];
  const after = timeline.scoreAfter[index];
  const context: PlayContext = {
    teamShortKo: deps.teamShortKo,
    scoreBefore: { ...before },
    homeTeam: game.home_team_abbr,
    awayTeam: game.away_team_abbr,
    nextSnap: findNextSnap(plays, index),
  };
  const explained = deps.explain(play, context);
  const extraTags: PlayTag[] = [];
  if (scoreIncreased(before, after)) extraTags.push("scoring");
  if (isLeadChange(before, after)) extraTags.push("lead_change");

  const termSlugs = [...new Set(explained.termSlugs)].filter((slug) => {
    if (isGlossarySlug(slug)) return true;
    deps.warn?.(`${game.id} play ${play.play_id}: unknown glossary slug "${slug}" dropped`);
    return false;
  });

  const secondsLeft = periodSecondsLeft(play);
  return {
    id: String(play.play_id),
    period: play.qtr,
    clock: play.time ?? formatClock(secondsLeft ?? 0),
    elapsedSeconds: timeline.elapsed[index],
    offense: play.posteam,
    defense: play.defteam,
    down: play.down,
    distance: play.ydstogo,
    yardline100: play.yardline_100,
    situationKo: explained.situationKo,
    kind: explained.kind,
    tags: mergeTags(explained.tags, extraTags),
    yards: play.yards_gained,
    titleKo: explained.titleKo,
    explanationKo: explained.explanationKo,
    termSlugs,
    scoreAfter: { away: after.away, home: after.home },
    fieldBar: buildFieldBar(play),
  };
}

// ---------------------------------------------------------------------------
// Summary

const ORDINAL_KO = ["", "", "두 번째", "세 번째", "네 번째", "다섯 번째"];

/** Prose period name: "1쿼터", "연장전", "두 번째 연장전". */
export function periodNameKo(period: number): string {
  if (period <= 4) return `${period}쿼터`;
  if (period === 5) return "연장전";
  return `${ORDINAL_KO[period - 4] ?? `${period - 4}번째`} 연장전`;
}

/** "4쿼터 2분 31초를 남기고", "1쿼터 12분을 남기고", "1쿼터 시작과 함께", "4쿼터 마지막 순간에" */
export function whenKo(period: number, clock: string): string {
  const name = periodNameKo(period);
  const seconds = clockSeconds(clock);
  if (seconds === null) return `${name}에`;
  if (seconds === 0) return `${name} 마지막 순간에`;
  const periodStart = period <= 4 ? seconds === 900 : seconds === 600 || seconds === 900;
  if (periodStart) return `${name} 시작과 함께`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const left = [minutes > 0 ? `${minutes}분` : "", rest > 0 ? `${rest}초` : ""].filter(Boolean).join(" ");
  return `${name} ${josa(left, "을/를")} 남기고`;
}

/**
 * Noun phrase naming who made the turning point and what it was, e.g.
 * "애틀랜타의 59야드 러싱 터치다운" or "시카고 수비의 가로채기". The team is the
 * one that made the play, which is not always the team it helped (a missed
 * field goal helps the other side), so the phrase never says who benefited.
 */
export function turningPointPhraseKo(
  play: PlayRow,
  kind: PlayKind,
  scoreChange: Score,
  teamShortKo: (abbr: string) => string,
): string {
  const name = (abbr: string | null): string | null => (abbr ? teamShortKo(abbr) : null);
  const off = name(play.posteam);
  const def = name(play.defteam);
  const defense = def === null ? null : `${def} 수비`;
  const of = (team: string | null, what: string) => (team ? `${team}의 ${what}` : what);
  const yards = (value: number | null) => (value !== null && value > 0 ? `${value}야드 ` : "");
  const defenseScored = play.touchdown && play.td_team !== null && play.td_team === play.defteam;

  switch (kind) {
    case "pass":
    case "run": {
      if (defenseScored) return of(defense, "터치다운");
      if (play.touchdown) return of(off, `${yards(play.yards_gained)}${kind === "pass" ? "패스" : "러싱"} 터치다운`);
      if (play.fourth_down_failed) return of(off, "4번째 공격 실패");
      if (play.fourth_down_converted || (play.down === 4 && play.first_down)) return of(off, "4번째 공격 성공");
      if (kind === "pass" && play.incomplete_pass) return of(off, "패스 실패");
      return of(off, kind === "pass" ? `${yards(play.yards_gained)}패스` : `${yards(play.yards_gained)}러싱 플레이`);
    }
    case "sack":
      return of(defense, "색");
    case "interception":
      // Intercepted, then fumbled back to the offense.
      if (play.fumble_lost) return play.touchdown && play.td_team === play.posteam ? of(off, "펌블 회수 터치다운") : of(defense, "가로채기 뒤 펌블");
      return of(defense, defenseScored ? "가로채기 터치다운" : "가로채기");
    case "fumble":
      // On kickoffs posteam receives; on a kicked punt posteam is the punting team that recovered.
      if (play.play_type === "kickoff") return of(def, "킥오프 펌블 회수");
      if (play.play_type === "punt" && play.kick_distance !== null) return of(off, "펀트 펌블 회수");
      return of(defense, defenseScored ? "펌블 회수 터치다운" : "펌블 회수");
    case "field_goal":
      if (play.field_goal_result === "made" || play.field_goal_result === "good") {
        return of(off, `${yards(play.kick_distance)}필드골`);
      }
      if (play.field_goal_result === "blocked") return of(defense, "필드골 블록");
      return of(off, hasText(play.field_goal_result) ? `${yards(play.kick_distance)}필드골 실패` : "필드골 시도");
    case "punt":
      // On punts posteam punts and defteam returns.
      if (play.punt_blocked) return of(defense, "펀트 블록");
      if (defenseScored) return of(def, "펀트 리턴 터치다운");
      if (isLongReturn(play)) return of(def, `${play.return_yards}야드 펀트 리턴`);
      return of(off, "펀트");
    case "kickoff":
      // On kickoffs posteam receives and defteam kicks.
      if (play.own_kickoff_recovery_td || (play.touchdown && play.td_team === play.defteam)) return of(def, "킥오프 회수 터치다운");
      if (play.touchdown && play.td_team === play.posteam) return of(off, "킥오프 리턴 터치다운");
      if (play.own_kickoff_recovery) {
        return of(def, play.kick_distance !== null && play.kick_distance <= ONSIDE_MAX_DISTANCE ? "온사이드 킥 성공" : "킥오프 회수");
      }
      if (isLongReturn(play)) return of(off, `${play.return_yards}야드 킥오프 리턴`);
      return of(def, "킥오프");
    case "extra_point":
      if (play.extra_point_result === "good") return of(off, "엑스트라 포인트");
      if (play.extra_point_result === "blocked") return of(defense, "엑스트라 포인트 블록");
      return of(off, "엑스트라 포인트 실패");
    case "two_point":
      return of(off, play.two_point_conv_result === "success" ? "2점 컨버전 성공" : "2점 컨버전 실패");
    case "safety": {
      const scorer =
        scoreChange.home === 2 && scoreChange.away === 0
          ? play.home_team
          : scoreChange.away === 2 && scoreChange.home === 0
            ? play.away_team
            : play.defteam;
      return of(name(scorer), "세이프티");
    }
    default:
      return of(off, "플레이");
  }
}

/** A return long enough to be the play itself, not just the kick. */
const LONG_RETURN_YARDS = 20;
/** Same threshold as the explainer's onside wording. */
const ONSIDE_MAX_DISTANCE = 20;

function isLongReturn(play: PlayRow): boolean {
  return play.return_yards !== null && play.return_yards >= LONG_RETURN_YARDS;
}

export interface TurningPoint {
  period: number;
  clock: string;
  /** From turningPointPhraseKo. */
  phraseKo: string;
}

/**
 * Two or three deterministic sentences: the result, the winner's best period
 * and the biggest turning point. Uses short team names only and never states
 * a probability.
 */
export function buildSummaryKo(input: {
  away: string;
  home: string;
  final: Score & { overtime: boolean };
  quarterScores: readonly QuarterScore[];
  turningPoint: TurningPoint | null;
}): string {
  const { away, home, final } = input;
  const sentences: string[] = [];
  const winnerSide = final.home > final.away ? "home" : final.home < final.away ? "away" : null;

  if (winnerSide === null) {
    const score = `${final.away}-${final.home}`;
    sentences.push(
      `${josa(away, "과/와")} ${josa(home, "은/는")} ${final.overtime ? "연장전까지 치르고도 " : ""}${josa(score, "으로/로")} 비겼어요.`,
    );
  } else {
    const winner = winnerSide === "home" ? home : away;
    const loser = winnerSide === "home" ? away : home;
    const winnerScore = Math.max(final.away, final.home);
    const loserScore = Math.min(final.away, final.home);
    sentences.push(
      `${josa(winner, "이/가")} ${final.overtime ? "연장전 끝에 " : ""}${josa(loser, "을/를")} ${winnerScore}-${loserScore}, ${winnerScore - loserScore}점 차로 이겼어요.`,
    );

    const points = input.quarterScores.map((quarter) => quarter[winnerSide]);
    const best = Math.max(0, ...points);
    const bestQuarters = input.quarterScores.filter((quarter) => quarter[winnerSide] === best);
    const regulationEven = bestQuarters.filter((quarter) => quarter.period <= 4).length === 4;
    if (best > 0 && regulationEven) {
      // Nothing to compare when every regulation quarter is the same.
      sentences.push(`${josa(winner, "은/는")} 네 쿼터 모두 ${best}점씩 올렸어요.`);
    } else if (best > 0) {
      const periods = bestQuarters.map((quarter) => periodNameKo(quarter.period));
      sentences.push(
        periods.length === 1
          ? `${josa(winner, "은/는")} ${periods[0]}에 가장 많은 ${best}점을 올렸어요.`
          : `${josa(winner, "은/는")} ${joinKo(periods)}에 각각 ${best}점씩 올려 가장 많이 득점했어요.`,
      );
    }
  }

  const turningPoint = input.turningPoint;
  if (turningPoint) {
    const copula = hasFinalConsonant(turningPoint.phraseKo) ? "이었어요" : "였어요";
    sentences.push(
      `가장 큰 흐름 변화는 ${whenKo(turningPoint.period, turningPoint.clock)} 나온 ${turningPoint.phraseKo}${copula}.`,
    );
  }
  return sentences.join(" ");
}

// ---------------------------------------------------------------------------
// Recap file

/** Builds one game's recap, or explains why it must be skipped. Never publishes inconsistent numbers. */
export function buildGameRecap(
  game: PublicGameRow,
  plays: readonly PlayRow[],
  deps: RecapDependencies,
): RecapResult {
  if (game.status !== "final" || game.away_score === null || game.home_score === null) {
    return { ok: false, reason: "game is not final" };
  }
  if (plays.length === 0) return { ok: false, reason: "no play-by-play rows" };
  const final: Score = { away: game.away_score, home: game.home_score };

  const timeline = buildTimeline(game, plays);
  const quarterScores = computeQuarterScores(plays, final, timeline);
  if (!quarterScores) {
    const last = timeline.scoreAfter[timeline.scoreAfter.length - 1];
    return {
      ok: false,
      reason: `period scores do not add up to the final score (play-by-play ${last.away}-${last.home}, schedule ${final.away}-${final.home})`,
    };
  }
  const wentToOvertime = quarterScores.length > 4;
  if (wentToOvertime !== game.overtime) {
    return { ok: false, reason: `overtime flag (${game.overtime}) disagrees with play-by-play periods (${quarterScores.length})` };
  }

  const scoreBreakdown = computeScoreBreakdown(plays, timeline, final);
  if (!scoreBreakdown.ok) return { ok: false, reason: scoreBreakdown.reason };

  const ranked = rankBySwing(plays);
  if (ranked.length === 0) return { ok: false, reason: "no key play candidates (win probability missing)" };
  const keyIndexes = selectKeyPlayIndexes(plays, timeline.elapsed);
  const keyPlays = keyIndexes.map((index) => toRecapPlay(game, plays, index, timeline, deps));
  const scoringPlays: RecapPlay[] = [];
  plays.forEach((_, index) => {
    if (scoreIncreased(timeline.scoreBefore[index], timeline.scoreAfter[index])) {
      scoringPlays.push(toRecapPlay(game, plays, index, timeline, deps));
    }
  });

  const biggest = ranked[0];
  const biggestPlay = keyPlays[keyIndexes.indexOf(biggest)];
  const change: Score = {
    away: timeline.scoreAfter[biggest].away - timeline.scoreBefore[biggest].away,
    home: timeline.scoreAfter[biggest].home - timeline.scoreBefore[biggest].home,
  };
  const turningPoint: TurningPoint = {
    period: biggestPlay.period,
    clock: biggestPlay.clock,
    phraseKo: turningPointPhraseKo(plays[biggest], biggestPlay.kind, change, deps.teamShortKo),
  };

  const away = deps.teamShortKo(game.away_team_abbr);
  const home = deps.teamShortKo(game.home_team_abbr);
  return {
    ok: true,
    recap: {
      schemaVersion: 1,
      gameId: game.id,
      season: game.season,
      week: game.week,
      seasonType: game.season_type,
      generatedAt: deps.generatedAt,
      sourceCheckedAt: deps.sourceCheckedAt,
      away: { abbr: game.away_team_abbr, nameKo: game.away_team_name_ko },
      home: { abbr: game.home_team_abbr, nameKo: game.home_team_name_ko },
      final: { away: final.away, home: final.home, overtime: game.overtime },
      quarterScores,
      scoreBreakdown: scoreBreakdown.breakdown,
      keyPlays,
      scoringPlays,
      summaryKo: buildSummaryKo({ away, home, final: { ...final, overtime: game.overtime }, quarterScores, turningPoint }),
    },
  };
}

/**
 * Whether a recap written by an earlier run still matches the schedule row
 * and the current contract, so `has_recap` can stay true when this run does
 * not rebuild it. Files from before the contract revision (win probability,
 * no score breakdown or field bars) are not valid.
 */
export function isRecapStillValid(value: unknown, game: PublicGameRow): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (findForbiddenContent(value) !== null) return false;
  const recap = value as Partial<GameRecapFile>;
  if (recap.schemaVersion !== 1 || recap.gameId !== game.id || game.status !== "final") return false;
  const final = recap.final;
  if (!final || final.away !== game.away_score || final.home !== game.home_score || final.overtime !== game.overtime) {
    return false;
  }
  if (!Array.isArray(recap.quarterScores) || !Array.isArray(recap.keyPlays) || !Array.isArray(recap.scoringPlays)) {
    return false;
  }
  const breakdown = recap.scoreBreakdown;
  if (!breakdown || typeof breakdown.away !== "object" || typeof breakdown.home !== "object") return false;
  if (breakdownPoints(breakdown.away) !== game.away_score || breakdownPoints(breakdown.home) !== game.home_score) return false;
  if (![...recap.keyPlays, ...recap.scoringPlays].every((play) => play !== null && typeof play === "object" && "fieldBar" in play)) {
    return false;
  }
  const awayTotal = recap.quarterScores.reduce((sum, quarter) => sum + quarter.away, 0);
  const homeTotal = recap.quarterScores.reduce((sum, quarter) => sum + quarter.home, 0);
  return awayTotal === game.away_score && homeTotal === game.home_score && recap.keyPlays.length > 0;
}
