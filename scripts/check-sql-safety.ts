#!/usr/bin/env tsx
/**
 * CI guard: flag risky raw SQL patterns that may concatenate user input.
 * Drizzle parameterized sql`...${val}` is allowed; string-built queries are not.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCAN_DIRS = ["src", "api", "services", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

type Finding = { file: string; line: number; rule: string; snippet: string };

const RULES: Array<{ id: string; pattern: RegExp }> = [
  { id: "sql-raw", pattern: /\bsql\.raw\s*\(/ },
  { id: "db-execute-template", pattern: /\.execute\s*\(\s*`/ },
  { id: "db-query-template", pattern: /\.query\s*\(\s*`/ },
  /** String-built SQL outside Drizzle sql` tag (heuristic: SQL verb + table-ish fragment). */
  {
    id: "string-built-sql",
    pattern:
      /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b[^`]*\$\{[^}]+\}[^`]*`/i,
  },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
}

function scanFile(path: string): Finding[] {
  const rel = relative(ROOT, path);
  const lines = readFileSync(path, "utf8").split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (/\bsql\s*`/.test(line)) continue;
      findings.push({
        file: rel,
        line: i + 1,
        rule: rule.id,
        snippet: line.trim().slice(0, 120),
      });
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    try {
      walk(full, files);
    } catch {
      // optional dir missing
    }
  }

  const all = files.flatMap(scanFile);
  if (all.length === 0) {
    // eslint-disable-next-line no-console
    console.log("check-sql-safety: OK (no risky patterns)");
    return;
  }

  // eslint-disable-next-line no-console
  console.error("check-sql-safety: FAILED — review these lines (use Drizzle builders or sql` tagged params):\n");
  for (const f of all) {
    // eslint-disable-next-line no-console
    console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.snippet}`);
  }
  process.exit(1);
}

main();
