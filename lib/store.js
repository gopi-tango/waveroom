import { Redis } from "@upstash/redis";

// Works with either the Upstash marketplace integration (UPSTASH_*)
// or Vercel KV-style env names (KV_*).
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// We JSON-encode everything ourselves so values are predictable inside Lua.
const redis =
  url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;

// In-memory fallback so `next dev` works with zero setup.
// NOT reliable on Vercel (each serverless invocation may be a fresh process) —
// use Upstash there.
const mem =
  globalThis.__waveroomMem ||
  (globalThis.__waveroomMem = {
    rooms: new Map(), // code -> room
    presence: new Map(), // code -> Map(clientId -> entry)
    chat: new Map(), // code -> [message]
    timers: new Map(), // code -> timeout (ended-room cleanup)
  });

export const TTL_SECONDS = 60 * 60 * 24; // rooms expire after 24h of inactivity
export const ENDED_TTL_SECONDS = 60 * 10; // "session ended" notice lingers 10 min
export const STALE_MS = 12_000; // listener dropped if silent this long
// Browsers slow a hidden tab's timers to about once a minute, and the host
// often leaves the tab in the background. Give the host a longer leash so
// they don't vanish from "Here now" while the music keeps playing.
export const HOST_STALE_MS = 75_000;
export const MAX_MESSAGES = 50;
export const MAX_KICKED = 50;

export const usingRedis = !!redis;

const roomKey = (code) => `room:${code}`;
const presenceKey = (code) => `room:${code}:p`;
const chatKey = (code) => `room:${code}:c`;

function parse(s) {
  if (s === null || s === undefined) return null;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- room blob (written only by host actions) ----------

export async function getRoom(code) {
  if (redis) return parse(await redis.get(roomKey(code)));
  return mem.rooms.get(code) || null;
}

export async function setRoom(code, room, ttl = TTL_SECONDS) {
  if (redis) {
    await redis.set(roomKey(code), JSON.stringify(room), { ex: ttl });
    return;
  }
  mem.rooms.set(code, room);
  const prev = mem.timers.get(code);
  if (prev) clearTimeout(prev);
  if (ttl !== TTL_SECONDS) {
    const t = setTimeout(() => {
      mem.rooms.delete(code);
      mem.timers.delete(code);
    }, ttl * 1000);
    if (t.unref) t.unref();
    mem.timers.set(code, t);
  }
}

// ---------- live data: presence + chat ----------
//
// One Lua script does the whole listener poll — write my presence, drop stale
// listeners, append a chat message if any, and read room + listeners + chat.
// Upstash bills EVAL/EVALSHA as ONE command, so a poll costs the same as a
// plain GET did before. (A pipeline would bill each command separately.)

const SYNC_LUA = `
local roomKey, pKey, cKey = KEYS[1], KEYS[2], KEYS[3]
local clientId = ARGV[1]
local entry = ARGV[2]
local msg = ARGV[3]
local now = tonumber(ARGV[4])
local stale = tonumber(ARGV[5])
local wantRoom = ARGV[6]
local ttl = tonumber(ARGV[7])
local maxMsgs = tonumber(ARGV[8])
local hostStale = tonumber(ARGV[9])

if clientId ~= "" then
  redis.call("HSET", pKey, clientId, entry)
end
if msg ~= "" then
  redis.call("RPUSH", cKey, msg)
  redis.call("LTRIM", cKey, -maxMsgs, -1)
end
redis.call("EXPIRE", pKey, ttl)
redis.call("EXPIRE", cKey, ttl)

local all = redis.call("HGETALL", pKey)
local live = {}
for i = 1, #all, 2 do
  local at = tonumber(string.match(all[i + 1], '"at":(%d+)')) or 0
  local limit = stale
  if string.find(all[i + 1], '"host":true', 1, true) then limit = hostStale end
  if now - at > limit then
    redis.call("HDEL", pKey, all[i])
  else
    live[#live + 1] = all[i + 1]
  end
end

local room = false
if wantRoom == "1" then
  room = redis.call("GET", roomKey) or false
end
return { room, live, redis.call("LRANGE", cKey, 0, -1) }
`;

const syncScript = redis ? redis.createScript(SYNC_LUA) : null;

/**
 * @param {string} code
 * @param {{clientId?: string, name?: string, host?: boolean, message?: object|null, wantRoom?: boolean}} opts
 * @returns {Promise<{room: object|null, listeners: object[], messages: object[]}>}
 */
export async function syncLive(code, opts = {}) {
  const now = Date.now();
  const { clientId = "", name = "", host = false, message = null, wantRoom = false } =
    opts;
  const entry = clientId ? { clientId, name, host, at: now } : null;

  if (redis) {
    const res = await syncScript.exec(
      [roomKey(code), presenceKey(code), chatKey(code)],
      [
        clientId,
        entry ? JSON.stringify(entry) : "",
        message ? JSON.stringify(message) : "",
        String(now),
        String(STALE_MS),
        wantRoom ? "1" : "0",
        String(TTL_SECONDS),
        String(MAX_MESSAGES),
        String(HOST_STALE_MS),
      ]
    );
    const [rawRoom, rawLive, rawChat] = Array.isArray(res) ? res : [null, [], []];
    return {
      room: wantRoom ? parse(rawRoom) : null,
      listeners: sortListeners((rawLive || []).map(parse).filter(Boolean)),
      messages: (rawChat || []).map(parse).filter(Boolean),
    };
  }

  // ---- memory fallback ----
  let p = mem.presence.get(code);
  if (!p) mem.presence.set(code, (p = new Map()));
  if (entry) p.set(clientId, entry);
  for (const [id, e] of p) {
    if (now - e.at > (e.host ? HOST_STALE_MS : STALE_MS)) p.delete(id);
  }

  let c = mem.chat.get(code);
  if (!c) mem.chat.set(code, (c = []));
  if (message) {
    c.push(message);
    if (c.length > MAX_MESSAGES) c.splice(0, c.length - MAX_MESSAGES);
  }

  return {
    room: wantRoom ? mem.rooms.get(code) || null : null,
    listeners: sortListeners([...p.values()]),
    messages: [...c],
  };
}

export async function removeListener(code, clientId) {
  if (!clientId) return;
  if (redis) {
    await redis.hdel(presenceKey(code), clientId);
    return;
  }
  mem.presence.get(code)?.delete(clientId);
}

export async function clearLive(code) {
  if (redis) {
    await redis.del(presenceKey(code), chatKey(code));
    return;
  }
  mem.presence.delete(code);
  mem.chat.delete(code);
}

function sortListeners(list) {
  // Host first, then by name
  return list.sort(
    (a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0) || a.name.localeCompare(b.name)
  );
}

// ---------- helpers ----------

export function newCode() {
  // Unambiguous alphabet (no 0/O, 1/I/L)
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function publicRoom(room) {
  const { hostToken, kicked, ...rest } = room;
  // Effective position computed server-side so client clocks don't matter.
  const elapsed = room.isPlaying ? (Date.now() - room.positionAt) / 1000 : 0;
  return { ...rest, effectivePosition: room.position + elapsed };
}

export function cleanName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

export function cleanText(s, max = 300) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
