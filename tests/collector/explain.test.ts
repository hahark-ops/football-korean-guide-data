import assert from 'node:assert/strict';
import test from 'node:test';
import { explainPlay } from '../../collector/explain.ts';
import type { PlayContext, PlayExplanation, PlayRow } from '../../collector/types.ts';
import { GLOSSARY, GLOSSARY_SLUGS, SLUGS_WITHOUT_ENTRY, isGlossarySlug } from '../../src/content/glossary.ts';

const SHORT_KO: Record<string, string> = {
  ATL: '애틀랜타',
  NO: '뉴올리언스',
  CHI: '시카고',
  DEN: '덴버',
  PIT: '피츠버그',
  JAX: '잭슨빌',
  KC: '캔자스시티',
  TEN: '테네시',
  NYG: '뉴욕 자이언츠',
  ARI: '애리조나',
  SEA: '시애틀',
  LAC: '차저스',
  BUF: '버펄로',
  SF: '샌프란시스코',
  CAR: '캐롤라이나',
};

/** ATL (away) at NO (home); ATL has the ball unless a fixture says otherwise. */
function play(overrides: Partial<PlayRow> = {}): PlayRow {
  return {
    play_id: 100,
    game_id: '2026_01_ATL_NO',
    home_team: 'NO',
    away_team: 'ATL',
    posteam: 'ATL',
    defteam: 'NO',
    yardline_100: 75,
    qtr: 1,
    time: '10:00',
    game_seconds_remaining: 3300,
    down: 1,
    goal_to_go: false,
    ydstogo: 10,
    play_type: 'run',
    yards_gained: 0,
    field_goal_result: null,
    kick_distance: null,
    extra_point_result: null,
    two_point_conv_result: null,
    timeout: false,
    total_home_score: 0,
    total_away_score: 0,
    home_wp: 0.5,
    home_wp_post: 0.5,
    away_wp_post: 0.5,
    wpa: 0,
    first_down: false,
    third_down_converted: false,
    third_down_failed: false,
    fourth_down_converted: false,
    fourth_down_failed: false,
    incomplete_pass: false,
    interception: false,
    fumble_lost: false,
    fumble: false,
    lateral_reception: false,
    lateral_rush: false,
    sack: false,
    touchdown: false,
    pass_touchdown: false,
    rush_touchdown: false,
    return_touchdown: false,
    td_team: null,
    safety: false,
    penalty: false,
    penalty_team: null,
    penalty_type: null,
    penalty_yards: null,
    punt_blocked: false,
    touchback: false,
    return_yards: null,
    own_kickoff_recovery: false,
    own_kickoff_recovery_td: false,
    pass: false,
    rush: false,
    qb_kneel: false,
    qb_spike: false,
    aborted_play: false,
    ...overrides,
  };
}

function context(scoreBefore = { away: 0, home: 0 }, extra: Partial<PlayContext> = {}): PlayContext {
  return { teamShortKo: (abbr) => SHORT_KO[abbr] ?? abbr, scoreBefore, homeTeam: 'NO', awayTeam: 'ATL', ...extra };
}

/** Context with the next snap (team, nflverse yardline_100), as recap.ts builds it. */
function withNextSnap(posteam: string | null, yardline100 = 80): PlayContext {
  return context({ away: 0, home: 0 }, { nextSnap: posteam === null ? null : { posteam, yardline100 } });
}

const produced: PlayExplanation[] = [];

function explain(row: PlayRow, ctx: PlayContext = context()): PlayExplanation {
  const result = explainPlay(row, ctx);
  produced.push(result);
  return result;
}

test('상황 줄은 다운·거리·진영을 표시하고 골 투 고는 "& 골"로 쓴다', () => {
  assert.equal(
    explain(play({ down: 1, goal_to_go: true, ydstogo: 4, yardline_100: 4 })).situationKo,
    '1st & 골 · 상대 진영 4야드',
  );
  assert.equal(explain(play({ down: 2, ydstogo: 7, yardline_100: 50 })).situationKo, '2nd & 7 · 중앙(50야드)');
  assert.equal(explain(play({ down: 3, ydstogo: 4, yardline_100: 51 })).situationKo, '3rd & 4 · 자기 진영 49야드');
  assert.equal(explain(play({ down: 4, ydstogo: 1, yardline_100: 49 })).situationKo, '4th & 1 · 상대 진영 49야드');
});

test('킥오프·엑스트라 포인트·2점 컨버전·다운 없는 기록은 상황 줄이 없다', () => {
  const kickoff = play({ play_type: 'kickoff', down: null, ydstogo: null, yardline_100: 35, posteam: 'NO', defteam: 'ATL', touchback: true });
  const extraPoint = play({ play_type: 'extra_point', down: null, yardline_100: 15, extra_point_result: 'good', total_away_score: 7 });
  const twoPoint = play({ play_type: 'pass', down: null, yardline_100: 2, two_point_conv_result: 'failure', pass: true });
  const timeout = play({ play_type: 'no_play', down: null, posteam: null, defteam: null, timeout: true });
  for (const row of [kickoff, extraPoint, twoPoint, timeout]) assert.equal(explain(row).situationKo, null);
});

test('패스 전진과 퍼스트 다운을 구분하고 20야드 이상은 big_play로 표시한다', () => {
  const firstDown = explain(
    play({ posteam: 'NO', defteam: 'ATL', play_type: 'pass', pass: true, yards_gained: 44, first_down: true, yardline_100: 80 }),
  );
  assert.equal(firstDown.kind, 'pass');
  assert.equal(firstDown.titleKo, '뉴올리언스, 44야드 패스로 퍼스트 다운');
  assert.deepEqual(firstDown.tags, ['first_down', 'big_play']);
  assert.match(firstDown.explanationKo, /필요한 거리를 채워 공격 기회 네 번을 새로 얻었어요\./);

  const gain = explain(play({ posteam: 'NO', defteam: 'ATL', play_type: 'pass', pass: true, yards_gained: 6, down: 2, ydstogo: 8 }));
  assert.equal(gain.titleKo, '뉴올리언스, 6야드 패스 전진');
  assert.equal(gain.explanationKo, '6야드 패스가 성공했어요. 이제 3번째 공격에서 2야드를 더 가야 퍼스트 다운이에요.');
  assert.deepEqual(gain.tags, []);

  const incomplete = explain(play({ play_type: 'pass', pass: true, incomplete_pass: true }));
  assert.equal(incomplete.titleKo, '애틀랜타, 패스 실패');
  assert.ok(incomplete.termSlugs.includes('incomplete-pass'));
});

