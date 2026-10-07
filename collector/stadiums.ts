/**
 * Former stadium names that nflverse games.csv still lists after the stadium
 * was renamed. The newer nflverse rows for the same stadium_id already use
 * the current name (checked 2026-10-07: e.g. HOU00 is "NRG Stadium" in 2025
 * but "Reliant Stadium" in 2026). Only these exact names are replaced, and
 * only from the season the new name was in use; every other name is
 * published as the source gives it.
 *
 * Shared by the collector (schedule.ts) and the independent check (verify.ts)
 * as reference data, like the team list.
 */
export const RENAMED_STADIUMS: Readonly<Record<string, { current: string; since: number }>> = {
  "Reliant Stadium": { current: "NRG Stadium", since: 2014 },
  "New Era Field": { current: "Highmark Stadium", since: 2021 },
  "Mercedes-Benz Superdome": { current: "Caesars Superdome", since: 2021 },
  "TIAA Bank Stadium": { current: "EverBank Stadium", since: 2023 },
  "TIAA Bank Field": { current: "EverBank Stadium", since: 2023 },
  "FirstEnergy Stadium": { current: "Huntington Bank Field", since: 2024 },
  FedExField: { current: "Northwest Stadium", since: 2025 },
};

/** The stadium name in use in `season`, or the source name when no rename is known. */
export function stadiumNameForSeason(stadium: string | null, season: number): string | null {
  if (stadium === null) return null;
  const renamed = Object.hasOwn(RENAMED_STADIUMS, stadium) ? RENAMED_STADIUMS[stadium] : undefined;
  return renamed && season >= renamed.since ? renamed.current : stadium;
}
