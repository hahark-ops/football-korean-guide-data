// Reads BALLDONTLIE_API_KEY without ever printing it: the process environment
// first (GitHub Actions secret), then .env.local at the repository root (local runs).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const NAME = "BALLDONTLIE_API_KEY";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const clean = (value) => (value ?? "").trim().replace(/^["']|["']$/g, "");

export function readApiKey() {
  const fromEnvironment = clean(process.env[NAME]);
  if (fromEnvironment) return fromEnvironment;

  const file = path.join(root, ".env.local");
  if (!existsSync(file)) throw new Error(`${NAME} is not set in the environment and .env.local does not exist`);
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${NAME}=`));
  const key = clean(line?.slice(NAME.length + 1));
  if (!key) throw new Error(`${NAME} is not set in the environment or in .env.local`);
  return key;
}