test('러싱·패스 터치다운은 6점과 추가 득점 시도를 설명하고 득점 태그를 단다', () => {
  const run = explain(
    play({
      play_type: 'run', rush: true, down: 1, goal_to_go: true, ydstogo: 4, yardline_100: 4, yards_gained: 4,
      first_down: true, touchdown: true, rush_touchdown: true, td_team: 'ATL', total_away_score: 6,
    }),
  );
  assert.equal(run.kind, 'run');
  assert.equal(run.titleKo, '애틀랜타, 4야드 러싱 터치다운');
  assert.deepEqual(run.tags, ['touchdown', 'first_down', 'scoring', 'red_zone']);
  assert.equal(run.explanationKo, '4야드를 달려 터치다운을 올렸어요. 터치다운은 6점이고, 이어서 추가 득점 시도를 해요.');
  // The red-zone chip comes from the tag: the situation line shows the spot.
  assert.deepEqual(run.termSlugs, ['touchdown', 'extra-point', 'red-zone']);

  const pass = explain(
    play({
      play_type: 'pass', pass: true, down: 3, ydstogo: 8, yardline_100: 12, yards_gained: 12, first_down: true,
      third_down_converted: true, touchdown: true, pass_touchdown: true, td_team: 'ATL', total_away_score: 6,
    }),
  );
  assert.equal(pass.titleKo, '애틀랜타, 12야드 패스 터치다운');
  assert.ok(pass.tags.includes('touchdown') && pass.tags.includes('scoring'));
});

test('연장전이나 정규 시간 마지막 순간의 터치다운은 추가 득점 시도를 약속하지 않는다', () => {
  const overtime = explain(
    play({ qtr: 5, play_type: 'pass', pass: true, yards_gained: 9, touchdown: true, pass_touchdown: true, td_team: 'ATL', total_away_score: 6 }),
  );
  assert.ok(!overtime.explanationKo.includes('추가 득점 시도'));
  const lastSecond = explain(
    play({
      qtr: 4, game_seconds_remaining: 3, play_type: 'pass', interception: true, touchdown: true,
      return_touchdown: true, td_team: 'NO', return_yards: 98, total_home_score: 6,
    }),
  );
  assert.equal(lastSecond.explanationKo.endsWith('수비가 올린 터치다운도 6점이에요.'), true);
});

test('3번째 공격 성공과 실패를 설명한다', () => {
  const converted = explain(
    play({ down: 3, ydstogo: 4, yardline_100: 38, play_type: 'run', rush: true, yards_gained: 6, first_down: true, third_down_converted: true }),
  );
  assert.equal(converted.titleKo, '애틀랜타, 6야드 러싱으로 퍼스트 다운');
  assert.equal(converted.explanationKo, '3번째 공격에서 6야드를 달려 전진했어요. 필요한 거리를 채워 공격 기회 네 번을 새로 얻었어요.');
  assert.deepEqual(converted.termSlugs, ['third-down', 'distance', 'first-down']);

  const failed = explain(
    play({ down: 3, ydstogo: 6, yardline_100: 60, play_type: 'pass', pass: true, incomplete_pass: true, third_down_failed: true }),
  );
  assert.equal(failed.explanationKo, '3번째 공격에서 패스가 잡히지 않아 4번째 공격 상황이 됐어요. 보통 이때는 펀트나 필드골을 선택해요.');
  assert.deepEqual(failed.termSlugs, ['third-down', 'incomplete-pass', 'fourth-down', 'punt', 'field-goal']);

  const short = explain(
    play({ down: 3, ydstogo: 11, yardline_100: 46, play_type: 'pass', pass: true, yards_gained: 6, third_down_failed: true }),
  );
  assert.match(short.explanationKo, /^3번째 공격에서 6야드 패스가 성공했지만 필요한 11야드에 못 미쳐 4번째 공격 상황이 됐어요\./);
});

test('4번째 공격 성공은 새 공격 기회로, 실패는 턴오버로 설명한다', () => {
  const converted = explain(
    play({ down: 4, ydstogo: 1, yardline_100: 63, play_type: 'run', rush: true, yards_gained: 2, first_down: true, fourth_down_converted: true }),
  );
  assert.equal(converted.titleKo, '애틀랜타, 2야드 러싱으로 4번째 공격 성공');
  assert.ok(converted.tags.includes('fourth_down') && !converted.tags.includes('turnover'));
  assert.match(converted.explanationKo, /^4번째 공격에서 킥 대신 공격을 선택했고, 2야드를 달려 전진했어요\./);

  const failed = explain(
    play({
      posteam: 'PIT', defteam: 'ATL', down: 4, ydstogo: 3, yardline_100: 30, play_type: 'pass', pass: true,
      incomplete_pass: true, fourth_down_failed: true,
    }),
  );
  assert.equal(failed.kind, 'pass');
  assert.equal(failed.titleKo, '피츠버그, 4번째 공격 실패');
  assert.deepEqual(failed.tags, ['turnover', 'fourth_down']);
  assert.match(failed.explanationKo, /공격권이 상대에게 넘어갔어요/);
  assert.ok(failed.termSlugs.includes('turnover') && failed.termSlugs.includes('fourth-down'));
});

