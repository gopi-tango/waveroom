# Waveroom

Listen to YouTube together, in sync. The host pastes YouTube links into a
queue; everyone who joins by link or room code hears the same track at the
same moment, sees who else is in the room, and can chat.

No audio files are ever stored or streamed by this app — every browser plays
the official YouTube embed, and the server only synchronizes *state*
(which video, what position, playing or paused, who's here, what was said).

## How it works

- **Host** creates a room and gets a 6-character code + shareable link.
  The host's browser is the source of truth: every 3 seconds it reports its
  player position to the server, and it advances the queue when a track ends.
- **Everyone** enters a name at the door. Listeners sync with the room every
  3 seconds and correct their own player if it drifts more than ~1.75s from
  the host. The same request carries presence and chat, so there is exactly
  one server call per person per beat.
- **Here now** lists everyone in the room. Someone who closes the tab drops
  off after about 12 seconds. The host can remove a listener; a removed
  person can't rejoin from that browser.
- **Chat** keeps the last 50 messages while the room is open.
- **End session** (host only) clears the queue, chat, and listeners, shows
  everyone a "host ended the session" screen, and forgets the host token.
- Room state lives in Redis (Upstash) with a 24-hour expiry. Locally, an
  in-memory store is used so `npm run dev` works with zero setup.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. No Redis needed for local dev.

## Deploy to Vercel (free)

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo. Framework preset:
   Next.js (auto-detected). Deploy.
3. Add Redis (required in production — serverless functions don't share
   memory): in your Vercel project go to **Storage → Create Database →
   Upstash (Redis)**, free plan. Accepting the integration injects
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically.
   (`KV_REST_API_URL`/`KV_REST_API_TOKEN` names also work.)
4. Redeploy. Done — share `https://your-app.vercel.app/room/CODE`.

## Staying on the free tier

Upstash's free plan allows 500K Redis commands a month. Each sync from a
listener is a single Lua script (`EVAL`, billed as one command) that writes
presence, drops stale listeners, appends a chat message if any, and reads
room + listeners + chat together. A pipeline would bill each command
separately, which is why the poll is a script.

Rough budget with 10 people in a room:

| | Per hour | Free tier covers |
|---|---|---|
| Redis commands | ~14,000 | ~35 hours of full-room listening per month |

Vercel's Hobby function limits are far higher and are not the bottleneck.

## Notes & limits

- The YouTube player must stay visible and at least 200×200 px (YouTube's
  terms don't allow hidden/audio-only embeds), so it's shown as a small
  320×200 window beside the track title. That is as small as it can go.
- Browsers block autoplay until the user interacts with the page, so joiners
  enter a name and tap to join first; that tap unlocks playback. If the
  browser still refuses, a "Resume" prompt appears.
- Some videos disallow embedding (label "Watch on YouTube" only). The host
  can just skip those.
- Host identity is a token stored in the host browser's localStorage —
  clearing site data means losing host controls for that room. Your name
  and a per-browser id are stored the same way.
- Chat and presence are delivered on the 3-second beat, so messages appear
  with up to a few seconds of delay. Real-time push would need WebSockets,
  which Vercel serverless functions can't hold open.
