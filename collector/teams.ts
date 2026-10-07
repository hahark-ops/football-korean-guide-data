import type { DivisionStanding } from "../src/data/publicData.ts";
import { TEAM_BY_CODE, resolveTeamCode, type TeamCode } from "../src/data/teamAssets.ts";

export type Conference = DivisionStanding["conference"];
export type DivisionName = DivisionStanding["division"];

export interface DivisionDefinition {
  conference: Conference;
  division: DivisionName;
  nameKo: string;
  teams: readonly TeamCode[];
}

const DIVISION_KO: Record<DivisionName, string> = {
  East: "동부",
  North: "북부",
  South: "남부",
  West: "서부",
};

function division(conference: Conference, name: DivisionName, teams: TeamCode[]): DivisionDefinition {
  return { conference, division: name, nameKo: `${conference} ${DIVISION_KO[name]}`, teams };
}

/** Current alignment (since 2002). Order: AFC then NFC, East, North, South, West. */
export const DIVISIONS: readonly DivisionDefinition[] = [
  division("AFC", "East", ["BUF", "MIA", "NE", "NYJ"]),
  division("AFC", "North", ["BAL", "CIN", "CLE", "PIT"]),
  division("AFC", "South", ["HOU", "IND", "JAX", "TEN"]),
  division("AFC", "West", ["DEN", "KC", "LV", "LAC"]),
  division("NFC", "East", ["DAL", "NYG", "PHI", "WAS"]),
  division("NFC", "North", ["CHI", "DET", "GB", "MIN"]),
  division("NFC", "South", ["ATL", "CAR", "NO", "TB"]),
  division("NFC", "West", ["ARI", "LAR", "SF", "SEA"]),
];

const DIVISION_BY_TEAM = new Map<TeamCode, DivisionDefinition>(
  DIVISIONS.flatMap((entry) => entry.teams.map((team) => [team, entry] as const)),
);

export function divisionOf(abbr: string): DivisionDefinition | null {
  const code = resolveTeamCode(abbr);
  return code ? DIVISION_BY_TEAM.get(code) ?? null : null;
}

/** Full Korean name, e.g. "애틀랜타 팰컨스". Throws for an unknown source code. */
export function teamNameKo(abbr: string): string {
  const code = resolveTeamCode(abbr);
  if (!code) throw new Error(`Unknown team abbreviation "${abbr}"`);
  return TEAM_BY_CODE[code].nameKo;
}

/**
 * Two cities host two franchises each, so the city alone would be ambiguous.
 * Those four keep a short city prefix plus the nickname.
 */
const SHORT_NAME_OVERRIDES: Partial<Record<TeamCode, string>> = {
  LAR: "LA 램스",
  LAC: "LA 차저스",
  NYG: "뉴욕 자이언츠",
  NYJ: "뉴욕 제츠",
};

/** Short Korean name for sentences, e.g. "ATL" -> "애틀랜타", "LA" -> "LA 램스". */
export function teamShortKo(abbr: string): string {
  const code = resolveTeamCode(abbr);
  if (!code) throw new Error(`Unknown team abbreviation "${abbr}"`);
  const override = SHORT_NAME_OVERRIDES[code];
  if (override) return override;
  const fullName = TEAM_BY_CODE[code].nameKo;
  const lastSpace = fullName.lastIndexOf(" ");
  return lastSpace === -1 ? fullName : fullName.slice(0, lastSpace);
}
