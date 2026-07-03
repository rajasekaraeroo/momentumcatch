# MomentumScan — Complete Beginner Setup Guide

This guide assumes you have never programmed before. Follow it top to
bottom. There are two parts: a **one-time setup** (about an hour, done
once) and a **daily routine** (about one minute, every trading morning).

> Remember what this tool is: it **watches** the market and describes
> momentum patterns it observes. It never tells you to buy or sell
> anything, and nothing it shows is investment advice.

---

## Part 0 — What "the terminal" is

Almost every step below says "type this command." You type commands into
a program called a **terminal**:

- **Windows**: press the Start key, type `PowerShell`, press Enter.
- **Mac**: press Cmd+Space, type `Terminal`, press Enter.

A black/white window opens with a blinking cursor. You type a command,
press **Enter**, and the computer runs it and prints the result. That's
all a terminal is. Copy-paste works: copy a command from this guide,
right-click (Windows) or Cmd+V (Mac) to paste, press Enter.

---

## THE EASY PATH (recommended) — only Docker needed

Since this guide was first written, the project gained a one-command Docker
package. If you follow this section you can SKIP Parts 1, 2, 4b, 4d and 5
below — you install exactly one thing.

### E1. Install Docker Desktop (one time)
https://www.docker.com/products/docker-desktop → download → install →
open it and leave it running (whale icon). On Windows, say yes if it asks
to enable "WSL 2".

### E2. Download the project as a ZIP (one time — no Git needed)
Open this link in your browser; it downloads a zip of the code:

  https://github.com/rajasekaraeroo/momentumcatch/archive/refs/heads/claude/work-session-v1g250.zip

Right-click the downloaded file → "Extract All" → put the folder on your
Desktop. Inside it you'll find files like `start-momentumscan.bat`.

### E3. Add your Upstox keys (one time)
Do **Part 3** below (create the Upstox app, redirect URL exactly
`http://localhost:3001/auth/upstox/callback`). Then, on Windows,
double-click **start-momentumscan.bat** — the first time, it creates a
settings file and opens it in Notepad for you. Paste your API key and
secret after the `=` signs, save, close.
(Mac: copy `.env.example` to `.env` and edit it, as in Part 4a.)

### E4. Fix the holiday list (one time)
Do **Part 4c** below (edit `config/holidays.json`).

### E5. Start it (and every trading morning after)
1. Make sure Docker Desktop is running.
2. **Windows**: double-click `start-momentumscan.bat`.
   **Mac**: in a terminal, `cd` into the folder and run
   `docker compose up -d --build`, then open http://localhost:3000
3. The FIRST start builds everything and takes 5–10 minutes; after that
   it starts in seconds. The feed-decoding file (Part 4b) downloads
   itself automatically on first start.
4. Do the morning Upstox login when the yellow banner appears (Part 5
   step 4). To stop in the evening: double-click `stop-momentumscan.bat`
   (or `docker compose down`).

Everything below is the original "developer path" — useful if you ever
want to change the code, and for reference.

---

## Part 1 — Install the four tools (one time)

### 1. Git (downloads code)
Go to https://git-scm.com/downloads → download for your system → run the
installer → click "Next" through every screen (defaults are fine).

### 2. Node.js (runs the program)
Go to https://nodejs.org → download the **LTS** version (20 or newer) →
run the installer → defaults are fine.

### 3. pnpm (installs the program's building blocks)
Open a **new** terminal (important: new, so it sees Node) and type:
```
npm install -g pnpm@9
```

### 4. Docker Desktop (runs the two small databases)
Go to https://www.docker.com/products/docker-desktop → download → install
→ **start Docker Desktop and leave it running** (look for the whale icon).
On Windows it may ask to enable "WSL 2" — say yes and follow its prompts.

**Check everything worked.** In a new terminal, type each line and press
Enter. Each should print a version number, not an error:
```
git --version
node --version
pnpm --version
docker --version
```

---

## Part 2 — Download the project (one time)

In the terminal:
```
cd Desktop
git clone https://github.com/rajasekaraeroo/momentumcatch.git
cd momentumcatch
git checkout claude/work-session-v1g250
```

What this did: made a folder called `momentumcatch` on your Desktop with
all the code in it, and switched to the branch that contains the finished
program. From now on, **every command in this guide is typed while you
are "inside" this folder** — if you open a new terminal later, first type:
```
cd Desktop/momentumcatch
```

---

## Part 3 — Get your Upstox API keys (one time)

You need an Upstox trading account for this part.

