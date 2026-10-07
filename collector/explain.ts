import type { GlossarySlug } from "../src/content/glossary.ts";
import type { PlayKind, PlayTag } from "../src/data/publicData.ts";
import type { PlayContext, PlayExplanation, PlayRow } from "./types.ts";

/**
 * Korean beginner explanation for one nflverse play row, built from structured
 * fields only (the row model has no `desc` or player names).
 *
 * nflverse team semantics this relies on (checked against 2026 play-by-play):
 * - On kickoffs `posteam` is the receiving team and `defteam` the kicking team.
 * - On punts `posteam` is the punting team. `fumble_lost` on a punt that was
 *   kicked means the receiving team lost the ball to the punting team.
 * - `total_home_score` / `total_away_score` are the scores after the play.
 * - Declined and offsetting penalties have `penalty` false; `penalty_yards`
 *   is the enforced distance and is never negative.
 */
export function explainPlay(play: PlayRow, ctx: PlayContext): PlayExplanation {
  const kind = classifyPlay(play);
  const names = teamNames(play, ctx);
  const { title, sentences } = describe(kind, play, ctx, names);
  const explanationKo = sentences.slice(0, 2).join(" ");
  const tags = buildTags(play, kind, ctx);
  const termSlugs = termSlugsFor(explanationKo);
  // The situation line ("1st & 골 · 상대 진영 4야드") shows the red zone even
  // though the sentences do not name it, so its chip comes from the tag.
  if (tags.includes("red_zone") && !termSlugs.includes("red-zone")) termSlugs.push("red-zone");
  return {
    kind,
    tags,
    situationKo: formatSituation(play),
    titleKo: title,
    explanationKo,
    termSlugs,
  };
}

interface Description {
  title: string;
  sentences: string[];
}

interface TeamNames {
  /** Offense (`posteam`) short name. */
  off: string;
  /** Defense (`defteam`) short name. */
  def: string;
  of: (abbr: string | null) => string | null;
}

type Outcome =
  | "fourth_converted"
  | "fourth_failed"
  | "third_converted"
  | "third_failed"
  | "first_down"
  | "none";

const TOUCHDOWN_POINTS = "터치다운은 6점이고, 이어서 추가 득점 시도를 해요.";
const TOUCHDOWN_POINTS_LATE = "터치다운은 6점이에요.";
const DEFENSE_TOUCHDOWN_POINTS = "수비가 올린 터치다운도 6점이고, 이어서 추가 득점 시도를 해요.";
const DEFENSE_TOUCHDOWN_POINTS_LATE = "수비가 올린 터치다운도 6점이에요.";
const NEW_SET_OF_DOWNS = "공격 기회 네 번을 새로 얻었어요.";
const NEW_SET_OF_DOWNS_AND = "공격 기회 네 번을 새로 얻었고";
const THIRD_DOWN_CHOICE = "보통 이때는 펀트나 필드골을 선택해요.";
/** Within field-goal range nobody punts. */
const THIRD_DOWN_CHOICE_NEAR_GOAL = "보통 이때는 필드골을 차거나, 남은 거리가 짧으면 4번째 공격에 도전하기도 해요.";
const FOURTH_DOWN_RULE = "네 번의 공격 안에 필요한 거리를 채우지 못하면 공격권을 내줘요(턴오버).";
const KICKOFF_ROLE = "킥오프는 전·후반 시작과 득점 뒤에 공을 차서 상대에게 공격을 넘기는 플레이예요.";
const OWN_KICKOFF_RULE = "킥오프한 공은 10야드 이상 나아가면 차는 팀도 잡을 수 있어요.";
/** Laterals: nflverse yards_gained then includes the yards after the lateral. */
const LATERAL_AFTER_CATCH = "패스를 받은 선수가 동료에게 공을 다시 넘겨(래터럴)";
const LATERAL_ON_RUN = "공을 들고 달리던 선수가 동료에게 공을 다시 넘겨(래터럴)";
/** Onside kicks travel little more than the required 10 yards. */
const ONSIDE_MAX_DISTANCE = 20;
const PUNT_ROLE = "펀트는 상대가 득점하려면 더 먼 거리를 가야 하도록 공을 멀리 차는 플레이예요.";

// ---------------------------------------------------------------------------
// Classification and tags

function classifyPlay(play: PlayRow): PlayKind {
  // nflverse clears these flags on nullified plays; the guard keeps a stray
  // flag on a `no_play` row from describing a result that did not count.
  const counted = play.play_type !== "no_play";
  if (play.safety) return "safety";
  if (counted && play.interception) return "interception";
  if (counted && play.fumble_lost) return "fumble";
  if (hasText(play.two_point_conv_result)) return "two_point";
  if (play.play_type === "extra_point" || (counted && hasText(play.extra_point_result))) return "extra_point";
  if (play.play_type === "field_goal" || (counted && hasText(play.field_goal_result))) return "field_goal";
  if (play.play_type === "punt") return "punt";
  if (play.play_type === "kickoff") return "kickoff";
  if (counted && play.sack) return "sack";
  if (!counted && play.penalty) return "penalty";
  if (play.play_type === "pass") return "pass";
  if (play.play_type === "run") return "run";
  return "other";
}

/** A snapped play with a down: passes, runs, punts, field goals and nullified scrimmage plays. Not kickoffs or tries. */
function isScrimmage(play: PlayRow): boolean {
  return (
    play.down !== null &&
    play.play_type !== "kickoff" &&
    play.play_type !== "extra_point" &&
    !hasText(play.two_point_conv_result)
  );
}

function isTry(play: PlayRow): boolean {
  return hasText(play.two_point_conv_result) || play.play_type === "extra_point";
}

/**
 * A snap the offense ran from scrimmage: passes (sacks and interceptions are
 * pass rows in nflverse) and runs, including those that ended in a fumble.
 * Punts, field goals, kneels, spikes and no-play penalties are not, so they
 * never carry the `fourth_down` or `red_zone` tag (src/data/publicData.ts).
 */
function isOffensiveSnap(play: PlayRow): boolean {
  return isScrimmage(play) && (play.play_type === "pass" || play.play_type === "run");
}

