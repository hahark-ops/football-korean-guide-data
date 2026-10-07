import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findForbiddenContent, forbiddenKeyReason } from '../../collector/forbidden.ts';
import { runCollector } from '../../collector/run.ts';
import { SCHEDULE_URL, playByPlayUrl } from '../../collector/sources.ts';
import type { PlayRow } from '../../collector/types.ts';
import { Report, checkForbidden, checkLeaks, easternToUtcIso, isForbiddenKey, parseCsv, verify } from '../../collector/verify.ts';
import { leagueScheduleCsv, playByPlayCsvGz, smallGamePlays } from './fixtures.ts';

test('미국 동부 시각을 서머타임 규칙대로 UTC로 바꾼다', () => {
  assert.equal(easternToUtcIso('2026-10-05', '20:15'), '2026-10-06T00:15:00.000Z');
  assert.equal(easternToUtcIso('2026-10-04', '09:30'), '2026-10-04T13:30:00.000Z');
  // 2026: DST ends Sunday 1 November, starts Sunday 8 March.
  assert.equal(easternToUtcIso('2026-10-31', '13:00'), '2026-10-31T17:00:00.000Z');
  assert.equal(easternToUtcIso('2026-11-01', '13:00'), '2026-11-01T18:00:00.000Z');
  assert.equal(easternToUtcIso('2026-03-08', '01:00'), '2026-03-08T06:00:00.000Z');
  assert.equal(easternToUtcIso('2026-03-08', '13:00'), '2026-03-08T17:00:00.000Z');
  // Before 2007: first Sunday of April to last Sunday of October.
  assert.equal(easternToUtcIso('2006-10-29', '13:00'), '2006-10-29T18:00:00.000Z');
  assert.equal(easternToUtcIso('2006-10-22', '13:00'), '2006-10-22T17:00:00.000Z');
});

