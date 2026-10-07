import assert from 'node:assert/strict';
import test from 'node:test';
import {
  breakdownPoints,
  buildFieldBar,
  buildGameRecap,
  buildSummaryKo,
  buildTimeline,
  computeQuarterScores,
  findNextSnap,
  computeScoreBreakdown,
  isKeyPlayCandidate,
  isLeadChange,
  isRecapStillValid,
  selectKeyPlayIndexes,
  turningPointPhraseKo,
  whenKo,
} from '../../collector/recap.ts';
import { findForbiddenContent } from '../../collector/forbidden.ts';
import { teamShortKo } from '../../collector/teams.ts';
import type { PlayContext, PlayRow } from '../../collector/types.ts';
import { fakeExplain, makeGame, makePlay, smallGamePlays } from './fixtures.ts';

const DEPS = {
  explain: fakeExplain,
  teamShortKo,
  generatedAt: '2026-10-07T08:00:00.000Z',
  sourceCheckedAt: '2026-10-07T07:59:00.000Z',
};

function build(plays: PlayRow[], game = makeGame()) {
  const result = buildGameRecap(game, plays, DEPS);
  if (!result.ok) assert.fail(result.reason);
  return result.recap;
}

test('쿼터별 득점은 각 쿼터 끝의 누적 점수 차이이고 합이 최종 점수와 같다', () => {
  const recap = build(smallGamePlays());
  assert.deepEqual(recap.quarterScores, [
    { period: 1, label: '1Q', away: 7, home: 0 },
    { period: 2, label: '2Q', away: 0, home: 7 },
    { period: 3, label: '3Q', away: 0, home: 0 },
    { period: 4, label: '4Q', away: 3, home: 0 },
  ]);
  assert.deepEqual(recap.final, { away: 10, home: 7, overtime: false });
});

test('쿼터 합이 일정의 최종 점수와 다르면 요약을 만들지 않는다', () => {
  const result = buildGameRecap(makeGame({ home_score: 10 }), smallGamePlays(), DEPS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /do not add up/);
  assert.equal(computeQuarterScores(smallGamePlays(), { away: 10, home: 10 }), null);
  // A missing period also counts as inconsistent.
  const withoutThird = smallGamePlays().filter((play) => play.qtr !== 3);
  assert.equal(computeQuarterScores(withoutThird, { away: 10, home: 7 }), null);
});

function overtimeGame(): PlayRow[] {
  const plays = smallGamePlays()
    .filter((play) => !(play.qtr === 4 && play.play_type !== null))
    .map((play) => (play.qtr === 4 ? { ...play, total_away_score: 7 } : play));
  return [
    ...plays,
    makePlay({ play_id: 200, qtr: 5, time: '10:00', game_seconds_remaining: 600, play_type: 'kickoff', down: null, home_wp: 0.5, home_wp_post: 0.52, total_away_score: 7, total_home_score: 7 }),
    // A timeout row logged with a later clock must not move elapsed time backwards.
    makePlay({ play_id: 205, qtr: 5, time: '09:58', game_seconds_remaining: 598, play_type: 'pass', home_wp: 0.52, home_wp_post: 0.6, total_away_score: 7, total_home_score: 7 }),
    makePlay({ play_id: 210, qtr: 5, time: '09:59', game_seconds_remaining: 599, play_type: 'no_play', timeout: true, home_wp: 0.6, home_wp_post: null, total_away_score: 7, total_home_score: 7 }),
    makePlay({ play_id: 220, qtr: 5, time: '06:12', game_seconds_remaining: 372, play_type: 'field_goal', posteam: 'NO', defteam: 'ATL', down: 4, field_goal_result: 'made', kick_distance: 31, home_wp: 0.6, home_wp_post: 1, total_away_score: 7, total_home_score: 10 }),
    makePlay({ play_id: 230, qtr: 5, time: '06:08', game_seconds_remaining: 368, play_type: null, home_wp: 1, home_wp_post: 1, total_away_score: 7, total_home_score: 10 }),
  ];
}