function buildTags(play: PlayRow, kind: PlayKind, ctx: PlayContext): PlayTag[] {
  const counted = play.play_type !== "no_play";
  const offensive = isOffensiveSnap(play);
  const tags: PlayTag[] = [];
  if (play.touchdown) tags.push("touchdown");
  if (play.first_down) tags.push("first_down");
  // An interception on a try ends the try; possession does not change.
  const turnover =
    counted && ((play.interception && !isTry(play)) || play.fumble_lost || play.fourth_down_failed);
  if (turnover) tags.push("turnover");
  if (offensive && play.down === 4) tags.push("fourth_down");
  if (isScoring(play, ctx)) tags.push("scoring");
  if ((kind === "pass" || kind === "run") && (play.yards_gained ?? 0) >= 20) tags.push("big_play");
  if (play.penalty) tags.push("penalty");
  if (offensive && play.yardline_100 !== null && play.yardline_100 <= 20) tags.push("red_zone");
  return tags;
}

function isScoring(play: PlayRow, ctx: PlayContext): boolean {
  if (play.touchdown || play.safety) return true;
  if (play.field_goal_result === "made" || play.field_goal_result === "good") return true;
  if (play.extra_point_result === "good" || play.two_point_conv_result === "success") return true;
  const delta = scoreDelta(play, ctx);
  return delta !== null && (delta.home > 0 || delta.away > 0);
}

function scoreDelta(play: PlayRow, ctx: PlayContext): { home: number; away: number } | null {
  if (play.total_home_score === null || play.total_away_score === null) return null;
  return {
    home: play.total_home_score - ctx.scoreBefore.home,
    away: play.total_away_score - ctx.scoreBefore.away,
  };
}

/** The team whose score rose by exactly `points` on this play, if any. */
function teamThatScored(play: PlayRow, ctx: PlayContext, points: number): string | null {
  const delta = scoreDelta(play, ctx);
  if (delta === null) return null;
  if (delta.home === points && delta.away === 0) return ctx.homeTeam;
  if (delta.away === points && delta.home === 0) return ctx.awayTeam;
  return null;
}

// ---------------------------------------------------------------------------
// Situation line

const ORDINAL_SUFFIX: Record<number, string> = { 1: "st", 2: "nd", 3: "rd", 4: "th" };

function formatSituation(play: PlayRow): string | null {
  if (!isScrimmage(play) || play.down === null) return null;
  const ordinal = `${play.down}${ORDINAL_SUFFIX[play.down] ?? "th"}`;
  const distance = play.goal_to_go ? "골" : play.ydstogo !== null ? String(play.ydstogo) : null;
  const head = distance === null ? ordinal : `${ordinal} & ${distance}`;
  const territory = formatTerritory(play.yardline_100);
  return territory === null ? head : `${head} · ${territory}`;
}

function formatTerritory(yardline100: number | null): string | null {
  if (yardline100 === null) return null;
  if (yardline100 < 50) return `상대 진영 ${yardline100}야드`;
  if (yardline100 > 50) return `자기 진영 ${100 - yardline100}야드`;
  return "중앙(50야드)";
}

// ---------------------------------------------------------------------------
// Text per kind

function describe(kind: PlayKind, play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  switch (kind) {
    case "safety":
      return describeSafety(play, ctx, n);
    case "interception":
      return describeInterception(play, ctx, n);
    case "fumble":
      return describeFumble(play, ctx, n);
    case "two_point":
      return describeTwoPoint(play, ctx, n);
    case "extra_point":
      return describeExtraPoint(play, ctx, n);
    case "field_goal":
      return describeFieldGoal(play, n);
    case "punt":
      return describePunt(play, ctx, n);
    case "kickoff":
      return describeKickoff(play, n);
    case "penalty":
      return describeNoPlayPenalty(play, n);
    case "sack":
    case "pass":
    case "run":
      return describeScrimmage(kind, play, n);
    default:
      return describeOther(play, n);
  }
}

function describeScrimmage(kind: "pass" | "run" | "sack", play: PlayRow, n: TeamNames): Description {
  if (play.touchdown && (play.td_team === null || play.td_team === play.posteam)) {
    return describeOffensiveTouchdown(kind, play, n);
  }
  if (play.touchdown && play.td_team === play.defteam) {
    return {
      title: `${n.def} 수비, 터치다운`,
      sentences: [`${n.def} 수비가 공을 빼앗아 터치다운까지 올렸어요.`, touchdownPoints(play, true)],
    };
  }
  const outcome = resolveOutcome(play);
  const action = actionText(kind, play);
  const firstDownByPenalty =
    play.first_down && !gainedLineToGain(play) && play.penalty && play.penalty_team === play.defteam;
  const penalty = countedPenaltyClause(play, n, true);
  const title = scrimmageTitle(kind, play, n, outcome, firstDownByPenalty);
  const sentences: string[] = [];

  if (firstDownByPenalty) {
    sentences.push(`${downPrefix(play)}${action.plain}`, penaltyFirstDownSentence(play, n));
  } else if (outcome === "fourth_failed") {
    sentences.push(`4번째 공격에서 ${action.short} 공격권이 상대에게 넘어갔어요.`, sentence(penalty) ?? FOURTH_DOWN_RULE);
  } else if (outcome === "third_failed") {
    const choice = play.yardline_100 !== null && play.yardline_100 <= 35 ? THIRD_DOWN_CHOICE_NEAR_GOAL : THIRD_DOWN_CHOICE;
    sentences.push(`3번째 공격에서 ${action.short} 4번째 공격 상황이 됐어요.`, sentence(penalty) ?? choice);
  } else if (outcome === "none") {
    sentences.push(action.plain);
    const context = sentence(penalty) ?? noGainContext(kind, play);
    if (context) sentences.push(context);
  } else {
    const lead =
      outcome === "fourth_converted"
        ? `4번째 공격에서 킥 대신 공격을 선택했고, ${action.plain}`
        : `${outcome === "third_converted" ? "3번째 공격에서 " : ""}${action.plain}`;
    const reason = gainedLineToGain(play) ? "필요한 거리를 채워 " : "퍼스트 다운으로 ";
    sentences.push(lead, penalty ? `${reason}${NEW_SET_OF_DOWNS_AND}, ${penalty}.` : `${reason}${NEW_SET_OF_DOWNS}`);
  }
  return { title, sentences };
}

