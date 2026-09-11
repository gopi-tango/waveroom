"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createRoom() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create room");
      localStorage.setItem(`waveroom:host:${data.code}`, data.hostToken);
      router.push(`/room/${data.code}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function joinRoom(e) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/rooms/${c}`);
    if (res.ok) {
      router.push(`/room/${c}`);
    } else {
      setError("No room with that code. Check it and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <div className="home-card">
        <span className="wordmark">Waveroom</span>
        <h1>Same song, same second, with your friends.</h1>
        <p className="lede">
          Queue up YouTube links and listen together in sync. Up to ten
          people, a name, and a chat.
        </p>

        <div className="home-actions">
          <button className="btn btn-accent" onClick={createRoom} disabled={busy}>
            Start a room
          </button>

          <div className="or">or join one</div>

          <form className="join-row" onSubmit={joinRoom}>
            <input
              className="field"
              placeholder="Room code"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Room code"
            />
            <button className="btn" disabled={busy || !code.trim()}>
              Join
            </button>
          </form>
        </div>

        {error && <p className="home-error">{error}</p>}
      </div>
    </main>
  );
}
