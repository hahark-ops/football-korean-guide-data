import type { PublicGameRow } from "../src/data/publicData.ts";
import { buildTimeline, computeQuarterScores, type Score } from "./recap.ts";
import type { PlayRow } from "./types.ts";

export type Closeness = NonNullable<PublicGameRow["closeness"]>;

/** One score: a touchdown plus a two-point conversion. */
export const ONE_SCORE_MARGIN = 8;

function withinOneScore(score: Score): boolean {
  return Math.abs(score.home - score.away) <= ONE_SCORE_MARGIN;
}

/** Sign of home minus away: 1 home leads, -1 away leads, 0 tied. */
function leadSign(score: Score): -1 | 0 | 1 {
  return Math.sign(score.home - score.away) as -1 | 0 | 1;
}

/**
 * How watchable a final game was, from the running score.
 * - close_to_end: the lead changed hands or the score became tied during the
 *   4th quarter or overtime (the sign of home minus away differs before and
 *   after a row with qtr >= 4; lead -> tie and tie -> lead both count), and
 *   the final margin is one score (8 points) or less.
 * - close_once: otherwise within one score at some point from the 3rd quarter
 *   on. The score in effect when the 3rd quarter opens is the score before its
 *   first row; every later row adds the score after it.
 * - decided_early: neither.
 * Returns null when the game is not final or the play-by-play running score
 * does not reach the final score (the caller then estimates from the margin).
 */
export function computeCloseness(game: PublicGameRow, plays: readonly PlayRow[]): Closeness | null {
  if (game.status !== "final" || game.away_score === null || game.home_score === null || plays.length === 0) return null;
  const timeline = buildTimeline(game, plays);
  if (!computeQuarterScores(plays, { away: game.away_score, home: game.home_score }, timeline)) return null;

  const finalWithinOneScore = withinOneScore({ away: game.away_score, home: game.home_score });
  const lateSwing = plays.some(
    (play, index) => play.qtr >= 4 && leadSign(timeline.scoreBefore[index]) !== leadSign(timeline.scoreAfter[index]),
  );
  if (lateSwing && finalWithinOneScore) return "close_to_end";

  const thirdQuarterStart = plays.findIndex((play) => play.qtr >= 3);
  const closeOnce =
    thirdQuarterStart !== -1 &&
    (withinOneScore(timeline.scoreBefore[thirdQuarterStart]) ||
      timeline.scoreAfter.slice(thirdQuarterStart).some(withinOneScore));
  return closeOnce ? "close_once" : "decided_early";
}

/**
 * Estimate before play-by-play arrives (`closeness_provisional`): an overtime
 * game was close at the end, a final margin within one score was close at
 * least once, and anything else counts as decided early until the play data
 * says otherwise.
 */
export function estimateCloseness(awayScore: number, homeScore: number, overtime: boolean): Closeness {
  if (overtime) return "close_to_end";
  return Math.abs(homeScore - awayScore) <= ONE_SCORE_MARGIN ? "close_once" : "decided_early";
}