test('가로채기와 가로채기 터치다운', () => {
  const interception = explain(
    play({ posteam: 'NO', defteam: 'CHI', play_type: 'pass', pass: true, interception: true, return_yards: 12, third_down_failed: true, down: 3 }),
  );
  assert.equal(interception.kind, 'interception');
  assert.equal(interception.titleKo, '시카고 수비, 패스 가로채기');
  assert.equal(interception.explanationKo, '시카고 수비가 패스를 가로채 공격권이 바로 넘어갔어요(턴오버). 가로챈 뒤 12야드를 리턴했어요.');
  assert.deepEqual(interception.tags, ['turnover']);

  const pickSix = explain(
    play({
      play_type: 'pass', pass: true, interception: true, touchdown: true, return_touchdown: true, td_team: 'NO',
      return_yards: 35, total_home_score: 6,
    }),
  );
  assert.equal(pickSix.titleKo, '뉴올리언스 수비, 가로채기 터치다운');
  assert.deepEqual(pickSix.tags, ['touchdown', 'turnover', 'scoring']);
  assert.match(pickSix.explanationKo, /35야드를 달려 터치다운까지 올렸어요/);
});

test('펀트 리턴과 킥오프 리턴 터치다운은 받은 팀을 득점 팀으로 쓴다', () => {
  // Punt: posteam is the punting team.
  const puntReturn = explain(
    play({
      posteam: 'ATL', defteam: 'NO', down: 4, ydstogo: 5, yardline_100: 55, play_type: 'punt', kick_distance: 41,
      return_yards: 86, touchdown: true, return_touchdown: true, td_team: 'NO', total_home_score: 6,
    }),
  );
  assert.equal(puntReturn.kind, 'punt');
  assert.equal(puntReturn.titleKo, '뉴올리언스, 펀트 리턴 터치다운');
  assert.match(puntReturn.explanationKo, /^뉴올리언스가 펀트를 받아 86야드를 달려 터치다운을 올렸어요\./);

  // Kickoff: posteam is the receiving team.
  const kickReturn = explain(
    play({
      posteam: 'NO', defteam: 'ATL', down: null, ydstogo: null, yardline_100: 35, play_type: 'kickoff', kick_distance: 65,
      return_yards: 100, touchdown: true, return_touchdown: true, td_team: 'NO', total_home_score: 6,
    }),
  );
  assert.equal(kickReturn.kind, 'kickoff');
  assert.equal(kickReturn.titleKo, '뉴올리언스, 킥오프 리턴 터치다운');
  assert.ok(kickReturn.tags.includes('touchdown') && kickReturn.tags.includes('scoring'));
});

test('색과 색 도중 잃은 펌블', () => {
  const sack = explain(play({ posteam: 'NO', defteam: 'DEN', down: 1, play_type: 'pass', pass: true, sack: true, yards_gained: -7 }));
  assert.equal(sack.kind, 'sack');
  assert.equal(sack.titleKo, '덴버 수비, 쿼터백 색(7야드 손실)');
  assert.equal(sack.explanationKo, '쿼터백이 공을 던지기 전에 태클당해(색) 7야드 뒤로 밀렸어요. 이제 2번째 공격에서 17야드를 더 가야 퍼스트 다운이에요.');

  const strip = explain(play({ play_type: 'pass', pass: true, sack: true, fumble_lost: true, yards_gained: -9 }));
  assert.equal(strip.kind, 'fumble');
  assert.deepEqual(strip.tags, ['turnover']);
  assert.equal(strip.titleKo, '뉴올리언스 수비, 색으로 펌블 유도 후 회수');
  assert.equal(strip.explanationKo, '쿼터백이 색을 당하는 과정에서 공을 놓쳤고(펌블) 뉴올리언스 수비가 공을 차지해 공격권이 넘어갔어요(턴오버).');
  assert.deepEqual(strip.termSlugs, ['quarterback', 'sack', 'fumble', 'turnover']);
});

test('필드골 성공·실패·블록', () => {
  const made = explain(
    play({ posteam: 'DEN', defteam: 'NO', down: 4, ydstogo: 6, yardline_100: 30, play_type: 'field_goal', kick_distance: 48, field_goal_result: 'made' }),
  );
  assert.equal(made.kind, 'field_goal');
  assert.equal(made.titleKo, '덴버, 48야드 필드골 성공');
  assert.equal(made.explanationKo, '48야드 필드골이 들어가 3점을 얻었어요.');
  // A field goal on 4th down is a kick, not a 4th-down attempt.
  assert.deepEqual(made.tags, ['scoring']);

  const missed = explain(play({ down: 4, ydstogo: 4, yardline_100: 36, play_type: 'field_goal', kick_distance: 54, field_goal_result: 'missed' }));
  assert.equal(missed.titleKo, '애틀랜타, 54야드 필드골 실패');
  assert.ok(!missed.tags.includes('scoring'));
  assert.match(missed.explanationKo, /들어가지 않아 점수를 얻지 못했어요/);

  const blocked = explain(play({ down: 4, ydstogo: 6, yardline_100: 41, play_type: 'field_goal', kick_distance: 59, field_goal_result: 'blocked' }));
  assert.equal(blocked.titleKo, '뉴올리언스 수비, 필드골 블록');
  assert.equal(blocked.explanationKo, '뉴올리언스 수비가 59야드 필드골을 막아내(블록) 애틀랜타는 점수를 얻지 못했어요.');
});

