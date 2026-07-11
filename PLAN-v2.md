# GAZE v2 — Plan

> The chronicle PWA. Currently a single static `index.html` with hardcoded data
> arrays, hand-written timeline entries, and manually curated fragments.
> Deployed at `gaze-upon.cerebral.work` via Cloudflare Pages.

## Current state (v1)

- **One file** (`index.html`, 93KB): all HTML, CSS, JS, and data inline
- **Hardcoded data**: `repos[]`, `commitDays[]`, `sessionDays[]`, `fragments[]` as JS arrays
- **Manual timeline**: 8 hand-written `<div class="tl-entry">` blocks
- **Sections**: Scale (animated counters), Heatmap (2026 only, discrete levels), Distribution (log-scale ranked list), Chronicle (timeline), Realms (filterable repo cards), Fragments (searchable quotes), Truth (manifesto)
- **PWA**: service worker, manifest, install prompt, light/dark theme toggle
- **No build step**: deploy is `wrangler pages deploy .` on the raw file

## Problems to solve

1. **Data is frozen** — 7,590 commits hardcoded. Adding a commit means editing
   `index.html`. The chronicle can't grow.
2. **Timeline is manual** — new milestones require hand-authoring HTML. Inevitably
   goes stale.
3. **Heatmap is 2026-only** — the full era (2021–2026) exists in `commitDays[]`
   but isn't shown. No way to navigate between years.
4. **Distribution is static** — can't sort by net lines, insertions, or filter by
   category. The data is there but the interaction isn't.
5. **Fragments are curated** — 40 hand-picked quotes. The other 3,713 sessions
   are invisible.
6. **Not responsive** — heatmap and distribution are desktop-first. On mobile
   the grid overflows and the ranked list cramped.

## v2 architecture

### Build pipeline

Replace the inline data with a build step that regenerates from source.

```
scripts/
  collect.ts          # git log --pretty, session logs, engram → data.json
  build.ts             # data.json + template → index.html
  data.json            # generated, gitignored
```

**Data sources:**

| Source | What it yields | How |
|---|---|---|
| `git log` across `~/projects/cerebral/*` | commits per repo, insertions/deletions, per-day counts | `git log --pretty=format:'%ad %H' --date=short --numstat` per repo |
| Claude Code session logs | session counts per day, fragments | `~/.claude/projects/*/sessions/*.jsonl` — count + extract notable turns |
| Engram observations | curated highlights, decisions | `mem_search` for tagged highlights |

**Output:** `data.json` with the same shape as the current inline arrays, plus
a `timeline[]` array auto-generated from commit/session peaks.

**Build:** `bun scripts/build.ts` → regenerates `index.html` from template +
`data.json`. CI runs this on deploy.

### Heatmap — era scrubber

Add a year scrubber below the heatmap. Three modes:

- **Claude era** (default): May 2026 → present. The current view. Dense, the story.
- **Full era**: 2021 → present. Shows the human years, the 2025 gap, the Claude
  acceleration. Cells scale down to fit.
- **Year picker**: click a year (2021/2022/2023/2024/2025/2026) to zoom to that
  year. Same cell size, fills the width.

Implementation: same grid renderer, parameterized `firstDate`/`lastDate`. The
scrubber is a row of year buttons + an "all" button. CSS transitions on cell
size for smooth zoom.

### Distribution — sortable + filterable

Add sort controls above the list:

- **Commits** (default) — current behavior
- **Net lines** — `insertions - deletions`, descending
- **Inserted** — raw insertions
- **Deleted** — raw deletions

Add category filter chips (reuse the Realms filter pattern): design, agent,
infra, vendor, templates, archive. Clicking filters the distribution list.

Implementation: `distSort` and `distCategory` state vars. Re-render on change.
No new data needed — `repos[]` already has `category` and line counts.

### Fragments — auto-sourced

Replace the 40 hand-curated fragments with auto-extracted ones:

1. **Session log scan**: find turns with high token density, emotional
   language, or command fragments (regex on "stop", "don't", "use the",
   "full authorization", "gaze upon", profanity)
2. **Engram highlights**: pull `mem_search` results tagged as decisions or
   discoveries
3. **Manual override**: a `fragments-override.json` for hand-picked quotes that
   must survive (the "gaze upon" quote, "my heart sing", etc.)

Build step writes `fragments[]` into `data.json`. The PWA reads from data, not
inline arrays.

### Responsive

- **Heatmap**: on mobile (<768px), switch to a vertically-scrollable grid (days
  as rows, weeks as columns). Cell size 10px. Month labels rotate 90°.
- **Distribution**: on mobile, stack the row layout — repo name above, bar
  below, count right-aligned. Remove the net-lines column (available on tap).
- **Scale counters**: already responsive (flex-wrap). Verify font scaling.
- **Timeline**: single-column on mobile, already handled.
- **Realms**: grid → 1 column on mobile.

### Deployment

- **CI**: GitHub Actions on push to `main`:
  1. `bun scripts/build.ts` — regenerate `index.html` from latest git/session data
  2. `wrangler pages deploy .` — deploy to `gaze-works` project
- **Schedule**: daily cron (GitHub Actions `schedule: cron: '0 4 * * *'`) to
  regenerate with the latest commits even without a push
- **Custom domain**: `gaze-upon.cerebral.work` (already provisioned)

## Build sequence

1. **Extract data** — move `repos[]`, `commitDays[]`, `sessionDays[]`,
   `fragments[]` out of `index.html` into `data.json`. Template the HTML to read
   from `fetch('data.json')` or inline `<script src="data.js">`.
2. **Write `scripts/collect.ts`** — git log walker, session log parser, engram
   query. Output `data.json`.
3. **Write `scripts/build.ts`** — template + data → `index.html`. First version
   just inlines the JSON back (same as v1 but generated). Later: proper template.
4. **Heatmap scrubber** — year/all mode buttons, parameterized date range.
5. **Distribution sort/filter** — sort controls, category chips, re-render.
6. **Fragment auto-extraction** — session log scan + engram pull + override merge.
7. **Responsive pass** — mobile heatmap, mobile distribution, verify all
   sections at 375px width.
8. **CI** — GitHub Actions: build on push + daily cron deploy.

## Open decisions

1. **Template engine**: hand-roll string replacement (simplest, no deps) vs
   a real template engine. Lean: hand-roll. The HTML structure is fixed; only
   data arrays change.
2. **Fragment extraction heuristic**: regex keyword matching (simple, noisy) vs
   LLM scoring (accurate, costs money per build). Lean: regex first, manual
   override catches the important ones.
3. **Session log access**: logs live at `~/.claude/projects/*/sessions/*.jsonl`.
   The build runs locally or in CI with a checkout of the dotfiles. Lean: local
   build, CI just deploys the pre-built file.
4. **Timeline auto-generation**: detect peaks (local maxima in commit/session
   counts) and auto-generate timeline entries. But auto-generated text is bland
   without an LLM. Lean: auto-detect the dates, hand-write the descriptions
   (there are only ~10 per year).