test('연장전은 "연장"으로 표시하고 시간은 3600초 뒤로 이어진다', () => {
  const game = makeGame({ away_score: 7, home_score: 10, overtime: true });
  const recap = build(overtimeGame(), game);
  assert.deepEqual(recap.quarterScores.at(-1), { period: 5, label: '연장', away: 0, home: 3 });
  const overtimePlay = recap.scoringPlays.at(-1);
  assert.equal(overtimePlay?.period, 5);
  assert.equal(overtimePlay?.elapsedSeconds, 3600 + 600 - 372);
  assert.equal(overtimePlay?.clock, '06:12');
  assert.match(recap.summaryKo, /^뉴올리언스가 연장전 끝에 애틀랜타를 10-7, 3점 차로 이겼어요\./);
  assert.match(recap.summaryKo, /가장 큰 흐름 변화는 연장전 6분 12초를 남기고 나온 뉴올리언스의 31야드 필드골이었어요\.$/);

  const timeline = buildTimeline(game, overtimeGame());
  for (let i = 1; i < timeline.elapsed.length; i += 1) assert.ok(timeline.elapsed[i] >= timeline.elapsed[i - 1]);

  // The schedule's overtime flag must agree with the play-by-play periods.
  const mismatch = buildGameRecap(makeGame({ away_score: 7, home_score: 10, overtime: false }), overtimeGame(), DEPS);
  assert.equal(mismatch.ok, false);
});

test('출력에는 승리 확률 값이 어디에도 없다 (선택에만 내부적으로 쓴다)', () => {
  const recap = build(smallGamePlays());
  assert.equal(findForbiddenContent(recap), null);
  assert.ok(!('winProbability' in recap));
  for (const play of [...recap.keyPlays, ...recap.scoringPlays]) {
    assert.deepEqual(Object.keys(play), [
      'id', 'period', 'clock', 'elapsedSeconds', 'offense', 'defense', 'down', 'distance', 'yardline100', 'situationKo',
      'kind', 'tags', 'yards', 'titleKo', 'explanationKo', 'termSlugs', 'scoreAfter', 'fieldBar',
    ]);
  }
  assert.doesNotMatch(recap.summaryKo, /확률|%/);
});

test('핵심 플레이는 승리 확률 변화가 큰 5개를 고른 뒤 시간 순으로 둔다', () => {
  const recap = build(smallGamePlays());
  assert.deepEqual(recap.keyPlays.map((play) => play.id), ['20', '50', '60', '80', '90']);
  const fieldGoal = recap.keyPlays.at(-1);
  assert.equal(fieldGoal?.kind, 'field_goal');
  assert.deepEqual(fieldGoal?.scoreAfter, { away: 10, home: 7 });
  assert.equal(fieldGoal?.elapsedSeconds, 3570);
  assert.deepEqual(fieldGoal?.termSlugs, ['down']);
  for (const play of recap.keyPlays) assert.ok(!['70', '100', '1', '40', '110'].includes(play.id));
});

test('후보가 적으면 있는 만큼만, 무효 플레이(반칙)·타임아웃·무릎 꿇기·스파이크·스냅 실수는 빼고 고른다', () => {
  const base = { home_wp: 0.5, home_wp_post: 0.9 };
  assert.equal(isKeyPlayCandidate(makePlay(base)), true);
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, timeout: true, play_type: 'no_play' })), false);
  // A no-play penalty swings win probability too, but its result did not count.
  assert.equal(
    isKeyPlayCandidate(makePlay({ ...base, play_type: 'no_play', penalty: true, penalty_type: 'Defensive Pass Interference', penalty_yards: 40 })),
    false,
  );
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, play_type: 'qb_kneel', qb_kneel: true })), false);
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, play_type: 'qb_spike', qb_spike: true })), false);
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, aborted_play: true })), false);
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, play_type: null })), false);
  assert.equal(isKeyPlayCandidate(makePlay({ ...base, home_wp_post: null })), false);

  const plays = [
    makePlay({ play_id: 1, game_seconds_remaining: 3000, home_wp: 0.5, home_wp_post: 0.6 }),
    makePlay({ play_id: 2, game_seconds_remaining: 2000, home_wp: 0.6, home_wp_post: 0.3 }),
    makePlay({ play_id: 3, game_seconds_remaining: 1000, home_wp: 0.3, home_wp_post: 0.35 }),
    makePlay({ play_id: 4, game_seconds_remaining: 900, home_wp: 0.35, home_wp_post: 0.1, qb_kneel: true, play_type: 'qb_kneel' }),
    makePlay({ play_id: 5, game_seconds_remaining: 800, home_wp: 0.1, home_wp_post: 0.9, play_type: 'no_play', penalty: true }),
  ];
  const elapsed = buildTimeline(makeGame(), plays).elapsed;
  assert.deepEqual(selectKeyPlayIndexes(plays, elapsed), [0, 1, 2]);
  assert.deepEqual(selectKeyPlayIndexes(plays, elapsed, 2), [0, 1]);
});

