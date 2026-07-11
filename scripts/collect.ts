#!/usr/bin/env bun
/**
 * collect.ts — GAZE data collector
 *
 * Walks git repos and Claude session logs → writes data.json
 *
 * Data sources:
 *   - git log per repo → commits, insertions, deletions, per-day counts
 *   - ~/.claude/projects/ (all .jsonl session logs) → session counts per day
 *
 * Usage: bun scripts/collect.ts [--fragments]
 *   --fragments: also extract session fragments (slow, scans all session logs)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';


const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const projectsRoot = join(process.env.HOME ?? '/home/ctodie', 'projects');
const claudeProjectsRoot = join(process.env.HOME ?? '/home/ctodie', '.claude', 'projects');

// ============= TYPES =============

interface Repo {
  name: string;
  commits: number;
  insertions: number;
  deletions: number;
  net: number;
  desc: string;
  category: string;
}

interface Fragment {
  t: string;
  d: string;
  tags: string[];
}

interface DayCount {
  date: string;
  count: number;
}

// ============= CONFIG =============

// Repo name prefix → category mapping
const CATEGORY_MAP: Record<string, string> = {
  'cerebral/dreamcode': 'design',
  'cerebral/rina': 'design',
  'cerebral/site': 'design',
  'cerebral/cerebral-design': 'design',
  'cerebral/cerebral-design-rfc': 'design',
  'cerebral/reverie-demos': 'design',
  'cerebral/reverie': 'agent',
  'cerebral/reverie-r0': 'agent',
  'cerebral/reverie-slack-app': 'agent',
  'cerebral/cortex': 'agent',
  'cerebral/attention-router-wt': 'agent',
  'cerebral/linearctl': 'agent',
  'cerebral/terrarium': 'platform',
  'unsigned/paas': 'platform',
  'cerebral/files-portal': 'platform',
  'cerebral/openpanel': 'platform',
  'cerebral/mission-control': 'platform',
  'cerebral/revenant': 'infra',
  'cerebral/tailnet': 'infra',
  'cerebral/ml-images': 'infra',
  'cerebral/models': 'infra',
  'cerebral/governance': 'infra',
  'cerebral/docs': 'infra',
  'cerebral/legal': 'infra',
  'cerebral/catalog': 'infra',
  'cerebral/cicatrix': 'infra',
  'cerebral/many-realms': 'infra',
  'cerebral/reverie-rd17-adopt': 'infra',
  'vendor/rtk': 'vendor',
  'vendor/claude-hud': 'vendor',
  'vendor/claude-esp': 'vendor',
  'vendor/beepboopd': 'vendor',
  'vendor/action-runners': 'vendor',
  'todie/heretic': 'ops',
  'todie/dotfiles': 'ops',
  'todie/revenant': 'ops',
  'todie/explainers': 'ops',
  'todie/pact': 'ops',
  'todie/agentic': 'ops',
  'todie/reach': 'ops',
  'todie/mcp-honeypot': 'ops',
  'todie/nahbro.dev': 'ops',
  'todie/Signal-Desktop': 'ops',
  'todie/attention-router': 'ops',
  'todie/claude-code': 'ops',
  'todie/expression-manifold': 'ops',
  'todie/aaronbisla.com': 'ops',
  'todie/ghost-blog': 'ops',
  'todie/claude-session-manager': 'ops',
  'unsigned/gg': 'platform',
  'unsigned/agent-jury': 'agent',
  'unsigned/dc': 'infra',
  'unsigned/k8s-audit': 'infra',
  'unsigned/action-runners': 'infra',
  'templates/node': 'templates',
  'templates/rust': 'templates',
  'templates/terraform': 'templates',
  '_archive/todie-daemon-rs': 'archive',
  'identity': 'identity',
};

// Descriptions — preserved from v1 data, keyed by repo name
const DESC_PATH = join(root, 'data.json');
const existingDescs: Record<string, string> = {};
if (existsSync(DESC_PATH)) {
  try {
    const old = JSON.parse(readFileSync(DESC_PATH, 'utf-8'));
    for (const r of old.repos as Repo[]) existingDescs[r.name] = r.desc;
  } catch { /* first run */ }
}

// ============= GIT COLLECTION =============

interface GitRepoStats {
  commits: number;
  insertions: number;
  deletions: number;
}

function collectGitStats(repoPath: string): GitRepoStats | null {
  if (!existsSync(join(repoPath, '.git'))) return null;

  let commits = 0;
  let insertions = 0;
  let deletions = 0;

  // Count commits
  try {
    const out = execSync('git log --oneline --all 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
    commits = out.trim().split('\n').filter(Boolean).length;
  } catch { return null; }

  if (commits === 0) return null;

  // Sum insertions/deletions
  try {
    const out = execSync('git log --pretty=format: --numstat --all 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        if (!isNaN(ins)) insertions += ins;
        if (!isNaN(del)) deletions += del;
      }
    }
  } catch { /* numstat failed, use commit count only */ }

  return { commits, insertions, deletions };
}