test('서머타임 규칙 계산이 1999~2030년 매일 오후 1시에 시간대 데이터베이스와 같다', () => {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  for (let day = Date.UTC(1999, 0, 1); day < Date.UTC(2031, 0, 1); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const utc = easternToUtcIso(date, '13:00');
    const parts = Object.fromEntries(format.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    assert.equal(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, `${date} 13:00`, date);
  }
});

test('원본 CSV를 따옴표, CRLF, NA까지 직접 읽고 원하는 열만 남긴다', () => {
  const table = parseCsv('a,desc,b\r\n1,"x, ""y""",NA\r\n2,,z\r\n', (column) => column !== 'b');
  assert.deepEqual(table.header, ['a', 'desc']);
  assert.deepEqual(table.rows, [['1', 'x, "y"'], ['2', null]]);
  assert.equal(table.column('desc'), 1);
  assert.throws(() => table.column('b'));
});

test('선수 이름과 desc 문구를 찾아내고 허용된 표기는 통과시킨다', () => {
  const sources = {
    names: new Set(['J.Goff', 'Dan Campbell']),
    descTrigrams: new Set(['pass short right']),
    descFragments: new Set(['J.Goff pass short right to A.St. Brown']),
  };
  const clean = new Report();
  const good = { titleKo: 'LA 램스, 4번째 공격 성공', situationKo: '3rd & 4 · 상대 진영 38야드', nameKo: 'AFC 동부', termSlugs: ['two-point-conversion'] };
  checkLeaks(clean, [{ relative: 'good.json', text: JSON.stringify(good), json: good }], sources);
  assert.equal(clean.failed, false, clean.format());

  const leaky = new Report();
  const bad = { summaryKo: '디트로이트가 이겼어요 J.Goff', venue: 'pass short right side', titleKo: '디트로이트, 4th down 성공' };
  checkLeaks(leaky, [{ relative: 'bad.json', text: JSON.stringify(bad), json: bad }], sources);
  assert.deepEqual(leaky.failedChecks.sort(), [
    'language: Korean fields have Hangul and no other Latin text',
    'leaks: no English play-text patterns',
    'leaks: no desc word sequences (3 words)',
    'leaks: no player, coach or referee names',
  ]);
});

test('승리 확률·배당 관련 키와 확률 문구를 키 표기와 상관없이 찾아낸다', () => {
  const forbiddenKeys = [
    'wp', 'wpa', 'home_wp', 'home_wp_post', 'away_wp_post', 'vegas_wp', 'vegas_home_wpa', 'winProbability', 'homeWinProbAfter',
    'homeWinProbDelta', 'win-probability', 'spread_line', 'away_spread_odds', 'under_odds', 'away_moneyline', 'total_line', 'totalLine',
  ];
  const allowedKeys = ['winPct', 'wins', 'pointDiff', 'kickoff_tbd', 'closeness', 'scoreBreakdown', 'fieldBar', 'yardline100', 'downs', 'total'];
  for (const key of forbiddenKeys) {
    assert.equal(isForbiddenKey(key), true, key);
    assert.notEqual(forbiddenKeyReason(key), null, key);
  }
  for (const key of allowedKeys) {
    assert.equal(isForbiddenKey(key), false, key);
    assert.equal(forbiddenKeyReason(key), null, key);
  }

  const report = new Report();
  const bad = { summaryKo: '가장 큰 흐름 변화는 필드골로, 애틀랜타의 승리 확률이 15%p 올라갔어요.', nested: [{ homeWinProbAfter: 0.4 }] };
  const good = { methodNoteKo: '승률 순으로 정렬했어요.', winPct: 0.75, explanationKo: '4번째 공격에서 2야드를 달려 전진했어요.' };
  checkForbidden(report, [
    { relative: 'bad.json', text: JSON.stringify(bad), json: bad },
    { relative: 'good.json', text: JSON.stringify(good), json: good },
  ]);
  assert.deepEqual(report.failedChecks.sort(), [
    'forbidden: no probability, percentage or odds wording',
    'forbidden: no win-probability or betting keys',
  ]);
  assert.equal(report.checks.get('forbidden: no probability, percentage or odds wording')?.failures.length, 1);

  // The collector's own guard refuses the same content before writing.
  assert.match(findForbiddenContent(bad) ?? '', /probability wording/);
  assert.match(findForbiddenContent({ a: [{ spread_line: -3 }] }) ?? '', /\$\.a\[0\]\.spread_line: betting key/);
  assert.equal(findForbiddenContent(good), null);
});

/** smallGamePlays re-labelled as another game with another home team. */
function playsFor(gameId: string, home: string): PlayRow[] {
  const swap = (team: string | null) => (team === 'NO' ? home : team);
  return smallGamePlays().map((play) => ({
    ...play,
    game_id: gameId,
    home_team: home,
    posteam: swap(play.posteam),
    defteam: swap(play.defteam),
    td_team: swap(play.td_team),
  }));
}

/**
 * smallGamePlays with the 10-7 field goal moved to the last 30 seconds of the
 * 3rd quarter: the only change of lead is in the 3rd, so the game is close_once
 * (the 4th quarter is close but nobody takes or loses the lead in it).
 */
function thirdQuarterDecided(plays: PlayRow[]): PlayRow[] {
  return plays.map((play) => (play.play_id === 90 ? { ...play, qtr: 3, game_seconds_remaining: 930 } : play));
}

async function withLeague(run: (dirs: { outDir: string; cacheDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'collector-verify-'));
  const dirs = { outDir: path.join(root, 'out'), cacheDir: path.join(root, 'cache') };
  const pbp = playByPlayCsvGz([...thirdQuarterDecided(playsFor('2026_03_ATL_TB', 'TB')), ...smallGamePlays()]);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === SCHEDULE_URL) return new Response(leagueScheduleCsv());
    if (url === playByPlayUrl(2026)) return new Response(pbp);
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  try {
    // The real Korean explainer, so tags and texts are the shipped ones.
    await runCollector(
      { season: 2026, outDir: dirs.outDir, cacheDir: dirs.cacheDir, offline: false, maxAgeMinutes: 0, skipRecaps: false },
      { now: () => new Date('2026-10-07T08:00:00.000Z'), fetchImpl, log: () => {} },
    );
    await run(dirs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Output JSON is edited freely in the tamper cases below.
type Json = any;

test('수집기 출력은 독립 검증을 통과하고, 고친 출력은 해당 검사에서 실패한다', () =>
  withLeague(async ({ outDir, cacheDir }) => {
    const clean = await verify({ outDir, cacheDir });
    assert.equal(clean.failed, false, clean.format());
    for (const name of [
      '2026 games: closeness recomputed from raw play-by-play',
      '2026 games: closeness is the provisional margin estimate without play-by-play',
      '2026 games: kickoff_tbd only under the documented placeholder pattern',
      '2026 standings: rankChange vs standings before the latest completed week',
      'recaps: scoreBreakdown counts equal raw scoring flags',
      'recaps: fieldBar equals raw spot, gain and line to gain under the null rules',
      '2026 concepts: newest first',
      'forbidden: no win-probability or betting keys',
    ]) {
      assert.ok((clean.checks.get(name)?.checked ?? 0) > 0, `${name} ran`);
    }

    const games = await readFile(path.join(outDir, 'seasons/2026/games.json'), 'utf8');
    const gameRows = (JSON.parse(games) as Json).games as Json[];
    const tbdCount = gameRows.filter((game: Json) => game.kickoff_tbd).length;
    assert.equal(tbdCount, 16);
    const closenessOf = (id: string) => {
      const game = gameRows.find((item: Json) => item.id === id);
      return [game.closeness, game.closeness_provisional];
    };
    // ATL-NO: 7-7 into the 4th, 10-7 on a late field goal (tie -> lead in the 4th).
    assert.deepEqual(closenessOf('2026_04_ATL_NO'), ['close_to_end', false]);
    // ATL-TB: the same 10-7 final, but the lead was taken in the 3rd and kept.
    assert.deepEqual(closenessOf('2026_03_ATL_TB'), ['close_once', false]);
    // Without play-by-play, a final within one score is only close_once.
    const provisionalClose = gameRows.filter((game: Json) =>
      game.status === 'final' && game.closeness_provisional && !game.overtime && Math.abs(game.home_score - game.away_score) <= 8);
    assert.ok(provisionalClose.length > 0);
    assert.ok(provisionalClose.every((game: Json) => game.closeness === 'close_once'));

    /** Applies one edit to an output file, verifies, restores, and returns the failed checks. */
    const tamper = async (relative: string, edit: (json: Json) => void): Promise<string[]> => {
      const file = path.join(outDir, relative);
      const original = await readFile(file, 'utf8');
      const json = JSON.parse(original);
      edit(json);
      await writeFile(file, JSON.stringify(json));
      try {
        return (await verify({ outDir, cacheDir })).failedChecks;
      } finally {
        await writeFile(file, original);
      }
    };
    const recap = 'games/2026_04_ATL_NO.json';
    const row = (json: Json, id: string) => json.games.find((game: Json) => game.id === id);

    assert.ok((await tamper(recap, (json) => { json.keyPlays[0].homeWinProbAfter = 0.4; }))
      .includes('forbidden: no win-probability or betting keys'));
    assert.ok((await tamper(recap, (json) => { json.summaryKo += ' 애틀랜타의 승리 확률이 60%p 올라갔어요.'; }))
      .includes('forbidden: no probability, percentage or odds wording'));
    assert.ok((await tamper('seasons/2026/games.json', (json) => { json.games[0].spread_line = -3.5; }))
      .includes('forbidden: no win-probability or betting keys'));

    // Same total, wrong mix: the equation holds but the counts do not match the raw flags.
    const mix = await tamper(recap, (json) => { json.scoreBreakdown.away.fieldGoals = 0; json.scoreBreakdown.away.other = 3; });
    assert.ok(mix.includes('recaps: scoreBreakdown counts equal raw scoring flags'));
    assert.ok(!mix.includes('recaps: scoreBreakdown equation equals the raw final score'));
    assert.ok((await tamper(recap, (json) => { json.scoreBreakdown.home.other = 1; }))
      .includes('recaps: scoreBreakdown equation equals the raw final score'));

    // Key play 20 is the 75-yard touchdown pass: start 75, end 0.
    assert.ok((await tamper(recap, (json) => { json.keyPlays[0].fieldBar.end = 1; }))
      .includes('recaps: fieldBar equals raw spot, gain and line to gain under the null rules'));
    assert.ok((await tamper(recap, (json) => { json.keyPlays[0].fieldBar.start = 150; }))
      .includes('recaps: fieldBar ranges (0-100, end and firstDownLine nullable)'));
    // The field goal (play 90) is on 4th down but is a kick.
    assert.ok((await tamper(recap, (json) => { json.keyPlays.at(-1).tags.push('fourth_down'); }))
      .includes('recaps: fourth_down and red_zone tags only on offensive snaps'));

    assert.ok((await tamper('seasons/2026/games.json', (json) => { row(json, '2026_04_ATL_NO').closeness = 'decided_early'; }))
      .includes('2026 games: closeness recomputed from raw play-by-play'));
    // What the earlier "within one score in the last five minutes" rule gave for ATL-TB.
    assert.ok((await tamper('seasons/2026/games.json', (json) => { row(json, '2026_03_ATL_TB').closeness = 'close_to_end'; }))
      .includes('2026 games: closeness recomputed from raw play-by-play'));
    // The earlier provisional estimate called every one-score final close_to_end.
    assert.ok((await tamper('seasons/2026/games.json', (json) => {
      const game = json.games.find((item: Json) =>
        item.status === 'final' && item.closeness_provisional && !item.overtime && Math.abs(item.home_score - item.away_score) <= 8);
      game.closeness = 'close_to_end';
    })).includes('2026 games: closeness is the provisional margin estimate without play-by-play'));
    assert.ok((await tamper('seasons/2026/games.json', (json) => {
      const game = json.games.find((item: Json) => item.status === 'final' && item.closeness_provisional);
      game.closeness_provisional = false;
    })).includes('2026 games: closeness is the provisional margin estimate without play-by-play'));
    assert.ok((await tamper('seasons/2026/games.json', (json) => {
      json.games.find((item: Json) => item.status === 'scheduled').result_line_ko = '경기 전이에요.';
    })).includes('2026 games: result_line_ko present iff final'));
    assert.ok((await tamper('seasons/2026/games.json', (json) => {
      row(json, '2026_04_ATL_NO').result_line_ko = '애틀랜타가 4점 차로 이겼어요.';
    })).includes('2026 games: result_line_ko states the raw margin, overtime and nothing else numeric'));
    assert.ok((await tamper('seasons/2026/games.json', (json) => { json.games[0].kickoff_tbd = true; }))
      .includes('2026 games: kickoff_tbd only under the documented placeholder pattern'));

    const standingsFailures = await tamper('seasons/2026/standings.json', (json) => {
      const team = json.divisions[0].teams[0];
      team.tied = !team.tied;
      team.rankChange = (team.rankChange ?? 0) + 5;
    });
    assert.ok(standingsFailures.includes('2026 standings: shared rank by win pct only (1, 2, 2, 4) and tied flag'));
    assert.ok(standingsFailures.includes('2026 standings: rankChange vs standings before the latest completed week'));

    const concepts = 'seasons/2026/concepts.json';
    const firstSlug = (json: Json) => Object.keys(json.examples)[0];
    assert.ok((await tamper(concepts, (json) => { json.examples[firstSlug(json)].reverse(); }))
      .includes('2026 concepts: newest first'));
    assert.ok((await tamper(concepts, (json) => {
      const list = json.examples[firstSlug(json)];
      list.push(list[0], list[0], list[0]);
    })).includes('2026 concepts: 1 to 3 examples per term'));
    assert.ok((await tamper(concepts, (json) => { json.examples['not-a-term'] = json.examples[firstSlug(json)]; }))
      .includes('2026 concepts: keys are glossary slugs'));
    assert.ok((await tamper(concepts, (json) => { json.examples[firstSlug(json)][0].play.titleKo = '다른 장면이에요'; }))
      .includes('2026 concepts: example play equals the published recap play and uses the term'));
    assert.ok((await tamper(concepts, (json) => { delete json.examples[firstSlug(json)]; }))
      .includes('2026 concepts: every term used by a published play has examples'));
  }));

test('색인에 없는 시즌 폴더와 has_recap이 없는 요약 파일은 검증에서 실패한다', () =>
  withLeague(async ({ outDir, cacheDir }) => {
    assert.equal((await verify({ outDir, cacheDir })).failed, false);
    await mkdir(path.join(outDir, 'seasons/2025'), { recursive: true });
    await copyFile(path.join(outDir, 'seasons/2026/games.json'), path.join(outDir, 'seasons/2025/games.json'));
    await copyFile(path.join(outDir, 'games/2026_04_ATL_NO.json'), path.join(outDir, 'games/2025_01_ATL_NO.json'));
    const failed = (await verify({ outDir, cacheDir })).failedChecks;
    assert.ok(failed.includes('files: every season folder is listed in index.json'), failed.join('; '));
    assert.ok(failed.includes('files: every recap file is referenced by has_recap'), failed.join('; '));
  }));