test('득점 플레이는 점수가 바뀐 모든 플레이이고 역전이면 lead_change를 붙인다', () => {
  const recap = build(smallGamePlays());
  assert.deepEqual(recap.scoringPlays.map((play) => play.id), ['20', '30', '50', '60', '90']);
  assert.deepEqual(recap.scoringPlays.map((play) => play.scoreAfter), [
    { away: 6, home: 0 },
    { away: 7, home: 0 },
    { away: 7, home: 6 },
    { away: 7, home: 7 },
    { away: 10, home: 7 },
  ]);
  for (const play of recap.scoringPlays) {
    assert.ok(play.tags.includes('scoring'));
    assert.equal(new Set(play.tags).size, play.tags.length);
    assert.ok(!play.tags.includes('lead_change'));
  }

  const comeback = [
    makePlay({ play_id: 1, play_type: null, home_wp: 0.5, home_wp_post: null }),
    makePlay({ play_id: 2, game_seconds_remaining: 3000, play_type: 'field_goal', field_goal_result: 'made', home_wp: 0.5, home_wp_post: 0.3, total_away_score: 3 }),
    makePlay({ play_id: 3, qtr: 2, game_seconds_remaining: 2000, posteam: 'NO', defteam: 'ATL', home_wp: 0.3, home_wp_post: 0.7, touchdown: true, td_team: 'NO', total_away_score: 3, total_home_score: 6 }),
    makePlay({ play_id: 35, qtr: 3, game_seconds_remaining: 1500, play_type: null, home_wp: 0.7, home_wp_post: null, total_away_score: 3, total_home_score: 6 }),
    makePlay({ play_id: 4, qtr: 4, game_seconds_remaining: 0, play_type: null, home_wp: 1, home_wp_post: null, total_away_score: 3, total_home_score: 6 }),
  ];
  const result = build(comeback, makeGame({ away_score: 3, home_score: 6 }));
  const touchdown = result.scoringPlays.find((play) => play.id === '3');
  assert.deepEqual(touchdown?.tags, ['touchdown', 'scoring', 'lead_change']);
  assert.equal(isLeadChange({ away: 0, home: 0 }, { away: 3, home: 0 }), false);
  assert.equal(isLeadChange({ away: 3, home: 0 }, { away: 3, home: 3 }), false);
  assert.equal(isLeadChange({ away: 3, home: 0 }, { away: 3, home: 7 }), true);
});