function collectCommitDays(repoPath: string): DayCount[] {
  try {
    const out = execSync('git log --pretty=format:%ad --date=short --all 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
    const counts: Record<string, number> = {};
    for (const line of out.trim().split('\n')) {
      const d = line.trim();
      if (d) counts[d] = (counts[d] ?? 0) + 1;
    }
    return Object.entries(counts).map(([date, count]) => ({ date, count }));
  } catch { return []; }
}

function discoverRepos(): { name: string; path: string }[] {
  const repos: { name: string; path: string }[] = [];
  const seenPaths = new Set<string>();  // dedup by realpath

  // Scan top-level project groups
  for (const group of readdirSync(projectsRoot)) {
    const groupPath = join(projectsRoot, group);
    let isDir = false;
    try { isDir = statSync(groupPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    // Check if group itself is a git repo (e.g., 'identity', 'reverie')
    if (existsSync(join(groupPath, '.git'))) {
      const real = realpathSync(groupPath);
      if (!seenPaths.has(real)) { seenPaths.add(real); repos.push({ name: group, path: groupPath }); }
      continue;
    }

    // Scan subdirectories
    for (const sub of readdirSync(groupPath)) {
      const subPath = join(groupPath, sub);
      let subIsDir = false;
      try { subIsDir = statSync(subPath).isDirectory(); } catch { continue; }
      if (!subIsDir) continue;
      if (existsSync(join(subPath, '.git'))) {
        const real = realpathSync(subPath);
        if (!seenPaths.has(real)) { seenPaths.add(real); repos.push({ name: `${group}/${sub}`, path: subPath }); }
      }
    }
  }

  return repos;
}

// ============= SESSION COLLECTION =============

function collectSessionDays(): DayCount[] {
  const counts: Record<string, number> = {};
  const findOut = execSync(`find "${claudeProjectsRoot}" -name '*.jsonl' -type f`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const files = findOut.trim().split('\n').filter(Boolean);

  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      const firstLine = content.split('\n')[0];
      const obj = JSON.parse(firstLine) as { timestamp?: string };
      const ts = obj.timestamp;
      if (ts) {
        const date = ts.slice(0, 10);
        counts[date] = (counts[date] ?? 0) + 1;
      }
    } catch { /* skip unreadable files */ }
  }

  return Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ============= FRAGMENT EXTRACTION =============

const FRAGMENT_KEYWORDS = /\b(full authorization|gaze upon|despair|godmode|mint shit|decommission|sicknasty|humble|heart sing|fuck|shit|damn|hell yes|let'?s go|kill it|burn it|ship it|don'?t bother|stop using|stop doing|i don'?t want|i don'?t know how|i don'?t understand)\b/i;
const FRAGMENT_TAG_MAP: Record<string, string[]> = {
  'fire': ['fuck', 'shit', 'damn', 'hell yes', "let's go", 'sicknasty'],
  'command': ['full authorization', 'godmode', 'decommission', 'kill it', 'burn it', 'ship it', "don't bother", 'stop using', 'stop doing', "i don't want"],
  'culture': ['humble', 'heart sing', 'gaze upon', 'despair', 'sicknasty'],
  'infra': ['godmode', 'mint', 'decommission', 'deploy'],
  'platform': ['ship', 'deploy', 'platform'],
  'reflective': ['despair', 'humble', 'gaze upon', "i don't know how", "i don't understand"],
};

function extractTags(text: string): string[] {
  const tags = new Set<string>();
  const lower = text.toLowerCase();
  for (const [tag, keywords] of Object.entries(FRAGMENT_TAG_MAP)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) { tags.add(tag); break; }
    }
  }
  return [...tags];
}

function collectFragments(): Fragment[] {
  const fragments: Fragment[] = [];
  const findOut = execSync(`find "${claudeProjectsRoot}" -name '*.jsonl' -type f`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const files = findOut.trim().split('\n').filter(Boolean);

  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as {
          type?: string;
          content?: string | unknown[];
          message?: { content?: string | Array<{ type?: string; text?: string }> };
          timestamp?: string;
        };
        if (obj.type !== 'user') continue;

        // Claude Code stores user text in message.content, NOT top-level content
        const rawContent = obj.message?.content ?? obj.content;
        if (!rawContent) continue;

        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? (rawContent as Array<{ text?: string }>).map(c => c.text ?? '').join(' ')
            : '';

        if (text.length < 15 || text.length > 300) continue;
        if (text.includes('<command-') || text.startsWith('<')) continue;  // skip XML command wrappers
        if (!FRAGMENT_KEYWORDS.test(text)) continue;
        // Skip operational noise: merge/review/deploy commands without personality
        if (/^(merge|review|deploy|did the|just deploy|do the merge|split and|keep the|check the pr)/i.test(text.trim()) && text.length < 80) continue;

        const tags = extractTags(text);
        if (tags.length === 0) continue;
        // Filter noise: if only "command" tag, require >60 chars to keep
        if (tags.length === 1 && tags[0] === 'command' && text.length < 60) continue;

        const ts = obj.timestamp ?? '';
        const day = ts ? `Day ${Math.floor((new Date(ts).getTime() - new Date('2026-04-21').getTime()) / 86400000) + 1}` : '';

        fragments.push({ t: text.trim(), d: day, tags });
      }
    } catch { /* skip */ }
  }

  // Deduplicate by text, keep first occurrence
  const seen = new Set<string>();
  const unique: Fragment[] = [];
  for (const f of fragments) {
    const key = f.t.toLowerCase().slice(0, 80);
    if (!seen.has(key)) { seen.add(key); unique.push(f); }
  }

  // Sort by day, then by number of tags (most interesting first)
  unique.sort((a, b) => {
    if (a.d !== b.d) return a.d.localeCompare(b.d);
    return b.tags.length - a.tags.length;
  });

  return unique.slice(0, 100);
}

