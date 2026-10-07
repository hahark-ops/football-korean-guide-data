import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameRecapFile, PlayKind, PlayTag, PublicGameRow, RecapPlay } from '../../src/data/publicData.ts';
import { buildConceptExamples } from '../../collector/concepts.ts';
import { makeGame } from './fixtures.ts';

function play(id: string, elapsedSeconds: number, kind: PlayKind, termSlugs: string[], tags: PlayTag[] = []): RecapPlay {
  return {
    id,
    period: 1,
    clock: '10:00',
    elapsedSeconds,
    offense: 'ATL',
    defense: 'NO',
    down: 1,
    distance: 10,
    yardline100: 75,
    situationKo: null,
    kind,
    tags,
    yards: 0,
    titleKo: '테스트',
    explanationKo: '테스트 설명이에요.',
    termSlugs,
    scoreAfter: { away: 0, home: 0 },
    fieldBar: null,
  };
}

function recapFor(game: PublicGameRow, keyPlays: RecapPlay[], scoringPlays: RecapPlay[] = []): GameRecapFile {
  return {
    schemaVersion: 1,
    gameId: game.id,
    season: game.season,
    week: game.week,
    seasonType: game.season_type,
    generatedAt: '2026-10-07T08:00:00.000Z',
    sourceCheckedAt: '2026-10-07T08:00:00.000Z',
    away: { abbr: game.away_team_abbr, nameKo: game.away_team_name_ko },
    home: { abbr: game.home_team_abbr, nameKo: game.home_team_name_ko },
    final: { away: 0, home: 0, overtime: false },
    quarterScores: [],
    scoreBreakdown: {
      away: { touchdowns: 0, extraPoints: 0, twoPointConversions: 0, fieldGoals: 0, safeties: 0, other: 0 },
      home: { touchdowns: 0, extraPoints: 0, twoPointConversions: 0, fieldGoals: 0, safeties: 0, other: 0 },
    },
    keyPlays,
    scoringPlays,
    summaryKo: '테스트예요.',
  };
}

function game(id: string, week: number, kickoff: string, overrides: Partial<PublicGameRow> = {}): PublicGameRow {
  return makeGame({ id, week, kickoff_at: kickoff, has_recap: true, ...overrides });
}

test('용어마다 최신 경기부터 경기당 한 장면씩 최대 3개를 고르고, 예시가 없는 용어는 뺀다', () => {
  const games = [
    game('2026_01_A', 1, '2026-09-13T17:00:00.000Z'),
    game('2026_02_B', 2, '2026-09-20T17:00:00.000Z', { away_team_abbr: 'CHI', home_team_abbr: 'GB' }),
    game('2026_03_C', 3, '2026-09-27T17:00:00.000Z'),
    game('2026_04_D', 4, '2026-10-04T17:00:00.000Z'),
    game('2026_04_E', 4, '2026-10-04T20:25:00.000Z', { status: 'scheduled', away_score: null, home_score: null, has_recap: false }),
  ];
  const recaps = new Map<string, GameRecapFile>([
    ['2026_01_A', recapFor(games[0], [play('10', 100, 'pass', ['first-down'])])],
    ['2026_02_B', recapFor(games[1], [play('20', 200, 'run', ['first-down']), play('25', 900, 'pass', ['first-down', 'sack'])])],
    ['2026_03_C', recapFor(games[2], [play('30', 300, 'pass', ['first-down'])])],
    ['2026_04_D', recapFor(games[3], [play('40', 400, 'pass', ['first-down'])], [play('40', 400, 'pass', ['first-down'])])],
    ['2026_04_E', recapFor(games[4], [play('50', 500, 'pass', ['first-down'])])],
  ]);
  const file = buildConceptExamples(2026, games, recaps, '2026-10-07T08:00:00.000Z');
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.season, 2026);
  assert.deepEqual(Object.keys(file.examples), ['first-down', 'sack']);

  const firstDown = file.examples['first-down'];
  assert.deepEqual(firstDown.map((example) => [example.gameId, example.play.id]), [
    ['2026_04_D', '40'],
    ['2026_03_C', '30'],
    ['2026_02_B', '25'],
  ]);
  assert.deepEqual(firstDown[2], {
    gameId: '2026_02_B',
    week: 2,
    seasonType: 'REG',
    away: 'CHI',
    home: 'GB',
    play: recaps.get('2026_02_B')?.keyPlays[1],
  });
  // No preferred sack play exists, so the only play mentioning the term is used.
  assert.deepEqual(file.examples.sack.map((example) => example.play.id), ['25']);
});

test('용어에 맞는 종류의 장면을 더 최근의 다른 장면보다 먼저 고르고, 결과는 최신순으로 둔다', () => {
  const games = [
    game('2026_01_A', 1, '2026-09-13T17:00:00.000Z'),
    game('2026_02_B', 2, '2026-09-20T17:00:00.000Z'),
    game('2026_03_C', 3, '2026-09-27T17:00:00.000Z'),
    game('2026_04_D', 4, '2026-10-04T17:00:00.000Z'),
  ];
  const recaps = new Map<string, GameRecapFile>([
    // An extra point's explanation mentions 터치다운 too; real touchdowns win.
    ['2026_01_A', recapFor(games[0], [play('11', 100, 'pass', ['touchdown'], ['touchdown', 'scoring'])])],
    ['2026_02_B', recapFor(games[1], [play('21', 200, 'run', ['touchdown'], ['touchdown', 'scoring'])])],
    ['2026_03_C', recapFor(games[2], [play('31', 300, 'extra_point', ['touchdown', 'extra-point'], ['scoring'])])],
    ['2026_04_D', recapFor(games[3], [
      play('41', 400, 'interception', ['interception', 'touchdown'], ['touchdown', 'turnover', 'scoring']),
      play('42', 500, 'extra_point', ['touchdown', 'extra-point'], ['scoring']),
    ])],
  ]);
  const file = buildConceptExamples(2026, games, recaps, '2026-10-07T08:00:00.000Z');
  // Game D's newest touchdown-term play is the extra point, but its touchdown play is preferred.
  assert.deepEqual(file.examples.touchdown.map((example) => [example.gameId, example.play.id]), [
    ['2026_04_D', '41'],
    ['2026_02_B', '21'],
    ['2026_01_A', '11'],
  ]);
  assert.deepEqual(file.examples['extra-point'].map((example) => example.play.id), ['42', '31']);
  assert.deepEqual(file.examples.interception.map((example) => example.play.id), ['41']);
});

test('다른 시즌 경기와 요약 파일이 없는 경기는 쓰지 않는다', () => {
  const games = [
    game('2025_01_A', 1, '2025-09-14T17:00:00.000Z', { season: 2025 }),
    game('2026_01_B', 1, '2026-09-13T17:00:00.000Z', { has_recap: false }),
  ];
  const recaps = new Map<string, GameRecapFile>([
    ['2025_01_A', recapFor(games[0], [play('1', 100, 'sack', ['sack'])])],
    ['2026_01_B', recapFor(games[1], [play('2', 100, 'sack', ['sack'])])],
  ]);
  assert.deepEqual(buildConceptExamples(2026, games, recaps, '2026-10-07T08:00:00.000Z').examples, {});
});
