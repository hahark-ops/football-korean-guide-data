export type TeamCode =
  | "ARI" | "ATL" | "BAL" | "BUF" | "CAR" | "CHI" | "CIN" | "CLE"
  | "DAL" | "DEN" | "DET" | "GB" | "HOU" | "IND" | "JAX" | "KC"
  | "LAC" | "LAR" | "LV" | "MIA" | "MIN" | "NE" | "NO" | "NYG"
  | "NYJ" | "PHI" | "PIT" | "SEA" | "SF" | "TB" | "TEN" | "WAS";

export interface TeamMeta {
  code: TeamCode;
  nameKo: string;
  nameEn: string;
  color: string;
  color2: string;
}

const teamDefinitions: TeamMeta[] = [
  { code: "ARI", nameKo: "애리조나 카디널스", nameEn: "Arizona Cardinals", color: "#97233F", color2: "#FFB612" },
  { code: "ATL", nameKo: "애틀랜타 팰컨스", nameEn: "Atlanta Falcons", color: "#A71930", color2: "#000000" },
  { code: "BAL", nameKo: "볼티모어 레이븐스", nameEn: "Baltimore Ravens", color: "#241773", color2: "#9E7C0C" },
  { code: "BUF", nameKo: "버펄로 빌스", nameEn: "Buffalo Bills", color: "#00338D", color2: "#C60C30" },
  { code: "CAR", nameKo: "캐롤라이나 팬서스", nameEn: "Carolina Panthers", color: "#0085CA", color2: "#101820" },
  { code: "CHI", nameKo: "시카고 베어스", nameEn: "Chicago Bears", color: "#0B162A", color2: "#E64100" },
  { code: "CIN", nameKo: "신시내티 벵골스", nameEn: "Cincinnati Bengals", color: "#FB4F14", color2: "#000000" },
  { code: "CLE", nameKo: "클리블랜드 브라운스", nameEn: "Cleveland Browns", color: "#FF3C00", color2: "#311D00" },
  { code: "DAL", nameKo: "댈러스 카우보이스", nameEn: "Dallas Cowboys", color: "#002244", color2: "#B0B7BC" },
  { code: "DEN", nameKo: "덴버 브롱코스", nameEn: "Denver Broncos", color: "#002244", color2: "#FB4F14" },
  { code: "DET", nameKo: "디트로이트 라이언스", nameEn: "Detroit Lions", color: "#0076B6", color2: "#B0B7BC" },
  { code: "GB", nameKo: "그린베이 패커스", nameEn: "Green Bay Packers", color: "#203731", color2: "#FFB612" },
  { code: "HOU", nameKo: "휴스턴 텍산스", nameEn: "Houston Texans", color: "#03202F", color2: "#A71930" },
  { code: "IND", nameKo: "인디애나폴리스 콜츠", nameEn: "Indianapolis Colts", color: "#002C5F", color2: "#A5ACAF" },
  { code: "JAX", nameKo: "잭슨빌 재규어스", nameEn: "Jacksonville Jaguars", color: "#006778", color2: "#D7A22A" },
  { code: "KC", nameKo: "캔자스시티 치프스", nameEn: "Kansas City Chiefs", color: "#E31837", color2: "#FFB612" },
  { code: "LAC", nameKo: "로스앤젤레스 차저스", nameEn: "Los Angeles Chargers", color: "#007BC7", color2: "#FFC20E" },
  { code: "LAR", nameKo: "로스앤젤레스 램스", nameEn: "Los Angeles Rams", color: "#003594", color2: "#FFD100" },
  { code: "LV", nameKo: "라스베이거스 레이더스", nameEn: "Las Vegas Raiders", color: "#000000", color2: "#A5ACAF" },
  { code: "MIA", nameKo: "마이애미 돌핀스", nameEn: "Miami Dolphins", color: "#008E97", color2: "#F58220" },
  { code: "MIN", nameKo: "미네소타 바이킹스", nameEn: "Minnesota Vikings", color: "#4F2683", color2: "#FFC62F" },
  { code: "NE", nameKo: "뉴잉글랜드 패트리어츠", nameEn: "New England Patriots", color: "#002244", color2: "#C60C30" },
  { code: "NO", nameKo: "뉴올리언스 세인츠", nameEn: "New Orleans Saints", color: "#D3BC8D", color2: "#000000" },
  { code: "NYG", nameKo: "뉴욕 자이언츠", nameEn: "New York Giants", color: "#0B2265", color2: "#A71930" },
  { code: "NYJ", nameKo: "뉴욕 제츠", nameEn: "New York Jets", color: "#003F2D", color2: "#000000" },
  { code: "PHI", nameKo: "필라델피아 이글스", nameEn: "Philadelphia Eagles", color: "#004C54", color2: "#A5ACAF" },
  { code: "PIT", nameKo: "피츠버그 스틸러스", nameEn: "Pittsburgh Steelers", color: "#101820", color2: "#FFB612" },
  { code: "SEA", nameKo: "시애틀 시호크스", nameEn: "Seattle Seahawks", color: "#002244", color2: "#69BE28" },
  { code: "SF", nameKo: "샌프란시스코 포티나이너스", nameEn: "San Francisco 49ers", color: "#AA0000", color2: "#B3995D" },
  { code: "TB", nameKo: "탬파베이 버커니어스", nameEn: "Tampa Bay Buccaneers", color: "#A71930", color2: "#FF7900" },
  { code: "TEN", nameKo: "테네시 타이탄스", nameEn: "Tennessee Titans", color: "#4495D2", color2: "#D50A0A" },
  { code: "WAS", nameKo: "워싱턴 커맨더스", nameEn: "Washington Commanders", color: "#5A1414", color2: "#FFB612" },
];

export const NFL_TEAMS: TeamMeta[] = teamDefinitions;

export const TEAM_BY_CODE = Object.fromEntries(
  NFL_TEAMS.map((team) => [team.code, team]),
) as Record<TeamCode, TeamMeta>;

/**
 * Source abbreviations that differ from the app's franchise codes.
 * nflverse uses `LA` for the Rams and keeps relocated franchises' historical
 * codes (STL, SD, OAK). Other feeds commonly use JAC/WSH. Displayed text keeps
 * the source abbreviation; favorites, colors and names use the franchise code.
 */
export const TEAM_CODE_ALIASES: Readonly<Record<string, TeamCode>> = Object.freeze({
  LA: "LAR",
  STL: "LAR",
  SD: "LAC",
  OAK: "LV",
  JAC: "JAX",
  WSH: "WAS",
});

/** Resolves a source or stored abbreviation to the app's franchise code. */
export function resolveTeamCode(code: string | null | undefined): TeamCode | null {
  if (typeof code !== "string") return null;
  const normalized = code.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TEAM_BY_CODE, normalized)) return normalized as TeamCode;
  return Object.prototype.hasOwnProperty.call(TEAM_CODE_ALIASES, normalized) ? TEAM_CODE_ALIASES[normalized] : null;
}

export function getTeamMeta(code: string): TeamMeta | null {
  const resolved = resolveTeamCode(code);
  return resolved ? TEAM_BY_CODE[resolved] : null;
}

/** True when two abbreviations (source or stored) belong to the same franchise. */
export function isSameTeam(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = resolveTeamCode(a);
  return left !== null && left === resolveTeamCode(b);
}