test('펀트, 블록된 펀트, 받는 팀이 놓친 펀트', () => {
  const puntRow = play({ down: 4, ydstogo: 5, yardline_100: 60, play_type: 'punt', kick_distance: 60, touchback: true });
  const punt = explain(puntRow, withNextSnap('NO', 80));
  assert.equal(punt.titleKo, '애틀랜타, 60야드 펀트');
  assert.equal(
    punt.explanationKo,
    '4번째 공격에서 60야드 펀트를 차 공격권을 뉴올리언스에게 넘겼어요. 공이 엔드존으로 들어가 터치백이 됐고, 뉴올리언스는 자기 진영 20야드에서 공격을 시작했어요.',
  );
  // Without a next snap (half over, or unknown) the start spot is not claimed.
  assert.equal(explain(puntRow, withNextSnap(null)).explanationKo.endsWith('공이 엔드존으로 들어가 터치백이 됐어요.'), true);
  assert.ok(!explain(puntRow).explanationKo.includes('20야드'));

  const blocked = explain(play({ down: 4, ydstogo: 11, yardline_100: 81, play_type: 'punt', punt_blocked: true }));
  assert.equal(blocked.kind, 'punt');
  assert.equal(blocked.titleKo, '뉴올리언스 수비, 펀트 블록');
  assert.match(blocked.explanationKo, /^뉴올리언스 수비가 애틀랜타의 펀트를 막아냈어요\(블록\)\./);

  // After a kick, a punt's fumble_lost means the receiving team (defteam) lost the ball.
  const muffed = explain(play({ down: 4, ydstogo: 10, yardline_100: 76, play_type: 'punt', kick_distance: 46, fumble_lost: true }));
  assert.equal(muffed.kind, 'fumble');
  assert.equal(muffed.titleKo, '애틀랜타, 펀트 후 공격권 되찾음');
  assert.ok(muffed.tags.includes('turnover'));
  assert.match(muffed.explanationKo, /^펀트를 받은 뉴올리언스가 공을 놓쳤고, 펀트를 찬 애틀랜타가/);
});

test('킥오프는 posteam을 받는 팀으로 본다', () => {
  const kickoff = { down: null, ydstogo: null, yardline_100: 35, play_type: 'kickoff', posteam: 'NO', defteam: 'ATL', kick_distance: 65 };
  const touchback = explain(play({ ...kickoff, touchback: true }));
  assert.equal(touchback.kind, 'kickoff');
  assert.equal(touchback.titleKo, '애틀랜타, 킥오프 터치백');
  assert.ok(touchback.termSlugs.includes('touchback'));

  const returned = explain(play({ ...kickoff, return_yards: 25 }));
  assert.equal(returned.titleKo, '뉴올리언스, 킥오프 25야드 리턴');
  assert.match(returned.explanationKo, /^뉴올리언스가 애틀랜타의 킥오프를 받아 25야드를 리턴했어요\./);

  const lost = explain(play({ ...kickoff, return_yards: 20, fumble_lost: true }));
  assert.equal(lost.kind, 'fumble');
  assert.equal(lost.titleKo, '애틀랜타, 킥오프 후 공격권 가져옴');
  assert.match(lost.explanationKo, /킥오프를 받은 뉴올리언스가 공을 놓쳤고\(펌블\), 킥오프를 찬 애틀랜타가/);
});

test('엑스트라 포인트와 2점 컨버전', () => {
  const try_ = { down: null, ydstogo: null, yardline_100: 15 };
  const good = explain(play({ ...try_, play_type: 'extra_point', extra_point_result: 'good', kick_distance: 33, total_away_score: 7 }), context({ away: 6, home: 0 }));
  assert.equal(good.kind, 'extra_point');
  assert.equal(good.titleKo, '애틀랜타, 엑스트라 포인트 성공');
  assert.deepEqual(good.tags, ['scoring']);

  const failed = explain(play({ ...try_, play_type: 'extra_point', extra_point_result: 'failed', total_away_score: 6 }), context({ away: 6, home: 0 }));
  assert.equal(failed.titleKo, '애틀랜타, 엑스트라 포인트 실패');
  assert.deepEqual(failed.tags, []);

  const success = explain(
    play({ ...try_, yardline_100: 2, play_type: 'pass', pass: true, two_point_conv_result: 'success', yards_gained: 2, total_away_score: 8 }),
    context({ away: 6, home: 0 }),
  );
  assert.equal(success.kind, 'two_point');
  assert.equal(success.titleKo, '애틀랜타, 2점 컨버전 성공');
  assert.equal(success.explanationKo, '터치다운 뒤 킥 대신 상대 2야드 지점에서 한 번 더 공격하는 2점 컨버전에 성공해 2점을 더했어요.');
  assert.deepEqual(success.tags, ['scoring']);

  const failure = explain(
    play({ ...try_, yardline_100: 2, play_type: 'run', rush: true, two_point_conv_result: 'failure', total_away_score: 6 }),
    context({ away: 6, home: 0 }),
  );
  assert.equal(failure.titleKo, '애틀랜타, 2점 컨버전 실패');
  assert.deepEqual(failure.tags, []);
});

