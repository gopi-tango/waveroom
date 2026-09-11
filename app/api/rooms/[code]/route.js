import { NextResponse } from "next/server";
import { getRoom, setRoom, publicRoom } from "../../../../lib/store";

export const dynamic = "force-dynamic";

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
      { cache: "no-store" }
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

export async function GET(_req, { params }) {
  const room = await getRoom(params.code.toUpperCase());
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  return NextResponse.json(publicRoom(room));
}

export async function POST(req, { params }) {
  const code = params.code.toUpperCase();
  const room = await getRoom(code);
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const { action, hostToken } = body;

  if (hostToken !== room.hostToken) {
    return NextResponse.json({ error: "Host only" }, { status: 403 });
  }

  const now = Date.now();

  switch (action) {
    case "addTrack": {
      const videoId = extractVideoId(body.url);
      if (!videoId) {
        return NextResponse.json(
          { error: "That doesn't look like a YouTube link" },
          { status: 400 }
        );
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
          room.isPlaying = room.queue.length > 0 && room.isPlaying;
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

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  await setRoom(code, room);
  return NextResponse.json(publicRoom(room));
}