1. Go to **https://account.upstox.com/developer/apps** and log in.
2. Click **"New App"** (you may need to pay Upstox's one-time API fee —
   that is their charge, not this project's).
3. Fill the form:
   - **App name**: anything, e.g. `MomentumScan`
   - **Redirect URL**: paste this EXACTLY, character for character:
     ```
     http://localhost:3001/auth/upstox/callback
     ```
     (If this is even one letter off, login will fail later.)
4. Save. Upstox shows you two codes: an **API Key** and an **API Secret**.
   Keep this page open — you need both in Part 4. **Never share the
   Secret with anyone or post it anywhere.**

---

## Part 4 — Configure the project (one time)

### 4a. Create your settings file
In the terminal (inside the momentumcatch folder):

- **Mac**: `cp .env.example .env`
- **Windows PowerShell**: `copy .env.example .env`

Now open that new `.env` file in a text editor:

- **Windows**: `notepad .env`
- **Mac**: `open -e .env`

Find these two lines and paste your codes from Part 3 after the `=` signs
(no spaces, no quotes):
```
UPSTOX_API_KEY=paste_your_api_key_here
UPSTOX_API_SECRET=paste_your_api_secret_here
```
Save and close the file.

### 4b. Download the "feed dictionary"
Upstox sends market data in a compressed format; this file is the
dictionary for decoding it. In the terminal:

- **Mac**: `bash scripts/fetch-proto.sh`
- **Windows**: this script needs "Git Bash", which Git installed for you.
  Press Start, type `Git Bash`, open it, then:
  ```
  cd Desktop/momentumcatch
  bash scripts/fetch-proto.sh
  ```

You should see `Wrote packages/shared/proto/MarketDataFeedV3.proto`.
The program refuses to connect to the market without this file.

### 4c. Fix the holiday list
Open `config/holidays.json` in your text editor (same way as 4a — it's
inside the `config` folder). It currently contains placeholder dates.
Search the web for "NSE trading holidays 2026 circular", and make the
list match the official one, keeping the same format:
```json
{
  "2026": [
    "2026-01-26",
    "2026-03-31"
  ]
}
```
(dates in quotes, commas between them, no comma after the last one).
Why it matters: the program refuses to connect on listed dates.

### 4d. Install and start the databases
In the terminal (Docker Desktop must be running):
```
docker compose up -d
pnpm install
```
The first command starts two small databases (you'll see "Started").
The second downloads all the program's building blocks (takes a few
minutes the first time; a wall of text is normal).

**One-time setup is now done.**

---

## Part 5 — The daily routine (every trading morning)

1. Make sure **Docker Desktop is running** (whale icon).
2. Open a terminal:
   ```
   cd Desktop/momentumcatch
   pnpm dev
   ```
   Lots of text scrolls by — that's the engine and dashboard starting.
   **Leave this window open all day.** (To stop everything in the
   evening: click that window and press Ctrl+C.)
3. Open your web browser and go to: **http://localhost:3000**
4. You'll see a yellow banner: *"Login required"*. Click it. Upstox's
   own login page opens — log in with your phone/TOTP like you do in the
   Upstox app. After that you'll see *"Authenticated — engine starting"*.
   Close that tab and go back to the dashboard tab.
5. Within ~15 seconds the "feed" chip turns to **LIVE** (during market
   hours, 09:15–15:30 IST on trading days). About a minute after the
   first price arrives, the heat grid fills with option strikes.

Why every morning? Upstox deletes everyone's access token around 3:30 AM
every night — that's their security rule, not a bug.

---

## Part 6 — How to read the screen

- **Top strip**: health. `feed LIVE` = connected; `ticks/s` = data
  flowing; `AWAITING_AUTH` = you need to do the morning login.
- **Heat grid**: one row per option strike, calls (CE) on the left, puts
  (PE) on the right. The number is the momentum score 0–100. Blue fill =
  premium rising, orange = falling; brighter = stronger. Symbols:
  ▲ momentum building, ● at its peak, ▼ fading, ✕ ended.
- **Event tape** (right side): every time a score crosses 70 with real
  volume behind it, a card appears with the evidence (velocity, volume
  burst, order-flow, confirmation). "Momentum fading" cards tell you the
  system observed that move dying, and why.
- **Click any grid cell**: candles, volume and the score line for that
  contract appear below.

---

## Part 7 — When something looks wrong

Open **http://localhost:3001/health** in the browser — it's the
program's self-diagnosis page.

| What you see | What it means | What to do |
|---|---|---|
| `AWAITING_AUTH` | No valid daily token | Do the morning login (Part 5 step 4) |
| `IDLE_CLOSED` | Market is closed / holiday / weekend | Nothing — normal |
| `STOPPED` + proto error in the terminal | The 4b file is missing | Run Part 4b again |
| `redis: "down"` or database errors | Databases not running | Start Docker Desktop, then `docker compose up -d` |
| `TICK_STARVED` | Connected but no data | Usually a token/plan issue; try logging in again |
| Browser can't reach localhost:3000 | Program not running | Run `pnpm dev` (Part 5 step 2) |
| Scores look "stuck" for first 5 min after 09:15 | Warm-up period | Normal — baselines need ~5 minutes of data |

Two honest warnings:

1. **The first days are calibration.** The thresholds shipped with
   textbook defaults and have never seen real Indian market data. Expect
   too many or too few events at first; the numbers to adjust live in
   `config/momentum.yaml` (higher `scoreThreshold` = fewer, stronger
   events).
2. **This is a describing tool, not a deciding tool.** It reports "this
   option's premium is moving unusually fast on unusual volume" and
   "that move appears to be dying." What anyone does with that
   information is entirely outside this program — it will never suggest
   an action, by design.
