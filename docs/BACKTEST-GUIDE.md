# MomentumScan — Backtest Guide (for beginners)

This explains how to run the **real one-year backtest** with your Upstox
account. Follow it top to bottom. It uses the Docker setup (only Docker
Desktop needed). Developer-path commands are in [brackets].

---

## What is a backtest? (the big idea)

Imagine you built a machine that watches cricket and beeps "this batsman
is about to go big." You could wait months to find out if it's any good…
or you could play it **recordings of matches that already finished** and
check: when it beeped, did the batsman actually go big?

That second way is a **backtest**. Instead of waiting, we feed the
momentum detector **last year's real market history, minute by minute**,
let it flag the option contracts it thinks are moving, and then look at
what the price *actually did* in the next 1, 3, 5, 10 and 15 minutes. At
the end it prints a **report card**.

It answers one honest question: *when the detector flagged something, did
prices behave differently than at random moments?* If yes, the idea has
merit. If no, it doesn't (at these settings).

---

## Before you start — 3 things you need

1. **Upstox Plus plan (paid).** Normal Upstox can watch live data, but
   only **Plus** can download old, expired option contracts — which is
   exactly what a one-year backtest is made of. Check/upgrade in your
   Upstox account. (This costs money — that's Upstox's charge.)
2. **The app running.** Docker Desktop open, and `start-momentumscan.bat`
   run (Windows) / `docker compose up -d` (Mac).
3. **A fresh login today.** The download borrows your daily Upstox login
   token. Unlike the live dashboard, the backtest **does NOT need the
   market to be open** — you can run it any time of day — but you DO need
   to have logged in today.

> Why "today"? Upstox deletes everyone's login token every night around
> 3:30 AM. So the token is only good for the day you logged in.

---

## Step 1 — Log in (borrow today's token)

1. Open the dashboard: **http://localhost:3000**
2. Click the yellow **"Login required"** banner → complete the Upstox
   login (phone + TOTP, like their app).
3. Confirm it worked — open this page in your browser:
   **http://localhost:3001/auth/status**
   You want to see: `"authenticated": true`.

If it says `false`, the login didn't stick — do step 1 again.

---

## Step 2 — Download one year of history

This is the long part. One command downloads the index history plus, for
each trading day, the nearest-expiry options around the money (ATM ± 6
strikes, calls and puts), at 1-minute resolution.

```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY"
```
[developer path: `pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY`]

**What to expect — read this so nothing surprises you:**

- **It is SLOW — plan for several hours.** It's thousands of requests,
  deliberately paced at 2 per second so Upstox doesn't rate-limit you.
  Start it and go do something else. A scrolling log is normal.
- **It's resumable.** If it stops for any reason — your laptop sleeps,
  the internet drops, or the token expires overnight — just run the
  **exact same command again**. It remembers which contracts are already
  done and skips them. It will not re-download or duplicate.
- **If it runs past midnight**, the token dies. Log in again the next
  morning (Step 1) and re-run the same command to finish the rest.
- **Some gaps are normal.** A few expired contracts return empty or short
  data; the tool records these and *excludes* them rather than pretending
  they were zero — this is correct behavior, not an error.

---

## Step 3 — Check the data actually arrived

```
docker compose exec postgres psql -U momentum -d momentumscan -c "SELECT count(*) FROM bar_1m_hist;"
```

A full NIFTY year should show roughly **2–3 million** rows. If it shows a
small number or zero, the download didn't finish — re-run Step 2.

---

## Step 4 — Tune the sensitivity (the "sweep")

Before the real run, we find a sensible sensitivity. The detector fires
when its score crosses a threshold (default 70). Too low = it beeps at
everything; too high = it never beeps. The sweep tries 60, 65, 70, 75, 80
and shows how many events each produces — but **only using the first 9
months**, deliberately leaving the last 3 months untouched so you don't
accidentally "study for the test."

```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying NIFTY --sweep"
```

Look at the printed table, pick a threshold with a reasonable event count
(not thousands, not a handful), and set it: open `config/backtest.yaml`,
find `emission:` → `scoreThreshold:`, change the number, save.

---

## Step 5 — The final run (produces the report card)

```
docker compose exec engine sh -c "cd /app/apps/engine && pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying NIFTY --run-id NIFTY-1Y-REAL"
```

This takes ~20–40 minutes. When it finishes, the report is waiting **on
your own computer** at:

```
reports/NIFTY-1Y-REAL.html
```

Find that file in the momentumcatch folder and **double-click it** — it
opens in your web browser like a normal web page.

(Want BANKNIFTY too? Repeat Steps 2–5 with `--underlying BANKNIFTY`.)

---

## Step 6 — How to read the report card

Don't try to read all of it. Ask three questions, in this order:

1. **Section 2 — "forward-return distributions, signal vs random
   baseline."** For each time horizon there are two rows: **signal**
   (moments the detector flagged) and **random-baseline** (random moments
   for comparison). *Do the signal numbers sit clearly ABOVE the
   baseline numbers?* If yes, flagging meant something. If they're the
   same, the detector was no better than picking at random — that's the
   whole game, right there.

2. **Section 7 — "month-by-month stability."** Is it steady across all 12
   months, or did it only "work" in one or two? A signal that worked in
   just two months is a **red flag** — the report literally says so.

3. **Section 5 — "episode analytics & decay capture."** Compare the
   median giveback at the **MomentumFading** signal against the naive
   rule. Smaller giveback at the fading signal = the "detects momentum
   dying early" idea is doing its job.

---

## The one caution to keep in mind

This report describes what **followed** the flagged moments, at 1-minute
resolution, with the depth/order-flow parts switched off (those only
exist in the live tick engine). So it **tests the concept** — it is not a
promise about live behavior, and **nothing in it is a recommendation**.
The grey "fidelity statement" box at the top of the report says exactly
this. Read it, and take it seriously.
