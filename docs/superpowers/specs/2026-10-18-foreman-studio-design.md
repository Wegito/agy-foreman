# Foreman Studio: design

**Status:** design, approved in brainstorming on 2026-10-18; not yet planned.
**Visual reference:** [mockup.html](2026-10-18-foreman-studio/mockup.html), the final mockup (v10) from brainstorming. It is the source of truth for look and feel. It runs on fake data. See "Running the mockup" at the end.

## 1. Intent

agy-foreman runs plan tasks through Gemini in the background, and today the only live view is a one-line status line in Claude Code. Foreman Studio is a desktop program that makes that work visible and good to look at. The user keeps working in Claude Code as before, and a window shows the plan's progress live, mostly as a glowing human brain that assembles itself as tasks finish.

The user wants three things: to see progress at a glance without reading logs, to know when they must stay at the computer, and to have something that feels premium. "Not too much info" and "luxury, don't go crazy with color" were stated repeatedly. The brain is the centrepiece. Everything else stays quiet.

### Goals
- One command, `agy-foreman studio`, starts the whole system in the current repo and opens a native desktop window. It is not a browser tab.
- The window shows the real Claude Code session in a terminal card, and the plan's live state as a 3D brain plus a few calm cards.
- It works whether the user drives Claude from the window or from their own cmd window (see §5).
- It warns ahead of time when an upcoming task will need the user's approval, and offers a "Full access" switch.
- It shows Claude and Gemini usage against their 5-hour and weekly limits.

### Non-goals
- Not a replacement for Claude Code. The window hosts or mirrors the real `claude` CLI and never reimplements chat.
- No new delegation features. The studio reads agy-foreman's state. Only three server-side changes are in scope: Full access (§6.4), recording the finalize outcome on the job record (§7.1), and the session hooks `init` installs (§5).
- No web version and no remote or multi-machine viewing.
- No analytics panels, charts or log viewers beyond what is listed here.

### Anti-goals (would make it a failure even if it works)
- Busy or loud: dense numbers, many colors, saturated reds or greens, or "dashboard" clutter. The palette is warm near-black with champagne, ivory and pearl, plus one muted oxblood for failure.
- A brain that looks like math. The brain uses a real anatomical mesh and must read as a real brain at a glance.
- Opaque or solid brain rendering. The user rejected a solid "obsidian" version: the brain is see-through glowing points.
- Typing in two places into one live session, or anything that could corrupt a Claude conversation (§5).

## 2. How the user runs it

Today the user runs `agy-foreman init` once, then starts `claude` in cmd. Studio keeps that flow and adds one command:

```
agy-foreman studio
```

Run in a repo, it:
1. runs the `init` steps if the repo isn't set up yet (config, status line, skill, MCP registration), with the same output and prompts as `init`
2. opens the Studio window for that repo
3. inside the window's terminal card, starts `claude` already connected to the agy-foreman MCP server, unless a Claude session is already running in cmd for this repo, in which case it follows that session instead (§5).

The window opens only through this command. It never opens on its own when `claude` starts in cmd. That was the user's explicit choice.

## 3. Layout

The layout is three columns over the full window height, with no title bar content: no product name and no plan file name.

| Area | Content |
|---|---|
| Left column | **Claude card**, which takes most of the height (§5), and **Files card**: the files the running task touches, with M/A markers. Files that are only planned show dimmed. |
| Centre | **Brain** (§4), the **plan ring** at top centre, a **caption** at bottom centre (lobe name, task name in serif italic, a status line), and the **timer** in the bottom-right corner (elapsed plan time, mono, with a breathing gold dot). |
| Right column | Four cards, top to bottom: **Usage**, **Now**, **Heads-up**, **Plan** (§6). |

Interaction rules:
- **Cards:** every card collapses to its header with a `–` button, and can be resized vertically by dragging its corner.
- **Side columns:** you can widen or narrow them by dragging the edge between a column and the centre. The edge draws nothing; only the cursor changes. The user asked for the visible divider lines to be removed.
- **Hiding the right column:** a small round chevron button at the top right of the centre area slides the whole right column away, and the brain takes the space. The same button or the `]` key brings it back.
- **Remembered layout:** sizes, collapsed state and the hidden-column state are remembered per user (local settings). This was my call.

Type: Cormorant Garamond for display (italic), Inter for UI, JetBrains Mono for the terminal and timer. Colours: see the CSS variables in the mockup (`--bg #0a0908`, `--gold #d8c39a`, `--ivory #ece6da`, `--pearl #c3c9d2`, oxblood `#93424b` for failure).

## 4. The brain