function resolveOutcome(play: PlayRow): Outcome {
  if (play.fourth_down_failed) return "fourth_failed";
  if (play.fourth_down_converted || (play.down === 4 && play.first_down)) return "fourth_converted";
  if (play.third_down_converted || (play.down === 3 && play.first_down)) return "third_converted";
  if (play.third_down_failed) return "third_failed";
  if (play.first_down) return "first_down";
  return "none";
}

function gainedLineToGain(play: PlayRow): boolean {
  return play.yards_gained !== null && play.ydstogo !== null && play.yards_gained >= play.ydstogo;
}

function downPrefix(play: PlayRow): string {
  if (play.down === 3) return "3번째 공격에서 ";
  if (play.down === 4) return "4번째 공격에서 ";
  return "";
}

interface ActionText {
  /** Full sentence describing the play. */
  plain: string;
  /** Connective clause for a play that fell short, ready to be followed by the consequence. */
  short: string;
}

function actionText(kind: "pass" | "run" | "sack", play: PlayRow): ActionText {
  const y = play.yards_gained;
  const need = play.ydstogo !== null ? `필요한 ${play.ydstogo}야드` : "필요한 거리";
  const reachedLine = y !== null && play.ydstogo !== null && y >= play.ydstogo;

  if (kind === "sack") {
    return y !== null && y < 0
      ? {
          plain: `쿼터백이 공을 던지기 전에 태클당해(색) ${-y}야드 뒤로 밀렸어요.`,
          short: `쿼터백이 공을 던지기 전에 태클당해(색) ${-y}야드 뒤로 밀려`,
        }
      : { plain: "쿼터백이 공을 던지기 전에 태클당했어요(색).", short: "쿼터백이 공을 던지기 전에 태클당해(색)" };
  }

  if (kind === "pass") {
    if (play.incomplete_pass) {
      return { plain: "패스가 잡히지 않아(인컴플리트) 전진하지 못했어요.", short: "패스가 잡히지 않아" };
    }
    if (y === null) return { plain: "패스가 성공했어요.", short: "패스가 성공했지만 필요한 거리를 채우지 못해" };
    if (y > 0) {
      return {
        // nflverse counts the yards after a lateral as part of the pass.
        plain: play.lateral_reception ? `${LATERAL_AFTER_CATCH} 모두 ${y}야드를 전진했어요.` : `${y}야드 패스가 성공했어요.`,
        short: reachedLine
          ? `${y}야드 패스가 성공했지만 퍼스트 다운을 얻지 못해`
          : `${y}야드 패스가 성공했지만 ${need}에 못 미쳐`,
      };
    }
    if (y === 0) return { plain: "패스는 성공했지만 전진하지 못했어요.", short: "패스는 성공했지만 전진하지 못해" };
    return { plain: `패스는 성공했지만 ${-y}야드 뒤로 밀렸어요.`, short: `패스는 성공했지만 ${-y}야드 뒤로 밀려` };
  }

  if (play.aborted_play) {
    // On aborted plays (botched snap or exchange) nflverse `yards_gained` covers
    // only part of the play, so no distance is stated.
    return { plain: "플레이 초반에 공을 놓쳤지만 공격권은 지켰어요.", short: "플레이 초반에 공을 놓쳐" };
  }

  // nflverse marks a quarterback scramble as a run with the dropback (`pass`) flag.
  const runner = isScramble(play) ? "쿼터백이 직접 " : "";
  if (y !== null && y > 0) {
    return {
      plain: play.lateral_rush ? `${LATERAL_ON_RUN} 모두 ${y}야드를 전진했어요.` : `${runner}${y}야드를 달려 전진했어요.`,
      short: reachedLine
        ? `${runner}${y}야드를 달렸지만 퍼스트 다운을 얻지 못해`
        : `${runner}${y}야드를 달렸지만 ${need}에 못 미쳐`,
    };
  }
  if (y !== null && y < 0) {
    return {
      plain: `${runner}공을 들고 달렸지만 ${-y}야드 뒤로 밀렸어요.`,
      short: `${runner}공을 들고 달렸지만 ${-y}야드 뒤로 밀려`,
    };
  }
  return { plain: `${runner}공을 들고 달렸지만 전진하지 못했어요.`, short: `${runner}공을 들고 달렸지만 전진하지 못해` };
}

function isScramble(play: PlayRow): boolean {
  return play.play_type === "run" && play.pass && !play.rush;
}

function noGainContext(kind: "pass" | "run" | "sack", play: PlayRow): string | null {
  if (kind === "pass" && play.incomplete_pass) return "패스가 실패하면 공은 원래 자리에 놓이고 경기 시계도 멈춰요.";
  const y = play.yards_gained;
  if (play.aborted_play || play.down === null || play.down > 2 || play.ydstogo === null || y === null) return null;
  const remaining = play.ydstogo - y;
  if (remaining <= 0) return null;
  return play.goal_to_go
    ? `이제 ${play.down + 1}번째 공격에서 엔드존까지 ${remaining}야드가 남았어요.`
    : `이제 ${play.down + 1}번째 공격에서 ${remaining}야드를 더 가야 퍼스트 다운이에요.`;
}

function scrimmageTitle(
  kind: "pass" | "run" | "sack",
  play: PlayRow,
  n: TeamNames,
  outcome: Outcome,
  firstDownByPenalty: boolean,
): string {
  const y = play.yards_gained;
  if (outcome === "fourth_failed") return `${n.off}, 4번째 공격 실패`;
  if (kind === "sack") {
    return y !== null && y < 0 ? `${n.def} 수비, 쿼터백 색(${-y}야드 손실)` : `${n.def} 수비, 쿼터백 색`;
  }
  if (kind === "run" && play.aborted_play) {
    return play.first_down ? `${n.off}, 공을 놓쳤지만 퍼스트 다운` : `${n.off}, 플레이 시작 중 공 놓침`;
  }
  if (kind === "pass" && play.incomplete_pass) return `${n.off}, 패스 실패`;
  const label = kind === "pass" ? "패스" : "러싱";
  const by = kind === "pass" ? "패스로" : "러싱으로";
  if (y !== null && y > 0 && !firstDownByPenalty) {
    if (outcome === "fourth_converted") return `${n.off}, ${y}야드 ${by} 4번째 공격 성공`;
    if (outcome !== "none" && outcome !== "third_failed") return `${n.off}, ${y}야드 ${by} 퍼스트 다운`;
  }
  if (outcome === "fourth_converted") return `${n.off}, 4번째 공격 성공`;
  if (y === null) return `${n.off}, ${label} 플레이`;
  if (y > 0) return `${n.off}, ${y}야드 ${label} 전진`;
  if (y === 0) return kind === "pass" ? `${n.off}, 패스 성공했지만 전진 없음` : `${n.off}, 러싱 전진 없음`;
  return kind === "pass" ? `${n.off}, 패스 성공했지만 ${-y}야드 손실` : `${n.off}, 러싱 ${-y}야드 손실`;
}

