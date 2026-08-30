# SOME tracker

Paste a video link. See how it is doing at a glance.

One field at the top, one dashboard underneath. Each tracked video shows its
current view count, whether it is taking off or calming down right now, and a
curve of when people were actually watching it.

![dashboard](docs/dashboard.png)

## Quick start

Needs Node 22.5 or newer. There is nothing to install — no dependencies.

```bash
npm start                 # http://localhost:3000
```

Want to see what a full dashboard looks like before collecting real data?

```bash
npm run seed              # four demo videos with two weeks of history
npm start
```

## Reading the dashboard

Each card answers three questions.

| | |
|---|---|
| **Views** | The total right now. |
| **Per day** | How fast it is gaining views over the last 24 hours. |
| **Momentum** | That rate compared with the 24 hours before it. `+120%` means it is picking up more than twice as fast as yesterday. |

The badge turns that into a verdict:

| Badge | Meaning |
|---|---|
| 🔥 **Going viral** | Gaining at least 50% faster than the window before, *and* running at its own best pace. |
| 📈 **Picking up** | Noticeably faster than the window before. |
| ➡️ **Steady** | Holding roughly the same pace. |
| 📉 **Cooling off** | Clearly slowing down — the spike has passed. |
| 💤 **Quiet** | Under ~120 views/day. Nothing is happening. |
| ⏳ **Warming up** | Fewer than two hours of readings, so no honest verdict yet. |

"Viral" is judged against the video's own history, not a global threshold, so a
niche clip having its best week reads as hot without needing millions of views.

Click any card to open the curve. It plots **views gained per interval**, not the
running total — the peaks are the moments people were actually watching, and the
dips are the quiet stretches. Switch between 24 hours, 7 days, 30 days and all
time, and hover for exact numbers.

## Getting reliable YouTube numbers

Without configuration the app reads the public YouTube watch page. That works,
but it is best-effort and breaks whenever YouTube changes its markup.

For dependable data, use an API key — free, and one key covers thousands of
checks a day:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3**.
3. Make an API key under *Credentials*.

```bash
YOUTUBE_API_KEY=your-key-here npm start
```

With a key set, all tracked videos are fetched in a single batched request.

Vimeo works with no key at all.

## How history is collected

**The curve starts when you add the link.** Neither YouTube nor Vimeo will tell
you what a video's views were last Tuesday, so the app builds history by taking
its own readings — every 15 minutes while the server is running. Leave it
running and the curve fills in; a card needs a couple of hours before it can say
anything about momentum.

Readings are stored in SQLite at `data/tracker.db`. Nothing leaves your machine
except the requests to YouTube and Vimeo.

## Deploying it

The app needs two things from a host, and they rule out most of the obvious
choices:

- **An always-on process.** History exists only because the poller keeps taking
  readings. Serverless platforms (Vercel, Netlify, Cloudflare Workers) only run
  code while a request is in flight, so the poller would never run and the
  dashboard would stay empty.
- **A persistent disk.** The curves live in SQLite. On a platform with an
  ephemeral filesystem, every deploy silently starts them over.

The same trap exists on hosts that *do* fit: free tiers that sleep after
inactivity, and Fly's `auto_stop_machines`, both stop the poller and leave gaps
in the curves. Keep the instance awake.

Everything below assumes Docker. There are no dependencies to install, so the
image is small and the build is a copy.

### A VPS, home server or Raspberry Pi

The cheapest option, and the app is small enough for the smallest box.

```bash
YOUTUBE_API_KEY=your-key APP_PASSWORD=something-secret docker compose up -d
```

Then put it behind Caddy, nginx or a Tailscale/Cloudflare tunnel for HTTPS.

### Fly.io

```bash
fly launch --no-deploy               # sets app name and region in fly.toml
fly volumes create tracker_data --size 1
fly secrets set YOUTUBE_API_KEY=your-key APP_PASSWORD=something-secret
fly deploy
```

`fly.toml` already pins the machine awake, which is what keeps readings
continuous.

### Render

Point a new Blueprint at this repo — `render.yaml` describes the service, its
disk and its health check. Set `YOUTUBE_API_KEY` and `APP_PASSWORD` in the
dashboard. Use a paid instance: free ones sleep, and a sleeping tracker is not
tracking.

### Locking it down

Anything reachable from the internet should set `APP_PASSWORD`. Without it the
dashboard is open to anyone who finds the URL — they can add and delete videos
and burn through your API quota.

```bash
APP_PASSWORD=something-secret npm start
```

The browser then asks for a password (leave the username blank). `/api/health`
stays open so container health checks keep working.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | Port to serve on. |
| `YOUTUBE_API_KEY` | *(none)* | Recommended. Falls back to page scraping. |
| `POLL_INTERVAL_MINUTES` | `15` | How often to take a reading. |
| `DB_PATH` | `data/tracker.db` | Where history is stored. |
| `APP_PASSWORD` | *(none)* | Require a password. Set this if it is reachable from the internet. |
| `HOST` | `0.0.0.0` | Interface to bind. |

## Supported links

YouTube (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`) and Vimeo.
Anything else is rejected with a message rather than added as a dead card.

## API

| | |
|---|---|
| `GET /api/videos` | Every tracked video with its current analysis. |
| `POST /api/videos` | `{"url": "..."}` — add a link. |
| `DELETE /api/videos/:id` | Stop tracking and delete its history. |
| `GET /api/videos/:id/series?range=24h\|7d\|30d\|all` | Chart buckets. |
| `POST /api/refresh` | Take a reading now. |
| `GET /api/health` | Status, tracked count, poller state. |

## Layout

```
server.js          HTTP server and JSON API
seed.js            demo data
lib/db.js          SQLite schema and queries
lib/providers.js   link parsing and stat fetching
lib/metrics.js     velocity, momentum and the viral verdict
lib/poller.js      the background reading loop
public/            the dashboard (no build step, no framework)
Dockerfile         container image
docker-compose.yml self-hosting on your own box
fly.toml           Fly.io config
render.yaml        Render blueprint
```
