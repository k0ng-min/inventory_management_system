/* Load project-root .env without an external dependency. Explicit process
   environment values always win over values from this file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const envPath = join(rootDir, ".env");

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function loadEnv(path = envPath) {
  let source;
  try { source = readFileSync(path, "utf8"); } catch { return { loaded: false, keys: [] }; }
  const keys = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) process.env[key] = unquote(raw);
    keys.push(key);
  }
  return { loaded: true, keys };
}

loadEnv();
