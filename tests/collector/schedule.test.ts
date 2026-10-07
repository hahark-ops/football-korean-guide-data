import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicGameRow } from '../../src/data/publicData.ts';
import {
  buildSeasonIndexEntry,
  headlineKo,
  isOffseasonMonth,
  nflSeasonForDate,
  parseSchedule,
  placeholderKickoffIds,
  resultLineKo,
  seasonRows,
  toPublicGameRow,
  zonedTimeToUtcIso,
  type ScheduleRow,
} from '../../collector/schedule.ts';

const HEADER =
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium';

const CSV = [
  HEADER,
  '2026_04_ATL_NO,2026,REG,4,2026-10-04,Sunday,13:00,ATL,45,NO,24,Home,-21,69,0,Quarterback A,Quarterback B,Coach A,Coach B,Ref C,Caesars Superdome',
  '2026_04_IND_WAS,2026,REG,4,2026-10-04,Sunday,09:30,IND,30,WAS,13,Neutral,-17,43,0,QB,QB,C,C,R,Tottenham Hotspur Stadium',
  '2026_09_LA_SF,2026,REG,9,2026-11-01,Sunday,13:00,LA,NA,SF,NA,Home,NA,NA,NA,QB,QB,C,C,R,"Levi\'s Stadium"',
  '2025_20_BUF_DEN,2025,DIV,20,2026-01-17,Saturday,16:30,BUF,30,DEN,33,Home,3,63,1,QB,QB,C,C,R,Empower Field at Mile High',
  '2025_22_SEA_NE,2025,SB,22,2026-02-08,Sunday,18:30,SEA,29,NE,13,Neutral,-16,42,0,QB,QB,C,C,R,Levi\'s Stadium',
  '2025_19_GB_CHI,2025,WC,19,2026-01-10,Saturday,20:00,GB,NA,CHI,NA,Home,NA,NA,NA,QB,QB,C,C,R,NA',
].join('\n');

function rowById(rows: ScheduleRow[], id: string): ScheduleRow {
  const row = rows.find((item) => item.gameId === id);
  assert.ok(row, id);
  return row;
}

const CONTEXT = { checkedAt: '2026-10-07T08:00:00.000Z', runAt: '2026-10-07T08:00:05.000Z', hasRecap: false };

test('미국 동부 시간을 서머타임 전환과 무관하게 UTC로 바꾼다', () => {
  assert.equal(zonedTimeToUtcIso('2026-10-04', '13:00'), '2026-10-04T17:00:00.000Z');
  assert.equal(zonedTimeToUtcIso('2026-11-08', '13:00'), '2026-11-08T18:00:00.000Z');
  // DST ends at 02:00 on 2026-11-01, so a 1 p.m. kickoff that day is already EST.
  assert.equal(zonedTimeToUtcIso('2026-11-01', '13:00'), '2026-11-01T18:00:00.000Z');
  assert.equal(zonedTimeToUtcIso('2026-03-08', '13:00'), '2026-03-08T17:00:00.000Z');
  assert.equal(zonedTimeToUtcIso('2026-01-17', '16:30'), '2026-01-17T21:30:00.000Z');
  assert.equal(zonedTimeToUtcIso('2026-09-10', '20:20'), '2026-09-11T00:20:00.000Z');
});

test('런던 경기도 소스의 동부 시간(09:30 ET)으로 계산한다', () => {
  // 09:30 EDT = 13:30 UTC = 14:30 in London (BST).
  assert.equal(zonedTimeToUtcIso('2026-10-04', '09:30'), '2026-10-04T13:30:00.000Z');
  const rows = parseSchedule(CSV);
  const london = toPublicGameRow(rowById(rows, '2026_04_IND_WAS'), CONTEXT);
  assert.equal(london.kickoff_at, '2026-10-04T13:30:00.000Z');
  assert.equal(london.neutral_site, true);
  assert.equal(london.venue, 'Tottenham Hotspur Stadium');
});

test('일정 CSV에서 필요한 열만 읽고 선수·감독·심판 이름은 버린다', () => {
  const rows = parseSchedule(CSV);
  assert.equal(rows.length, 6);
  const serialized = JSON.stringify(rows);
  for (const name of ['Quarterback A', 'Coach A', 'Ref C']) assert.ok(!serialized.includes(name), name);
});