function describeOffensiveTouchdown(kind: "pass" | "run" | "sack", play: PlayRow, n: TeamNames): Description {
  const y = play.yards_gained;
  const distance = y !== null && y > 0 ? `${y}야드 ` : "";
  const lead = play.down === 4 ? "4번째 공격에서 킥 대신 공격을 선택해 " : "";
  if (kind === "pass") {
    const how = play.lateral_reception && y !== null && y > 0
      ? `${LATERAL_AFTER_CATCH} 모두 ${y}야드를 전진해`
      : `${distance}패스로`;
    return {
      title: `${n.off}, ${distance}패스 터치다운`,
      sentences: [`${lead}${how} 터치다운을 올렸어요.`, touchdownPoints(play)],
    };
  }
  const runner = isScramble(play) ? "쿼터백이 직접 " : "";
  const run = y !== null && y > 0
    ? play.lateral_rush ? `${LATERAL_ON_RUN} 모두 ${y}야드를 전진해` : `${y}야드를 달려`
    : "공을 들고 달려";
  return {
    title: `${n.off}, ${distance}러싱 터치다운`,
    sentences: [`${lead}${runner}${run} 터치다운을 올렸어요.`, touchdownPoints(play)],
  };
}

function touchdownPoints(play: PlayRow, byDefense = false): string {
  // The try is skipped when the touchdown ends the game, which one row cannot
  // tell, so the try is only promised outside overtime and the final seconds.
  const lateInRegulation =
    play.qtr === 4 && play.game_seconds_remaining !== null && play.game_seconds_remaining <= 15;
  const trySkippable = play.qtr >= 5 || lateInRegulation;
  if (byDefense) return trySkippable ? DEFENSE_TOUCHDOWN_POINTS_LATE : DEFENSE_TOUCHDOWN_POINTS;
  return trySkippable ? TOUCHDOWN_POINTS_LATE : TOUCHDOWN_POINTS;
}

function describeInterception(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  if (isTry(play)) {
    const scorer = teamThatScored(play, ctx, 2);
    return {
      title: `${n.def} 수비, 2점 컨버전 패스 가로채기`,
      sentences: [
        `${n.def} 수비가 2점 컨버전 패스를 가로채 추가 점수를 막았어요.`,
        ...(scorer !== null && scorer === play.defteam
          ? [`가로챈 공을 반대편 엔드존까지 가져가 ${subject(n.def)} 2점을 얻었어요.`]
          : []),
      ],
    };
  }
  if (play.fumble_lost) {
    // The defense intercepted, then lost the ball back to the offense.
    if (play.touchdown && play.td_team === play.posteam) {
      return {
        title: `${n.off}, 가로채기 뒤 공 되찾아 터치다운`,
        sentences: [
          `${n.def} 수비가 패스를 가로챘지만 다시 공을 놓쳐(펌블) ${subject(n.off)} 공을 되찾아 터치다운까지 올렸어요.`,
          touchdownPoints(play),
        ],
      };
    }
    return {
      title: `${n.def} 수비, 가로채기 후 공 놓침`,
      sentences: [
        `${n.def} 수비가 패스를 가로챘지만 다시 공을 놓쳐(펌블) ${subject(n.off)} 공을 되찾았어요.`,
        ...optional(sentence(countedPenaltyClause(play, n, false))),
      ],
    };
  }
  const returned = play.return_yards !== null && play.return_yards > 0 ? play.return_yards : null;
  if (play.touchdown && play.td_team === play.defteam) {
    return {
      title: `${n.def} 수비, 가로채기 터치다운`,
      sentences: [
        `${n.def} 수비가 패스를 가로챈 뒤 ${returned !== null ? `${returned}야드를 달려 ` : ""}터치다운까지 올렸어요.`,
        touchdownPoints(play, true),
      ],
    };
  }
  const sentences = [`${n.def} 수비가 패스를 가로채 공격권이 바로 넘어갔어요(턴오버).`];
  const followUp = possessionFollowUp(play, ctx, n, play.touchback ? "엔드존 안에서 가로챈 뒤 그대로 멈춰 터치백이 됐" : null);
  if (followUp) sentences.push(followUp);
  // A foul by the returning team is enforced on the return, so the return
  // yards nflverse reports end at the foul and are not stated.
  else if (returned !== null) sentences.push(`가로챈 뒤 ${returned}야드를 리턴했어요.`);
  return { title: `${n.def} 수비, 패스 가로채기`, sentences };
}

