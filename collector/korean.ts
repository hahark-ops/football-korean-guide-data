/** Small helpers for grammatical Korean particles in generated sentences. */

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

/**
 * Whether the word ends in a final consonant (받침). Latin letters and digits
 * fall back to how they are usually read aloud in Korean.
 */
export function hasFinalConsonant(word: string): boolean {
  const trimmed = word.trim();
  if (trimmed === "") return false;
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last >= HANGUL_START && last <= HANGUL_END) return (last - HANGUL_START) % 28 !== 0;
  const char = trimmed[trimmed.length - 1].toUpperCase();
  // 영(0) 일 삼 육 칠 팔 십: 받침 있음 / 이 사 오 구: 없음
  if (/[0-9]/.test(char)) return "013678".includes(char);
  // L, M, N, R are read with a final consonant (엘, 엠, 엔, 알).
  return "LMNR".includes(char);
}

type ParticlePair = "이/가" | "을/를" | "은/는" | "과/와" | "으로/로";

/** Appends the right particle, e.g. josa("애틀랜타", "이/가") -> "애틀랜타가". */
export function josa(word: string, pair: ParticlePair): string {
  const [withFinal, withoutFinal] = pair.split("/");
  if (pair === "으로/로" && endsWithRieul(word)) return `${word}로`;
  return `${word}${hasFinalConsonant(word) ? withFinal : withoutFinal}`;
}

/** ㄹ 받침 takes "로" as if there were no final consonant (필드골로, 21로). */
function endsWithRieul(word: string): boolean {
  const trimmed = word.trim();
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last >= HANGUL_START && last <= HANGUL_END) return (last - HANGUL_START) % 28 === 8;
  // 일(1), 칠(7), 팔(8); a trailing 0 is read 십/백/천/영, none of which end in ㄹ.
  if (/[178]$/.test(trimmed)) return true;
  return /L$/i.test(trimmed);
}

/** "A", "A와 B", "A, B와 C" */
export function joinKo(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  const head = words.slice(0, -1);
  const lastHead = head[head.length - 1];
  return [...head.slice(0, -1), josa(lastHead, "과/와")].join(", ") + ` ${words[words.length - 1]}`;
}
