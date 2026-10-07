/**
 * Beginner glossary shared by the collector (play explanations reference these
 * slugs through `termSlugs`) and the app (Guide tab). Slugs are part of the
 * public data contract: never rename one without regenerating data.
 *
 * Definitions are written for someone who has never watched American football.
 * Keep each definition to one or two short sentences in 해요체.
 */
export interface GlossaryTerm {
  slug: GlossarySlug;
  termKo: string;
  termEn: string;
  definitionKo: string;
}

export const GLOSSARY_SLUGS = [
  "down",
  "first-down",
  "distance",
  "line-of-scrimmage",
  "territory",
  "drive",
  "red-zone",
  "end-zone",
  "goal-to-go",
  "touchdown",
  "extra-point",
  "two-point-conversion",
  "field-goal",
  "safety",
  "punt",
  "kickoff",
  "touchback",
  "turnover",
  "interception",
  "fumble",
  "sack",
  "incomplete-pass",
  "third-down",
  "fourth-down",
  "penalty",
  "holding",
  "pass-interference",
  "false-start",
  "overtime",
  "win-probability",
  "quarterback",
] as const;

export type GlossarySlug = (typeof GLOSSARY_SLUGS)[number];

export function isGlossarySlug(value: string): value is GlossarySlug {
  return (GLOSSARY_SLUGS as readonly string[]).includes(value);
}

/**
 * Slugs that stay valid in published data but have no entry, so their text
 * never ships in the app bundle. Win probability is used only inside the
 * collector to pick turning points and must never be shown (it can read like
 * odds in Apps in Toss review).
 */
export const SLUGS_WITHOUT_ENTRY: ReadonlySet<GlossarySlug> = new Set<GlossarySlug>(["win-probability"]);