test('플레이를 무효로 만든 반칙은 양쪽 팀 모두 설명한다', () => {
  const falseStart = explain(
    play({ posteam: 'JAX', defteam: 'NO', play_type: 'no_play', penalty: true, penalty_team: 'JAX', penalty_type: 'False Start', penalty_yards: 5 }),
  );
  assert.equal(falseStart.kind, 'penalty');
  assert.equal(falseStart.titleKo, '잭슨빌, 폴스 스타트 반칙(5야드)');
  assert.equal(
    falseStart.explanationKo,
    '잭슨빌은 폴스 스타트 반칙으로 5야드 물러났어요. 공을 스냅하기 전에 나온 반칙이라 플레이 없이 벌칙만 적용됐어요.',
  );
  assert.deepEqual(falseStart.tags, ['penalty']);
  assert.deepEqual(falseStart.termSlugs, ['false-start', 'penalty']);

  const interference = explain(
    play({
      posteam: 'JAX', defteam: 'NO', down: 1, ydstogo: 20, yardline_100: 89, play_type: 'no_play', pass: true,
      first_down: true, penalty: true, penalty_team: 'NO', penalty_type: 'Defensive Pass Interference', penalty_yards: 24,
    }),
  );
  assert.equal(interference.kind, 'penalty');
  assert.equal(interference.titleKo, '뉴올리언스, 패스 방해 반칙(24야드)');
  assert.equal(
    interference.explanationKo,
    '뉴올리언스의 패스 방해 반칙으로 잭슨빌이 24야드와 퍼스트 다운을 얻었어요. 반칙이 적용돼 이 플레이의 결과는 인정되지 않았어요.',
  );
  assert.deepEqual(interference.tags, ['first_down', 'penalty']);
  assert.ok(interference.termSlugs.includes('pass-interference'));

  const unmapped = explain(
    play({ play_type: 'no_play', penalty: true, penalty_team: 'ATL', penalty_type: 'Disqualification', penalty_yards: 5 }),
  );
  assert.equal(unmapped.titleKo, '애틀랜타, 반칙(5야드)');
  const shift = explain(
    play({ play_type: 'no_play', penalty: true, penalty_team: 'ATL', penalty_type: 'Illegal Shift', penalty_yards: 5 }),
  );
  assert.equal(shift.titleKo, '애틀랜타, 부정 시프트 반칙(5야드)');
  const roughing = explain(
    play({ posteam: 'JAX', defteam: 'NO', play_type: 'no_play', penalty: true, penalty_team: 'NO', penalty_type: 'Roughing the Passer', penalty_yards: 15, first_down: true }),
  );
  assert.equal(roughing.titleKo, '뉴올리언스, 러핑 더 패서 반칙(15야드)');
});

test('결과가 인정된 플레이의 반칙은 퍼스트 다운의 이유를 구분한다', () => {
  const byPenalty = explain(
    play({
      play_type: 'run', rush: true, yards_gained: 3, first_down: true, penalty: true, penalty_team: 'NO',
      penalty_type: 'Defensive Holding', penalty_yards: 5,
    }),
  );
  assert.equal(byPenalty.kind, 'run');
  assert.equal(byPenalty.titleKo, '애틀랜타, 3야드 러싱 전진');
  assert.equal(byPenalty.explanationKo, '3야드를 달려 전진했어요. 뉴올리언스의 홀딩 반칙으로 5야드를 더 얻고 퍼스트 다운도 받았어요.');

  const byPlay = explain(
    play({
      play_type: 'pass', pass: true, down: 2, ydstogo: 8, yards_gained: 21, first_down: true, penalty: true,
      penalty_team: 'NO', penalty_type: 'Unnecessary Roughness', penalty_yards: 15,
    }),
  );
  assert.equal(
    byPlay.explanationKo,
    '21야드 패스가 성공했어요. 필요한 거리를 채워 공격 기회 네 번을 새로 얻었고, 뉴올리언스의 불필요한 거친 행위 반칙으로 애틀랜타가 15야드를 더 얻었어요.',
  );
  assert.deepEqual(byPlay.tags, ['first_down', 'big_play', 'penalty']);
});

test('반칙으로 생긴 세이프티는 반칙보다 세이프티가 우선이고 점수가 오른 팀을 득점 팀으로 쓴다', () => {
  const safety = explain(
    play({
      down: 2, ydstogo: 10, yardline_100: 94, play_type: 'no_play', pass: true, safety: true, penalty: true,
      penalty_team: 'ATL', penalty_type: 'Offensive Holding', penalty_yards: 6, total_home_score: 16, total_away_score: 10,
    }),
    context({ away: 10, home: 14 }),
  );
  assert.equal(safety.kind, 'safety');
  assert.equal(safety.titleKo, '뉴올리언스, 세이프티로 2점');
  assert.equal(
    safety.explanationKo,
    '애틀랜타의 홀딩 반칙으로 세이프티가 선언돼 뉴올리언스가 2점을 얻었어요. 세이프티를 내준 애틀랜타는 이어서 프리킥으로 공을 넘겨줘야 해요.',
  );
  assert.ok(safety.tags.includes('scoring') && safety.tags.includes('penalty'));
  assert.deepEqual(safety.termSlugs, ['holding', 'penalty', 'safety']);

  const sackSafety = explain(
    play({ down: 3, yardline_100: 97, play_type: 'pass', pass: true, sack: true, safety: true, yards_gained: -4, total_home_score: 2 }),
  );
  assert.equal(sackSafety.kind, 'safety');
  assert.match(sackSafety.explanationKo, /^쿼터백이 자기 엔드존 안에서 색을 당해 세이프티가 됐고, 뉴올리언스 수비가 2점을 얻었어요\./);
});

test('같은 행에 여러 사건이 있으면 정해진 우선순위를 따른다', () => {
  const pickThenFumble = explain(play({ play_type: 'pass', pass: true, interception: true, fumble_lost: true }));
  assert.equal(pickThenFumble.kind, 'interception');
  assert.match(pickThenFumble.explanationKo, /애틀랜타가 공을 되찾았어요/);

  // nflverse clears result flags on nullified plays; a stray one must not win over the penalty.
  const nullifiedSack = explain(
    play({ play_type: 'no_play', sack: true, penalty: true, penalty_team: 'NO', penalty_type: 'Defensive Holding', penalty_yards: 5, first_down: true }),
  );
  assert.equal(nullifiedSack.kind, 'penalty');

  const tryInterception = explain(
    play({ down: null, yardline_100: 2, play_type: 'pass', pass: true, interception: true, two_point_conv_result: 'failure' }),
  );
  assert.equal(tryInterception.kind, 'interception');
  assert.ok(!tryInterception.tags.includes('turnover'));
  assert.match(tryInterception.explanationKo, /2점 컨버전 패스를 가로채 추가 점수를 막았어요/);

  const penalizedTry = explain(play({ down: null, yardline_100: 2, play_type: 'run', rush: true, two_point_conv_result: 'failure', penalty: true, penalty_team: 'NO', penalty_type: 'Defensive Offside', penalty_yards: 1 }));
  assert.equal(penalizedTry.kind, 'two_point');
});