test('점수가 둘 다 있을 때만 final, 아니면 scheduled로 둔다', () => {
  const rows = parseSchedule(CSV);
  const final = toPublicGameRow(rowById(rows, '2026_04_ATL_NO'), CONTEXT);
  assert.equal(final.status, 'final');
  assert.equal(final.away_score, 45);
  assert.equal(final.home_score, 24);
  assert.equal(final.season_type, 'REG');
  assert.equal(final.postseason_round, null);
  assert.equal(final.headline_ko, null);
  assert.equal(final.away_team_name_ko, '애틀랜타 팰컨스');
  assert.equal(final.source_updated_at, null);
  assert.equal(final.source_checked_at, CONTEXT.checkedAt);
  assert.equal(final.is_published, true);

  const scheduled = toPublicGameRow(rowById(rows, '2026_09_LA_SF'), CONTEXT);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.away_score, null);
  assert.equal(scheduled.overtime, false);
  assert.equal(scheduled.away_team_abbr, 'LA');
  assert.equal(scheduled.away_team_name_ko, '로스앤젤레스 램스');
  assert.equal(scheduled.venue, "Levi's Stadium");
  assert.equal(scheduled.kickoff_at, '2026-11-01T18:00:00.000Z');
});

test('포스트시즌 라운드와 연장 표기를 붙인다', () => {
  const rows = parseSchedule(CSV);
  const divisional = toPublicGameRow(rowById(rows, '2025_20_BUF_DEN'), CONTEXT);
  assert.equal(divisional.season_type, 'POST');
  assert.equal(divisional.postseason_round, 'DIV');
  assert.equal(divisional.overtime, true);
  assert.equal(divisional.headline_ko, '디비저널 라운드 · 연장전');

  const superBowl = toPublicGameRow(rowById(rows, '2025_22_SEA_NE'), CONTEXT);
  assert.equal(superBowl.headline_ko, '슈퍼볼');
  assert.equal(superBowl.neutral_site, true);

  const wildCard = toPublicGameRow(rowById(rows, '2025_19_GB_CHI'), CONTEXT);
  assert.equal(wildCard.headline_ko, '와일드카드');
  assert.equal(wildCard.status, 'scheduled');
  assert.equal(wildCard.venue, null);

  const base = rowById(rows, '2026_04_ATL_NO');
  assert.equal(headlineKo({ ...base, gameType: 'CON' }), '콘퍼런스 챔피언십');
  assert.equal(headlineKo({ ...base, overtime: true }), '연장전');
  assert.equal(headlineKo({ ...base, overtime: true, awayScore: null, homeScore: null }), null);
});

