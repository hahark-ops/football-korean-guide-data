import { iterateSelectedColumns } from "./csv.ts";
import type { PlayRow } from "./types.ts";

type ColumnKind = "int" | "num?" | "str" | "str?" | "bool";

/**
 * The only play-by-play columns the collector reads, with how each is parsed.
 * `desc` and every `*_player_name` / `*_player_id` column are deliberately
 * absent, so English play text and player identities never enter memory.
 */
export const PLAY_ROW_COLUMN_KINDS = {
  play_id: "int",
  game_id: "str",
  home_team: "str",
  away_team: "str",
  posteam: "str?",
  defteam: "str?",
  yardline_100: "num?",
  qtr: "int",
  time: "str?",
  game_seconds_remaining: "num?",
  down: "num?",
  goal_to_go: "bool",
  ydstogo: "num?",
  play_type: "str?",
  yards_gained: "num?",
  field_goal_result: "str?",
  kick_distance: "num?",
  extra_point_result: "str?",
  two_point_conv_result: "str?",
  timeout: "bool",
  total_home_score: "num?",
  total_away_score: "num?",
  home_wp: "num?",
  home_wp_post: "num?",
  away_wp_post: "num?",
  wpa: "num?",
  first_down: "bool",
  third_down_converted: "bool",
  third_down_failed: "bool",
  fourth_down_converted: "bool",
  fourth_down_failed: "bool",
  incomplete_pass: "bool",
  interception: "bool",
  fumble_lost: "bool",
  fumble: "bool",
  lateral_reception: "bool",
  lateral_rush: "bool",
  sack: "bool",
  touchdown: "bool",
  pass_touchdown: "bool",
  rush_touchdown: "bool",
  return_touchdown: "bool",
  td_team: "str?",
  safety: "bool",
  penalty: "bool",
  penalty_team: "str?",
  penalty_type: "str?",
  penalty_yards: "num?",
  punt_blocked: "bool",
  touchback: "bool",
  return_yards: "num?",
  own_kickoff_recovery: "bool",
  own_kickoff_recovery_td: "bool",
  pass: "bool",
  rush: "bool",
  qb_kneel: "bool",
  qb_spike: "bool",
  aborted_play: "bool",
} as const satisfies Record<keyof PlayRow, ColumnKind>;

export const PLAY_ROW_COLUMNS = Object.keys(PLAY_ROW_COLUMN_KINDS) as Array<keyof PlayRow>;

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFlag(value: string | null): boolean {
  if (value === null) return false;
  return value.toUpperCase() === "TRUE" || Number(value) === 1;
}

/** Parses play-by-play CSV text into PlayRows in source order (nflverse order_sequence). */
export function parsePlayRows(text: string, filter?: (gameId: string) => boolean): PlayRow[] {
  const rows: PlayRow[] = [];
  for (const record of iterateSelectedColumns(text, PLAY_ROW_COLUMNS)) {
    const gameId = record.game_id;
    if (gameId === null || (filter && !filter(gameId))) continue;
    const row: Record<string, unknown> = {};
    let valid = true;
    for (const column of PLAY_ROW_COLUMNS) {
      const raw = record[column];
      switch (PLAY_ROW_COLUMN_KINDS[column] as ColumnKind) {
        case "int": {
          const parsed = toNumber(raw);
          if (parsed === null || !Number.isInteger(parsed)) valid = false;
          row[column] = parsed;
          break;
        }
        case "num?":
          row[column] = toNumber(raw);
          break;
        case "str":
          if (raw === null) valid = false;
          row[column] = raw;
          break;
        case "str?":
          row[column] = raw;
          break;
        case "bool":
          row[column] = toFlag(raw);
          break;
      }
    }
    if (valid) rows.push(row as unknown as PlayRow);
  }
  return rows;
}

/** Groups rows by game, keeping source order inside each game. */
export function groupPlaysByGame(rows: readonly PlayRow[]): Map<string, PlayRow[]> {
  const byGame = new Map<string, PlayRow[]>();
  for (const row of rows) {
    const list = byGame.get(row.game_id);
    if (list) list.push(row);
    else byGame.set(row.game_id, [row]);
  }
  return byGame;
}
