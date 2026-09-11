import { Redis } from "@upstash/redis";

// Works with either the Upstash marketplace integration (UPSTASH_*)
// or Vercel KV-style env names (KV_*).
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const redis = url && token ? new Redis({ url, token }) : null;

// In-memory fallback so `next dev` works with zero setup.
// NOT reliable on Vercel (each serverless invocation may be a fresh process) —
// use Upstash there.
const mem = globalThis.__waveroomRooms || (globalThis.__waveroomRooms = new Map());

const TTL_SECONDS = 60 * 60 * 24; // rooms expire after 24h of inactivity

export const usingRedis = !!redis;

export async function getRoom(code) {
  if (redis) return await redis.get(`room:${code}`);
  return mem.get(code) || null;
}

export async function setRoom(code, room) {
  if (redis) {
    await redis.set(`room:${code}`, room, { ex: TTL_SECONDS });
  } else {
    mem.set(code, room);
  }
}

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
  const { hostToken, ...rest } = room;
  // Effective position computed server-side so client clocks don't matter.
  const elapsed = room.isPlaying ? (Date.now() - room.positionAt) / 1000 : 0;
  return { ...rest, effectivePosition: room.position + elapsed };
}