test('닐 다운·스파이크·타임아웃·진행 기록·스냅 실수', () => {
  const kneel = explain(play({ play_type: 'qb_kneel', qb_kneel: true, yards_gained: -1 }));
  assert.equal(kneel.kind, 'other');
  assert.equal(kneel.titleKo, '애틀랜타, 닐 다운(무릎 꿇기)');

  const lastDownKneel = explain(play({ down: 4, ydstogo: 9, yardline_100: 17, play_type: 'qb_kneel', qb_kneel: true, yards_gained: -1, fourth_down_failed: true }));
  assert.ok(lastDownKneel.tags.includes('turnover'));
  assert.ok(!lastDownKneel.tags.includes('fourth_down') && !lastDownKneel.tags.includes('red_zone'));
  assert.match(lastDownKneel.explanationKo, /공격권은 상대에게 넘어가요/);

  const spike = explain(play({ play_type: 'qb_spike', qb_spike: true, incomplete_pass: true }));
  assert.equal(spike.kind, 'other');
  assert.equal(spike.titleKo, '애틀랜타, 스파이크로 시계 멈춤');

  const timeout = explain(play({ play_type: 'no_play', posteam: null, defteam: null, down: null, timeout: true }));
  assert.equal(timeout.titleKo, '타임아웃');
  assert.deepEqual(timeout.tags, []);

  const marker = explain(play({ play_type: null, posteam: null, defteam: null, down: null, ydstogo: null, yardline_100: null }));
  assert.equal(marker.kind, 'other');
  assert.equal(marker.titleKo, '경기 진행 기록');

  // nflverse yardage on aborted snaps covers only part of the play, so none is stated.
  const aborted = explain(play({ play_type: 'run', rush: true, aborted_play: true, yards_gained: 4 }));
  assert.equal(aborted.explanationKo, '플레이 초반에 공을 놓쳤지만 공격권은 지켰어요.');
});

test('4번째 공격·레드존 태그는 공격 팀이 직접 한 플레이(패스·러싱·색·가로채기·펌블)에만 붙는다', () => {
  const fourth = { down: 4, ydstogo: 2, yardline_100: 15 };
  const run = explain(play({ ...fourth, play_type: 'run', rush: true, yards_gained: 3, first_down: true, fourth_down_converted: true }));
  assert.ok(run.tags.includes('fourth_down') && run.tags.includes('red_zone'));
  const sack = explain(play({ ...fourth, play_type: 'pass', pass: true, sack: true, yards_gained: -6, fourth_down_failed: true }));
  assert.ok(sack.tags.includes('fourth_down') && sack.tags.includes('red_zone'));
  const pick = explain(play({ ...fourth, play_type: 'pass', pass: true, interception: true }));
  assert.equal(pick.kind, 'interception');
  assert.ok(pick.tags.includes('fourth_down') && pick.tags.includes('red_zone'));
  const fumble = explain(play({ ...fourth, play_type: 'run', rush: true, fumble: true, fumble_lost: true }));
  assert.equal(fumble.kind, 'fumble');
  assert.ok(fumble.tags.includes('fourth_down') && fumble.tags.includes('red_zone'));

  const fieldGoal = explain(play({ ...fourth, play_type: 'field_goal', kick_distance: 33, field_goal_result: 'missed' }));
  const punt = explain(play({ ...fourth, yardline_100: 60, play_type: 'punt', kick_distance: 45 }));
  const noPlay = explain(play({ ...fourth, play_type: 'no_play', penalty: true, penalty_team: 'ATL', penalty_type: 'False Start', penalty_yards: 5 }));
  const nullified = explain(play({ ...fourth, play_type: 'no_play', pass: true, penalty: true, penalty_team: 'NO', penalty_type: 'Defensive Holding', penalty_yards: 5, first_down: true }));
  for (const result of [fieldGoal, punt, noPlay, nullified]) {
    assert.ok(!result.tags.includes('fourth_down'), result.titleKo);
    assert.ok(!result.tags.includes('red_zone'), result.titleKo);
  }
  // A two-point try is snapped at the 2 but is not a red-zone down.
  const twoPoint = explain(play({ down: null, ydstogo: null, yardline_100: 2, play_type: 'pass', pass: true, two_point_conv_result: 'success', total_away_score: 8 }), context({ away: 6, home: 0 }));
  assert.ok(!twoPoint.tags.includes('red_zone'));
});

test('터치백 뒤 시작 위치는 다음 스냅으로만 말하고, 같은 플레이의 반칙을 함께 쓴다 (2026_03_TEN_NYG #4070)', () => {
  // Intercepted in the end zone; NYG's unsportsmanlike conduct moved the start to its own 10.
  const row = play({
    play_id: 4070, game_id: '2026_03_TEN_NYG', home_team: 'NYG', away_team: 'TEN', posteam: 'TEN', defteam: 'NYG',
    qtr: 4, time: '00:24', game_seconds_remaining: 24, down: 1, ydstogo: 7, yardline_100: 7, play_type: 'pass', pass: true,
    interception: true, touchback: true, return_yards: 0, penalty: true, penalty_team: 'NYG',
    penalty_type: 'Unsportsmanlike Conduct', penalty_yards: 10,
  });
  const result = explain(row, withNextSnap('NYG', 90));
  assert.equal(result.titleKo, '뉴욕 자이언츠 수비, 패스 가로채기');
  assert.equal(
    result.explanationKo,
    '뉴욕 자이언츠 수비가 패스를 가로채 공격권이 바로 넘어갔어요(턴오버). ' +
      '엔드존 안에서 가로챈 뒤 그대로 멈춰 터치백이 됐지만, 뉴욕 자이언츠의 비신사적 행위 반칙으로 10야드 벌칙이 적용돼 뉴욕 자이언츠는 자기 진영 10야드에서 공격을 시작했어요.',
  );
  assert.ok(!result.explanationKo.includes('20야드'));
  assert.ok(result.termSlugs.includes('touchback') && result.termSlugs.includes('penalty'));
  // Same play without the next snap: the penalty is still named, the spot is not.
  assert.equal(
    explain(row).explanationKo.split('. ')[1],
    '엔드존 안에서 가로챈 뒤 그대로 멈춰 터치백이 됐고, 뉴욕 자이언츠의 비신사적 행위 반칙으로 10야드 벌칙이 적용됐어요.',
  );
});