test('내용이 같으면 updated_at을 유지하고 바뀌면 이번 실행 시각으로 바꾼다', () => {
  const rows = parseSchedule(CSV);
  const row = rowById(rows, '2026_04_ATL_NO');
  const first = toPublicGameRow(row, { ...CONTEXT, runAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(first.updated_at, '2026-10-05T00:00:00.000Z');

  const later = { checkedAt: '2026-10-07T09:00:00.000Z', runAt: '2026-10-07T09:00:01.000Z', hasRecap: false };
  const same = toPublicGameRow(row, { ...later, previous: first });
  assert.equal(same.updated_at, '2026-10-05T00:00:00.000Z');
  assert.equal(same.source_checked_at, '2026-10-07T09:00:00.000Z');

  const recapAdded = toPublicGameRow(row, { ...later, hasRecap: true, previous: first });
  assert.equal(recapAdded.updated_at, later.runAt);

  const scoreFixed = toPublicGameRow({ ...row, homeScore: 27 }, { ...later, previous: first });
  assert.equal(scoreFixed.updated_at, later.runAt);

  // Key order in an older file must not count as a change.
  const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as PublicGameRow;
  assert.equal(toPublicGameRow(row, { ...later, previous: reordered }).updated_at, '2026-10-05T00:00:00.000Z');
});

test('시즌 색인의 current는 아직 끝나지 않은 가장 이른 주차다', () => {
  const rows = parseSchedule(CSV);
  const season2026 = seasonRows(rows, 2026).map((row) => toPublicGameRow(row, CONTEXT));
  const entry = buildSeasonIndexEntry(2026, season2026, CONTEXT.checkedAt);
  assert.deepEqual(entry.current, { seasonType: 'REG', week: 9 });
  assert.deepEqual(entry.weeks, { REG: [4, 9], POST: [] });
  assert.equal(entry.gamesPath, 'seasons/2026/games.json');
  assert.equal(entry.standingsPath, 'seasons/2026/standings.json');
  assert.equal(entry.conceptsPath, 'seasons/2026/concepts.json');

  const season2025 = seasonRows(rows, 2025).map((row) => toPublicGameRow(row, CONTEXT));
  assert.deepEqual(buildSeasonIndexEntry(2025, season2025, CONTEXT.checkedAt).current, { seasonType: 'POST', week: 19 });

  const allFinal = season2025.filter((game) => game.status === 'final');
  const done = buildSeasonIndexEntry(2025, allFinal, CONTEXT.checkedAt);
  assert.deepEqual(done.current, { seasonType: 'POST', week: 22 });
  assert.deepEqual(done.weeks, { REG: [], POST: [20, 22] });
});

test('경기 순서는 킥오프, 그다음 game_id 순이다', () => {
  const rows = seasonRows(parseSchedule(CSV), 2026).map((row) => row.gameId);
  assert.deepEqual(rows, ['2026_04_IND_WAS', '2026_04_ATL_NO', '2026_09_LA_SF']);
});

test('1~2월은 전 시즌, 3~8월은 비시즌으로 본다', () => {
  assert.equal(nflSeasonForDate(new Date('2026-10-07T12:00:00Z')), 2026);
  assert.equal(nflSeasonForDate(new Date('2027-02-10T12:00:00Z')), 2026);
  assert.equal(nflSeasonForDate(new Date('2027-03-01T12:00:00Z')), 2027);
  // 2027-01-01 02:00 UTC is still Dec 31 in New York.
  assert.equal(nflSeasonForDate(new Date('2027-01-01T02:00:00Z')), 2026);
  assert.equal(isOffseasonMonth(new Date('2027-05-01T12:00:00Z')), true);
  assert.equal(isOffseasonMonth(new Date('2026-09-01T12:00:00Z')), false);
  assert.equal(isOffseasonMonth(new Date('2027-02-28T12:00:00Z')), false);
});

test('결과 한 줄은 점수만으로 만든 한국어 문장이고 끝난 경기에만 있다', () => {
  const rows = parseSchedule(CSV);
  const base = rowById(rows, '2026_04_ATL_NO');
  assert.equal(resultLineKo(base), '애틀랜타가 21점 차로 이겼어요.');
  assert.equal(resultLineKo({ ...base, awayTeam: 'CHI', awayScore: 23, homeScore: 20, overtime: true }), '연장 끝에 시카고가 3점 차로 이겼어요.');
  assert.equal(resultLineKo({ ...base, awayScore: 17, homeScore: 17 }), '17-17 무승부로 끝났어요.');
  assert.equal(resultLineKo({ ...base, awayScore: 20, homeScore: 20, overtime: true }), '연장전에서도 승부가 나지 않아 20-20 무승부로 끝났어요.');
  assert.equal(resultLineKo({ ...base, homeTeam: 'LA', awayScore: 3, homeScore: 10 }), 'LA 램스가 7점 차로 이겼어요.');
  assert.equal(resultLineKo(rowById(rows, '2026_09_LA_SF')), null);

  assert.equal(toPublicGameRow(base, CONTEXT).result_line_ko, '애틀랜타가 21점 차로 이겼어요.');
  assert.equal(toPublicGameRow(rowById(rows, '2026_09_LA_SF'), CONTEXT).result_line_ko, null);
  assert.equal(toPublicGameRow(rowById(rows, '2025_20_BUF_DEN'), CONTEXT).result_line_ko, '연장 끝에 덴버가 3점 차로 이겼어요.');
});

test('볼 만한 경기 단계는 끝난 경기에만 있고, 플레이 데이터가 없으면 점수 차로 임시 추정한다', () => {
  const rows = parseSchedule(CSV);
  const blowout = rowById(rows, '2026_04_ATL_NO');
  const estimated = toPublicGameRow(blowout, CONTEXT);
  assert.equal(estimated.closeness, 'decided_early');
  assert.equal(estimated.closeness_provisional, true);

  const measured = toPublicGameRow(blowout, { ...CONTEXT, closeness: 'close_once' });
  assert.equal(measured.closeness, 'close_once');
  assert.equal(measured.closeness_provisional, false);

  // A one-score final without play data was close at least once; whether the lead changed late is unknown.
  const oneScore = toPublicGameRow({ ...blowout, awayScore: 20, homeScore: 17 }, CONTEXT);
  assert.equal(oneScore.closeness, 'close_once');
  assert.equal(oneScore.closeness_provisional, true);

  const overtime = toPublicGameRow(rowById(rows, '2025_20_BUF_DEN'), CONTEXT);
  assert.equal(overtime.closeness, 'close_to_end');
  assert.equal(overtime.closeness_provisional, true);

  const scheduled = toPublicGameRow(rowById(rows, '2026_09_LA_SF'), { ...CONTEXT, closeness: 'close_once' });
  assert.equal(scheduled.closeness, null);
  assert.equal(scheduled.closeness_provisional, false);

  // Measured closeness replacing the estimate is a content change.
  assert.notEqual(
    toPublicGameRow(blowout, { ...CONTEXT, runAt: '2026-10-08T00:00:00.000Z', previous: estimated, closeness: 'decided_early' }).updated_at,
    estimated.updated_at,
  );
});

test('18주차 경기가 모두 같은 시각이면 미정(kickoff_tbd)으로 표시한다', () => {
  const week18 = [
    HEADER,
    '2026_18_ATL_CAR,2026,REG,18,2027-01-10,Sunday,13:00,ATL,NA,CAR,NA,Home,NA,NA,NA,QB,QB,C,C,R,Bank of America Stadium',
    '2026_18_CHI_MIN,2026,REG,18,2027-01-10,Sunday,13:00,CHI,NA,MIN,NA,Home,NA,NA,NA,QB,QB,C,C,R,U.S. Bank Stadium',
    '2026_17_DAL_WAS,2026,REG,17,2027-01-03,Sunday,13:00,DAL,NA,WAS,NA,Home,NA,NA,NA,QB,QB,C,C,R,Northwest Stadium',
    '2026_17_NYG_PHI,2026,REG,17,2027-01-03,Sunday,13:00,NYG,NA,PHI,NA,Home,NA,NA,NA,QB,QB,C,C,R,Lincoln Financial Field',
    '2025_18_BUF_NYJ,2025,REG,18,2026-01-04,Sunday,13:00,BUF,13,NYJ,10,Home,NA,NA,0,QB,QB,C,C,R,MetLife Stadium',
    '2025_18_SEA_SF,2025,REG,18,2026-01-03,Saturday,20:00,SEA,13,SF,3,Home,NA,NA,0,QB,QB,C,C,R,Santa Clara Stadium',
    '2026_01_KC_DEN,2026,REG,1,2026-09-13,Sunday,NA,KC,NA,DEN,NA,Home,NA,NA,NA,QB,QB,C,C,R,Empower Field at Mile High',
  ].join('\n');
  const rows = parseSchedule(week18);
  // Week 18 of 2026 shares one slot; week 17 is not the final week; 2025 week 18 has real times.
  // A game without any start time in the source is a placeholder too.
  assert.deepEqual([...placeholderKickoffIds(rows)].sort(), ['2026_01_KC_DEN', '2026_18_ATL_CAR', '2026_18_CHI_MIN']);
  // A lone week-18 game cannot show a shared placeholder.
  assert.deepEqual([...placeholderKickoffIds(rows.filter((row) => row.gameId !== '2026_18_CHI_MIN'))].sort(), ['2026_01_KC_DEN']);

  const tbd = toPublicGameRow(rowById(rows, '2026_18_ATL_CAR'), { ...CONTEXT, kickoffTbd: true });
  assert.equal(tbd.kickoff_tbd, true);
  assert.equal(tbd.kickoff_at, '2027-01-10T18:00:00.000Z');
  assert.equal(toPublicGameRow(rowById(rows, '2026_17_DAL_WAS'), CONTEXT).kickoff_tbd, false);
});
