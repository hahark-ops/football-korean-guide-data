/**
 * Collector-internal input model: one nflverse play-by-play row, already
 * parsed from CSV. `NA` and empty cells become null. Numeric columns are
 * numbers, 0/1 flags are booleans. Only the columns the collector and the
 * Korean explainer need are kept; `desc` and player-name columns are never
 * read into this model so they cannot leak into the output.
 *
 * Column meanings follow the nflverse play-by-play data dictionary
 * (https://nflreadr.nflverse.com/articles/dictionary_pbp.html).
 */
export interface PlayRow {
  play_id: number;
  game_id: string;
  home_team: string;
  away_team: string;
  posteam: string | null;
  defteam: string | null;
  /** Distance from the offense to the opponent end zone. */
  yardline_100: number | null;
  qtr: number;
  /** "MM:SS" game clock at the snap. */
  time: string | null;
  game_seconds_remaining: number | null;
  down: number | null;
  goal_to_go: boolean;
  ydstogo: number | null;
  /** nflverse play_type: pass, run, punt, field_goal, kickoff, extra_point, qb_kneel, qb_spike, no_play, ... */
  play_type: string | null;
  yards_gained: number | null;
  field_goal_result: string | null;
  kick_distance: number | null;
  extra_point_result: string | null;
  two_point_conv_result: string | null;
  timeout: boolean;
  total_home_score: number | null;
  total_away_score: number | null;
  /**
   * Win probability columns. Used only inside the collector to choose turning
   * points; never copied into the output (see src/data/publicData.ts).
   */
  home_wp: number | null;
  home_wp_post: number | null;
  away_wp_post: number | null;
  wpa: number | null;
  first_down: boolean;
  third_down_converted: boolean;
  third_down_failed: boolean;
  fourth_down_converted: boolean;
  fourth_down_failed: boolean;
  incomplete_pass: boolean;
  interception: boolean;
  fumble_lost: boolean;
  /** Any fumble on the play, lost or not. */
  fumble: boolean;
  /**
   * A lateral after a catch or a run. yards_gained (and passing_yards) then
   * include the yards gained after the lateral, e.g. a 2-yard catch and an
   * 80-yard lateral run is 82.
   */
  lateral_reception: boolean;
  lateral_rush: boolean;
  sack: boolean;
  touchdown: boolean;
  pass_touchdown: boolean;
  rush_touchdown: boolean;
  return_touchdown: boolean;
  td_team: string | null;
  safety: boolean;
  penalty: boolean;
  penalty_team: string | null;
  penalty_type: string | null;
  penalty_yards: number | null;
  punt_blocked: boolean;
  touchback: boolean;
  return_yards: number | null;
  /** Kickoffs: the kicking team (defteam) got the ball back, e.g. an onside kick. */
  own_kickoff_recovery: boolean;
  /** Kickoffs: the kicking team recovered its own kickoff and scored a touchdown. */
  own_kickoff_recovery_td: boolean;
  pass: boolean;
  rush: boolean;
  qb_kneel: boolean;
  qb_spike: boolean;
  aborted_play: boolean;
}

/** Context the explainer may use beyond the single row. */
export interface PlayContext {
  /** Korean short team name lookup, e.g. "ATL" -> "애틀랜타". Accepts source codes such as "LA". */
  teamShortKo: (abbr: string) => string;
  /** Score before this play. */
  scoreBefore: { away: number; home: number };
  homeTeam: string;
  awayTeam: string;
  /**
   * The first snap after this play in the same half (a later row with a down,
   * before any kickoff): where the next set of downs started. Null when the
   * half or game ended first, undefined when unknown.
   */
  nextSnap?: NextSnap | null;
}

/** Team and spot of a snap, in that team's frame (nflverse yardline_100). */
export interface NextSnap {
  posteam: string;
  yardline100: number | null;
}

/** What the explainer returns for one play. */
export interface PlayExplanation {
  kind: import("../src/data/publicData.ts").PlayKind;
  tags: import("../src/data/publicData.ts").PlayTag[];
  situationKo: string | null;
  titleKo: string;
  explanationKo: string;
  termSlugs: string[];
}
