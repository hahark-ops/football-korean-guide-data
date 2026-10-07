import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicGameRow, StandingsFile, TeamStanding } from '../../src/data/publicData.ts';
import { STANDINGS_METHOD_NOTE_KO, buildStandings, formatRecord, latestCompletedWeek, streakOf } from '../../collector/standings.ts';
import { DIVISIONS, divisionOf, teamShortKo } from '../../collector/teams.ts';
import { makeGame } from './fixtures.ts';

const CONTEXT = { generatedAt: '2026-10-07T08:00:00.000Z', sourceCheckedAt: '2026-10-07T07:59:00.000Z' };

let sequence = 0;
function final(away: string, awayScore: number, home: string, homeScore: number, kickoff: string, week = 4): PublicGameRow {
  sequence += 1;
  return makeGame({
    id: `2026_${String(sequence).padStart(2, '0')}_${away}_${home}`,
    week,
    kickoff_at: kickoff,
    away_team_abbr: away,
    home_team_abbr: home,
    away_score: awayScore,
    home_score: homeScore,
  });
}

function team(file: StandingsFile, abbr: string): TeamStanding {
  for (const division of file.divisions) {
    const found = division.teams.find((entry) => entry.abbr === abbr);
    if (found) return found;
  }
  throw new Error(`missing ${abbr}`);
}

test('경기가 없어도 8개 지구에 4팀씩 0으로 채운다', () => {
  const file = buildStandings(2026, [], CONTEXT);
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.gamesCounted, 0);
  assert.equal(file.methodNoteKo, STANDINGS_METHOD_NOTE_KO);
  assert.equal(file.divisions.length, 8);
  assert.deepEqual(
    file.divisions.map((division) => division.nameKo),
    ['AFC 동부', 'AFC 북부', 'AFC 남부', 'AFC 서부', 'NFC 동부', 'NFC 북부', 'NFC 남부', 'NFC 서부'],
  );
  for (const division of file.divisions) {
    assert.equal(division.teams.length, 4);
    for (const entry of division.teams) {
      assert.equal(entry.wins + entry.losses + entry.ties, 0);
      assert.equal(entry.winPct, 0);
      assert.equal(entry.streak, null);
      assert.equal(entry.divisionRecord, '0-0');
    }
    // With all zeros every team shares first place, listed by Korean name.
    const names = division.teams.map((entry) => entry.nameKo);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ko')));
    assert.deepEqual(division.teams.map((entry) => entry.divisionRank), [1, 1, 1, 1]);
    assert.ok(division.teams.every((entry) => entry.tied && entry.rankChange === null));
  }
  assert.equal(file.methodNoteKo, '승률 순으로 정렬했어요. 승률이 같으면 동률로 표시하고, 공식 순위 결정 방식(맞대결 등)은 반영하지 않았어요.');
});

test('32팀이 한 번씩, 올바른 지구에 들어 있다', () => {
  const seen = DIVISIONS.flatMap((division) => division.teams);
  assert.equal(new Set(seen).size, 32);
  assert.equal(divisionOf('LA')?.nameKo, 'NFC 서부');
  assert.equal(divisionOf('LAC')?.nameKo, 'AFC 서부');
  assert.equal(divisionOf('XYZ'), null);
  assert.equal(teamShortKo('ATL'), '애틀랜타');
  assert.equal(teamShortKo('LA'), 'LA 램스');
  assert.equal(teamShortKo('NYJ'), '뉴욕 제츠');
  assert.equal(teamShortKo('KC'), '캔자스시티');
});