function describeFumble(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  const penalty = sentence(countedPenaltyClause(play, n, false));
  if (play.play_type === "kickoff") {
    // Kickoff: posteam received and lost the ball; defteam kicked and recovered.
    return {
      title: `${n.def}, 킥오프 후 공격권 가져옴`,
      sentences: [
        `킥오프를 받은 ${subject(n.off)} 공을 놓쳤고(펌블), 킥오프를 찬 ${subject(n.def)} 공을 차지해 공격권을 가져갔어요(턴오버).`,
        ...optional(penalty),
      ],
    };
  }
  if (play.play_type === "punt" && play.kick_distance !== null) {
    // Punt that was kicked: the receiving team (defteam) lost the ball to the punting team.
    return {
      title: `${n.off}, 펀트 후 공격권 되찾음`,
      sentences: [
        `펀트를 받은 ${subject(n.def)} 공을 놓쳤고, 펀트를 찬 ${subject(n.off)} 공을 차지해 공격권을 다시 가져갔어요(턴오버).`,
        ...optional(penalty),
      ],
    };
  }
  if (play.play_type !== "pass" && play.play_type !== "run") {
    return {
      title: "킥 상황에서 펌블, 공격권 이동",
      sentences: ["킥 과정에서 펌블이 나왔고, 공을 놓친 팀이 공격권을 잃었어요(턴오버).", ...optional(penalty)],
    };
  }
  const defenseScored = play.touchdown && play.td_team === play.defteam;
  const lost = play.sack
    ? "쿼터백이 색을 당하는 과정에서 공을 놓쳤고(펌블)"
    : `${subject(n.off)} 공을 놓쳤고(펌블)`;
  if (defenseScored) {
    return {
      title: `${n.def} 수비, 펌블 회수 후 터치다운`,
      sentences: [
        `${lost} ${n.def} 수비가 그 공을 잡아 터치다운까지 올렸어요.`,
        touchdownPoints(play, true),
      ],
    };
  }
  const sentences = [`${lost} ${n.def} 수비가 공을 차지해 공격권이 넘어갔어요(턴오버).`];
  const followUp = possessionFollowUp(play, ctx, n, play.touchback ? "공이 엔드존에서 죽어 터치백이 됐" : null);
  if (followUp) sentences.push(followUp);
  return { title: play.sack ? `${n.def} 수비, 색으로 펌블 유도 후 회수` : `${n.def} 수비, 펌블 회수`, sentences };
}

/**
 * Second sentence after the ball went to `defteam` (a turnover or a punt): the
 * touchback (`touchback` is a clause stem ending in "됐"), an enforced
 * penalty, and where the new offense started. The start comes from the next
 * snap only, so a touchback followed by a penalty or by the end of the half
 * never claims the 20-yard line. Null when there is nothing to add.
 */
function possessionFollowUp(play: PlayRow, ctx: PlayContext, n: TeamNames, touchback: string | null): string | null {
  const start = startClause(ctx, play.defteam, n.def);
  const lead = enforcedPenaltyLead(play, n);
  const penalty = countedPenaltyClause(play, n, false);
  if (touchback !== null) {
    if (lead !== null && start !== null) return `${touchback}지만, ${lead} ${start}.`;
    if (penalty !== null) return `${touchback}고, ${penalty}.`;
    if (start !== null) return `${touchback}고, ${start}.`;
    return `${touchback}어요.`;
  }
  if (lead !== null && start !== null) return `${lead} ${start}.`;
  return sentence(penalty);
}

/** "덴버는 자기 진영 20야드에서 공격을 시작했어요" when the next snap shows where `team` started, else null. */
function startClause(ctx: PlayContext, team: string | null, name: string): string | null {
  const next = ctx.nextSnap;
  if (!next || team === null || next.posteam !== team || next.yardline100 === null) return null;
  const spot = formatTerritory(next.yardline100);
  return spot === null ? null : `${topic(name)} ${spot}에서 공격을 시작했어요`;
}

function describeTwoPoint(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  const spot = play.yardline_100 !== null ? `상대 ${play.yardline_100}야드 지점에서 ` : "";
  if (play.two_point_conv_result === "success") {
    return {
      title: `${n.off}, 2점 컨버전 성공`,
      sentences: [`터치다운 뒤 킥 대신 ${spot}한 번 더 공격하는 2점 컨버전에 성공해 2점을 더했어요.`],
    };
  }
  const scorer = teamThatScored(play, ctx, 2);
  return {
    title: `${n.off}, 2점 컨버전 실패`,
    sentences: [
      `터치다운 뒤 킥 대신 ${spot}한 번 더 공격하는 2점 컨버전에 실패해 추가 점수를 얻지 못했어요.`,
      scorer !== null && scorer === play.defteam
        ? `${subject(n.def)} 공을 반대편 엔드존까지 가져가 오히려 2점을 얻었어요.`
        : "성공하면 1점짜리 킥보다 많은 2점을 얻을 수 있어요.",
    ],
  };
}

function describeExtraPoint(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  const penalty = sentence(countedPenaltyClause(play, n, false));
  const result = play.extra_point_result;
  if (result === "good") {
    return {
      title: `${n.off}, 엑스트라 포인트 성공`,
      sentences: ["터치다운 뒤 킥으로 1점을 더했어요(엑스트라 포인트).", ...optional(penalty)],
    };
  }
  if (result === "blocked") {
    const scorer = teamThatScored(play, ctx, 2);
    return {
      title: `${n.def} 수비, 엑스트라 포인트 블록`,
      sentences: [
        `${n.def} 수비가 터치다운 뒤 1점을 더하는 킥(엑스트라 포인트)을 막아냈어요.`,
        ...optional(
          scorer !== null && scorer === play.defteam
            ? `막아낸 공을 반대편 엔드존까지 가져가 ${subject(n.def)} 2점을 얻었어요.`
            : penalty,
        ),
      ],
    };
  }
  if (hasText(result)) {
    return {
      title: `${n.off}, 엑스트라 포인트 실패`,
      sentences: ["터치다운 뒤 1점을 더하는 킥(엑스트라 포인트)에 실패해 점수를 더하지 못했어요.", ...optional(penalty)],
    };
  }
  return {
    title: `${n.off}, 엑스트라 포인트 시도`,
    sentences: ["터치다운 뒤 1점을 더하는 킥(엑스트라 포인트)을 시도했어요.", ...optional(penalty)],
  };
}

