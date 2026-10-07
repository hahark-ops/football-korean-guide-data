// Turns a raw probe log from log-scores.mjs into the change events the
// latency comparison needs, and nothing else.
//
// The raw log holds every balldontlie response as received (ids, status text,
// quarter-by-quarter scores). It stays local or inside the CI job. What the
// public data repository keeps is this summary: for each game, when a state
// or score change was first seen, the poll before it, and the points added.
// Scores themselves are sports facts that nflverse also publishes (CC BY 4.0)
// play by play; the timing is our own measurement.
//
// Usage:
//   node research/live/summarize-log.mjs research/live/logs/2026-10-11.jsonl > changes.jsonl
// Prints nothing unless at least two polls returned games: a day without games,
// or a run that stopped after its first look, has no change to time.
//
// Output, one JSON object per line:
//   {"run": {firstPollAt, pollingFrom, lastPollAt, stoppedAt, reason, polls,
//            okPolls, failedPolls, rateLimited, maxGapSeconds}}
//   {"game": "TB@DAL", "kickoff", "firstSeenAt", "state", "scoreAtFirstSeen"?}
//     scoreAtFirstSeen [away, home] only when the game was already under way,
//     so later point changes can be matched to real scores.
//   {"game", "kickoff", "seenAt", "prevPollAt", "state"?, "awayPts"?, "homePts"?}
//     The change reached the API after prevPollAt (when the previous poll
//     that did not show it was sent) and by seenAt (when this response
//     arrived). state is the new status_state; awayPts/homePts are the points
//     added (negative for a correction).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const points = (value) => (Number.isFinite(value) ? value : 0);
const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/** @param {string} text raw JSONL from log-scores.mjs @returns {object[]} summary lines */
export function summarizeLog(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut off by a killed run is skipped.
    }
  }
  const polls = entries.filter((entry) => typeof entry.fetchedAt === "string");
  const ok = polls.filter((entry) => entry.http === 200 && Array.isArray(entry.games));
  if (ok.filter((entry) => entry.games.length > 0).length < 2) return [];

  const stop = entries.findLast((entry) => typeof entry.stoppedAt === "string");
  let maxGapSeconds = 0;
  // The first gap is the wait before kickoff, not a polling gap.
  for (let i = 2; i < ok.length; i += 1) maxGapSeconds = Math.max(maxGapSeconds, seconds(ok[i - 1].fetchedAt, ok[i].fetchedAt));
  const run = {
    firstPollAt: polls[0].fetchedAt,
    pollingFrom: ok[1]?.fetchedAt ?? null,
    lastPollAt: polls.at(-1).fetchedAt,
    stoppedAt: stop?.stoppedAt ?? null,
    reason: stop?.reason ?? null,
    polls: polls.length,
    okPolls: ok.length,
    failedPolls: polls.length - ok.length,
    rateLimited: polls.filter((entry) => entry.http === 429).length,
    maxGapSeconds,
  };

  const out = [{ run }];
  const last = new Map();
  for (const poll of ok) {
    for (const game of poll.games) {
      const key = `${game.away}@${game.home}`;
      const now = { state: game.state, away: points(game.away_score), home: points(game.home_score) };
      const before = last.get(key);
      last.set(key, { ...now, fetchedAt: poll.fetchedAt });
      if (!before) {
        const first = { game: key, kickoff: game.date, firstSeenAt: poll.receivedAt, state: game.state };
        if (game.state !== "scheduled" && (now.away !== 0 || now.home !== 0)) first.scoreAtFirstSeen = [now.away, now.home];
        out.push(first);
        continue;
      }
      if (before.state === now.state && before.away === now.away && before.home === now.home) continue;
      const change = { game: key, kickoff: game.date, seenAt: poll.receivedAt, prevPollAt: before.fetchedAt };
      if (before.state !== now.state) change.state = now.state;
      if (before.away !== now.away) change.awayPts = now.away - before.away;
      if (before.home !== now.home) change.homePts = now.home - before.home;
      out.push(change);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error("usage: summarize-log.mjs <raw log .jsonl>");
    for (const line of summarizeLog(readFileSync(file, "utf8"))) process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch (error) {
    console.error(`summarize-log: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