test('필드 막대: 시작점, 끝점, 퍼스트 다운 선을 공격 팀 기준 야드로 준다', () => {
  // Completed pass, run and sack: end = start - yards gained.
  assert.deepEqual(buildFieldBar(makePlay({ yardline_100: 75, ydstogo: 10, yards_gained: 12 })), { start: 75, end: 63, firstDownLine: 65 });
  assert.deepEqual(buildFieldBar(makePlay({ play_type: 'run', pass: false, rush: true, yardline_100: 40, ydstogo: 3, yards_gained: -2 })), { start: 40, end: 42, firstDownLine: 37 });
  assert.deepEqual(buildFieldBar(makePlay({ yardline_100: 30, ydstogo: 7, sack: true, yards_gained: -8 })), { start: 30, end: 38, firstDownLine: 23 });
  // Incomplete pass: the ball stays at the line.
  assert.deepEqual(buildFieldBar(makePlay({ yardline_100: 50, ydstogo: 10, incomplete_pass: true, yards_gained: 0 })), { start: 50, end: 50, firstDownLine: 40 });
  // Goal to go: the line to gain is the goal line; a touchdown ends at 0.
  assert.deepEqual(buildFieldBar(makePlay({ yardline_100: 4, goal_to_go: true, ydstogo: 4, yards_gained: 4, touchdown: true })), { start: 4, end: 0, firstDownLine: 0 });
  // Clamped to the field: a safety in the own end zone ends at 100.
  assert.deepEqual(buildFieldBar(makePlay({ yardline_100: 97, ydstogo: 10, sack: true, safety: true, yards_gained: -5 })), { start: 97, end: 100, firstDownLine: 87 });

  // Spots that yards_gained cannot give exactly.
  const noEnd = [
    makePlay({ play_type: 'no_play', penalty: true, penalty_type: 'False Start', penalty_yards: 5 }),
    makePlay({ yards_gained: 8, penalty: true, penalty_type: 'Defensive Holding', penalty_yards: 5 }),
    makePlay({ yards_gained: 15, interception: true }),
    makePlay({ yards_gained: 6, fumble: true }),
    makePlay({ yards_gained: 6, fumble: true, fumble_lost: true }),
    makePlay({ yards_gained: 20, lateral_reception: true }),
    makePlay({ play_type: 'run', pass: false, yards_gained: 3, lateral_rush: true }),
    makePlay({ play_type: 'run', pass: false, yards_gained: 4, aborted_play: true }),
    makePlay({ play_type: 'punt', pass: false, down: 4, kick_distance: 45 }),
    makePlay({ play_type: 'field_goal', pass: false, down: 4, field_goal_result: 'made' }),
    makePlay({ play_type: 'qb_kneel', pass: false, yards_gained: -1 }),
  ];
  for (const play of noEnd) {
    const bar = buildFieldBar(play);
    assert.ok(bar, play.play_type ?? 'null');
    assert.equal(bar.start, 75);
    assert.equal(bar.end, null, JSON.stringify(play));
    assert.equal(bar.firstDownLine, 65);
  }

  // No bar at all for kickoffs, tries and rows without a spot.
  assert.equal(buildFieldBar(makePlay({ play_type: 'kickoff', down: null, yardline_100: 35 })), null);
  assert.equal(buildFieldBar(makePlay({ play_type: 'extra_point', down: null, yardline_100: 15, extra_point_result: 'good' })), null);
  assert.equal(buildFieldBar(makePlay({ down: null, yardline_100: 2, two_point_conv_result: 'success', yards_gained: 2 })), null);
  assert.equal(buildFieldBar(makePlay({ yardline_100: null })), null);
  // A spot without a down (e.g. a timeout row) has no line to gain.
  assert.deepEqual(buildFieldBar(makePlay({ play_type: 'no_play', down: null, ydstogo: null, timeout: true })), { start: 75, end: null, firstDownLine: null });

  const recap = build(smallGamePlays());
  assert.deepEqual(recap.scoringPlays.map((play) => play.fieldBar), [
    { start: 75, end: 0, firstDownLine: 65 },
    null,
    { start: 5, end: 0, firstDownLine: 0 },
    null,
    { start: 22, end: null, firstDownLine: 17 },
  ]);
});

