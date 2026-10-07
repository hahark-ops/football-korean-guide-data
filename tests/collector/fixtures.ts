import { gzipSync } from 'node:zlib';
import type { PublicGameRow } from '../../src/data/publicData.ts';
import { PLAY_ROW_COLUMNS } from '../../collector/pbp.ts';
import { DIVISIONS } from '../../collector/teams.ts';
import type { PlayContext, PlayExplanation, PlayRow } from '../../collector/types.ts';

export function makePlay(overrides: Partial<PlayRow> = {}): PlayRow {
  return {
    play_id: 1,
    game_id: '2026_04_ATL_NO',
    home_team: 'NO',
    away_team: 'ATL',
    posteam: 'ATL',
    defteam: 'NO',
    yardline_100: 75,
    qtr: 1,
    time: '15:00',
    game_seconds_remaining: 3600,
    down: 1,
    goal_to_go: false,
    ydstogo: 10,
    play_type: 'pass',
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
    pass: true,
    rush: false,
    qb_kneel: false,
    qb_spike: false,
    aborted_play: false,
    ...overrides,
  };
}

export function makeGame(overrides: Partial<PublicGameRow> = {}): PublicGameRow {
  return {
    id: '2026_04_ATL_NO',
    season: 2026,
    week: 4,
    season_type: 'REG',
    kickoff_at: '2026-10-04T17:00:00.000Z',
    away_team_abbr: 'ATL',
    away_team_name_ko: '애틀랜타 팰컨스',
    home_team_abbr: 'NO',
    home_team_name_ko: '뉴올리언스 세인츠',
    away_score: 10,
    home_score: 7,
    status: 'final',
    venue: 'Caesars Superdome',
    headline_ko: null,
    is_published: true,
    source_updated_at: null,
    source_checked_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    postseason_round: null,
    overtime: false,
    neutral_site: false,
    has_recap: false,
    kickoff_tbd: false,
    result_line_ko: null,
    closeness: null,
    closeness_provisional: false,
    ...overrides,
  };
}

/** Deterministic stand-in for collector/explain.ts. */
export function fakeExplain(play: PlayRow, context: PlayContext): PlayExplanation {
  const kind = play.play_type === 'pass' ? 'pass' : play.play_type === 'run' ? 'run' : play.play_type === 'field_goal' ? 'field_goal' : 'other';
  return {
    kind,
    tags: play.touchdown ? ['touchdown', 'scoring'] : [],
    situationKo: null,
    titleKo: `${context.teamShortKo(play.posteam ?? context.homeTeam)} 플레이`,
    explanationKo: '테스트 설명이에요.',
    termSlugs: ['down', 'down'],
  };
}

/**
 * A small, consistent game: ATL 10 - NO 7.
 * Q1 ATL 75-yard TD pass + XP (7-0), Q2 NO 5-yard TD run + XP (7-7), Q3 a
 * completed pass for no gain, Q4 ATL 40-yard FG with 30 seconds left (10-7).
 */
export function smallGamePlays(): PlayRow[] {
  const rows: Array<Partial<PlayRow>> = [
    { play_id: 1, play_type: null, pass: false, down: null, home_wp: 0.55, home_wp_post: null, posteam: null, defteam: null },
    { play_id: 10, play_type: 'kickoff', down: null, ydstogo: null, yardline_100: 35, pass: false, home_wp: 0.55, home_wp_post: 0.555, posteam: 'ATL', touchback: true },
    { play_id: 20, time: '12:00', game_seconds_remaining: 3420, play_type: 'pass', yards_gained: 75, home_wp: 0.555, home_wp_post: 0.4, touchdown: true, pass_touchdown: true, td_team: 'ATL', total_away_score: 6 },
    { play_id: 30, time: '11:55', game_seconds_remaining: 3415, play_type: 'extra_point', down: null, ydstogo: null, yardline_100: 15, pass: false, extra_point_result: 'good', kick_distance: 33, home_wp: 0.4, home_wp_post: 0.385, total_away_score: 7 },
    { play_id: 40, time: '00:00', game_seconds_remaining: 2700, play_type: null, pass: false, down: null, posteam: null, defteam: null, home_wp: 0.385, home_wp_post: 0.385, total_away_score: 7 },
    { play_id: 50, qtr: 2, time: '05:00', game_seconds_remaining: 2100, play_type: 'run', pass: false, rush: true, posteam: 'NO', defteam: 'ATL', yardline_100: 5, goal_to_go: true, ydstogo: 5, yards_gained: 5, home_wp: 0.385, home_wp_post: 0.6, touchdown: true, rush_touchdown: true, td_team: 'NO', total_away_score: 7, total_home_score: 6 },
    { play_id: 60, qtr: 2, time: '04:56', game_seconds_remaining: 2096, play_type: 'extra_point', down: null, ydstogo: null, yardline_100: 15, pass: false, extra_point_result: 'good', kick_distance: 33, posteam: 'NO', defteam: 'ATL', home_wp: 0.6, home_wp_post: 0.62, total_away_score: 7, total_home_score: 7 },
    { play_id: 70, qtr: 2, time: '01:00', game_seconds_remaining: 1860, play_type: 'no_play', pass: false, down: null, timeout: true, posteam: null, defteam: null, home_wp: 0.62, home_wp_post: null, total_away_score: 7, total_home_score: 7 },
    { play_id: 80, qtr: 3, time: '10:00', game_seconds_remaining: 1500, play_type: 'pass', home_wp: 0.62, home_wp_post: 0.58, total_away_score: 7, total_home_score: 7 },
    { play_id: 90, qtr: 4, time: '00:30', game_seconds_remaining: 30, play_type: 'field_goal', pass: false, down: 4, ydstogo: 5, yardline_100: 22, field_goal_result: 'made', kick_distance: 40, home_wp: 0.7, home_wp_post: 0.1, total_away_score: 10, total_home_score: 7 },
    { play_id: 100, qtr: 4, time: '00:20', game_seconds_remaining: 20, play_type: 'qb_kneel', pass: false, qb_kneel: true, yards_gained: -1, home_wp: 0.1, home_wp_post: 0.0, total_away_score: 10, total_home_score: 7 },
    { play_id: 110, qtr: 4, time: '00:00', game_seconds_remaining: 0, play_type: null, pass: false, down: null, posteam: null, defteam: null, home_wp: 0, home_wp_post: null, total_away_score: 10, total_home_score: 7 },
  ];
  return rows.map((row) => makePlay(row));
}