// ============= MAIN =============

const wantFragments = process.argv.includes('--fragments');

console.log('Discovering repos...');
const repoPaths = discoverRepos();
console.log(`  Found ${repoPaths.length} git repos`);

console.log('Collecting git stats...');
const repos: Repo[] = [];
const allCommitDays: Record<string, number> = {};
const seenRepoKeys = new Set<string>();  // dedup by commit count + first hash
for (const { name, path } of repoPaths) {
  process.stdout.write(`  ${name}...`);
  const stats = collectGitStats(path);
  if (!stats) { process.stdout.write(' skip (no git data)\n'); continue; }

  // Dedup by commit count + first commit hash (catches worktrees/clones of same repo)
  let firstHash = '';
  try {
    firstHash = execSync('git log --reverse --pretty=format:%H --all 2>/dev/null | head -1', { cwd: path, encoding: 'utf-8' }).trim();
  } catch { /* ignore */ }
  const dedupKey = `${stats.commits}:${firstHash}`;
  if (seenRepoKeys.has(dedupKey)) { process.stdout.write(' skip (duplicate of earlier repo)\n'); continue; }
  seenRepoKeys.add(dedupKey);

  const days = collectCommitDays(path);
  for (const { date, count } of days) {
    allCommitDays[date] = (allCommitDays[date] ?? 0) + count;
  }

  const category = CATEGORY_MAP[name] ?? 'ops';
  const desc = existingDescs[name] ?? '';
  repos.push({
    name,
    commits: stats.commits,
    insertions: stats.insertions,
    deletions: stats.deletions,
    net: stats.insertions - stats.deletions,
    desc,
    category,
  });
  process.stdout.write(` ${stats.commits} commits\n`);
}

repos.sort((a, b) => b.commits - a.commits);

console.log('Collecting session days...');
const sessionDays = collectSessionDays();
console.log(`  ${sessionDays.length} active session days`);

const commitDays = Object.entries(allCommitDays)
  .map(([date, count]) => [date, count] as [string, number])
  .sort((a, b) => a[0].localeCompare(b[0]));

let fragments: Fragment[] = [];
const overridePath = join(root, 'fragments-override.json');
const overrides: Fragment[] = existsSync(overridePath)
  ? JSON.parse(readFileSync(overridePath, 'utf-8')) as Fragment[]
  : [];
if (overrides.length > 0) console.log(`  Loaded ${overrides.length} override fragments`);

if (wantFragments) {
  console.log('Extracting fragments from session logs...');
  const extracted = collectFragments();
  console.log(`  ${extracted.length} auto-extracted`);
  // Merge: overrides first (deduplicated), then auto-extracted
  const seen = new Set<string>();
  for (const f of overrides) { seen.add(f.t.toLowerCase().slice(0, 80)); fragments.push(f); }
  for (const f of extracted) {
    const key = f.t.toLowerCase().slice(0, 80);
    if (!seen.has(key)) { seen.add(key); fragments.push(f); }
  }
  console.log(`  ${fragments.length} total fragments (${overrides.length} overrides + ${fragments.length - overrides.length} auto)`);
} else {
  // Preserve existing fragments
  try {
    const old = JSON.parse(readFileSync(DESC_PATH, 'utf-8'));
    fragments = old.fragments as Fragment[];
    console.log(`  Preserved ${fragments.length} existing fragments`);
  } catch { console.log('  No existing fragments to preserve'); }
}

const sessionDaysTuples = sessionDays.map(d => [d.date, d.count] as [string, number]);
const data = { repos, fragments, commitDays, sessionDays: sessionDaysTuples };
writeFileSync(join(root, 'data.json'), JSON.stringify(data, null, 2));
console.log(`\n✓ data.json written (${JSON.stringify(data).length} bytes)`);
console.log(`  ${repos.length} repos, ${commitDays.length} commit days, ${sessionDays.length} session days, ${fragments.length} fragments`);
