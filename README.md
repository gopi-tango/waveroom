# Waveroom

Listen to YouTube together, in sync. The host pastes YouTube links into a
queue; everyone who joins by link or room code hears the same track at the
same moment.

No audio files are ever stored or streamed by this app — every browser plays
the official YouTube embed, and the server only synchronizes *state*
(which video, what position, playing or paused).

## How it works

- **Host** creates a room and gets a 6-character code + shareable link.
  The host's browser is the source of truth: it reports its player position
  to the server every 3 seconds and advances the queue when a track ends.
- **Listeners** poll the room state every 2 seconds and correct their own
  player if it drifts more than ~1.75s from the host.
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

## Notes & limits

- The YouTube player must stay visible (YouTube's terms don't allow
  hidden/audio-only embeds), so the video is shown — which doubles as the UI.
- Browsers block autoplay until the user interacts with the page, so joiners
  see a "Join the session" button first; that tap unlocks playback.
- Some videos disallow embedding (label "Watch on YouTube" only). The host
  can just skip those.
- Host identity is a token stored in the host browser's localStorage —
  clearing site data means losing host controls for that room.
- Polling every 2s per listener is negligible load for a friends-scale room
  and fits comfortably in Vercel + Upstash free tiers.