test('점수 분해는 득점 플래그를 팀별로 세고 식이 최종 점수와 정확히 맞는다', () => {
  const recap = build(smallGamePlays());
  assert.deepEqual(recap.scoreBreakdown, {
    away: { touchdowns: 1, extraPoints: 1, twoPointConversions: 0, fieldGoals: 1, safeties: 0, other: 0 },
    home: { touchdowns: 1, extraPoints: 1, twoPointConversions: 0, fieldGoals: 0, safeties: 0, other: 0 },
  });
  assert.equal(breakdownPoints(recap.scoreBreakdown.away), 10);
  assert.equal(breakdownPoints(recap.scoreBreakdown.home), 7);

  // Safety credited to the side whose score rose, a two-point try, and a defensive
  // two-point return (no flag explains it) in "other".
  const game = makeGame({ away_score: 8, home_score: 4 });
  const plays = [
    makePlay({ play_id: 1, touchdown: true, td_team: 'ATL', total_away_score: 6 }),
    makePlay({ play_id: 2, down: null, yardline_100: 2, two_point_conv_result: 'success', total_away_score: 8 }),
    makePlay({ play_id: 3, qtr: 2, posteam: 'ATL', defteam: 'NO', yardline_100: 98, sack: true, safety: true, total_away_score: 8, total_home_score: 2 }),
    makePlay({ play_id: 4, qtr: 3, down: null, posteam: 'ATL', defteam: 'NO', yardline_100: 2, two_point_conv_result: 'failure', interception: true, total_away_score: 8, total_home_score: 4 }),
    makePlay({ play_id: 5, qtr: 4, play_type: null, total_away_score: 8, total_home_score: 4 }),
  ];
  const timeline = buildTimeline(game, plays);
  const result = computeScoreBreakdown(plays, timeline, { away: 8, home: 4 });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.breakdown.away, { touchdowns: 1, extraPoints: 0, twoPointConversions: 1, fieldGoals: 0, safeties: 0, other: 0 });
    assert.deepEqual(result.breakdown.home, { touchdowns: 0, extraPoints: 0, twoPointConversions: 0, fieldGoals: 0, safeties: 1, other: 2 });
  }

  // A scoring flag the running score does not reflect skips the recap.
  const broken = smallGamePlays().map((play) => (play.play_id === 80 ? { ...play, touchdown: true, td_team: 'ATL' } : play));
  const skipped = buildGameRecap(makeGame(), broken, DEPS);
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.match(skipped.reason, /scoring flags credit away 6 points but the score rose by 0/);
});