function describeFieldGoal(play: PlayRow, n: TeamNames): Description {
  const d = play.kick_distance;
  const distance = d !== null ? `${d}야드 ` : "";
  const penalty = sentence(countedPenaltyClause(play, n, false));
  const result = play.field_goal_result;
  if (result === "made" || result === "good") {
    return {
      title: `${n.off}, ${distance}필드골 성공`,
      sentences: [`${distance}필드골이 들어가 3점을 얻었어요.`, ...optional(penalty)],
    };
  }
  if (result === "blocked") {
    const defenseScored = play.touchdown && play.td_team === play.defteam;
    return {
      title: defenseScored ? `${n.def}, 필드골 블록 후 터치다운` : `${n.def} 수비, 필드골 블록`,
      sentences: [
        `${n.def} 수비가 ${distance}필드골을 막아내(블록) ${topic(n.off)} 점수를 얻지 못했어요.`,
        ...optional(defenseScored ? `${subject(n.def)} 막아낸 공으로 터치다운까지 올렸어요.` : penalty),
      ],
    };
  }
  if (hasText(result)) {
    return {
      title: `${n.off}, ${distance}필드골 실패`,
      sentences: [
        `${distance}필드골이 들어가지 않아 점수를 얻지 못했어요.`,
        penalty ?? "필드골이 실패하면 보통 상대가 공격권을 넘겨받아요.",
      ],
    };
  }
  return { title: `${n.off}, 필드골 시도`, sentences: ["필드골을 시도했어요.", ...optional(penalty)] };
}

function describePunt(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  const defenseScored = play.touchdown && play.td_team === play.defteam;
  if (play.punt_blocked) {
    return {
      title: defenseScored ? `${n.def}, 펀트 블록 후 터치다운` : `${n.def} 수비, 펀트 블록`,
      sentences: [
        `${n.def} 수비가 ${n.off}의 펀트를 막아냈어요(블록).`,
        defenseScored
          ? `${subject(n.def)} 막아낸 공으로 터치다운까지 올렸어요.`
          : "펀트가 막히면 공이 멀리 가지 못해 보통 상대가 좋은 위치에서 공격을 시작해요.",
      ],
    };
  }
  const returned = play.return_yards;
  if (defenseScored) {
    return {
      title: `${n.def}, 펀트 리턴 터치다운`,
      sentences: [
        `${subject(n.def)} 펀트를 받아 ${returned !== null && returned > 0 ? `${returned}야드를 달려 ` : ""}터치다운을 올렸어요.`,
        touchdownPoints(play),
      ],
    };
  }
  const d = play.kick_distance;
  const lead = play.down === 4 ? "4번째 공격에서 " : "";
  const sentences = [`${lead}${d !== null ? `${d}야드 ` : ""}펀트를 차 공격권을 ${n.def}에게 넘겼어요.`];
  // The receiving team (defteam) gets the ball, as after a turnover.
  const followUp = possessionFollowUp(play, ctx, n, play.touchback ? "공이 엔드존으로 들어가 터치백이 됐" : null);
  if (followUp) sentences.push(followUp);
  else if (returned !== null && returned > 0) sentences.push(`${topic(n.def)} 공을 받아 ${returned}야드를 리턴했어요.`);
  else if (returned !== null && returned < 0) sentences.push(`${topic(n.def)} 공을 받은 뒤 ${-returned}야드 뒤로 밀렸어요.`);
  else sentences.push(PUNT_ROLE);
  return { title: d !== null ? `${n.off}, ${d}야드 펀트` : `${n.off}, 펀트`, sentences };
}

function describeKickoff(play: PlayRow, n: TeamNames): Description {
  // On kickoffs nflverse `posteam` is the receiving team.
  const receiving = n.off;
  const kicking = n.def;
  const penalty = sentence(countedPenaltyClause(play, n, false));
  const returned = play.return_yards;
  if (play.own_kickoff_recovery_td || (play.touchdown && play.td_team === play.defteam)) {
    return {
      title: `${kicking}, 킥오프한 공 되찾아 터치다운`,
      sentences: [`${subject(kicking)} 킥오프한 공을 직접 다시 잡아 터치다운까지 올렸어요.`, touchdownPoints(play)],
    };
  }
  if (play.touchdown && play.td_team === play.posteam) {
    return {
      title: `${receiving}, 킥오프 리턴 터치다운`,
      sentences: [
        `${subject(receiving)} 킥오프를 받아 ${returned !== null && returned > 0 ? `${returned}야드를 달려 ` : ""}터치다운을 올렸어요.`,
        touchdownPoints(play),
      ],
    };
  }
  if (play.own_kickoff_recovery) {
    const onside = play.kick_distance !== null && play.kick_distance <= ONSIDE_MAX_DISTANCE;
    return {
      title: onside ? `${kicking}, 온사이드 킥 성공` : `${kicking}, 킥오프한 공 되찾음`,
      sentences: [
        onside
          ? `${subject(kicking)} 짧게 찬 킥(온사이드 킥)을 다시 차지해 공격권을 지켰어요.`
          : `${subject(kicking)} 킥오프한 공을 다시 차지해 공격권을 지켰어요.`,
        penalty ?? OWN_KICKOFF_RULE,
      ],
    };
  }
  if (play.touchback) {
    return {
      title: `${kicking}, 킥오프 터치백`,
      sentences: [
        `${kicking}의 킥오프가 터치백이 돼 ${topic(receiving)} 리턴 없이 규칙이 정한 위치에서 공격을 시작해요.`,
        penalty ?? KICKOFF_ROLE,
      ],
    };
  }
  if (returned !== null && returned > 0) {
    return {
      title: `${receiving}, 킥오프 ${returned}야드 리턴`,
      sentences: [`${subject(receiving)} ${kicking}의 킥오프를 받아 ${returned}야드를 리턴했어요.`, penalty ?? KICKOFF_ROLE],
    };
  }
  if (returned !== null && returned < 0) {
    return {
      title: `${receiving}, 킥오프 리턴 ${-returned}야드 손실`,
      sentences: [`${subject(receiving)} 킥오프를 받았지만 ${-returned}야드 뒤로 밀렸어요.`, penalty ?? KICKOFF_ROLE],
    };
  }
  if (play.penalty) {
    const fouler = n.of(play.penalty_team);
    const label = penaltyLabel(play.penalty_type);
    return {
      title: `${fouler ?? kicking}, ${label}`,
      sentences: [`${subject(kicking)} 킥오프를 찼어요.`, penalty ?? KICKOFF_ROLE],
    };
  }
  // Kicks the receiving team fell on without a return (often failed onside kicks).
  return { title: `${kicking}, 킥오프`, sentences: [`${subject(kicking)} 킥오프를 찼어요.`, KICKOFF_ROLE] };
}

