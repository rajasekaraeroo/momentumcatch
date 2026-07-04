# MomentumScan — Backtest Guide (for complete beginners)

How to run the **real one-year backtest** for **NIFTY, BANKNIFTY and SENSEX**
using your Upstox account — even if you have never touched code before.

Every instruction below tells you three things:

- 📍 **WHERE** — which window or program to use
- ⌨️ **WHAT** — exactly what to type or click
- ⏰ **WHEN** — the timing, and how long to wait

Follow the steps in order. Don't skip. If something looks different from what
this guide says, stop and re-read the step — don't guess.

---

## What a backtest is (30-second version)

A backtest is a **time machine test**. Instead of waiting months to see if
the momentum detector is any good, we feed it **last year's real market
history, minute by minute**, let it flag the options it thinks are moving,
then check what prices *actually did* next. At the end it prints a **report
card** — one web page per instrument. Nothing here is advice — it only
describes what happened.

You will do this for three instruments:

- **NIFTY** — the Nifty 50 index options (trades on the NSE exchange)
- **BANKNIFTY** — the Nifty Bank index options (also NSE)
- **SENSEX** — the Sensex index options (trades on the **BSE** exchange)

The steps are **identical** for all three. Only the name changes.

---

## A few words you'll see a lot (mini-glossary)

- **Docker / Docker Desktop** — the program that runs the whole app in a
  self-contained box on your computer. You just need it open (the little
  whale icon showing).
- **Command window / PowerShell** — a text window where you type commands.
  It looks scary but you only ever **paste** lines this guide gives you.
- **Container** — one piece of the app running inside Docker. Ours has four:
  `engine`, `web`, `postgres` (the database), `redis` (short-term memory).
- **The database** — where downloaded history is stored. It lives on **this**
  computer and **survives shut-downs**. Once something is downloaded, it stays
  downloaded.
- **Upstox login / token** — permission to download. It is **wiped every
  night** by Upstox (around 3:30 AM), so you log in again each new day.

---

## The 3 things you must have first

1. **Upstox Plus (paid plan).** Only Plus can download old, expired option
   contracts. Without Plus, the download (Step 3) will fail.
   - Extra note for **SENSEX**: your Plus plan must also serve **BSE**
     history. Some accounts serve NSE (NIFTY/BANKNIFTY) but not BSE (SENSEX)
     yet. Step 3 tells you how to spot this in the first minute.
2. **Docker Desktop installed and running** (the whale icon is showing).
3. **The MomentumScan folder on your computer** (the one with
   `docker-compose.yml` and `start-momentumscan.bat` inside it).

---

# PART 1 — One-time setup (do this ONCE)

You only do Part 1 the very first time, or after moving to a new computer.

## Step 0 — Open your "command window" (you'll use it constantly)

Almost every step is typed into one window. Open it once, keep it open.

📍 **WHERE:** open the MomentumScan folder in your file explorer first.
- **Windows:** open the folder in File Explorer. Click the white address
  bar at the top, type `powershell`, press **Enter**. A dark blue window
  opens — it is already "inside" the folder. ✅
- **Mac:** open the folder in Finder. Right-click the folder → **New
  Terminal at Folder**. (If you don't see that option: open Terminal, type
  `cd ` with a space, then drag the folder onto the window, press Enter.)

⌨️ **WHAT:** to confirm you're in the right place, type this and press Enter:
```
docker compose ps
```
⏰ **WHEN:** now.

✅ **You'll know it worked when:** you see a small table listing `engine`,
`web`, `postgres`, `redis`. If instead you see an error like "no
configuration file", you're in the wrong folder — redo the WHERE part.

## Step 1 — Build and start the app

📍 **WHERE:** the command window from Step 0.

⌨️ **WHAT:** type this and press Enter:
```
docker compose up -d --build
```
⏰ **WHEN:** now. **The very first time this builds everything and takes
5–10 minutes.** After that it's seconds.

✅ **You'll know it worked when:** the last lines say things are
"Started" / "Running", and http://localhost:3000 opens the dashboard in
your browser.

> 💡 **Why `--build`?** It makes sure the app includes SENSEX support (a
> recent addition). Once you've built at least once, plain
> `docker compose up -d` is enough on later days.

---

# PART 2 — The daily routine (do this at the START of every day you work)

The downloaded history stays on your computer forever, but **two things reset
and must be redone whenever you begin a new day** (or after restarting your
PC):

### 2A — Make sure the app is running