test('흐름 변화 문장은 "N쿼터 M분 S초를 남기고"와 플레이를 한 팀을 쓴다', () => {
  assert.equal(whenKo(1, '13:43'), '1쿼터 13분 43초를 남기고');
  assert.equal(whenKo(1, '12:00'), '1쿼터 12분을 남기고');
  assert.equal(whenKo(4, '00:30'), '4쿼터 30초를 남기고');
  assert.equal(whenKo(2, '05:03'), '2쿼터 5분 3초를 남기고');
  assert.equal(whenKo(1, '15:00'), '1쿼터 시작과 함께');
  assert.equal(whenKo(4, '00:00'), '4쿼터 마지막 순간에');
  assert.equal(whenKo(5, '10:00'), '연장전 시작과 함께');
  assert.equal(whenKo(5, '06:12'), '연장전 6분 12초를 남기고');

  const none = { away: 0, home: 0 };
  const phrase = (kind: Parameters<typeof turningPointPhraseKo>[1], overrides: Partial<PlayRow>, change = none) =>
    turningPointPhraseKo(makePlay(overrides), kind, change, teamShortKo);
  assert.equal(phrase('run', { play_type: 'run', yards_gained: 59, touchdown: true, td_team: 'ATL' }), '애틀랜타의 59야드 러싱 터치다운');
  assert.equal(phrase('pass', { yards_gained: 12, touchdown: true, td_team: 'ATL' }), '애틀랜타의 12야드 패스 터치다운');
  assert.equal(phrase('pass', { yards_gained: 44 }), '애틀랜타의 44야드 패스');
  assert.equal(phrase('pass', { incomplete_pass: true }), '애틀랜타의 패스 실패');
  assert.equal(phrase('run', { play_type: 'run', down: 4, fourth_down_failed: true }), '애틀랜타의 4번째 공격 실패');
  assert.equal(phrase('run', { play_type: 'run', down: 4, first_down: true, fourth_down_converted: true }), '애틀랜타의 4번째 공격 성공');
  assert.equal(phrase('sack', { sack: true }), '뉴올리언스 수비의 색');
  assert.equal(phrase('interception', { interception: true }), '뉴올리언스 수비의 가로채기');
  assert.equal(phrase('interception', { interception: true, touchdown: true, td_team: 'NO' }), '뉴올리언스 수비의 가로채기 터치다운');
  assert.equal(phrase('fumble', { fumble_lost: true }), '뉴올리언스 수비의 펌블 회수');
  // Kickoff: posteam received and lost it, the kicking team (defteam) recovered.
  assert.equal(phrase('fumble', { play_type: 'kickoff', posteam: 'NO', defteam: 'ATL', fumble_lost: true }), '애틀랜타의 킥오프 펌블 회수');
  // A missed field goal names the kicking team, not the team it helped.
  assert.equal(phrase('field_goal', { play_type: 'field_goal', field_goal_result: 'missed', kick_distance: 52 }), '애틀랜타의 52야드 필드골 실패');
  assert.equal(phrase('field_goal', { play_type: 'field_goal', field_goal_result: 'made', kick_distance: 48 }), '애틀랜타의 48야드 필드골');
  assert.equal(phrase('field_goal', { play_type: 'field_goal', field_goal_result: 'blocked' }), '뉴올리언스 수비의 필드골 블록');
  assert.equal(phrase('punt', { play_type: 'punt', punt_blocked: true }), '뉴올리언스 수비의 펀트 블록');
  assert.equal(phrase('punt', { play_type: 'punt', touchdown: true, td_team: 'NO' }), '뉴올리언스의 펀트 리턴 터치다운');
  assert.equal(phrase('kickoff', { play_type: 'kickoff', posteam: 'NO', defteam: 'ATL', touchdown: true, td_team: 'NO' }), '뉴올리언스의 킥오프 리턴 터치다운');
  assert.equal(phrase('safety', { safety: true }, { away: 0, home: 2 }), '뉴올리언스의 세이프티');
  // A long return is the play, so the returning team is named (2025_11_SF_ARI, 2025_13_SF_CLE).
  assert.equal(phrase('kickoff', { play_type: 'kickoff', posteam: 'SF', defteam: 'ARI', return_yards: 98 }), '샌프란시스코의 98야드 킥오프 리턴');
  assert.equal(phrase('kickoff', { play_type: 'kickoff', posteam: 'SF', defteam: 'ARI', return_yards: 12 }), '애리조나의 킥오프');
  assert.equal(phrase('punt', { play_type: 'punt', posteam: 'CLE', defteam: 'SF', kick_distance: 50, return_yards: 66 }), '샌프란시스코의 66야드 펀트 리턴');
  assert.equal(phrase('punt', { play_type: 'punt', posteam: 'CLE', defteam: 'SF', kick_distance: 50, return_yards: 5 }), '클리블랜드의 펀트');
  // The kicking team got its own kickoff back (2025_02_SEA_PIT, 2025_02_CAR_ARI).
  assert.equal(phrase('kickoff', { play_type: 'kickoff', posteam: 'PIT', defteam: 'SEA', kick_distance: 65, own_kickoff_recovery_td: true, touchdown: true, td_team: 'SEA' }), '시애틀의 킥오프 회수 터치다운');
  assert.equal(phrase('kickoff', { play_type: 'kickoff', posteam: 'ARI', defteam: 'CAR', kick_distance: 9, own_kickoff_recovery: true }), '캐롤라이나의 온사이드 킥 성공');
  // Intercepted, then fumbled back to the offense, which scored (2025_05_TEN_ARI).
  assert.equal(phrase('interception', { posteam: 'TEN', defteam: 'ARI', interception: true, fumble_lost: true, touchdown: true, td_team: 'TEN' }), '테네시의 펌블 회수 터치다운');
  assert.equal(phrase('interception', { posteam: 'TEN', defteam: 'ARI', interception: true, fumble_lost: true }), '애리조나 수비의 가로채기 뒤 펌블');
  assert.equal(phrase('two_point', { two_point_conv_result: 'success' }), '애틀랜타의 2점 컨버전 성공');
});

