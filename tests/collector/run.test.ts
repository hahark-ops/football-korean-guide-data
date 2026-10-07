import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ConceptExamplesFile,
  GameRecapFile,
  PublicDataIndex,
  SeasonGamesFile,
  StandingsFile,
} from '../../src/data/publicData.ts';
import { findForbiddenContent } from '../../collector/forbidden.ts';
import { formatSummary, parseArgs, runCollector, seasonsToPublish, type CollectorOptions } from '../../collector/run.ts';
import { SCHEDULE_URL, playByPlayUrl } from '../../collector/sources.ts';
import { fakeExplain, playByPlayCsvGz, smallGamePlays } from './fixtures.ts';

const SCHEDULE_CSV = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,away_qb_name,home_qb_name,stadium',
  '2026_04_ATL_NO,2026,REG,4,2026-10-04,Sunday,13:00,ATL,10,NO,7,Home,-3,17,0,Passer One,Passer Two,Caesars Superdome',
  '2026_04_IND_WAS,2026,REG,4,2026-10-04,Sunday,09:30,IND,30,WAS,13,Neutral,-17,43,0,Passer Three,Passer Four,Tottenham Hotspur Stadium',
  '2026_05_LA_SF,2026,REG,5,2026-10-11,Sunday,16:25,LA,NA,SF,NA,Home,NA,NA,NA,Passer Five,Passer Six,"Levi\'s Stadium"',
  '2025_22_SEA_NE,2025,SB,22,2026-02-08,Sunday,18:30,SEA,29,NE,13,Neutral,-16,42,0,Passer Seven,Passer Eight,Levi\'s Stadium',
].join('\n');