test('경기가 끝나 다음 공격이 없으면 터치백 뒤 시작 위치를 말하지 않는다 (2026_03_LA_DEN #5085)', () => {
  const result = explain(
    play({
      qtr: 4, time: '00:02', game_seconds_remaining: 2, posteam: 'ATL', defteam: 'NO', down: 2, ydstogo: 15, yardline_100: 19,
      play_type: 'pass', pass: true, interception: true, touchback: true, return_yards: 0,
    }),
    withNextSnap(null),
  );
  assert.equal(result.explanationKo, '뉴올리언스 수비가 패스를 가로채 공격권이 바로 넘어갔어요(턴오버). 엔드존 안에서 가로챈 뒤 그대로 멈춰 터치백이 됐어요.');
});

test('가로채기·펌블 뒤 반칙이 있으면 리턴 거리 대신 반칙과 실제 시작 위치를 말한다', () => {
  // 2026_04_ARI_NYG #2372: 22-yard return cut to 15 by ARI's block; ARI started at the NYG 37.
  const pick = explain(
    play({
      posteam: 'NYG', defteam: 'ARI', home_team: 'NYG', away_team: 'ARI', down: 3, ydstogo: 13, yardline_100: 77,
      play_type: 'pass', pass: true, interception: true, return_yards: 15, penalty: true, penalty_team: 'ARI',
      penalty_type: 'Illegal Block Above the Waist', penalty_yards: 10,
    }),
    withNextSnap('ARI', 37),
  );
  assert.equal(
    pick.explanationKo,
    '애리조나 수비가 패스를 가로채 공격권이 바로 넘어갔어요(턴오버). 애리조나의 허리 위 부정 블록 반칙으로 10야드 벌칙이 적용돼 애리조나는 상대 진영 37야드에서 공격을 시작했어요.',
  );
  assert.ok(!pick.explanationKo.includes('15야드'));

  // 2026_04_LAC_SEA #4593: strip sack, then LAC's unnecessary roughness; SEA started at the LAC 10.
  const strip = explain(
    play({
      posteam: 'LAC', defteam: 'SEA', down: 1, ydstogo: 10, yardline_100: 71, play_type: 'pass', pass: true, sack: true,
      fumble: true, fumble_lost: true, yards_gained: -9, penalty: true, penalty_team: 'LAC', penalty_type: 'Unnecessary Roughness', penalty_yards: 10,
    }),
    withNextSnap('SEA', 10),
  );
  assert.equal(
    strip.explanationKo,
    '쿼터백이 색을 당하는 과정에서 공을 놓쳤고(펌블) 시애틀 수비가 공을 차지해 공격권이 넘어갔어요(턴오버). ' +
      '차저스의 불필요한 거친 행위 반칙으로 10야드 벌칙이 적용돼 시애틀은 상대 진영 10야드에서 공격을 시작했어요.',
  );

  // Without the next snap the penalty is still stated.
  const noSnap = explain(play({ play_type: 'run', rush: true, fumble: true, fumble_lost: true, penalty: true, penalty_team: 'NO', penalty_type: 'Taunting', penalty_yards: 15 }));
  assert.match(noSnap.explanationKo, /뉴올리언스의 도발 행위 반칙으로 15야드 벌칙이 적용됐어요\.$/);
});

test('차는 팀이 다시 잡은 킥오프는 온사이드 성공이나 킥오프 팀 터치다운으로 설명한다', () => {
  const kickoff = { down: null, ydstogo: null, yardline_100: 35, play_type: 'kickoff', pass: false };
  // 2025_02_SEA_PIT #3004: SEA kicked 65 yards and recovered in the end zone for a touchdown.
  const kickTd = explain(
    play({
      ...kickoff, posteam: 'NO', defteam: 'SEA', home_team: 'NO', away_team: 'SEA', qtr: 4, game_seconds_remaining: 766,
      kick_distance: 65, own_kickoff_recovery_td: true, touchdown: true, td_team: 'SEA', total_away_score: 6,
    }),
    { teamShortKo: (abbr) => SHORT_KO[abbr] ?? abbr, scoreBefore: { away: 0, home: 0 }, homeTeam: 'NO', awayTeam: 'SEA' },
  );
  assert.equal(kickTd.kind, 'kickoff');
  assert.equal(kickTd.titleKo, '시애틀, 킥오프한 공 되찾아 터치다운');
  assert.equal(kickTd.explanationKo, '시애틀이 킥오프한 공을 직접 다시 잡아 터치다운까지 올렸어요. 터치다운은 6점이고, 이어서 추가 득점 시도를 해요.');
  assert.ok(kickTd.tags.includes('touchdown') && kickTd.tags.includes('scoring'));

  // 2025_02_CAR_ARI #4169: a 9-yard onside kick recovered by CAR.
  const onside = explain(play({ ...kickoff, posteam: 'ARI', defteam: 'CAR', kick_distance: 9, own_kickoff_recovery: true, return_yards: 0 }));
  assert.equal(onside.titleKo, '캐롤라이나, 온사이드 킥 성공');
  assert.equal(
    onside.explanationKo,
    '캐롤라이나가 짧게 찬 킥(온사이드 킥)을 다시 차지해 공격권을 지켰어요. 킥오프한 공은 10야드 이상 나아가면 차는 팀도 잡을 수 있어요.',
  );
  assert.ok(!onside.explanationKo.includes('상대에게 공격을 넘기는'));
});

