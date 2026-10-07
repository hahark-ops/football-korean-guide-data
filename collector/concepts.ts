import type {
  ConceptExample,
  ConceptExamplesFile,
  GameRecapFile,
  PublicGameRow,
  RecapPlay,
} from "../src/data/publicData.ts";
import { GLOSSARY_SLUGS, type GlossarySlug } from "../src/content/glossary.ts";

export const MAX_EXAMPLES_PER_TERM = 3;

/**
 * Plays that show a term best: a sack for "sack", an actual touchdown for
 * "touchdown" (an extra point's explanation also mentions 터치다운), and so on.
 * Terms without an entry have no preference.
 */
const PREFERRED: Partial<Record<GlossarySlug, (play: RecapPlay) => boolean>> = {
  touchdown: (play) => play.tags.includes("touchdown"),
  "first-down": (play) => play.tags.includes("first_down"),
  "third-down": (play) => play.down === 3,
  "fourth-down": (play) => play.tags.includes("fourth_down"),
  "red-zone": (play) => play.tags.includes("red_zone"),
  turnover: (play) => play.tags.includes("turnover"),
  interception: (play) => play.kind === "interception",
  fumble: (play) => play.kind === "fumble",
  sack: (play) => play.kind === "sack",
  safety: (play) => play.kind === "safety",
  "field-goal": (play) => play.kind === "field_goal",
  punt: (play) => play.kind === "punt",
  kickoff: (play) => play.kind === "kickoff",
  // A penalty on the same play moves the start away from where a touchback puts the ball.
  touchback: (play) => !play.tags.includes("penalty"),
  "end-zone": (play) => !play.tags.includes("penalty"),
  "extra-point": (play) => play.kind === "extra_point",
  "two-point-conversion": (play) => play.kind === "two_point",
  "incomplete-pass": (play) => play.kind === "pass",
  penalty: (play) => play.tags.includes("penalty"),
  holding: (play) => play.tags.includes("penalty"),
  "pass-interference": (play) => play.tags.includes("penalty"),
  "false-start": (play) => play.tags.includes("penalty"),
};

interface Candidate {
  game: PublicGameRow;
  play: RecapPlay;
  /** Position in newest-first order across the season. */
  recency: number;
  preferred: boolean;
}

/** Newest first: later kickoff, then game id; inside a game, later play first. */
function newestFirst(games: readonly PublicGameRow[], recaps: ReadonlyMap<string, GameRecapFile>) {
  const ordered = games
    .filter((game) => game.status === "final" && game.has_recap && recaps.has(game.id))
    .slice()
    .sort((a, b) => (a.kickoff_at === b.kickoff_at ? b.id.localeCompare(a.id) : a.kickoff_at < b.kickoff_at ? 1 : -1));
  return ordered.map((game) => {
    const recap = recaps.get(game.id) as GameRecapFile;
    const unique = new Map<string, RecapPlay>();
    for (const play of [...recap.keyPlays, ...recap.scoringPlays]) if (!unique.has(play.id)) unique.set(play.id, play);
    const plays = [...unique.values()].sort(
      (a, b) => b.elapsedSeconds - a.elapsedSeconds || Number(b.id) - Number(a.id),
    );
    return { game, plays };
  });
}

/**
 * Real plays that illustrate each glossary term (seasons/{season}/concepts.json).
 * A play qualifies when its explanation's termSlugs include the term. Each
 * game contributes at most one play per term (its newest preferred play, else
 * its newest play), so hiding one game never empties a term. Up to three are
 * kept: preferred plays first, then the newest, and the kept ones are listed
 * newest first. Terms without a qualifying play are omitted.
 */
export function buildConceptExamples(
  season: number,
  games: readonly PublicGameRow[],
  recaps: ReadonlyMap<string, GameRecapFile>,
  generatedAt: string,
): ConceptExamplesFile {
  const seasonGames = newestFirst(
    games.filter((game) => game.season === season),
    recaps,
  );
  const examples: Record<string, ConceptExample[]> = {};

  for (const slug of GLOSSARY_SLUGS) {
    const prefer = PREFERRED[slug] ?? (() => false);
    const candidates: Candidate[] = [];
    seasonGames.forEach(({ game, plays }, gameIndex) => {
      const matching = plays.filter((play) => play.termSlugs.includes(slug));
      const play = matching.find(prefer) ?? matching[0];
      if (play) candidates.push({ game, play, recency: gameIndex, preferred: prefer(play) });
    });
    if (candidates.length === 0) continue;
    const chosen = candidates
      .slice()
      .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.recency - b.recency)
      .slice(0, MAX_EXAMPLES_PER_TERM)
      .sort((a, b) => a.recency - b.recency);
    examples[slug] = chosen.map(({ game, play }) => ({
      gameId: game.id,
      week: game.week,
      seasonType: game.season_type,
      away: game.away_team_abbr,
      home: game.home_team_abbr,
      play,
    }));
  }

  return { schemaVersion: 1, season, generatedAt, examples };
}
