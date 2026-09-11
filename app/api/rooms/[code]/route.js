import { NextResponse } from "next/server";
import {
  getRoom,
  setRoom,
  publicRoom,
  syncLive,
  removeListener,
  clearLive,
  cleanName,
  cleanText,
  ENDED_TTL_SECONDS,
  MAX_KICKED,
} from "../../../../lib/store";

export const dynamic = "force-dynamic";

const HOST_ACTIONS = new Set([
  "addTrack",
  "checkLinks",
  "addTracks",
  "removeTrack",
  "moveTrack",
  "playback",
  "advance",
  "kick",
  "end",
]);
const OPEN_ACTIONS = new Set(["sync", "chat"]);

const MAX_BULK = 30; // links checked or added in one go
const MAX_QUEUE = 100;

const json = (data, status = 200) => NextResponse.json(data, { status });

function extractVideoId(input) {
  const s = (input || "").trim();
  // Bare 11-char ID
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchMeta(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`,
      { cache: "no-store", signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title || videoId,
      author: data.author_name || "",
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

// ---------- bulk paste ----------
//
// Accepts whatever an AI assistant (or a person) pasted: one song per line in
// "Title — Artist — link" shape, a bare list of links, markdown bullets, etc.
// Returns each distinct video with the text that was claimed for it.

const URL_RE = /https?:\/\/[^\s<>"'()\]]+/g;

function parseBulk(text) {
  const items = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const urls = line.match(URL_RE) || [];
    // A line with nothing but an 11-char id also counts.
    const candidates = urls.length ? urls : /^[\w-]{11}$/.test(line) ? [line] : [];
    if (!candidates.length) continue;
    let claimed = line;
    for (const u of urls) claimed = claimed.replace(u, " ");
    claimed = claimed
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "") // list markers
      .replace(/[*_`#>]/g, "") // markdown
      .replace(/[—–|:]+/g, " - ")
      .replace(/\s*-\s*$/, "")
      .replace(/^\s*-\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    for (const u of candidates) {
      const videoId = extractVideoId(u);
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      items.push({ videoId, url: u, claimed });
      if (items.length >= MAX_BULK) return items;
    }
  }
  return items;
}

const NOISE = new Set([
  "official",
  "video",
  "audio",
  "lyric",
  "lyrics",
  "song",
  "songs",
  "full",
  "hd",
  "4k",
  "remaster",
  "remastered",
  "the",
  "and",
  "feat",
  "ft",
  "from",
  "with",
]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !NOISE.has(w));
}

// Does what YouTube returned look like the song the line claimed?
function looksLikeMatch(claimed, meta) {
  const want = tokens(claimed);
  if (want.length === 0) return null;
  const have = new Set(tokens(`${meta.title} ${meta.author}`));
  const hits = want.filter((w) => have.has(w)).length;
  return hits >= Math.max(1, Math.ceil(want.length * 0.4));
}

function respond(room, live) {
  return json({
    ...publicRoom(room),
    listeners: live.listeners,
    messages: live.messages,
  });
}

// Pre-join view: room info + who's here. One Redis command.
export async function GET(_req, { params }) {
  const code = params.code.toUpperCase();
  const live = await syncLive(code, { wantRoom: true });
  if (!live.room) return json({ error: "Room not found" }, 404);
  if (live.room.ended) return json({ ended: true, code });
  return respond(live.room, live);
}