test('가로챈 공을 공격 팀이 다시 잡아 터치다운하면 득점 팀 기준으로 쓴다 (2025_05_TEN_ARI #4224)', () => {
  const result = explain(
    play({
      posteam: 'TEN', defteam: 'ARI', home_team: 'ARI', away_team: 'TEN', qtr: 4, time: '04:53', game_seconds_remaining: 293,
      down: 3, ydstogo: 2, yardline_100: 20, play_type: 'pass', pass: true, interception: true, fumble: true, fumble_lost: true,
      touchdown: true, td_team: 'TEN', total_away_score: 6,
    }),
    { teamShortKo: (abbr) => SHORT_KO[abbr] ?? abbr, scoreBefore: { away: 0, home: 0 }, homeTeam: 'ARI', awayTeam: 'TEN' },
  );
  assert.equal(result.titleKo, '테네시, 가로채기 뒤 공 되찾아 터치다운');
  assert.equal(
    result.explanationKo,
    '애리조나 수비가 패스를 가로챘지만 다시 공을 놓쳐(펌블) 테네시가 공을 되찾아 터치다운까지 올렸어요. 터치다운은 6점이고, 이어서 추가 득점 시도를 해요.',
  );
});

test('래터럴로 이어진 거리, 반칙 지점 벌칙, 골라인 앞 3번째 공격 실패를 맞게 설명한다', () => {
  // 2026_03_ARI_SF #503: 2-yard catch, 80-yard lateral run.
  const lateral = explain(
    play({
      posteam: 'SF', defteam: 'ARI', down: 3, ydstogo: 12, yardline_100: 82, play_type: 'pass', pass: true, yards_gained: 82,
      lateral_reception: true, first_down: true, third_down_converted: true, touchdown: true, pass_touchdown: true, td_team: 'SF', total_away_score: 6,
    }),
  );
  assert.equal(lateral.titleKo, '샌프란시스코, 82야드 패스 터치다운');
  assert.match(lateral.explanationKo, /^패스를 받은 선수가 동료에게 공을 다시 넘겨\(래터럴\) 모두 82야드를 전진해 터치다운을 올렸어요\./);

  // 2026_03_LAC_BUF #3478: the gain counts up to the holding spot, then 10 yards back.
  const holding = explain(
    play({
      posteam: 'BUF', defteam: 'LAC', down: 4, ydstogo: 6, yardline_100: 43, play_type: 'pass', pass: true, yards_gained: 29,
      first_down: true, fourth_down_converted: true, penalty: true, penalty_team: 'BUF', penalty_type: 'Offensive Holding', penalty_yards: 10,
    }),
  );
  assert.match(holding.explanationKo, /필요한 거리를 채워 공격 기회 네 번을 새로 얻었고, 버펄로는 홀딩 반칙으로 반칙 지점에서 10야드 물러났어요\.$/);

  const goalLine = explain(
    play({ down: 3, ydstogo: 1, goal_to_go: true, yardline_100: 1, play_type: 'run', rush: true, yards_gained: 0, third_down_failed: true }),
  );
  assert.match(goalLine.explanationKo, /보통 이때는 필드골을 차거나, 남은 거리가 짧으면 4번째 공격에 도전하기도 해요\.$/);
  assert.ok(!goalLine.explanationKo.includes('펀트'));
  assert.ok(goalLine.termSlugs.includes('red-zone'));
});

test('생성된 모든 설명은 해요체 1~2문장이고 영어와 잘못된 용어 slug가 없다', () => {
  assert.ok(produced.length >= 40, String(produced.length));
  for (const result of produced) {
    const sentences = result.explanationKo.split(/(?<=\.)\s+/);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, result.explanationKo);
    for (const sentence of sentences) assert.match(sentence, /요(\([^)]*\))?\.$/, sentence);
    assert.doesNotMatch(result.explanationKo, /[A-Za-z]|undefined|null|NaN/, result.explanationKo);
    assert.doesNotMatch(result.titleKo, /undefined|null|NaN/, result.titleKo);
    // Titles stay Korean too; only the "LA" of the two Los Angeles team names is Latin.
    assert.doesNotMatch(result.titleKo.replace(/\bLA (?=램스|차저스)/g, ''), /[A-Za-z]/, result.titleKo);
    for (const slug of result.termSlugs) assert.ok(isGlossarySlug(slug), slug);
    assert.equal(new Set(result.termSlugs).size, result.termSlugs.length);
    assert.ok(!result.tags.includes('lead_change'));
  }
  const kinds = new Set(produced.map((result) => result.kind));
  for (const kind of ['pass', 'run', 'sack', 'interception', 'fumble', 'field_goal', 'punt', 'kickoff', 'extra_point', 'two_point', 'penalty', 'safety', 'other']) {
    assert.ok(kinds.has(kind as PlayExplanation['kind']), kind);
  }
});

test('용어집은 slug마다 정확히 한 항목을 가지고, 승리 확률은 앱 번들에 글이 없도록 항목을 두지 않는다', () => {
  const slugs = GLOSSARY.map((term) => term.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual([...SLUGS_WITHOUT_ENTRY], ['win-probability']);
  assert.deepEqual([...slugs].sort(), GLOSSARY_SLUGS.filter((slug) => !SLUGS_WITHOUT_ENTRY.has(slug)).sort());
  assert.ok(!JSON.stringify(GLOSSARY).includes('확률'));
  for (const term of GLOSSARY) {
    assert.ok(term.termKo.trim() && term.termEn.trim(), term.slug);
    const sentences = term.definitionKo.split(/(?<=\.)\s+/);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, term.slug);
    for (const sentence of sentences) assert.match(sentence, /요\.$/, `${term.slug}: ${sentence}`);
  }
});