function describeSafety(play: PlayRow, ctx: PlayContext, n: TeamNames): Description {
  const scorerAbbr = teamThatScored(play, ctx, 2) ?? play.defteam;
  const scorer = n.of(scorerAbbr) ?? n.def;
  const concederAbbr = scorerAbbr === ctx.homeTeam ? ctx.awayTeam : scorerAbbr === ctx.awayTeam ? ctx.homeTeam : play.posteam;
  const conceder = n.of(concederAbbr) ?? n.off;
  const free = `세이프티를 내준 ${topic(conceder)} 이어서 프리킥으로 공을 넘겨줘야 해요.`;
  const title = `${scorer}, 세이프티로 2점`;
  if (play.penalty && play.play_type === "no_play") {
    const fouler = n.of(play.penalty_team);
    const label = penaltyLabel(play.penalty_type);
    return {
      title,
      sentences: [`${fouler ? `${fouler}의 ` : ""}${label}으로 세이프티가 선언돼 ${subject(scorer)} 2점을 얻었어요.`, free],
    };
  }
  if (play.sack && scorerAbbr === play.defteam) {
    return {
      title,
      sentences: [`쿼터백이 자기 엔드존 안에서 색을 당해 세이프티가 됐고, ${n.def} 수비가 2점을 얻었어요.`, free],
    };
  }
  return { title, sentences: [`세이프티가 선언돼 ${subject(scorer)} 2점을 얻었어요.`, free] };
}

function describeNoPlayPenalty(play: PlayRow, n: TeamNames): Description {
  const fouler = n.of(play.penalty_team);
  const label = penaltyLabel(play.penalty_type);
  const who = fouler ? `${fouler}의 ${label}` : label;
  const yards = play.penalty_yards ?? 0;
  let first: string;
  if (fouler !== null && play.penalty_team === play.defteam) {
    if (yards > 0) first = `${who}으로 ${subject(n.off)} ${yards}야드${play.first_down ? "와 퍼스트 다운을" : "를"} 얻었어요.`;
    else if (play.first_down) first = `${who}으로 ${subject(n.off)} 퍼스트 다운을 얻었어요.`;
    else first = `${who}이 선언됐어요.`;
  } else if (fouler !== null && play.penalty_team === play.posteam && yards > 0) {
    first = `${topic(fouler)} ${label}으로 ${yards}야드 물러났어요.`;
  } else {
    first = `${who}이 선언됐어요.`;
  }
  const second = PRE_SNAP_PENALTIES.has(play.penalty_type ?? "")
    ? "공을 스냅하기 전에 나온 반칙이라 플레이 없이 벌칙만 적용됐어요."
    : "반칙이 적용돼 이 플레이의 결과는 인정되지 않았어요.";
  const yardsText = yards > 0 ? `(${yards}야드)` : "";
  return { title: `${fouler ?? n.off}, ${label}${yardsText}`, sentences: [first, second] };
}

function describeOther(play: PlayRow, n: TeamNames): Description {
  if (play.play_type === "qb_kneel") {
    return {
      title: `${n.off}, 닐 다운(무릎 꿇기)`,
      sentences: [
        "쿼터백이 공을 받자마자 무릎을 꿇어 플레이를 끝냈어요(닐 다운).",
        play.fourth_down_failed
          ? "4번째 공격에서 필요한 거리를 채우지 못했기 때문에 공격권은 상대에게 넘어가요."
          : "주로 경기나 전반 막판에 시간을 흘려보낼 때 쓰는 플레이예요.",
      ],
    };
  }
  if (play.play_type === "qb_spike") {
    return {
      title: `${n.off}, 스파이크로 시계 멈춤`,
      sentences: [
        "쿼터백이 공을 받자마자 땅에 던져 경기 시계를 멈췄어요(스파이크).",
        "패스 실패로 처리돼 공격 기회 한 번을 쓰지만 시간을 아낄 수 있어요.",
      ],
    };
  }
  if (play.timeout) {
    return { title: "타임아웃", sentences: ["한 팀이 타임아웃을 불러 경기 시계가 멈췄어요."] };
  }
  if (play.play_type === "no_play") {
    return {
      title: play.posteam ? `${n.off}, 플레이 무효` : "플레이 무효",
      sentences: ["이 플레이는 무효 처리돼 기록에 반영되지 않았어요."],
    };
  }
  return { title: "경기 진행 기록", sentences: ["실제 플레이가 아닌 경기 진행 기록이에요."] };
}

// ---------------------------------------------------------------------------
// Penalties

const PENALTY_NAME_KO: Readonly<Record<string, string>> = {
  "Offensive Holding": "홀딩",
  "Defensive Holding": "홀딩",
  Holding: "홀딩",
  "Defensive Pass Interference": "패스 방해",
  "Offensive Pass Interference": "패스 방해",
  "False Start": "폴스 스타트",
  Offside: "오프사이드",
  "Defensive Offside": "오프사이드",
  "Offensive Offside": "오프사이드",
  "Offside on Free Kick": "오프사이드",
  "Neutral Zone Infraction": "뉴트럴 존 침범",
  Encroachment: "인크로치먼트",
  "Roughing the Passer": "러핑 더 패서",
  "Roughing the Kicker": "러핑 더 키커",
  "Unnecessary Roughness": "불필요한 거친 행위",
  "Delay of Game": "경기 지연",
  "Defensive Delay of Game": "경기 지연",
  "Illegal Formation": "부정 대형",
  "Illegal Shift": "부정 시프트",
  "Illegal Motion": "부정 모션",
  "Face Mask": "페이스마스크",
  "Face Mask (15 Yards)": "페이스마스크",
  "Intentional Grounding": "고의적 패스 버리기",
  Taunting: "도발 행위",
  "Unsportsmanlike Conduct": "비신사적 행위",
  "Defensive Too Many Men on Field": "경기장 인원 초과",
  "Offensive Too Many Men on Field": "경기장 인원 초과",
  "Kickoff Out of Bounds": "킥오프 아웃 오브 바운즈",
  "Kickoff Short of Landing Zone": "킥오프 착지 구역 미달",
  "Illegal Contact": "부정 접촉",
  "Illegal Use of Hands": "부정한 손 사용",
  "Illegal Block Above the Waist": "허리 위 부정 블록",
  "Illegal Blindside Block": "부정 블라인드사이드 블록",
  "Ineligible Downfield Pass": "패스 전 라인맨 전진",
  "Low Block": "부정 낮은 블록",
  "Chop Block": "찹 블록",
  Clipping: "클리핑",
  Tripping: "트리핑",
  "Horse Collar Tackle": "호스 칼라 태클",
  "Hip Drop Tackle": "힙 드롭 태클",
};