/** nflverse-style play-by-play CSV (gzip) with every PlayRow column plus text that must never leak. */
export function playByPlayCsvGz(plays: readonly PlayRow[]): Buffer {
  const header = ['desc', ...PLAY_ROW_COLUMNS, 'passer_player_name'];
  const lines = plays.map((play) => {
    const values: Record<string, unknown> = { ...play, desc: 'J.Doe pass deep left, TOUCHDOWN', passer_player_name: 'J.Doe' };
    return header
      .map((column) => {
        const value = values[column];
        if (value === null || value === undefined) return 'NA';
        if (typeof value === 'boolean') return value ? '1' : '0';
        const text = String(value);
        return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      })
      .join(',');
  });
  return gzipSync([header.join(','), ...lines].join('\n'));
}

const LEAGUE_HEADER =
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,' +
  'away_moneyline,home_moneyline,spread_line,total_line,div_game,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium';

/**
 * A whole-league 2026 schedule in nflverse games.csv shape:
 * weeks 1-3 final for all 32 teams, week 4 with only ATL at NO final, and
 * week 18 listed at one placeholder slot. ATL at NO (week 4) and ATL at TB
 * (week 3) end 10-7 so smallGamePlays can serve as their play-by-play.
 */
export function leagueScheduleCsv(): string {
  const teams: string[] = DIVISIONS.flatMap((division) => division.teams).map((code) => (code === 'LAR' ? 'LA' : code));
  const division = (abbr: string) => Math.floor(teams.indexOf(abbr) / 4);
  const pairs: Record<number, Array<[number, number]>> = { 1: [], 2: [], 3: [], 4: [], 18: [] };
  for (let block = 0; block < 32; block += 4) {
    pairs[1].push([block, block + 1], [block + 2, block + 3]);
    pairs[3].push([block, block + 3], [block + 1, block + 2]);
    pairs[4].push([block, block + 2], [block + 1, block + 3]);
    pairs[18].push([block + 1, block], [block + 3, block + 2]);
  }
  for (let i = 0; i < 16; i += 1) pairs[2].push([i, i + 16]);
  const days: Record<number, string> = { 1: '2026-09-13', 2: '2026-09-20', 3: '2026-09-27', 4: '2026-10-04', 18: '2027-01-10' };

  const rows = [LEAGUE_HEADER];
  let n = 0;
  for (const week of [1, 2, 3, 4, 18]) {
    for (const [a, h] of pairs[week]) {
      n += 1;
      const away = teams[a];
      const home = teams[h];
      const id = `2026_${String(week).padStart(2, '0')}_${away}_${home}`;
      let scores: [string, string] = ['NA', 'NA'];
      if (week <= 3) scores = [String(10 + ((n * 7) % 21)), String(13 + ((n * 5) % 17))];
      if (id === '2026_04_ATL_NO' || id === '2026_03_ATL_TB') scores = ['10', '7'];
      const time = week === 18 ? '13:00' : n % 3 === 0 ? '16:25' : '13:00';
      const divGame = division(away) === division(home) ? 1 : 0;
      rows.push(
        [id, 2026, 'REG', week, days[week], 'Sunday', time, away, scores[0], home, scores[1], 'Home', 'NA', 'NA', scores[0] === 'NA' ? 'NA' : 0,
          -150, 130, 3.5, 44.5, divGame, `Passer ${n}A`, `Passer ${n}H`, `Coach ${n}A`, `Coach ${n}H`, `Referee ${n}`, `Stadium ${home}`].join(','),
      );
    }
  }
  return rows.join('\n');
}
