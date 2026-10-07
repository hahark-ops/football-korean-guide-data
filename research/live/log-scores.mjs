// Live-score latency probe for the balldontlie free tier.
//
// Polls the NFL games endpoint for one US date and writes every poll to a
// JSONL log, so the time each score change appeared can later be compared
// with nflverse play-by-play `time_of_day`. Research only: the app never
// calls this API directly. The key comes from the environment (GitHub
// Actions secret) or .env.local, and is never printed. The raw log stays
// local (git-ignored); summarize-log.mjs turns it into the change events that
// the public data repository keeps.
//
// Usage:
//   node research/live/log-scores.mjs --date 2026-10-09 [--interval 20] [--max-minutes 360]
// --date is the kickoff date in UTC: the API's `dates` filter matches the UTC
// date, so a Thursday 8:15 PM ET game (Friday 00:15 UTC) is "2026-10-09".
// It waits until 10 minutes before the earliest kickoff on that date, then
// polls until every game is final (plus 10 minutes) or 4.5 hours after the
// latest kickoff. --max-minutes caps the whole run, waiting included, so a
// CI job with a time limit ends cleanly instead of being killed. A date with
// no games (bye day, off-season), or whose first kickoff is after that limit,
// logs one poll and exits successfully.
// On Windows it asks the OS not to idle-sleep while it runs
// (SetThreadExecutionState from a helper process; no system setting changes,
// released when the probe exits). Closing the lid can still sleep the laptop.
//
// The script never calls process.exit(): on Windows (Node 24) exiting while
// fetch's connections are still closing trips a libuv assertion
// (src\win\async.c) and the process dies with 127. It sets process.exitCode
// and lets the event loop drain instead.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readApiKey } from "./env.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function main() {
  const startedAt = Date.now();
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
      return pairs;
    }, []),
  );
  const usDate = args.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usDate ?? "")) throw new Error("--date YYYY-MM-DD (UTC kickoff date) is required");
  // Free tier allows 5 requests per minute; stay well below it.
  const intervalMs = Math.max(15, Number(args.interval ?? 20)) * 1000;
  const maxMinutes = Number(args["max-minutes"] ?? 360);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("--max-minutes must be a positive number");
  const deadline = startedAt + maxMinutes * 60_000;

  const key = readApiKey();
  const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${usDate}.jsonl`);
  const url = `https://api.balldontlie.io/nfl/v1/games?dates[]=${usDate}&per_page=50`;
  const write = (entry) => appendFileSync(logFile, JSON.stringify(entry) + "\n");

  async function poll() {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) });
      const receivedAt = new Date().toISOString();
      if (!response.ok) {
        write({ fetchedAt, receivedAt, http: response.status });
        return { http: response.status, games: [] };
      }
      const body = await response.json();
      const games = body.data.map((game) => ({
        id: game.id,
        away: game.visitor_team.abbreviation,
        home: game.home_team.abbreviation,
        date: game.date,
        status: game.status,
        state: game.status_state,
        away_score: game.visitor_team_score,
        home_score: game.home_team_score,
        away_q: [game.visitor_team_q1, game.visitor_team_q2, game.visitor_team_q3, game.visitor_team_q4, game.visitor_team_ot],
        home_q: [game.home_team_q1, game.home_team_q2, game.home_team_q3, game.home_team_q4, game.home_team_ot],
      }));
      write({ fetchedAt, receivedAt, http: response.status, games });
      return { http: response.status, games };
    } catch (error) {
      write({ fetchedAt, error: String(error) });
      return { http: 0, games: [] };
    }
  }

  // A transient failure on the first request should not lose a whole game
  // window, so it gets two more tries a minute apart.
  let first = await poll();
  for (let attempt = 2; first.http !== 200 && attempt <= 3 && Date.now() + 60_000 < deadline; attempt += 1) {
    console.log(`first request failed (HTTP ${first.http}); retrying in 60s (attempt ${attempt} of 3)`);
    await sleep(60_000);
    first = await poll();
  }
  if (first.http !== 200) throw new Error(`could not read games for ${usDate} (HTTP ${first.http}); see ${logFile}`);
  if (first.games.length === 0) {
    write({ stoppedAt: new Date().toISOString(), reason: "no games" });
    console.log(`notice: no games on ${usDate} (UTC); nothing to measure. One poll logged to ${logFile}`);
    return;
  }
  const kickoffs = first.games.map((game) => Date.parse(game.date));
  const startAt = Math.min(...kickoffs) - 10 * 60_000;
  const stopAt = Math.max(...kickoffs) + 4.5 * 60 * 60_000;
  const endAt = Math.min(stopAt, deadline);
  console.log(`games: ${first.games.map((g) => `${g.away}@${g.home}`).join(", ")}`);
  if (startAt >= endAt) {
    // Waiting would use up the whole run (a day game on a date probed the evening before).
    write({ stoppedAt: new Date().toISOString(), reason: "first kickoff after max-minutes" });
    console.log(`notice: the first kickoff on ${usDate} is after the --max-minutes limit; nothing to record. See ${logFile}`);
    return;
  }
  console.log(
    `polling every ${intervalMs / 1000}s from ${new Date(startAt).toISOString()} until at most ${new Date(endAt).toISOString()}` +
      (deadline < stopAt ? ` (--max-minutes ${maxMinutes}; games may still be running then)` : "") +
      ` into ${logFile}`,
  );

  // Keep Windows from idle-sleeping while this process lives. ES_CONTINUOUS |
  // ES_SYSTEM_REQUIRED is held by the helper and released when it exits.
  let keepAwake = null;
  if (process.platform === "win32") {
    const script = [
      "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
      "$api = Add-Type -MemberDefinition $sig -Name Power -Namespace KeepAwake -PassThru",
      "[void]$api::SetThreadExecutionState([uint32]'0x80000001')",
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
    ].join("; ");
    keepAwake = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
    keepAwake.on("error", (error) => write({ keepAwakeError: String(error) }));
  }

  try {
    if (Date.now() < startAt) await sleep(Math.min(startAt, endAt) - Date.now());

    let finalSince = null;
    let reason = deadline < stopAt ? "max-minutes" : "4.5 hours after the last kickoff";
    while (Date.now() < endAt) {
      const { http, games } = await poll();
      if (http === 429) {
        await sleep(Math.min(60_000, endAt - Date.now()));
        continue;
      }
      const allFinal = games.length > 0 && games.every((game) => game.state === "final");
      if (allFinal) finalSince ??= Date.now();
      else finalSince = null;
      if (finalSince !== null && Date.now() - finalSince >= 10 * 60_000) {
        reason = "all games final";
        break;
      }
      await sleep(Math.min(intervalMs, endAt - Date.now()));
    }
    write({ stoppedAt: new Date().toISOString(), reason });
    console.log(`done (${reason}): ${logFile}`);
  } finally {
    keepAwake?.kill();
  }
}

try {
  await main();
} catch (error) {
  console.error(`log-scores: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