/**
 * Blocking fouls by the offense during a play that still counts: nflverse
 * yards_gained then ends at the foul spot, and the penalty is walked off from
 * there.
 */
const SPOT_FOULS = new Set([
  "Offensive Holding",
  "Holding",
  "Illegal Block Above the Waist",
  "Illegal Blindside Block",
  "Illegal Use of Hands",
  "Low Block",
  "Chop Block",
  "Clipping",
  "Tripping",
]);

/** Fouls that stop the play before the snap, so there was never a play to nullify. */
const PRE_SNAP_PENALTIES = new Set(["False Start", "Delay of Game", "Neutral Zone Infraction", "Encroachment"]);

/** Always ends with "반칙", so the instrumental particle is "으로" and the subject particle "이". */
function penaltyLabel(type: string | null): string {
  const name = type !== null ? PENALTY_NAME_KO[type] : undefined;
  return name ? `${name} 반칙` : "반칙";
}

/**
 * Clause (without the final period) for an enforced penalty on a play whose
 * result still counted. `sideAware` phrases it from the offense's view, which
 * only makes sense on scrimmage plays.
 */
function countedPenaltyClause(play: PlayRow, n: TeamNames, sideAware: boolean): string | null {
  if (!play.penalty) return null;
  const fouler = n.of(play.penalty_team);
  const label = penaltyLabel(play.penalty_type);
  const who = fouler ? `${fouler}의 ${label}` : label;
  const yards = play.penalty_yards ?? 0;
  if (yards <= 0) return `${who}도 선언됐어요`;
  if (sideAware && fouler !== null && play.penalty_team === play.defteam) {
    return `${who}으로 ${subject(n.off)} ${yards}야드를 더 얻었어요`;
  }
  if (sideAware && fouler !== null && play.penalty_team === play.posteam) {
    if (SPOT_FOULS.has(play.penalty_type ?? "") && (play.yards_gained ?? 0) > 0) {
      return `${topic(fouler)} ${label}으로 반칙 지점에서 ${yards}야드 물러났어요`;
    }
    return `${topic(fouler)} ${label}으로 ${yards}야드 벌칙을 받았어요`;
  }
  return `${who}으로 ${yards}야드 벌칙이 적용됐어요`;
}

/** Connective form of an enforced penalty, "애리조나의 홀딩 반칙으로 10야드 벌칙이 적용돼", or null. */
function enforcedPenaltyLead(play: PlayRow, n: TeamNames): string | null {
  if (!play.penalty) return null;
  const fouler = n.of(play.penalty_team);
  const label = penaltyLabel(play.penalty_type);
  const who = fouler ? `${fouler}의 ${label}` : label;
  const yards = play.penalty_yards ?? 0;
  return yards > 0 ? `${who}으로 ${yards}야드 벌칙이 적용돼` : `${who}도 선언돼`;
}

function penaltyFirstDownSentence(play: PlayRow, n: TeamNames): string {
  const fouler = n.of(play.penalty_team) ?? n.def;
  const label = penaltyLabel(play.penalty_type);
  const yards = play.penalty_yards ?? 0;
  return yards > 0
    ? `${fouler}의 ${label}으로 ${yards}야드를 더 얻고 퍼스트 다운도 받았어요.`
    : `${fouler}의 ${label}으로 퍼스트 다운을 받았어요.`;
}

// ---------------------------------------------------------------------------
// Glossary references

/** Glossary slugs in order of first appearance in the explanation text. */
const TERM_PATTERNS: ReadonlyArray<readonly [GlossarySlug, RegExp]> = [
  ["third-down", /3번째 공격/],
  ["fourth-down", /4번째 공격/],
  ["distance", /필요한 (거리|\d+야드)/],
  ["first-down", /퍼스트 다운|공격 기회 네 번/],
  ["incomplete-pass", /인컴플리트|패스가 잡히지 않|패스가 실패하면|패스 실패/],
  ["sack", /\(색\)|색을 당/],
  ["quarterback", /쿼터백/],
  ["interception", /가로채|가로챈|가로챘/],
  ["fumble", /펌블/],
  ["turnover", /턴오버/],
  ["touchdown", /터치다운/],
  ["extra-point", /엑스트라 포인트|추가 득점 시도/],
  ["two-point-conversion", /2점 컨버전/],
  ["field-goal", /필드골/],
  ["punt", /펀트/],
  ["kickoff", /킥오프/],
  ["touchback", /터치백/],
  ["safety", /세이프티/],
  ["end-zone", /엔드존/],
  ["penalty", /반칙/],
  ["holding", /홀딩/],
  ["pass-interference", /패스 방해/],
  ["false-start", /폴스 스타트/],
];

function termSlugsFor(text: string): string[] {
  return TERM_PATTERNS.map(([slug, pattern]) => ({ slug, index: text.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((match) => match.slug);
}

// ---------------------------------------------------------------------------
// Small helpers

function teamNames(play: PlayRow, ctx: PlayContext): TeamNames {
  const of = (abbr: string | null): string | null => (abbr ? ctx.teamShortKo(abbr) : null);
  return { off: of(play.posteam) ?? "공격 팀", def: of(play.defteam) ?? "수비 팀", of };
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

function sentence(clause: string | null): string | null {
  return clause === null ? null : `${clause}.`;
}

function optional(value: string | null): string[] {
  return value === null ? [] : [value];
}

/**
 * Korean particle choice by the last syllable's final consonant. Latin letters
 * and digits are read the Korean way (L "엘", 3 "삼", ...).
 */
function hasFinalConsonant(word: string): boolean {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return /[LMNR013678]/i.test(last);
}

function subject(word: string): string {
  return `${word}${hasFinalConsonant(word) ? "이" : "가"}`;
}

function topic(word: string): string {
  return `${word}${hasFinalConsonant(word) ? "은" : "는"}`;
}