test('승패, 승률, 득실, 연속 기록, 지구 내 전적을 계산한다', () => {
  const games: PublicGameRow[] = [
    final('BUF', 20, 'MIA', 10, '2026-09-13T17:00:00.000Z'), // division game
    final('NE', 17, 'NYJ', 17, '2026-09-13T17:00:00.000Z'), // division tie
    final('BUF', 13, 'KC', 27, '2026-09-20T17:00:00.000Z'),
    final('MIA', 24, 'NE', 21, '2026-09-20T17:00:00.000Z'), // division game
    final('NYJ', 31, 'BUF', 30, '2026-09-27T17:00:00.000Z'), // division game
    final('MIA', 3, 'LA', 0, '2026-09-27T17:00:00.000Z'),
    makeGame({ id: 'sched', away_team_abbr: 'BUF', home_team_abbr: 'NE', away_score: null, home_score: null, status: 'scheduled' }),
    makeGame({ id: 'post', season_type: 'POST', away_team_abbr: 'BUF', home_team_abbr: 'MIA', away_score: 50, home_score: 0, postseason_round: 'WC' }),
  ];
  const file = buildStandings(2026, games, CONTEXT);
  assert.equal(file.gamesCounted, 6);

  const buf = team(file, 'BUF');
  assert.deepEqual([buf.wins, buf.losses, buf.ties], [1, 2, 0]);
  assert.equal(buf.winPct, 0.333);
  assert.deepEqual([buf.pointsFor, buf.pointsAgainst, buf.pointDiff], [63, 68, -5]);
  assert.equal(buf.streak, 'L2');
  assert.equal(buf.divisionRecord, '1-1');

  const nyj = team(file, 'NYJ');
  assert.deepEqual([nyj.wins, nyj.losses, nyj.ties], [1, 0, 1]);
  assert.equal(nyj.winPct, 0.75);
  assert.equal(nyj.streak, 'W1');
  assert.equal(nyj.divisionRecord, '1-0-1');

  const mia = team(file, 'MIA');
  assert.deepEqual([mia.wins, mia.losses], [2, 1]);
  assert.equal(mia.winPct, 0.667);
  assert.equal(mia.streak, 'W2');
  assert.equal(mia.divisionRecord, '1-1');

  const ne = team(file, 'NE');
  assert.equal(ne.streak, 'L1');
  assert.equal(ne.winPct, 0.25);
  assert.equal(ne.divisionRecord, '0-1-1');

  // The source abbreviation is kept for the Rams.
  assert.equal(team(file, 'LA').nameKo, '로스앤젤레스 램스');
  assert.equal(team(file, 'LA').divisionRecord, '0-0');

  const east = file.divisions[0];
  assert.deepEqual(east.teams.map((entry) => entry.abbr), ['NYJ', 'MIA', 'BUF', 'NE']);
  assert.deepEqual(east.teams.map((entry) => entry.divisionRank), [1, 2, 3, 4]);
});

test('승률이 같으면 득실차와 상관없이 같은 순위(1, 2, 2, 4)와 동률로 두고 이름 순으로 놓는다', () => {
  const games = [
    final('CHI', 30, 'DET', 10, '2026-09-13T17:00:00.000Z'), // CHI 1-0 (+20), DET 0-1
    final('GB', 14, 'MIN', 7, '2026-09-13T17:00:00.000Z'), // GB 1-0 (+7), MIN 0-1
    final('DET', 0, 'GB', 3, '2026-09-20T17:00:00.000Z'), // GB 2-0, DET 0-2
    final('MIN', 10, 'CHI', 3, '2026-09-20T17:00:00.000Z'), // CHI 1-1 (+13), MIN 1-1 (0)
  ];
  const north = buildStandings(2026, games, CONTEXT).divisions.find((division) => division.nameKo === 'NFC 북부');
  assert.ok(north);
  // 미네소타 sorts before 시카고 even though Chicago has the better point differential.
  assert.deepEqual(north.teams.map((entry) => entry.abbr), ['GB', 'MIN', 'CHI', 'DET']);
  assert.deepEqual(north.teams.map((entry) => entry.divisionRank), [1, 2, 2, 4]);
  assert.deepEqual(north.teams.map((entry) => entry.tied), [false, true, true, false]);
});

