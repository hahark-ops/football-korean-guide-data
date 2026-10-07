import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCloseness, estimateCloseness } from '../../collector/closeness.ts';
import type { PlayRow } from '../../collector/types.ts';
import { makeGame, makePlay, smallGamePlays } from './fixtures.ts';

/** Rows at the given clock with the running score after each row. */
function game(rows: Array<[qtr: number, clock: string, away: number, home: number]>): PlayRow[] {
  return rows.map(([qtr, clock, away, home], index) => {
    const [minutes, seconds] = clock.split(':').map(Number);
    const left = minutes * 60 + seconds;
    return makePlay({
      play_id: index + 1,
      qtr,
      time: clock,
      game_seconds_remaining: qtr <= 4 ? (4 - qtr) * 900 + left : left,
      total_away_score: away,
      total_home_score: home,
    });
  });
}

function final(away: number, home: number, overtime = false) {
  return makeGame({ away_score: away, home_score: home, overtime });
}

test('4쿼터에 리드가 뒤집히고 최종 점수 차가 8점 이내면 close_to_end', () => {
  // Home leads 17-10 into the 4th; the away team goes ahead 24-17 at 3:00 and wins by 7.
  const flipped = game([
    [1, '15:00', 0, 0], [2, '10:00', 3, 10], [3, '05:00', 10, 17], [4, '09:00', 17, 17], [4, '03:00', 24, 17], [4, '00:00', 24, 17],
  ]);
  assert.equal(computeCloseness(final(24, 17), flipped), 'close_to_end');

  // One row flips the lead (14-17 -> 20-17) on the first snap of the 4th, compared with the 3rd-quarter score.
  const firstSnap = game([
    [1, '15:00', 0, 0], [2, '10:00', 7, 10], [3, '05:00', 14, 17], [4, '14:50', 20, 17], [4, '00:00', 22, 17],
  ]);
  assert.equal(computeCloseness(final(22, 17), firstSnap), 'close_to_end');

  // A final margin of exactly 8 still counts.
  const eight = game([
    [1, '15:00', 0, 0], [2, '10:00', 0, 7], [3, '05:00', 3, 10], [4, '06:00', 9, 10], [4, '05:55', 11, 10],
    [4, '02:00', 17, 10], [4, '01:55', 18, 10], [4, '00:00', 18, 10],
  ]);
  assert.equal(computeCloseness(final(18, 10), eight), 'close_to_end');
});

test('4쿼터에 동점이 되거나 동점에서 앞서가도 close_to_end', () => {
  // Home 21-14 into the 4th; tied 21-21 at 2:00 (lead -> tie), then home wins 24-21 (tie -> lead).
  // The same team led before and after, but the tie in between counts.
  const tied = game([
    [1, '15:00', 0, 0], [2, '10:00', 7, 14], [3, '05:00', 14, 21], [4, '02:00', 21, 21], [4, '00:03', 21, 24], [4, '00:00', 21, 24],
  ]);
  assert.equal(computeCloseness(final(21, 24), tied), 'close_to_end');

  // smallGamePlays: 7-7 into the 4th quarter, decided 10-7 with 30 seconds left (tie -> lead).
  assert.equal(computeCloseness(makeGame(), smallGamePlays()), 'close_to_end');
});

test('리드가 3쿼터에만 바뀌었으면 4쿼터에 접전이어도 close_once', () => {
  // The away team takes the lead 14-10 late in the 3rd and keeps it through the 4th (17-10, 17-13).
  const thirdOnly = game([
    [1, '15:00', 0, 0], [2, '10:00', 7, 10], [3, '01:00', 14, 10], [4, '10:00', 17, 10], [4, '02:00', 17, 13], [4, '00:00', 17, 13],
  ]);
  assert.equal(computeCloseness(final(17, 13), thirdOnly), 'close_once');
});