test('요약은 결과, 승리 팀이 가장 많이 득점한 쿼터, 가장 큰 흐름 변화를 확률 없이 담는다', () => {
  const recap = build(smallGamePlays());
  assert.equal(
    recap.summaryKo,
    '애틀랜타가 뉴올리언스를 10-7, 3점 차로 이겼어요. 애틀랜타는 1쿼터에 가장 많은 7점을 올렸어요. ' +
      '가장 큰 흐름 변화는 4쿼터 30초를 남기고 나온 애틀랜타의 40야드 필드골이었어요.',
  );
  assert.ok(!/[A-Za-z]{3,}/.test(recap.summaryKo), 'no English words in the summary');

  const withTouchdown = buildSummaryKo({
    away: '애틀랜타',
    home: '뉴올리언스',
    final: { away: 45, home: 24, overtime: false },
    quarterScores: recap.quarterScores,
    turningPoint: { period: 1, clock: '13:43', phraseKo: '애틀랜타의 59야드 러싱 터치다운' },
  });
  assert.match(withTouchdown, /가장 큰 흐름 변화는 1쿼터 13분 43초를 남기고 나온 애틀랜타의 59야드 러싱 터치다운이었어요\.$/);
  const vowelEnding = buildSummaryKo({
    away: '애틀랜타',
    home: '뉴올리언스',
    final: { away: 10, home: 7, overtime: false },
    quarterScores: [],
    turningPoint: { period: 4, clock: '00:22', phraseKo: '탬파베이의 4번째 공격 실패' },
  });
  assert.match(vowelEnding, /4쿼터 22초를 남기고 나온 탬파베이의 4번째 공격 실패였어요\.$/);

  const tie = buildSummaryKo({
    away: 'LA 램스',
    home: '시애틀',
    final: { away: 20, home: 20, overtime: true },
    quarterScores: [],
    turningPoint: null,
  });
  assert.equal(tie, 'LA 램스와 시애틀은 연장전까지 치르고도 20-20으로 비겼어요.');

  const sharedBest = buildSummaryKo({
    away: '뉴욕 제츠',
    home: '그린베이',
    final: { away: 14, home: 21, overtime: false },
    quarterScores: [
      { period: 1, label: '1Q', away: 7, home: 7 },
      { period: 2, label: '2Q', away: 0, home: 0 },
      { period: 3, label: '3Q', away: 7, home: 7 },
      { period: 4, label: '4Q', away: 0, home: 7 },
    ],
    turningPoint: null,
  });
  assert.equal(
    sharedBest,
    '그린베이가 뉴욕 제츠를 21-14, 7점 차로 이겼어요. 그린베이는 1쿼터, 3쿼터와 4쿼터에 각각 7점씩 올려 가장 많이 득점했어요.',
  );
});

test('네 쿼터 득점이 모두 같으면 가장 많이 득점한 쿼터 대신 고르게 올렸다고 쓴다', () => {
  const even = buildSummaryKo({
    away: '댈러스',
    home: '뉴욕 자이언츠',
    final: { away: 20, home: 28, overtime: false },
    quarterScores: [1, 2, 3, 4].map((period) => ({ period, label: `${period}Q`, away: 5, home: 7 })),
    turningPoint: null,
  });
  assert.equal(even, '뉴욕 자이언츠가 댈러스를 28-20, 8점 차로 이겼어요. 뉴욕 자이언츠는 네 쿼터 모두 7점씩 올렸어요.');
});

