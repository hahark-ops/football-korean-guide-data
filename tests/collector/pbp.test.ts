import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAY_ROW_COLUMNS, groupPlaysByGame, parsePlayRows } from '../../collector/pbp.ts';
import { makePlay } from './fixtures.ts';

/** A CSV that carries every PlayRow column plus the columns that must never leak. */
function buildCsv(rows: Array<Record<string, string>>): string {
  const leakColumns = ['desc', 'passer_player_name', 'receiver_player_name', 'td_player_name', 'passer_player_id', 'weather'];
  const header = [...leakColumns.slice(0, 2), ...PLAY_ROW_COLUMNS, ...leakColumns.slice(2)];
  const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [header.join(','), ...rows.map((row) => header.map((column) => quote(row[column] ?? 'NA')).join(','))].join('\n');
}

const SECRET_DESC = '(12:00) (Shotgun) J.Doe pass short right to R.Roe for 12 yards, TOUCHDOWN.';
const SECRET_NAMES = ['J.Doe', 'R.Roe', '00-0099999', 'Sunny, 70°F'];

function sourceRow(overrides: Record<string, string> = {}): Record<string, string> {
  const base = makePlay();
  const row: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    row[key] = typeof value === 'boolean' ? (value ? '1' : '0') : value === null ? 'NA' : String(value);
  }
  return {
    ...row,
    desc: SECRET_DESC,
    passer_player_name: 'J.Doe',
    receiver_player_name: 'R.Roe',
    td_player_name: 'R.Roe',
    passer_player_id: '00-0099999',
    weather: 'Sunny, 70°F',
    ...overrides,
  };
}

test('PlayRow 열 목록에는 desc, 선수 이름, 선수 ID 열이 없다', () => {
  for (const column of PLAY_ROW_COLUMNS) {
    assert.notEqual(column, 'desc');
    assert.ok(!/player|_name$|_id$/.test(column) || column === 'play_id' || column === 'game_id', column);
  }
});

test('desc와 선수 이름 열을 읽어 오지 않는다 (유출 방지)', () => {
  const csv = buildCsv([
    sourceRow({ play_id: '20', touchdown: '1', td_team: 'ATL', total_away_score: '6', yards_gained: '12' }),
    sourceRow({ play_id: '30', play_type: 'extra_point', extra_point_result: 'good', total_away_score: '7' }),
  ]);
  const rows = parsePlayRows(csv);
  assert.equal(rows.length, 2);
  const expectedKeys = [...PLAY_ROW_COLUMNS].sort();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedKeys);
    assert.ok(!('desc' in row));
  }
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(SECRET_DESC));
  for (const secret of SECRET_NAMES) assert.ok(!serialized.includes(secret), secret);
});

test('숫자, 0/1 플래그, NA를 PlayRow 타입대로 바꾼다', () => {
  const csv = buildCsv([
    sourceRow({
      play_id: '85',
      qtr: '2',
      time: '14:22',
      game_seconds_remaining: '2662',
      home_wp: '0.560371309518814',
      home_wp_post: 'NA',
      down: 'NA',
      timeout: 'NA',
      goal_to_go: '1',
      touchdown: '1',
      posteam: 'NA',
    }),
  ]);
  const [row] = parsePlayRows(csv);
  assert.equal(row.play_id, 85);
  assert.equal(row.qtr, 2);
  assert.equal(row.time, '14:22');
  assert.equal(row.game_seconds_remaining, 2662);
  assert.equal(row.home_wp, 0.560371309518814);
  assert.equal(row.home_wp_post, null);
  assert.equal(row.down, null);
  assert.equal(row.timeout, false);
  assert.equal(row.goal_to_go, true);
  assert.equal(row.touchdown, true);
  assert.equal(row.posteam, null);
});

test('필수 값이 없는 행은 버리고 게임별로 원래 순서를 지킨다', () => {
  const csv = buildCsv([
    sourceRow({ play_id: '4920', game_id: 'G1' }),
    sourceRow({ play_id: '4908', game_id: 'G1' }),
    sourceRow({ play_id: 'NA', game_id: 'G1' }),
    sourceRow({ play_id: '1', game_id: 'G2' }),
    sourceRow({ play_id: '2', game_id: 'G3' }),
  ]);
  const rows = parsePlayRows(csv, (id) => id !== 'G3');
  const byGame = groupPlaysByGame(rows);
  assert.deepEqual([...byGame.keys()], ['G1', 'G2']);
  assert.deepEqual(byGame.get('G1')?.map((row) => row.play_id), [4920, 4908]);
});
