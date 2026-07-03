# MomentumScan — Backtest Guide (for beginners)

How to run the **real one-year backtest** with your Upstox account.

Every step below tells you three things:
- 📍 **WHERE** — which window/program to use
- ⌨️ **WHAT** — exactly what to type or click
- ⏰ **WHEN** — the timing, and how long to wait

Follow the steps in order. Don't skip.

---

## What a backtest is (30-second version)

A backtest is a **time machine test**. Instead of waiting months to see if
the momentum detector is any good, we feed it **last year's real market
history, minute by minute**, let it flag the options it thinks are moving,
then check what prices *actually did* next. At the end it prints a **report
card**. Nothing here is advice — it only describes what happened.

---

## The 3 things you must have first

1. **Upstox Plus (paid plan).** Only Plus can download old expired option
   contracts. Without Plus, the download in Step 3 will fail.
2. **Docker Desktop installed and running** (the whale icon is showing).
3. **The MomentumScan folder on your computer** (the one with
   `start-momentumscan.bat` inside it).

---

## Step 0 — Open your "command window" (you'll use it for every step)

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

---

## Step 1 — Make sure the app is running

📍 **WHERE:** the command window from Step 0.

⌨️ **WHAT:** type this and press Enter:
```
docker compose up -d
```
⏰ **WHEN:** now. (First ever run builds things and takes 5–10 minutes.
After that, seconds.)

✅ **You'll know it worked when:** the last lines say things are
"Started" / "Running", and http://localhost:3000 opens the dashboard in
your browser.

---

## Step 2 — Log in to Upstox (this gives the backtest permission)

The download borrows your daily Upstox login. **The market does NOT need
to be open** for a backtest — but you must have logged in *today*, because
Upstox erases everyone's login every night around 3:30 AM.

📍 **WHERE:** your **web browser**.

⌨️ **WHAT:**
1. Go to **http://localhost:3000**
2. Click the yellow **"Login required"** banner.
3. Complete the Upstox login (phone number + TOTP, same as their app).
4. When it says "Authenticated", go to **http://localhost:3001/auth/status**

⏰ **WHEN:** any time of day today, before Step 3.

✅ **You'll know it worked when:** the /auth/status page shows
`"authenticated": true`. If it says `false`, do this step again.

---

## Step 3 — Download one year of history (THE LONG STEP)

📍 **WHERE:** the command window from Step 0.

⌨️ **WHAT:** copy this whole line, paste it (right-click to paste in
Windows), press Enter:
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY"
```

⏰ **WHEN:** right after Step 2. **Then wait — this takes SEVERAL HOURS.**
Leave the window open and go do something else. Scrolling text = good, it's
working.

✅ **You'll know it worked when:** it eventually prints
`download complete` and gives your command window's cursor back.

🛟 **If it stops early** (laptop slept, wifi dropped, or it ran past
midnight and the login expired):
- If it's a new day, redo **Step 2** (log in again).
- Then paste the **exact same command** and press Enter. It skips
  everything already downloaded and continues — it never duplicates.

---

## Step 4 — Check the data actually arrived

📍 **WHERE:** the command window.

⌨️ **WHAT:**
```
docker compose exec postgres psql -U momentum -d momentumscan -c "SELECT count(*) FROM bar_1m_hist;"
```
⏰ **WHEN:** after Step 3 says "download complete".

✅ **You'll know it worked when:** the number shown is in the **millions**
(roughly 2–3 million for a NIFTY year). If it's small or zero, the download
didn't finish — redo Step 3.

---

## Step 5 — Find the right sensitivity (the "sweep")

This tries five sensitivity settings and shows how many alerts each makes,
using only the first 9 months (so you don't accidentally "cheat").

📍 **WHERE:** the command window.

⌨️ **WHAT:**
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying NIFTY --sweep"
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

---

## Step 6 — The final run (this makes the report card)

📍 **WHERE:** the command window.

⌨️ **WHAT:**
```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying NIFTY --run-id NIFTY-1Y-REAL"
```
⏰ **WHEN:** after Step 5. Takes about 20–40 minutes.

✅ **You'll know it worked when:** it prints `report written`.

---

## Step 7 — Open and read the report card

📍 **WHERE:** your **file explorer**, then your **web browser**.

⌨️ **WHAT:** inside the MomentumScan folder, open the `reports` folder.
Find the file **`NIFTY-1Y-REAL.html`** and **double-click it** — it opens
in your browser like a normal web page.

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

---

## Want BANKNIFTY too?

Repeat Steps 3–7, but everywhere you see `NIFTY` type `BANKNIFTY` instead
(including the `--run-id`, e.g. `BANKNIFTY-1Y-REAL`).

---

---

## Common problem: "port is already allocated" (port 5432)

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

## The one caution

This report describes what **followed** the flagged moments at 1-minute
resolution, with the live-only depth/flow parts switched off. So it
**tests the concept** — it is not a promise about live behavior, and
**nothing in it is a recommendation**. The grey box at the top of the
report says exactly this. Read it and take it seriously.