📍 **WHERE:** the command window (Step 0).
⌨️ **WHAT:**
```
docker compose up -d
```
⏰ **WHEN:** first thing, each day. (If the app was already running, this just
says everything is up-to-date — that's fine.)
✅ **Worked when:** http://localhost:3000 opens the dashboard.

### 2B — Log in to Upstox again (this is the big daily one)

Upstox erases everyone's login every night around **3:30 AM**. So even though
your *data* is still here, your *permission to download more* is gone each
morning. You must log in again — **the market does NOT need to be open** for a
backtest, but you must have logged in **today**.

📍 **WHERE:** your **web browser**.
⌨️ **WHAT:**
1. Go to this exact link: **http://localhost:3001/auth/login**
   (This automatically bounces you to Upstox's own login page. The yellow
   **"Login required"** banner on http://localhost:3000 leads to the same
   place — use the direct link if the banner isn't showing.)
2. Complete the Upstox login: **phone number + TOTP**, same as their app.
3. You'll land on a page that says **"Authenticated — engine starting."**
   Close that tab.
4. Double-check it stuck: open **http://localhost:3001/auth/status** — it
   should show `"authenticated": true`.

⏰ **WHEN:** every day, before any download. Takes 30 seconds.

✅ **Worked when:** `/auth/status` shows `"authenticated": true`. If it says
`false`, do this step again.

> 🌙 **If a download runs past midnight** and stops because the login
> expired: that's normal. The next morning, redo **2B** (log in again), then
> re-run the same download command — it **resumes** where it left off (see
> Step 3's resume note). You never lose finished work.

---

# PART 3 — Backtest each instrument (the repeatable block)

Now the actual work. You will run **Steps 3 → 7 once per instrument**:
first for NIFTY, then BANKNIFTY, then SENSEX.

Everywhere you see **`SYMBOL`** in a command, replace it with the real name
from this table (type it in CAPITALS, exactly):

| Instrument | Type as SYMBOL | Run-id to use     |
|------------|----------------|-------------------|
| NIFTY      | `NIFTY`        | `NIFTY-1Y-REAL`   |
| BANKNIFTY  | `BANKNIFTY`    | `BANKNIFTY-1Y-REAL` |
| SENSEX     | `SENSEX`       | `SENSEX-1Y-REAL`  |

> ✅ **Do one instrument all the way through (Steps 3–7), then start the next.**
> This keeps things simple and avoids a settings clash explained in Step 5.

---

## Step 3 — Download one year of history (THE LONG STEP)

📍 **WHERE:** the command window.

⌨️ **WHAT:** copy this whole line, **replace `SYMBOL`**, paste it (right-click
to paste in Windows), press Enter. Example shown for NIFTY:
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY"
```
(For BANKNIFTY put `BANKNIFTY` at the end; for SENSEX put `SENSEX`.)

⏰ **WHEN:** right after logging in (Part 2). **This takes SEVERAL HOURS per
instrument.** Leave the window open and go do something else. Scrolling text =
good, it's working.

✅ **You'll know it worked when:** it eventually prints
`download complete` and gives your command window's cursor back.

🛟 **If it stops early** (laptop slept, wifi dropped, or it ran past midnight
and the login expired):
- If it's a **new day**, redo **Part 2B** (log in again).
- Then paste the **exact same command** and press Enter. It skips everything
  already downloaded and continues — it **never duplicates**. You can stop and
  resume as many times as you like.

⚠️ **SENSEX only — check the first minute of scrolling text.** SENSEX history
comes from the **BSE** exchange, which not every account can access. Look for
a line like `expiries in range` followed by a number:
- **Number greater than 0**, and contracts start downloading → BSE history
  works on your account. Let it run for hours, just like NIFTY. ✅
- **`0 expiries`, or every contract prints `empty_response`** → your Upstox
  plan does not serve **BSE** old-option data. The SENSEX **backtest can't
  run** (SENSEX *live* scanning would still work another day). This is an
  account/data limit, **not a bug** — nothing is broken. Just move on to the
  instruments that do work.

---

## Step 4 — Check the data actually arrived

📍 **WHERE:** the command window.

⌨️ **WHAT:**
```
docker compose exec postgres psql -U momentum -d momentumscan -c "SELECT count(*) FROM bar_1m_hist;"
```
⏰ **WHEN:** after Step 3 says "download complete".

✅ **You'll know it worked when:** the number shown is in the **millions**
(roughly 2–3 million per instrument for a year). This count is the **running
total across everything you've downloaded so far**, so after BANKNIFTY it
should be bigger than after NIFTY, and bigger again after SENSEX. If the
number didn't grow after a download, that download didn't finish — redo
Step 3 for that instrument.

---

## Step 5 — Find the right sensitivity (the "sweep")

This tries five sensitivity settings and shows how many alerts each makes,
using only the first 9 months (so you don't accidentally "cheat").

📍 **WHERE:** the command window.

⌨️ **WHAT:** (replace `SYMBOL`)
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying SYMBOL --sweep"
```
⏰ **WHEN:** after Step 4 looks good. Takes a few minutes.

✅ **You'll know it worked when:** a small table prints, one row per
threshold (60, 65, 70, 75, 80) with an event count.

👉 **Then do this:** pick the threshold whose event count looks reasonable
(not tens of thousands, not a handful). Open the file
`config/backtest.yaml` in Notepad/TextEdit, find the lines:
```
emission:
  scoreThreshold: 70
```
change `70` to your chosen number, **save**, close.

> ⚠️ **Important — why one instrument at a time.** That `scoreThreshold`
> setting is **shared** by all three instruments. So finish an instrument's
> Step 5 **and** Step 6 before starting the next one's Step 5. If you sweep
> all three first and change the setting three times, only the last change
> survives. One instrument fully, then the next — that's the safe order.

---

## Step 6 — The final run (this makes the report card)

📍 **WHERE:** the command window.

⌨️ **WHAT:** (replace `SYMBOL` **and** the run-id — see the table above)
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying SYMBOL --run-id SYMBOL-1Y-REAL"
```
Example for BANKNIFTY:
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying BANKNIFTY --run-id BANKNIFTY-1Y-REAL"
```
⏰ **WHEN:** after Step 5. Takes about 20–40 minutes.

✅ **You'll know it worked when:** it prints `report written`.

> 🔁 Re-running the **same** `--run-id` is completely safe: it clears that
> run's previous results first, so numbers never double up.

---

## Step 7 — Open and read the report card

📍 **WHERE:** your **file explorer**, then your **web browser**.

⌨️ **WHAT:** inside the MomentumScan folder, open the `reports` folder.
Find the file named after your run-id — e.g. **`NIFTY-1Y-REAL.html`** — and
**double-click it**. It opens in your browser like a normal web page.

⏰ **WHEN:** after Step 6 says "report written".

👀 **What to look at — just 3 things, in order:**
1. **Section 2** (signal vs random baseline): do the **signal** rows sit
   clearly ABOVE the **random-baseline** rows? If yes, the alerts meant
   something. If they're the same, the detector was no better than chance.
2. **Section 7** (month by month): steady across all 12 months, or only
   good in one or two? Only two = a red flag.
3. **Section 5** (decay capture): is the giveback smaller at the "fading"
   signal than the naive rule? That's the "spots momentum dying early"
   claim being tested.

**Then go back to Step 3 and repeat Steps 3–7 for the next instrument.**

---

# Doing it faster (optional, for the impatient)

The **downloads** (Step 3) are the slow part, and they don't fight each
other — different instruments write to different rows in the database. So you
*can* run all three downloads at the same time in **three separate command
windows** (all opened in the same MomentumScan folder). They share Upstox's
speed limit, so each goes a little slower, but nothing breaks — the app
automatically slows down when Upstox says "too fast".

**But** still do the **sweep and final run (Steps 5–6) one instrument at a
time**, because of the shared `scoreThreshold` setting explained in Step 5.

---

# What survives, what resets (so a "new day" never confuses you)

| Thing | Survives PC shutdown / new day? | What to do |
|-------|-------------------------------|------------|
| Downloaded history (the database) | ✅ Yes, permanently | Nothing — it's kept |
| The app containers | ✅ Yes (stopped, not deleted) | `docker compose up -d` to restart |
| Your Upstox login | ❌ No — wiped ~3:30 AM nightly | Log in again (Part 2B) |
| A half-finished download | ✅ Progress is saved | Re-run the same command; it resumes |
| A backtest run's results | ✅ Saved under its run-id | Nothing, unless you want to re-run |

So a normal "second day" is just: **2A (start app) → 2B (log in) → carry on
from wherever Step 3 stopped.**

---

# Running on a SECOND computer (e.g. home laptop)

Your downloaded data lives in the database on the FIRST computer — it does
not travel with you. On a second machine the database starts empty, so the
simplest path is to re-download there (it's quick and unattended).

Do this on the second computer:

1. **Get the latest code** (has all the fixes and SENSEX support): download a
   fresh ZIP —
   https://github.com/rajasekaraeroo/momentumcatch/archive/refs/heads/claude/work-session-v1g250.zip
   — Extract All, and work inside that fresh folder.
2. **Open a command window there** (File Explorer address bar → type
   `powershell` → Enter).
3. **Create the settings file:** `copy .env.example .env` then
   `notepad .env` — paste your SAME Upstox API Key + Secret (the Upstox app
   works on any computer), save, close.
4. **Build and start:** `docker compose up -d --build` (first time: 5–10 min).
5. **Open** http://localhost:3000, then **log in** (Part 2B).
6. **Re-download** (Step 3), then **verify** (Step 4), **sweep** (Step 5),
   **final run** (Step 6), **open the report** (Step 7) — exactly as above.

(Advanced alternative: if you made an `mc-backup.dump` on the first machine,
you can restore it instead of re-downloading — but re-downloading is
simpler.)

---

# Does the backtest itself resume if interrupted? (Steps 5–6)

**No — and it doesn't need to.** Unlike the download (which is slow and
resumable), the backtest RUN is fast local computation on data you already
have. If it's interrupted, just run it again from the start — it re-reads
your saved data (it never re-downloads) and finishes in minutes. Re-running
the same `--run-id` is safe: it clears the previous run's results first, so
numbers never double up.

---

# Common problem: "relation bar_1m_hist does not exist"

This means the database tables weren't created yet (it can happen if the
engine started before the database was ready — e.g. right after fixing the
port problem below). Fix:

1. In the command window, run: `docker compose restart engine`
2. Wait about 10 seconds.
3. Check the tables exist:
   `docker compose exec postgres psql -U momentum -d momentumscan -c "\dt"`
   You should see a list of ~11 tables including `bar_1m_hist`.
4. Run the Step 3 download command again.

(New downloads of the project already have a fix that creates the tables
automatically.)

---

# Common problem: "port is already allocated" (port 5432)

If `docker compose up -d` shows an error like:

> Bind for 0.0.0.0:5432 failed: port is already allocated

it means another PostgreSQL already on your PC is using port 5432. Fix
(one line):

1. In the MomentumScan folder, open **docker-compose.yml** in Notepad.
2. Find the line `- "5432:5432"` (under `postgres:`).
3. Change it to `- "5433:5432"` and **save**.
4. Back in the command window, run `docker compose up -d` again.

This moves our database to port 5433; the app is unaffected because it
talks to the database over Docker's internal network, not that port. (New
downloads of the project already have this fix.)

---

# Common problem: "unknown underlying SENSEX"

This means the copy of the app you're running is older than the SENSEX
feature. Two ways to fix:

- **Best:** rebuild with the latest code — `docker compose up -d --build`
  (do this when nothing else is running, since it restarts the engine).
- **Quick, no rebuild:** open `config/universe.yaml` in Notepad and, just
  above the `expiry:` line, add these five lines (the leading spaces matter):
  ```yaml
    - symbol: SENSEX
      indexInstrumentKey: "BSE_INDEX|SENSEX"
      strikeStep: 100
      atmRange: 10
      exchange: BSE
  ```
  Save, close, and re-run the Step 3 command. (This config file is read live,
  so no restart is needed and any running download is undisturbed.)

---

# Advanced (research): the premium-expansion analysis

This is an extra, **descriptive** study — not part of the normal report, and
**not a trading signal**. It answers one question: *when the momentum score
reads high, how much more often does a near-ATM option premium at least
double soon after, compared with a random minute?* That ratio is called
**lift**.

📍 **WHERE:** the command window (after you've downloaded that instrument).
⌨️ **WHAT:** (example for BANKNIFTY)
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest:expansion --from 2025-07-01 --to 2026-06-30 --underlying BANKNIFTY --horizon 30 --multiple 2 --atm-strikes 3"
```
- `--horizon 30` = look 30 minutes forward · `--multiple 2` = "doubling" ·
  `--atm-strikes 3` = ATM ± 3 strikes.

⏰ **WHEN:** any time after the download. Takes a few minutes.
✅ **Worked when:** tables print in the window **and** a report is saved to
`reports/BANKNIFTY-expansion.html` (double-click to open).

👀 **How to read it — in this order:**
1. **Base rate** — the % of near-ATM minutes that double anyway. This is your
   yardstick.
2. **Lift by score band** — does the top band (85–100) show a **lift well
   above 1**? Lift ≈ 1 means the score tells you nothing; lift of 3–5×
   means high-score minutes really do precede doublings more than chance.
3. **Holdout section** — the same tables on months the tuning never saw. **If
   the lift is big in "Tune" but ~1 in "Holdout", it was luck, not an edge.**
   Only a lift that survives the holdout is worth anything.
4. **Capture of the ideal move** — even with lift, how much of the trough→peak
   move is left by the time the score actually crosses (you always arrive
   late), and how much is handed back by the fading glyph. Small capture =
   the move looks great in hindsight but little of it is reachable live.

⚠️ Everything here is computed on 1-minute closes with the live depth/flow
signal off and **no fills or slippage** — so treat any positive result as the
*most optimistic* case, and as a description of past behavior only, never a
recommendation.

---

# The one caution

This report describes what **followed** the flagged moments at 1-minute
resolution, with the live-only depth/flow parts switched off. So it
**tests the concept** — it is not a promise about live behavior, and
**nothing in it is a recommendation**. The grey box at the top of the
report says exactly this. Read it and take it seriously.