test('최종 점수 차가 9점 이상이면 4쿼터 역전이 있어도 close_to_end가 아니다', () => {
  // Home leads 17-20 into the 4th; the away team goes ahead 23-20 at 8:00 and wins 29-20 (FG, then a safety).
  const nine = game([
    [1, '15:00', 0, 0], [2, '10:00', 10, 13], [3, '05:00', 17, 20], [4, '08:00', 23, 20], [4, '07:55', 24, 20],
    [4, '04:00', 27, 20], [4, '01:00', 29, 20], [4, '00:00', 29, 20],
  ]);
  const result = computeCloseness(final(29, 20), nine);
  assert.notEqual(result, 'close_to_end');
  // Within one score at the lead change, so it was close once.
  assert.equal(result, 'close_once');
});

test('연장전 경기는 4쿼터나 연장에 동점이 되거나 앞서가므로 close_to_end', () => {
  // Tied 21-21 with 20 seconds left in regulation, home wins 21-27 in overtime.
  const overtime = game([
    [1, '15:00', 0, 0], [2, '01:00', 0, 21], [3, '08:00', 7, 21], [4, '06:00', 14, 21], [4, '00:20', 21, 21], [5, '10:00', 21, 21], [5, '04:00', 21, 27],
  ]);
  assert.equal(computeCloseness(final(21, 27, true), overtime), 'close_to_end');

  // Tied 10-10 through the whole 4th; the only change of sign is the overtime field goal (qtr 5).
  const otOnly = game([
    [1, '15:00', 0, 0], [2, '01:00', 7, 3], [3, '08:00', 7, 10], [3, '01:00', 10, 10], [4, '06:00', 10, 10], [5, '07:00', 13, 10], [5, '06:55', 13, 10],
  ]);
  assert.equal(computeCloseness(final(13, 10, true), otOnly), 'close_to_end');
});

test('3쿼터부터 한 번이라도 8점 이내였으면 close_once, 그것도 아니면 decided_early', () => {
  const once = game([
    [1, '15:00', 0, 0], [2, '01:00', 3, 10], [3, '08:00', 3, 17], [3, '02:00', 3, 24], [4, '06:00', 3, 31], [4, '00:00', 3, 31],
  ]);
  // Halftime score 3-10 is in effect when the 3rd quarter starts.
  assert.equal(computeCloseness(final(3, 31), once), 'close_once');

  // Close in the first half only: 7-7 before halftime, 7-21 from the first row of the 3rd quarter on.
  const firstHalfOnly = game([
    [1, '15:00', 0, 0], [2, '01:00', 7, 7], [2, '00:10', 7, 21], [3, '08:00', 7, 28], [4, '06:00', 14, 35], [4, '00:00', 14, 35],
  ]);
  assert.equal(computeCloseness(final(14, 35), firstHalfOnly), 'decided_early');

  const early = game([
    [1, '15:00', 0, 0], [2, '01:00', 0, 21], [3, '08:00', 0, 28], [4, '06:00', 7, 35], [4, '00:00', 7, 35],
  ]);
  assert.equal(computeCloseness(final(7, 35), early), 'decided_early');
});

test('경기가 끝나지 않았거나 플레이 데이터가 최종 점수와 다르면 계산하지 않는다', () => {
  assert.equal(computeCloseness(makeGame({ status: 'scheduled', away_score: null, home_score: null }), smallGamePlays()), null);
  assert.equal(computeCloseness(makeGame({ home_score: 14 }), smallGamePlays()), null);
  assert.equal(computeCloseness(makeGame(), []), null);
});

test('플레이 데이터 전 임시 추정: 연장이면 close_to_end, 8점 차 이내면 close_once, 아니면 decided_early', () => {
  assert.equal(estimateCloseness(30, 16, true), 'close_to_end');
  assert.equal(estimateCloseness(20, 20, true), 'close_to_end');
  assert.equal(estimateCloseness(20, 17, false), 'close_once');
  assert.equal(estimateCloseness(10, 18, false), 'close_once');
  assert.equal(estimateCloseness(17, 17, false), 'close_once');
  assert.equal(estimateCloseness(10, 19, false), 'decided_early');
  assert.equal(estimateCloseness(35, 7, false), 'decided_early');
});