test('순위 변화는 가장 최근에 모두 끝난 주차 이전 순위와 비교하고, 그 뒤로 경기가 없으면 null이다', () => {
  const games = [
    final('CHI', 20, 'DET', 10, '2026-09-13T17:00:00.000Z', 1),
    final('GB', 14, 'MIN', 7, '2026-09-13T17:00:00.000Z', 1),
    final('BUF', 24, 'MIA', 3, '2026-09-13T17:00:00.000Z', 1),
    final('DET', 17, 'CHI', 10, '2026-09-20T17:00:00.000Z', 2),
    final('MIN', 21, 'GB', 20, '2026-09-20T17:00:00.000Z', 2),
    final('NE', 13, 'NYJ', 6, '2026-09-20T17:00:00.000Z', 2), // BUF and MIA are off in week 2
    final('MIN', 9, 'DET', 16, '2026-09-27T17:00:00.000Z', 3),
    makeGame({ id: 'open3', week: 3, away_team_abbr: 'CHI', home_team_abbr: 'GB', away_score: null, home_score: null, status: 'scheduled' }),
  ];
  assert.equal(latestCompletedWeek(games), 2);
  const file = buildStandings(2026, games, CONTEXT);
  const north = file.divisions.find((division) => division.nameKo === 'NFC 북부');
  assert.ok(north);
  // Now: DET 2-1, CHI 1-1, GB 1-1, MIN 1-2. Before week 2: CHI and GB 1st, DET and MIN 3rd.
  assert.deepEqual(north.teams.map((entry) => [entry.abbr, entry.divisionRank, entry.rankChange]), [
    ['DET', 1, 2],
    ['GB', 2, -1],
    ['CHI', 2, -1],
    ['MIN', 4, -1],
  ]);
  // Before week 2: BUF 1st; MIA, NE and NYJ share 2nd. BUF and MIA have not played since.
  // Ties are listed by Korean name: 뉴잉글랜드 before 버펄로, 뉴욕 제츠 before 마이애미.
  const east = file.divisions[0];
  assert.deepEqual(east.teams.map((entry) => [entry.abbr, entry.divisionRank, entry.tied, entry.rankChange]), [
    ['NE', 1, true, 1],
    ['BUF', 1, true, null],
    ['NYJ', 3, true, -1],
    ['MIA', 3, true, null],
  ]);

  // Only week 1 complete: no earlier standings to compare with.
  const weekOne = buildStandings(2026, games.filter((game) => game.week === 1), CONTEXT);
  assert.ok(weekOne.divisions.every((division) => division.teams.every((entry) => entry.rankChange === null)));
});

test('모두 끝난 주차는 정규 시즌만 보고, 경기가 하나라도 남은 주차는 제외한다', () => {
  assert.equal(latestCompletedWeek([]), null);
  assert.equal(latestCompletedWeek([makeGame({ week: 1, status: 'scheduled', away_score: null, home_score: null })]), null);
  assert.equal(
    latestCompletedWeek([
      makeGame({ id: 'a', week: 3 }),
      makeGame({ id: 'b', week: 4 }),
      makeGame({ id: 'c', week: 4, status: 'scheduled', away_score: null, home_score: null }),
      makeGame({ id: 'd', week: 19, season_type: 'POST', postseason_round: 'WC' }),
    ]),
    3,
  );
});

test('연속 기록과 전적 문자열 형식', () => {
  assert.equal(streakOf([]), null);
  assert.equal(streakOf(['W']), 'W1');
  assert.equal(streakOf(['L', 'W', 'W']), 'W2');
  assert.equal(streakOf(['W', 'T']), 'T1');
  assert.equal(streakOf(['W', 'L', 'L', 'L']), 'L3');
  assert.equal(formatRecord({ wins: 3, losses: 1, ties: 0 }), '3-1');
  assert.equal(formatRecord({ wins: 3, losses: 1, ties: 1 }), '3-1-1');
});
