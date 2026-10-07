import type { PublicGameRow, StandingsFile, TeamStanding } from "../src/data/publicData.ts";
import { resolveTeamCode, type TeamCode } from "../src/data/teamAssets.ts";
import { DIVISIONS, divisionOf, teamNameKo, type DivisionDefinition } from "./teams.ts";

export const STANDINGS_METHOD_NOTE_KO =
  "승률 순으로 정렬했어요. 승률이 같으면 동률로 표시하고, 공식 순위 결정 방식(맞대결 등)은 반영하지 않았어요.";

type Result = "W" | "L" | "T";

interface TeamTally {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  results: Result[];
  division: { wins: number; losses: number; ties: number };
}

function emptyTally(): TeamTally {
  return {
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    results: [],
    division: { wins: 0, losses: 0, ties: 0 },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function exactWinPct(tally: Pick<TeamTally, "wins" | "losses" | "ties">): number {
  const games = tally.wins + tally.losses + tally.ties;
  return games === 0 ? 0 : (tally.wins + tally.ties / 2) / games;
}

/** "W2", "L1", "T1" from results in date order; null before the first game. */
export function streakOf(results: readonly Result[]): string | null {
  if (results.length === 0) return null;
  const last = results[results.length - 1];
  let count = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === last; i -= 1) count += 1;
  return `${last}${count}`;
}

export function formatRecord(record: { wins: number; losses: number; ties: number }): string {
  return record.ties > 0
    ? `${record.wins}-${record.losses}-${record.ties}`
    : `${record.wins}-${record.losses}`;
}

function addResult(tally: TeamTally, scored: number, allowed: number, divisionGame: boolean): void {
  const result: Result = scored > allowed ? "W" : scored < allowed ? "L" : "T";
  if (result === "W") tally.wins += 1;
  else if (result === "L") tally.losses += 1;
  else tally.ties += 1;
  tally.pointsFor += scored;
  tally.pointsAgainst += allowed;
  tally.results.push(result);
  if (divisionGame) {
    if (result === "W") tally.division.wins += 1;
    else if (result === "L") tally.division.losses += 1;
    else tally.division.ties += 1;
  }
}

export interface StandingsContext {
  generatedAt: string;
  sourceCheckedAt: string;
}

function byKickoff(a: PublicGameRow, b: PublicGameRow): number {
  return a.kickoff_at === b.kickoff_at ? a.id.localeCompare(b.id) : a.kickoff_at < b.kickoff_at ? -1 : 1;
}

/** Tallies from finals in kickoff order (streaks depend on the order). */
function tallyFinals(finals: readonly PublicGameRow[]): { tallies: Map<TeamCode, TeamTally>; counted: number } {
  const tallies = new Map<TeamCode, TeamTally>();
  const tallyOf = (code: TeamCode): TeamTally => {
    let tally = tallies.get(code);
    if (!tally) {
      tally = emptyTally();
      tallies.set(code, tally);
    }
    return tally;
  };
  let counted = 0;
  for (const game of finals) {
    const away = resolveTeamCode(game.away_team_abbr);
    const home = resolveTeamCode(game.home_team_abbr);
    if (!away || !home || game.away_score === null || game.home_score === null) continue;
    const divisionGame = divisionOf(away) === divisionOf(home);
    addResult(tallyOf(away), game.away_score, game.home_score, divisionGame);
    addResult(tallyOf(home), game.home_score, game.away_score, divisionGame);
    counted += 1;
  }
  return { tallies, counted };
}

interface RankedTeam {
  code: TeamCode;
  nameKo: string;
  tally: TeamTally;
  /** Published 3-decimal win pct; ranks compare this value so they match the table. */
  winPct: number;
  rank: number;
  tied: boolean;
}

/**
 * Division order by win pct only. Equal win pct shares a rank (competition
 * ranking: 1, 2, 2, 4), is marked tied and is listed by Korean name.
 */
function rankDivision(definition: DivisionDefinition, tallies: ReadonlyMap<TeamCode, TeamTally>): RankedTeam[] {
  const teams = definition.teams.map((code) => {
    const tally = tallies.get(code) ?? emptyTally();
    return { code, nameKo: teamNameKo(code), tally, winPct: round3(exactWinPct(tally)) };
  });
  return teams
    .map((team) => ({
      ...team,
      rank: 1 + teams.filter((other) => other.winPct > team.winPct).length,
      tied: teams.some((other) => other !== team && other.winPct === team.winPct),
    }))
    .sort((a, b) => a.rank - b.rank || a.nameKo.localeCompare(b.nameKo, "ko"));
}

/** The latest regular-season week whose games are all final, or null. */
export function latestCompletedWeek(games: readonly PublicGameRow[]): number | null {
  const weeks = new Map<number, boolean>();
  for (const game of games) {
    if (game.season_type !== "REG") continue;
    weeks.set(game.week, (weeks.get(game.week) ?? true) && game.status === "final");
  }
  const completed = [...weeks].filter(([, done]) => done).map(([week]) => week);
  return completed.length === 0 ? null : Math.max(...completed);
}

/**
 * Simplified division standings from regular-season finals. All eight
 * divisions with four teams each are always present, zeros before week 1.
 *
 * `rankChange` compares with the standings built from finals before the most
 * recent completed regular-season week W (all of W's games final), positive
 * when the team moved up. It is null while W is missing or below 2, and for a
 * team with no final in week W or later (it has not played since).
 */
export function buildStandings(
  season: number,
  games: readonly PublicGameRow[],
  context: StandingsContext,
): StandingsFile {
  const sourceAbbr = new Map<TeamCode, string>();
  for (const game of games) {
    for (const abbr of [game.away_team_abbr, game.home_team_abbr]) {
      const code = resolveTeamCode(abbr);
      if (code && !sourceAbbr.has(code)) sourceAbbr.set(code, abbr);
    }
  }

  const finals = games.filter((game) => game.season_type === "REG" && game.status === "final").slice().sort(byKickoff);
  const { tallies, counted } = tallyFinals(finals);

  const week = latestCompletedWeek(games);
  const baseline = week !== null && week >= 2 ? tallyFinals(finals.filter((game) => game.week < week)).tallies : null;
  const playedSince = new Set<TeamCode>();
  if (week !== null) {
    for (const game of finals) {
      if (game.week < week) continue;
      for (const abbr of [game.away_team_abbr, game.home_team_abbr]) {
        const code = resolveTeamCode(abbr);
        if (code) playedSince.add(code);
      }
    }
  }

  const divisions = DIVISIONS.map((definition) => {
    const before = baseline ? new Map(rankDivision(definition, baseline).map((team) => [team.code, team.rank])) : null;
    const teams: TeamStanding[] = rankDivision(definition, tallies).map(({ code, tally, nameKo, winPct, rank, tied }) => {
      const previousRank = before?.get(code);
      return {
        abbr: sourceAbbr.get(code) ?? code,
        nameKo,
        wins: tally.wins,
        losses: tally.losses,
        ties: tally.ties,
        winPct,
        pointsFor: tally.pointsFor,
        pointsAgainst: tally.pointsAgainst,
        pointDiff: tally.pointsFor - tally.pointsAgainst,
        streak: streakOf(tally.results),
        divisionRecord: formatRecord(tally.division),
        divisionRank: rank,
        tied,
        rankChange: previousRank !== undefined && playedSince.has(code) ? previousRank - rank : null,
      };
    });

    return {
      conference: definition.conference,
      division: definition.division,
      nameKo: definition.nameKo,
      teams,
    };
  });

  return {
    schemaVersion: 1,
    season,
    generatedAt: context.generatedAt,
    sourceCheckedAt: context.sourceCheckedAt,
    gamesCounted: counted,
    methodNoteKo: STANDINGS_METHOD_NOTE_KO,
    divisions,
  };
}
