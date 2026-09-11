import { NextResponse } from "next/server";
import { getRoom, setRoom, newCode } from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  let code = newCode();
  // Regenerate on the (unlikely) collision
  for (let i = 0; i < 5 && (await getRoom(code)); i++) code = newCode();

  const hostToken = crypto.randomUUID();
  const room = {
    code,
    hostToken,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    position: 0,
    positionAt: Date.now(),
    version: 0,
  };
  await setRoom(code, room);
  return NextResponse.json({ code, hostToken });
}