### 4.1 Geometry and look
- **Source mesh:** the MNI ICBM152 2009 brain surface (`mni152_2009.mz3`, about 612k triangles) from NiiVue's demo assets, preprocessed at build time by `bake-brain.mjs` (in the spec folder).
- **Points:** the script spreads about 95k points over the surface, weighting by area and thinning points on sulcal walls. Each point stores a "crest" value (how much the surface faces outward, used for brightness, so gyri read) and a region.
- **Lobes only:** frontal (prefrontal included), parietal, occipital and temporal, each split into left and right halves. The cerebellum and brainstem are dropped. The user didn't like their structure.
- **Rendering:** Three.js points with additive blending and a soft round sprite, plus `UnrealBloomPass` bloom. There is no solid surface: the brain must stay see-through. It auto-rotates slowly; the user can drag to orbit and scroll to zoom, but not pan.
- **Lobe colours:** each lobe has its own muted tone: frontal champagne `#d8c39a`, parietal pearl `#c3c9d2`, occipital ivory `#efe3c4`, temporal rose `#cbb3a8`. A failed task's lobe turns oxblood.
- **Brightness by status:** done is a steady glow, running breathes slowly, failed pulses gently, not started is dim at about 0.3.
- **Lock this look.** The user said the v9/v10 brain "looks amazing, no update on the brain". Treat the mockup's sampling density, brightness levels, bloom settings (strength 0.7, radius 0.5, threshold 0.25) and colours as the target.