function fakeFetch(schedule = SCHEDULE_CSV) {
  const pbp = playByPlayCsvGz(smallGamePlays());
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === SCHEDULE_URL) return new Response(schedule);
    if (url === playByPlayUrl(2026)) return new Response(pbp);
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function withDirs(run: (options: CollectorOptions) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'collector-run-'));
  try {
    await run({
      season: 2026,
      outDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      offline: false,
      maxAgeMinutes: 0,
      skipRecaps: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CLI 인자를 읽는다', () => {
  const options = parseArgs(['--season', '2025', '--out=tmp/out', '--offline', '--max-age-minutes', '5', '--skip-recaps']);
  assert.equal(options.season, 2025);
  assert.equal(options.outDir, path.resolve('tmp/out'));
  assert.equal(options.offline, true);
  assert.equal(options.maxAgeMinutes, 5);
  assert.equal(options.skipRecaps, true);
  assert.equal(parseArgs([]).season, null);
  assert.equal(parseArgs([]).maxAgeMinutes, 30);
  assert.throws(() => parseArgs(['--season']), /needs a value/);
  assert.throws(() => parseArgs(['--season', 'abc']), /expected an integer/);
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
});

test('비시즌(3~8월)에만 지난 시즌도 함께 낸다', () => {
  assert.deepEqual(seasonsToPublish(null, new Date('2026-10-07T12:00:00Z')), [2026]);
  assert.deepEqual(seasonsToPublish(null, new Date('2027-01-20T12:00:00Z')), [2026]);
  assert.deepEqual(seasonsToPublish(null, new Date('2027-05-01T12:00:00Z')), [2027, 2026]);
  assert.deepEqual(seasonsToPublish(2025, new Date('2026-10-07T12:00:00Z')), [2025]);
});

test('수집기는 색인, 일정, 순위, 경기 요약을 쓰고 원문 설명과 선수 이름을 남기지 않는다', () =>
  withDirs(async (options) => {
    const { impl } = fakeFetch();
    const logs: string[] = [];
    const firstRun = new Date('2026-10-07T08:00:00.000Z');
    const result = await runCollector(options, { now: () => firstRun, fetchImpl: impl, explain: fakeExplain, log: (m) => logs.push(m) });

    const index = await readJson<PublicDataIndex>(path.join(options.outDir, 'index.json'));
    assert.equal(index.schemaVersion, 1);
    assert.equal(index.latestSeason, 2026);
    assert.deepEqual(index.source, {
      name: 'nflverse',
      url: 'https://github.com/nflverse',
      license: 'CC-BY-4.0',
      attributionKo: '경기 데이터: nflverse (CC BY 4.0)',
    });
    assert.deepEqual(index.seasons.map((season) => season.season), [2026]);
    assert.deepEqual(index.seasons[0].current, { seasonType: 'REG', week: 5 });
    assert.deepEqual(index.seasons[0].weeks, { REG: [4, 5], POST: [] });
    assert.equal(index.seasons[0].conceptsPath, 'seasons/2026/concepts.json');

    const games = await readJson<SeasonGamesFile>(path.join(options.outDir, 'seasons/2026/games.json'));
    assert.deepEqual(games.games.map((game) => [game.id, game.status, game.has_recap]), [
      ['2026_04_IND_WAS', 'final', false],
      ['2026_04_ATL_NO', 'final', true],
      ['2026_05_LA_SF', 'scheduled', false],
    ]);
    for (const game of games.games) assert.equal(game.updated_at, firstRun.toISOString());
    // ATL-NO has play-by-play (7-7 into the 4th, 10-7 final); IND-WAS has not, so it is a margin estimate.
    assert.deepEqual(games.games.map((game) => [game.id, game.result_line_ko, game.closeness, game.closeness_provisional, game.kickoff_tbd]), [
      ['2026_04_IND_WAS', '인디애나폴리스가 17점 차로 이겼어요.', 'decided_early', true, false],
      ['2026_04_ATL_NO', '애틀랜타가 3점 차로 이겼어요.', 'close_to_end', false, false],
      ['2026_05_LA_SF', null, null, false, false],
    ]);

    const recap = await readJson<GameRecapFile>(path.join(options.outDir, 'games/2026_04_ATL_NO.json'));
    assert.equal(recap.gameId, '2026_04_ATL_NO');
    assert.equal(recap.keyPlays.length, 5);
    assert.deepEqual(recap.scoreBreakdown.away, { touchdowns: 1, extraPoints: 1, twoPointConversions: 0, fieldGoals: 1, safeties: 0, other: 0 });
    assert.ok(recap.keyPlays.every((play) => 'fieldBar' in play));
    assert.match(recap.summaryKo, /가장 큰 흐름 변화는 4쿼터 30초를 남기고 나온 애틀랜타의 40야드 필드골이었어요\.$/);
    await assert.rejects(stat(path.join(options.outDir, 'games/2026_04_IND_WAS.json')));

    const standings = await readJson<StandingsFile>(path.join(options.outDir, 'seasons/2026/standings.json'));
    assert.equal(standings.gamesCounted, 2);
    assert.ok(standings.divisions.every((division) => division.teams.every((team) => 'tied' in team && 'rankChange' in team)));

    const concepts = await readJson<ConceptExamplesFile>(path.join(options.outDir, 'seasons/2026/concepts.json'));
    assert.equal(concepts.season, 2026);
    // fakeExplain tags every play with "down"; one example per game.
    assert.deepEqual(Object.keys(concepts.examples), ['down']);
    assert.deepEqual(concepts.examples.down.map((example) => [example.gameId, example.away, example.home]), [['2026_04_ATL_NO', 'ATL', 'NO']]);

    const files = [
      await readFile(path.join(options.outDir, 'index.json'), 'utf8'),
      await readFile(path.join(options.outDir, 'seasons/2026/games.json'), 'utf8'),
      await readFile(path.join(options.outDir, 'seasons/2026/standings.json'), 'utf8'),
      await readFile(path.join(options.outDir, 'games/2026_04_ATL_NO.json'), 'utf8'),
      await readFile(path.join(options.outDir, 'seasons/2026/concepts.json'), 'utf8'),
    ];
    const everything = files.join('\n');
    for (const secret of ['J.Doe', 'TOUCHDOWN', 'Passer', 'deep left', 'moneyline', 'spread', 'home_wp', '0.555']) {
      assert.ok(!everything.includes(secret), secret);
    }
    for (const text of files) assert.equal(findForbiddenContent(JSON.parse(text)), null);

    assert.equal(result.seasons[0].recapsWritten, 1);
    assert.equal(result.warnings.length, 0);
    assert.match(
      formatSummary(result, options),
      /2026: games 3, finals 2, recaps written 1, kept 0, skipped 0, awaiting play data 1, has_recap 1, closeness provisional 1, concept terms 1/,
    );

    // Second run with identical source data keeps updated_at; --skip-recaps keeps the valid recap.
    const secondRun = new Date('2026-10-07T09:00:00.000Z');
    await runCollector({ ...options, skipRecaps: true }, { now: () => secondRun, fetchImpl: impl, log: () => {} });
    const again = await readJson<SeasonGamesFile>(path.join(options.outDir, 'seasons/2026/games.json'));
    assert.equal(again.generatedAt, secondRun.toISOString());
    for (const game of again.games) {
      assert.equal(game.updated_at, firstRun.toISOString(), game.id);
      assert.equal(game.source_checked_at, secondRun.toISOString());
    }
    const kept = again.games.find((game) => game.id === '2026_04_ATL_NO');
    assert.equal(kept?.has_recap, true);
    // Without reading play-by-play the measured closeness from the first run is kept.
    assert.deepEqual([kept?.closeness, kept?.closeness_provisional], ['close_to_end', false]);
    const keptConcepts = await readJson<ConceptExamplesFile>(path.join(options.outDir, 'seasons/2026/concepts.json'));
    assert.deepEqual(keptConcepts.examples, concepts.examples);
  }));

test('계약 개정 전 형식(승리 확률 포함)의 요약 파일은 다시 쓰지 않으면 지우고 has_recap을 끈다', () =>
  withDirs(async (options) => {
    const { impl } = fakeFetch();
    await runCollector(options, { now: () => new Date('2026-10-07T08:00:00.000Z'), fetchImpl: impl, explain: fakeExplain, log: () => {} });
    const file = path.join(options.outDir, 'games/2026_04_ATL_NO.json');
    const recap = await readJson<GameRecapFile>(file);
    const old = { ...recap, winProbability: [[0, 0.55]], keyPlays: recap.keyPlays.map((play) => ({ ...play, homeWinProbAfter: 0.4 })) };
    await writeFile(file, JSON.stringify(old));

    const result = await runCollector(
      { ...options, skipRecaps: true },
      { now: () => new Date('2026-10-07T09:00:00.000Z'), fetchImpl: impl, log: () => {} },
    );
    await assert.rejects(stat(file));
    assert.ok(result.warnings.some((warning) => warning.includes('2026_04_ATL_NO') && warning.includes('removed')));
    const games = await readJson<SeasonGamesFile>(path.join(options.outDir, 'seasons/2026/games.json'));
    assert.equal(games.games.find((game) => game.id === '2026_04_ATL_NO')?.has_recap, false);
    const concepts = await readJson<ConceptExamplesFile>(path.join(options.outDir, 'seasons/2026/concepts.json'));
    assert.deepEqual(concepts.examples, {});
  }));

test('일정이 아직 없는 시즌은 건너뛰고 경고한다', () =>
  withDirs(async (options) => {
    const { impl } = fakeFetch();
    const result = await runCollector(
      { ...options, season: null, skipRecaps: true },
      { now: () => new Date('2027-05-01T12:00:00.000Z'), fetchImpl: impl, log: () => {} },
    );
    assert.deepEqual(result.index.seasons.map((season) => season.season), [2026]);
    assert.equal(result.index.latestSeason, 2026);
    assert.ok(result.warnings.some((warning) => warning.includes('season 2027')));
  }));

test('공개 범위에서 빠진 시즌의 폴더와 요약 파일, has_recap이 꺼진 요약 파일을 지운다', () =>
  withDirs(async (options) => {
    // A 2027 opener in the source: from March through August both seasons are published, from September only 2027.
    const { impl } = fakeFetch(
      `${SCHEDULE_CSV}\n2027_01_NE_SEA,2027,REG,1,2027-09-09,Thursday,20:20,NE,NA,SEA,NA,Home,NA,NA,NA,Passer Nine,Passer Ten,Lumen Field`,
    );
    const offseason = { ...options, season: null };
    const first = await runCollector(offseason, { now: () => new Date('2027-05-01T12:00:00.000Z'), fetchImpl: impl, explain: fakeExplain, log: () => {} });
    assert.deepEqual(first.index.seasons.map((season) => season.season), [2027, 2026]);
    assert.deepEqual(first.removed, []);
    assert.deepEqual(await readdir(path.join(options.outDir, 'games')), ['2026_04_ATL_NO.json']);
    // Not collector-shaped: left alone.
    await writeFile(path.join(options.outDir, 'games', 'notes.txt'), 'keep');
    await mkdir(path.join(options.outDir, 'seasons', 'drafts'), { recursive: true });

    const logs: string[] = [];
    const second = await runCollector(
      { ...offseason, skipRecaps: true },
      { now: () => new Date('2027-09-01T12:00:00.000Z'), fetchImpl: impl, log: (message) => logs.push(message) },
    );
    assert.deepEqual(second.index.seasons.map((season) => season.season), [2027]);
    assert.deepEqual(second.removed, ['games/2026_04_ATL_NO.json', 'seasons/2026/']);
    assert.ok(logs.some((message) => message.includes('removed 2 output path(s)')));
    assert.match(formatSummary(second, offseason), /removed unreferenced outputs 2/);
    assert.deepEqual((await readdir(path.join(options.outDir, 'games'))).sort(), ['notes.txt']);
    assert.deepEqual((await readdir(path.join(options.outDir, 'seasons'))).sort(), ['2027', 'drafts']);

    // In a published season, a recap file for a game without has_recap goes too. The validity check
    // above only looks at finals, so a file for a scheduled game is caught here.
    await runCollector(options, { now: () => new Date('2026-10-07T08:00:00.000Z'), fetchImpl: impl, explain: fakeExplain, log: () => {} });
    const games = path.join(options.outDir, 'seasons/2026/games.json');
    const orphan = path.join(options.outDir, 'games/2026_05_LA_SF.json');
    await writeFile(orphan, await readFile(path.join(options.outDir, 'games/2026_04_ATL_NO.json')));
    const third = await runCollector({ ...options, skipRecaps: true }, { now: () => new Date('2026-10-07T09:00:00.000Z'), fetchImpl: impl, log: () => {} });
    assert.deepEqual(third.removed, ['games/2026_05_LA_SF.json']);
    await assert.rejects(stat(orphan));
    const rows = (await readJson<SeasonGamesFile>(games)).games;
    assert.equal(rows.find((game) => game.id === '2026_04_ATL_NO')?.has_recap, true);
    await stat(path.join(options.outDir, 'games/2026_04_ATL_NO.json'));
  }));