/** Every slug above except SLUGS_WITHOUT_ENTRY has exactly one entry. */
export const GLOSSARY: GlossaryTerm[] = [
  {
    slug: "down",
    termKo: "다운",
    termEn: "Down",
    definitionKo: "공격 팀에게 주어지는 한 번의 공격 기회예요. 네 번의 다운 안에 정해진 거리(보통 10야드)를 전진하면 다시 네 번의 기회를 얻어요.",
  },
  {
    slug: "first-down",
    termKo: "퍼스트 다운",
    termEn: "First down",
    definitionKo: "필요한 거리를 채워 공격 기회 네 번을 새로 얻는 것을 말해요. 새로 시작하는 첫 공격(1st down)에서는 보통 다시 10야드를 가야 해요.",
  },
  {
    slug: "distance",
    termKo: "남은 거리",
    termEn: "Distance (yards to go)",
    definitionKo: "다음 퍼스트 다운까지 전진해야 하는 남은 야드예요. '3rd & 4'는 3번째 공격에서 4야드가 남았다는 뜻이에요.",
  },
  {
    slug: "line-of-scrimmage",
    termKo: "스크리미지 라인",
    termEn: "Line of scrimmage",
    definitionKo: "플레이를 시작할 때 공이 놓인 위치를 가로지르는 가상의 선이에요. 공격과 수비는 이 선을 사이에 두고 마주 서서 플레이를 시작해요.",
  },
  {
    slug: "territory",
    termKo: "진영",
    termEn: "Territory",
    definitionKo: "50야드 선을 기준으로 나눈 필드의 절반이에요. '상대 진영 30야드'는 상대 엔드존까지 30야드, '자기 진영 30야드'는 자기 엔드존에서 30야드 나와 있다는 뜻이에요.",
  },
  {
    slug: "drive",
    termKo: "드라이브",
    termEn: "Drive",
    definitionKo: "한 팀이 공격권을 얻은 뒤 잃을 때까지 이어지는 공격의 묶음이에요. 득점, 펀트, 턴오버, 전·후반 종료 등으로 끝나요.",
  },
  {
    slug: "red-zone",
    termKo: "레드존",
    termEn: "Red zone",
    definitionKo: "상대 엔드존까지 20야드 이내인 구역이에요. 득점 가능성이 높은 곳이라 여기서 점수를 내는지가 중요하게 다뤄져요.",
  },
  {
    slug: "end-zone",
    termKo: "엔드존",
    termEn: "End zone",
    definitionKo: "필드 양 끝에 있는 깊이 10야드의 득점 구역이에요. 공을 가진 채 상대 엔드존에 들어가거나 그 안에서 패스를 잡으면 터치다운이에요.",
  },
  {
    slug: "goal-to-go",
    termKo: "골 투 고",
    termEn: "Goal to go",
    definitionKo: "남은 거리가 엔드존까지의 거리와 같아서 퍼스트 다운 대신 터치다운을 노려야 하는 상황이에요. '1st & 골'처럼 표시해요.",
  },
  {
    slug: "touchdown",
    termKo: "터치다운",
    termEn: "Touchdown",
    definitionKo: "공을 가진 채 상대 엔드존에 들어가거나 엔드존 안에서 패스를 잡으면 6점을 얻어요. 이어서 1점이나 2점을 더하는 추가 득점 시도를 해요.",
  },
  {
    slug: "extra-point",
    termKo: "엑스트라 포인트",
    termEn: "Extra point (PAT)",
    definitionKo: "터치다운 뒤 골대 사이로 공을 차 넣어 1점을 더하는 시도예요. NFL에서는 상대 15야드 선에서 스냅해 약 33야드 거리에서 차요.",
  },
  {
    slug: "two-point-conversion",
    termKo: "2점 컨버전",
    termEn: "Two-point conversion",
    definitionKo: "터치다운 뒤 킥 대신 상대 2야드 지점에서 한 번 더 공격해 엔드존에 들어가면 2점을 얻는 시도예요. 킥보다 어렵지만 성공하면 1점이 아닌 2점을 얻어요.",
  },
  {
    slug: "field-goal",
    termKo: "필드골",
    termEn: "Field goal",
    definitionKo: "공을 차서 상대 골대의 가로대 위, 두 기둥 사이로 넘기면 3점을 얻어요. 보통 터치다운이 어려운 4번째 공격에서 시도해요.",
  },
  {
    slug: "safety",
    termKo: "세이프티",
    termEn: "Safety",
    definitionKo: "공을 가진 팀이 자기 엔드존 안에서 태클당하는 등으로 플레이가 끝나면 상대 팀이 2점을 얻어요. 점수를 내준 팀은 이어서 자기 진영 20야드에서 프리킥으로 공을 넘겨줘야 해요.",
  },
  {
    slug: "punt",
    termKo: "펀트",
    termEn: "Punt",
    definitionKo: "보통 4번째 공격에서 공을 멀리 차서 상대에게 공격권을 넘기는 플레이예요. 상대가 득점하려면 더 먼 거리를 가야 하도록 만드는 선택이에요.",
  },
  {
    slug: "kickoff",
    termKo: "킥오프",
    termEn: "Kickoff",
    definitionKo: "전반·후반을 시작할 때와 득점한 뒤에 공을 차서 상대에게 공격권을 넘기는 플레이예요. 터치다운이나 필드골 뒤에는 점수를 낸 팀이 차요.",
  },
  {
    slug: "touchback",
    termKo: "터치백",
    termEn: "Touchback",
    definitionKo: "킥이나 턴오버로 넘어온 공이 엔드존 안에서 죽거나 엔드존 밖으로 나가면, 그 엔드존을 지키는 팀이 리턴 없이 정해진 위치에서 공격을 시작하는 거예요. 펀트·턴오버 뒤에는 자기 진영 20야드, 킥오프 뒤에는 현재 규칙상 대부분 35야드에서 시작해요.",
  },
  {
    slug: "turnover",
    termKo: "턴오버",
    termEn: "Turnover",
    definitionKo: "공격 팀이 가로채기나 펌블로 공을 빼앗겨 공격권이 상대에게 넘어가는 거예요. 4번째 공격에 실패해 공격권을 내주는 것은 '턴오버 온 다운스'라고 해요.",
  },
  {
    slug: "interception",
    termKo: "인터셉션(가로채기)",
    termEn: "Interception",
    definitionKo: "수비 선수가 상대 패스를 땅에 닿기 전에 잡아내는 거예요. 공격권이 바로 수비 팀으로 넘어가고, 잡은 선수는 그대로 달릴 수 있어요.",
  },
  {
    slug: "fumble",
    termKo: "펌블",
    termEn: "Fumble",
    definitionKo: "공을 가진 선수가 공을 놓치는 거예요. 떨어진 공은 어느 팀이든 잡을 수 있고, 수비 팀이 잡으면 공격권이 넘어가요.",
  },
  {
    slug: "sack",
    termKo: "색",
    termEn: "Sack",
    definitionKo: "쿼터백이 패스를 던지기 전에 스크리미지 라인 뒤에서 태클당하는 거예요. 공격 팀은 그만큼 뒤로 밀리고 공격 기회 한 번을 써요.",
  },
  {
    slug: "incomplete-pass",
    termKo: "패스 실패(인컴플리트)",
    termEn: "Incomplete pass",
    definitionKo: "던진 패스를 아무도 잡지 못하고 땅에 떨어지거나 밖으로 나간 거예요. 공은 원래 자리로 돌아오고 경기 시계가 멈추며, 공격 기회 한 번을 쓴 걸로 쳐요.",
  },
  {
    slug: "third-down",
    termKo: "3번째 공격(서드 다운)",
    termEn: "Third down",
    definitionKo: "네 번의 공격 기회 중 세 번째예요. 여기서 필요한 거리를 채우지 못하면 보통 4번째 공격에서 펀트나 필드골을 선택해요.",
  },
  {
    slug: "fourth-down",
    termKo: "4번째 공격(포스 다운)",
    termEn: "Fourth down",
    definitionKo: "네 번의 공격 기회 중 마지막이에요. 실패하면 그 자리에서 공격권이 넘어가서 보통 펀트나 필드골을 차지만, 직접 공격을 시도하기도 해요.",
  },
  {
    slug: "penalty",
    termKo: "반칙(페널티)",
    termEn: "Penalty",
    definitionKo: "규칙을 어긴 팀에 주는 벌칙이에요. 보통 반칙한 팀에 불리하게 정해진 야드만큼 공을 옮기고, 반칙에 따라 플레이 결과가 취소되거나 상대가 퍼스트 다운을 얻어요.",
  },
  {
    slug: "holding",
    termKo: "홀딩",
    termEn: "Holding",
    definitionKo: "상대 선수를 손이나 팔로 붙잡아 움직임을 막는 반칙이에요. 공격 홀딩은 기본 10야드, 수비 홀딩은 5야드와 자동 퍼스트 다운이 주어져요.",
  },
  {
    slug: "pass-interference",
    termKo: "패스 방해",
    termEn: "Pass interference",
    definitionKo: "패스가 날아가는 동안 상대 선수가 공을 잡지 못하도록 몸으로 방해하는 반칙이에요. 수비가 저지르면 반칙한 지점에 공을 놓고 퍼스트 다운을 줘서 큰 벌칙이 돼요.",
  },
  {
    slug: "false-start",
    termKo: "폴스 스타트",
    termEn: "False start",
    definitionKo: "공격 선수가 스냅 전에 먼저 움직이는 반칙이에요. 플레이는 시작되지 않고 공격 팀이 5야드 뒤로 물러나요.",
  },
  {
    slug: "overtime",
    termKo: "연장전",
    termEn: "Overtime",
    definitionKo: "4쿼터가 끝났을 때 동점이면 이어서 하는 연장 경기예요. 정규 시즌은 10분 동안 하고 그래도 동점이면 무승부로 끝나며, 플레이오프는 승부가 날 때까지 계속해요.",
  },
  {
    slug: "quarterback",
    termKo: "쿼터백",
    termEn: "Quarterback",
    definitionKo: "공격을 이끄는 선수예요. 스냅된 공을 받아 패스를 던지거나, 다른 선수에게 건네거나, 직접 들고 달려요.",
  },
];