export async function POST(req, { params }) {
  const code = params.code.toUpperCase();
  const body = await req.json().catch(() => ({}));
  const action = body.action;
  const hostToken = typeof body.hostToken === "string" ? body.hostToken : "";
  const clientId =
    typeof body.clientId === "string" ? body.clientId.slice(0, 64) : "";
  const name = cleanName(body.name);
  const now = Date.now();

  if (!HOST_ACTIONS.has(action) && !OPEN_ACTIONS.has(action)) {
    return json({ error: "Unknown action" }, 400);
  }

  // ---------- anyone in the room: poll / chat ----------

  if (action === "sync") {
    if (!clientId || !name) return json({ error: "Tell us your name first" }, 400);
    // Presence is written in the same command that reads the room, so the
    // host claim is checked afterwards and undone if it was false.
    const live = await syncLive(code, {
      clientId,
      name,
      host: !!hostToken,
      wantRoom: true,
    });
    const room = live.room;
    if (!room) return json({ error: "Room not found" }, 404);
    if (room.ended) return json({ ended: true, code });
    if (hostToken && hostToken !== room.hostToken) {
      await removeListener(code, clientId);
      return json({ error: "Host only" }, 403);
    }
    if ((room.kicked || []).includes(clientId)) {
      await removeListener(code, clientId);
      return json({ error: "kicked" }, 403);
    }
    return respond(room, live);
  }

  if (action === "chat") {
    if (!clientId || !name) return json({ error: "Tell us your name first" }, 400);
    const text = cleanText(body.text);
    if (!text) return json({ error: "Type something first" }, 400);
    const room = await getRoom(code);
    if (!room) return json({ error: "Room not found" }, 404);
    if (room.ended) return json({ ended: true, code });
    if ((room.kicked || []).includes(clientId)) return json({ error: "kicked" }, 403);
    const isHost = !!hostToken && hostToken === room.hostToken;
    const live = await syncLive(code, {
      clientId,
      name,
      host: isHost,
      message: { id: crypto.randomUUID(), clientId, name, host: isHost, text, at: now },
    });
    return respond(room, live);
  }

  // ---------- host only ----------

  const room = await getRoom(code);
  if (!room) return json({ error: "Room not found" }, 404);
  if (room.ended) return json({ ended: true, code });
  if (!hostToken || hostToken !== room.hostToken) {
    return json({ error: "Host only" }, 403);
  }

  switch (action) {
    case "addTrack": {
      const videoId = extractVideoId(body.url);
      if (!videoId) {
        return json({ error: "That doesn't look like a YouTube link" }, 400);
      }
      const meta = (await fetchMeta(videoId)) || {
        title: videoId,
        author: "",
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      };
      room.queue.push({ id: crypto.randomUUID(), videoId, ...meta });
      room.version++;
      break;
    }

    case "checkLinks": {
      // Read-only: look every pasted link up on YouTube so the host can review
      // before anything lands in the queue. Nothing is written here.
      const items = parseBulk(body.text);
      if (items.length === 0) {
        return json({ error: "No YouTube links found in that text" }, 400);
      }
      const queued = new Set(room.queue.map((t) => t.videoId));
      const results = await Promise.all(
        items.map(async (it) => ({ it, meta: await fetchMeta(it.videoId) }))
      );
      const found = [];
      const failed = [];
      for (const { it, meta } of results) {
        if (meta) {
          found.push({
            videoId: it.videoId,
            ...meta,
            claimed: it.claimed,
            match: it.claimed ? looksLikeMatch(it.claimed, meta) : null,
            inQueue: queued.has(it.videoId),
          });
        } else {
          failed.push({ videoId: it.videoId, url: it.url, claimed: it.claimed });
        }
      }
      return json({ found, failed });
    }

    case "addTracks": {
      const list = Array.isArray(body.tracks) ? body.tracks.slice(0, MAX_BULK) : [];
      const existing = new Set(room.queue.map((t) => t.videoId));
      let added = 0;
      for (const t of list) {
        const videoId =
          t && typeof t.videoId === "string" && /^[\w-]{11}$/.test(t.videoId)
            ? t.videoId
            : null;
        if (!videoId || existing.has(videoId)) continue;
        if (room.queue.length >= MAX_QUEUE) break;
        room.queue.push({
          id: crypto.randomUUID(),
          videoId,
          title: cleanText(t.title, 200) || videoId,
          author: cleanText(t.author, 100),
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        });
        existing.add(videoId);
        added++;
      }
      if (added === 0) {
        return json({ error: "Nothing new to add. Those songs are already queued." }, 400);
      }
      room.version++;
      break;
    }

    case "removeTrack": {
      const idx = room.queue.findIndex((t) => t.id === body.trackId);
      if (idx === -1) break;
      room.queue.splice(idx, 1);
      if (idx < room.currentIndex) {
        room.currentIndex--;
      } else if (idx === room.currentIndex) {
        // Removed the playing track: stay at same index (next track slides in)
        room.position = 0;
        room.positionAt = now;
        if (room.currentIndex >= room.queue.length) {
          room.currentIndex = Math.max(0, room.queue.length - 1);
        }
        if (room.queue.length === 0) room.isPlaying = false;
      }
      room.version++;
      break;
    }

    case "moveTrack": {
      const idx = room.queue.findIndex((t) => t.id === body.trackId);
      const to = idx + (body.dir === "up" ? -1 : 1);
      if (idx === -1 || to < 0 || to >= room.queue.length) break;
      const [t] = room.queue.splice(idx, 1);
      room.queue.splice(to, 0, t);
      // Keep currentIndex pointing at the same track
      if (idx === room.currentIndex) room.currentIndex = to;
      else if (to === room.currentIndex) room.currentIndex = idx;
      room.version++;
      break;
    }

    case "playback": {
      // Host heartbeat / play / pause / jump
      if (typeof body.currentIndex === "number") {
        room.currentIndex = Math.max(
          0,
          Math.min(body.currentIndex, room.queue.length - 1)
        );
      }
      if (typeof body.isPlaying === "boolean") room.isPlaying = body.isPlaying;
      if (typeof body.position === "number") {
        room.position = Math.max(0, body.position);
        room.positionAt = now;
      }
      break;
    }

    case "advance": {
      // Current track ended
      if (room.currentIndex < room.queue.length - 1) {
        room.currentIndex++;
        room.position = 0;
        room.positionAt = now;
        room.isPlaying = true;
      } else {
        room.isPlaying = false;
        room.position = 0;
        room.positionAt = now;
      }
      room.version++;
      break;
    }

    case "kick": {
      const target = typeof body.targetId === "string" ? body.targetId : "";
      if (!target || target === clientId) break;
      room.kicked = [...(room.kicked || []).filter((k) => k !== target), target].slice(
        -MAX_KICKED
      );
      await removeListener(code, target);
      break;
    }

    case "end": {
      // Everyone polling sees {ended:true}; the notice expires on its own.
      await setRoom(code, { code, ended: true, endedAt: now }, ENDED_TTL_SECONDS);
      await clearLive(code);
      return json({ ended: true, code });
    }
  }

  await setRoom(code, room);
  const live = await syncLive(code, { clientId, name, host: true });
  return respond(room, live);
}