test('다음 스냅은 같은 하프의 다음 다운 있는 행이고, 하프가 끝나거나 킥오프가 먼저 오면 없다', () => {
  const rows = [
    makePlay({ play_id: 1, qtr: 2, posteam: 'ATL', defteam: 'NO', interception: true, touchback: true }),
    makePlay({ play_id: 2, qtr: 2, play_type: 'no_play', posteam: null, defteam: null, down: null, timeout: true }),
    makePlay({ play_id: 3, qtr: 2, play_type: 'no_play', posteam: 'NO', defteam: 'ATL', down: 1, yardline_100: 80, penalty: true }),
    makePlay({ play_id: 4, qtr: 2, play_type: 'qb_kneel', posteam: 'NO', defteam: 'ATL', down: 1, yardline_100: 85 }),
    makePlay({ play_id: 5, qtr: 2, play_type: null, posteam: null, defteam: null, down: null }),
    makePlay({ play_id: 6, qtr: 3, play_type: 'field_goal', posteam: 'NO', defteam: 'ATL', down: 4, field_goal_result: 'made' }),
    makePlay({ play_id: 7, qtr: 3, play_type: 'kickoff', posteam: 'ATL', defteam: 'NO', down: null }),
    makePlay({ play_id: 8, qtr: 3, play_type: 'run', posteam: 'ATL', defteam: 'NO', down: 1, yardline_100: 70 }),
  ];
  assert.deepEqual(findNextSnap(rows, 0), { posteam: 'NO', yardline100: 80 });
  assert.equal(findNextSnap(rows, 3), null, 'halftime comes before the next snap');
  assert.equal(findNextSnap(rows, 5), null, 'a kickoff is not followed through');
  assert.deepEqual(findNextSnap(rows, 6), { posteam: 'ATL', yardline100: 70 });
  assert.equal(findNextSnap(rows, 7), null, 'nothing after the last row');

  // buildGameRecap hands the next snap to the explainer.
  const seen = new Map<string, PlayContext['nextSnap']>();
  const result = buildGameRecap(makeGame(), smallGamePlays(), {
    ...DEPS,
    explain: (play, context) => {
      seen.set(String(play.play_id), context.nextSnap);
      return fakeExplain(play, context);
    },
  });
  assert.ok(result.ok);
  // The 75-yard touchdown pass (play 20) is followed by the try and NO's drive in the second quarter.
  assert.deepEqual(seen.get('20'), { posteam: 'NO', yardline100: 5 });
  // The fixture has no kickoffs, so the kneel is the snap after the last field goal.
  assert.deepEqual(seen.get('90'), { posteam: 'ATL', yardline100: 75 });
});

test('이전 실행의 요약 파일은 일정 점수와 현재 계약에 맞을 때만 유효하다', () => {
  const recap = build(smallGamePlays());
  const game = makeGame();
  assert.equal(isRecapStillValid(recap, game), true);
  assert.equal(isRecapStillValid(recap, makeGame({ home_score: 9 })), false);
  assert.equal(isRecapStillValid(recap, makeGame({ id: 'other' })), false);
  assert.equal(isRecapStillValid({ ...recap, schemaVersion: 2 }, game), false);
  assert.equal(isRecapStillValid(null, game), false);
  assert.equal(isRecapStillValid(recap, makeGame({ status: 'scheduled', away_score: null, home_score: null })), false);
  // Files written before the contract revision.
  assert.equal(isRecapStillValid({ ...recap, winProbability: [[0, 0.5]] }, game), false);
  const { scoreBreakdown: _dropped, ...withoutBreakdown } = recap;
  assert.equal(isRecapStillValid(withoutBreakdown, game), false);
  const oldPlay = { ...recap.keyPlays[0], homeWinProbAfter: 0.4 } as Record<string, unknown>;
  delete oldPlay.fieldBar;
  assert.equal(isRecapStillValid({ ...recap, keyPlays: [oldPlay] }, game), false);
  const wrongBreakdown = { ...recap, scoreBreakdown: { ...recap.scoreBreakdown, away: { ...recap.scoreBreakdown.away, other: 1 } } };
  assert.equal(isRecapStillValid(wrongBreakdown, game), false);
});

test('요약 데이터에는 선수 이름이나 영어 설명이 들어갈 자리가 없다', () => {
  const recap = build(smallGamePlays());
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(recap);
  for (const key of keys) assert.ok(!/desc|player|name$/i.test(key) || key === 'nameKo', key);
});