### 4.2 Which tasks are on the brain
The four lobes show a **sliding window of 4 plan tasks**: the task finished just before the running one, the running one, and the next two. At the start of a plan, the window is tasks 1–4. At the end, it is the last 4. The window maps to the lobes in this order: frontal, parietal, occipital, temporal. When the window slides, the lobes take their new tasks with a short crossfade. (The crossfade is my call; the user hasn't seen one.)

Rule when nothing is running: the window holds the 4 tasks around the next task to run, or the last 4 when the plan is done. This rule is my call.

**Two tasks at once** (`max_concurrent` defaults to 2): the window anchors on the lowest-numbered running task. Any other running task inside the window also breathes, drifts in by its own progress, and fires its own cascades from its own tokens. The Now card stacks the running tasks as compact rows, one per task. The Files card and the caption follow the anchored task, unless the user hovers over or clicks another. My call.

### 4.3 Assembly = progress
- Each lobe's two halves sit away from the centre along the direction from the brain's centre to that half, by a distance of `(1 − ease(progress)) × 0.62` in scene units, smoothed over time.
- **Not started:** progress 0, fully apart.
- **Running:** progress comes from the job record (§7) and drifts in as it updates.
- **Done:** 1, locked in place.
- **Failed:** sits partly out, at progress 0.35, with a slight tremble.
- Pieces that are out bob gently, so the brain never looks frozen.
- Finished lobes fuse into the whole brain, with no gap left. This is my call, and the user has not objected. The brain is whole only when the plan is.

### 4.4 Neural firing
- **Neurons:** each lobe half has a sparse neuron mesh, about 420 neurons picked from its points, linked to their 5 nearest neighbours **within the same half**. Links never cross the gap.
- **Cascades:** a cascade starts at one neuron and travels along the links. The signal runs down a link as a growing line, the next neuron flashes, and the cascade branches: 3 branches at the start, then sometimes 2. It stops after 6–10 hops, and links afterglow for about 0.7 s.
- **One cascade = 100 tokens.** Every 100 tokens the running task uses fires one cascade in its lobe, in its colour.
- **Background activity:** finished lobes fire small quiet cascades about every 1.6 s. A failed lobe fires a stuttering cascade that dies after 2 hops.
- The running lobe also shows a faint resting web of its links, at about 7% opacity.

### 4.5 Hover and focus
- **Hovering a lobe:** that lobe brightens, the others dim to about 50%, and a small card appears next to the cursor:
  - "Task N · Lobe"
  - the task name in serif
  - a one-line description: the first sentence of the task's section in the plan file
  - status: merged, running with % and tokens, failed with the reason, or not started with what's coming.
- **Hover hit-testing:** project a subsample of the points, including their explode offsets, and pick the front-most one within 12 px of the cursor. The card hides while the user drags to rotate.
- **Clicking a task** in the Plan card spotlights its lobe and dims the rest. Clicking again clears it.

## 5. The Claude card and syncing with cmd

The card has two modes, shown as a small pill in its header.

**Live here:** the card is a real terminal running `claude`, with full colour, keyboard, resizing and Claude Code's own UI. It is a pseudo-terminal (node-pty) rendered with xterm.js.

**Following cmd:** if the user already runs `claude` in their own cmd window for this repo, the card shows that conversation live and read-only, rendered from Claude Code's on-disk session transcript. A footer explains: "Mirroring your cmd session. When you close cmd, it continues here."

Detecting a cmd session (my call):
- **Session-start hook:** `init` installs a Claude Code session-start hook as well as the session-end one. It writes a marker into the state directory: session ID, cwd, process ID and source.
- **Telling sessions apart:** the studio launches its embedded `claude` with an environment variable (for example `FOREMAN_STUDIO=1`). The hook copies it into the marker, so the studio can tell its own session from one in cmd.
- **Running means:** a cmd session counts as running when its marker exists for this repo, its process ID is alive, and there's no matching session-end marker.
- **Ambiguous cases** (process ID gone but no end marker) count as ended only after a check that no `claude` process with that session is alive.
- `init --uninstall`, or the existing uninstall path, removes both hooks.

Handoff:
- **When the cmd session ends,** the card resumes that same conversation in its own terminal (`claude --resume <session id>`), and the pill switches to "live here".
- **How the studio learns the session ended:** `init` installs a Claude Code session-end hook that writes a small marker the studio watches. Watching the transcript alone isn't enough, because idle and closed look the same.
- **A "Continue here" button** in the footer does the handoff on demand. It is only enabled once the cmd session has ended. Before that, it explains that the session is open in cmd.
- **The other direction:** after closing the window, `claude --continue` in cmd picks the conversation up. Nothing extra is needed.
- **Hard rule:** one live process per conversation. The studio never resumes a session while another `claude` process still has it open.

Brain and cards work in both modes, because they read agy-foreman's state files, not the terminal.

## 6. Right-column cards

### 6.1 Usage (top right)
- **Header:** "Usage", with the 5-hour reset countdown.
- **5-hour window:** used % for Claude (champagne bar) and Gemini (pearl bar).
- **Weekly:** the same two, with a weekly reset note.
- **Plan:** a bar with done/total.
- Bars are 3 px hairlines. Used % above about 80% may shift toward oxblood. (That threshold is my call.)
- **Gemini numbers:** they already exist: `usage-quota.ts` caches `agy -p /usage` (5-hour and weekly remaining %) in `quota.json`. Show used = 100 − remaining.
- **Claude numbers:** take them from the JSON Claude Code passes to the status line on stdin. The status line process already runs every few seconds inside Claude Code: have it write the Claude usage fields to a cache file next to `quota.json`, and the studio reads that file. *To verify:* that Claude Code's status line input carries 5-hour and weekly usage, and what the fields are called. If it doesn't, show only Gemini rows and say so in the card. Don't invent numbers.

### 6.2 Now
The running task's name in large serif, a 6-segment phase bar (prepare, contract, brief, run, verify, report; done segments gold, the current one breathing), and three stats: phase, tokens, tool calls.

### 6.3 Heads-up
It appears only when there's something to say, and collapses to nothing otherwise. (Collapsing when empty is my call; the mockup always shows it.) It warns about approvals the server can predict:
- **Plan approval:** in `per_plan` mode, the next task isn't covered by the existing plan grant, for example because the plan file changed.
- **Task approval:** in `per_task` mode, every upcoming task.
- **Quota:** Gemini 5-hour quota is close enough to empty that a quota card is likely.

Text example: "Task 7 will ask for your approval · stay close". Claude Code's own tool-permission prompts can't be predicted and are out of scope. Show an ETA only if a real estimate exists (job `etaSec`), never a guess.

### 6.4 Full access
A switch in the Heads-up card: "Full access: run the rest of the plan without asking."
- **Scope:** it approves the remaining tasks of the current plan file, and only those. My call is that it lasts until the current plan ends, and the user has not objected. It is off by default and clearly shown while on.
- **Mechanism (my call):** the server stores a "Full access" grant for the plan file, keyed to the plan file's content the way plan grants already are, so editing the plan ends it by itself. The approval step in `jobs/start.ts` checks it in **both** approval modes. It already checks plan grants in `per_plan`, and in `per_task` it must skip the task card while Full access covers the plan. The user asked for Full access without conditions, so it has to work in `per_task` too.
- **Expiry:** existing grants expire after 24 h. A Full access grant lasts until the plan ends or the user turns it off; there is no fixed TTL.
- **Turning it off** removes the grant, and later tasks ask again as usual.
- **Before any job:** "current plan" comes from job records, so before the first task of a plan starts the studio doesn't know which plan to grant. The switch is disabled with the hint "starts with the first task". The first task's normal approval happens anyway.
- **Limits:** it does not affect quota cards, lesson-promotion cards, or Claude Code's own permission prompts.
- **Writes go through the server:** this is the one place the studio changes server behavior, so the server should do the write through a small API or file protocol, never the studio writing grants directly. *For the builder:* pick the mechanism, keep it auditable (it already logs to `approvals.jsonl`).

### 6.5 Plan
- **Dots:** one dot per plan task on a hairline, which is gold up to the progress point.
- **Colours:** done tasks show their colour, running has a breathing ring, failed is oxblood, not started is hollow.
- **Hover:** grows the dot and shows "N · Task name".
- **Click:** spotlights the task's lobe if it's on the brain.

### 6.6 Plan ring (top centre of the brain area)
- One arc per plan task: gold when done, gray otherwise. The running task's arc fills with gold as it progresses (my call). A failed task stays gray.
- "done/total" in the centre in serif.
- Hovering an arc shows "Task N · name" under the ring and updates the caption.
- *Open:* the ring and the Plan card show the same information. I asked whether to drop the Plan card and the user didn't answer. Keep both for now.

## 7. Data the studio reads
Everything comes from agy-foreman's state directory (`paths.ts`: `stateDir()`), so the studio works no matter where Claude runs.

### 7.1 Task status (my call)
Every task in the plan gets a status, including tasks Claude does itself without Gemini:
- **Tasks with jobs:** the most recently updated job record for that `plan.step` wins. That covers a passing follow-up after a failure, and retries.
  - Running or queued counts as running.
  - `passed` counts as done only once it has been finalized as merged.
  - Failed or error counts as failed.
  - Discarded means not started again.
- **Recording merges:** the server doesn't record "merged" yet. `finalize` in `jobs/actions.ts` returns it but doesn't write it, so `finalize` must store its outcome (`merged` / `kept` / `discarded`) on the job record. This is a small server change and is in scope.
- **Tasks without jobs**, the ones Claude does directly: done when every checkbox in that task's section of the plan file is ticked (`- [x]`), running when some are ticked, not started when none are.
- The plan ring, Plan card, Usage "done/total" and the brain all use this one status function.

### 7.2 Sources

| Data | Source | What it gives |
|---|---|---|
| Jobs | `jobs/*.json` (`JobRecord`) | title, state, `plan {file, step}`, progress: percent, phase, tokens, toolSteps, currentFile, checklist done/total, elapsedSec, etaSec |
| Plan | the plan file named in the job record | task list and titles (same parser as `countPlanSteps` / `jobs/plan.ts`), and each task's first sentence for hover text |
| Gemini usage | `quota.json` | 5-hour and weekly remaining |
| Claude usage | new cache written by the status line | see §6.1 |
| Approval policy | `.agy-foreman.json` (`approval`) + plan grants | Heads-up predictions |
| Session handoff | Claude Code session transcript + the session-end marker | the following-cmd mode |

Watch files, don't poll in a tight loop. The status line already shows how to read these cheaply.

"Current plan" means the plan of the most recent non-terminal job in this repo, or the most recent job if none is running. With no plan at all, the centre shows the brain dim and assembled, with the caption "No plan running". This empty state is my call.

## 8. Building it (decided and left open)

**Decided**
- **Desktop app on Electron.** It's needed to host a real pseudo-terminal (node-pty + xterm.js) next to a WebGL scene. Three.js renders the brain.
- **Separate package (my call):** `agy-foreman-studio` (Electron, node-pty, xterm.js, Three.js) lives in the same repo as a workspace package. `agy-foreman` itself stays light with its two dependencies. `agy-foreman studio` looks for the studio package; if it's missing, it asks once, then installs it (`npm i -g agy-foreman-studio`) and launches it. The studio package has its own CI job across the three OSes and its own publish step. The core package's `test:ci` and publish stay as they are.
- **Windows first:** the author works on Windows. Linux and macOS must not break, matching the project's CI matrix.

**Left to the builder**
- Process layout (main process, renderer, how the file watchers feed the renderer) and how to package node-pty for each platform.
- Whether the brain points are baked at build time and shipped (about 1.9 MB) or sampled at startup.
- The Full access write path (§6.4).
- Exact cross-fade and animation timings, within the mockup's feel.

## 9. Things to verify before or during planning
1. **Mesh license:** the license of `mni152_2009.mz3`. It's derived from ICBM152 2009, which MNI publishes under a permissive "use, copy, modify, distribute… without fee" notice with copyright. Confirm, and add attribution to NOTICE. If it isn't clear, pick another permissively licensed whole-brain mesh.
2. **Claude usage fields:** Claude Code's status line stdin, i.e. whether it carries 5-hour and weekly usage, and the field names.
3. **Transcript format:** Claude Code's session transcript location and format, for mirroring.
4. **Session-end hook:** whether it fires when the user closes the cmd window on Windows, not only on `/exit`.
5. **Resuming:** `claude --resume <id>` behavior when the session was last used in another terminal.

## 10. Running the mockup
`mockup.html` loads `/files/brain-points.bin`. To view it:
1. Run `node bake-brain.mjs <mni152_2009.mz3> <dir>` to produce `brain-points.bin`.
2. Serve the HTML and the bin together so that path resolves.

The mockup's terminal, usage numbers, task names and token rate are fake. The demo replays the running task's progress about every minute.
