"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

const POLL_MS = 2000; // listeners fetch room state
const HEARTBEAT_MS = 3000; // host pushes its player position
const DRIFT_TOLERANCE = 1.75; // seconds before a listener re-seeks

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function RoomPage() {
  const { code: rawCode } = useParams();
  const code = String(rawCode || "").toUpperCase();

  const [room, setRoom] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [joined, setJoined] = useState(false);
  const [blocked, setBlocked] = useState(false); // autoplay blocked → tap to resume
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0); // drives the progress bar

  const playerRef = useRef(null);
  const playerReadyRef = useRef(false);
  const loadedVideoRef = useRef(null);
  const roomRef = useRef(null);
  const hostTokenRef = useRef(null);
  const fetchedAtRef = useRef(0);

  const isHost = !!hostTokenRef.current;

  useEffect(() => {
    hostTokenRef.current = localStorage.getItem(`waveroom:host:${code}`);
  }, [code]);

  roomRef.current = room;

  const currentTrack =
    room && room.queue.length > 0 ? room.queue[room.currentIndex] : null;

  // ---------- server helpers ----------

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
    if (res.status === 404) {
      setNotFound(true);
      return null;
    }
    const data = await res.json();
    fetchedAtRef.current = Date.now();
    setRoom(data);
    return data;
  }, [code]);

  const act = useCallback(
    async (payload) => {
      const res = await fetch(`/api/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostToken: hostTokenRef.current, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      fetchedAtRef.current = Date.now();
      setRoom(data);
      return data;
    },
    [code]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------- YouTube player ----------

  const expectedPosition = useCallback(() => {
    const r = roomRef.current;
    if (!r) return 0;
    if (!r.isPlaying) return r.effectivePosition;
    return r.effectivePosition + (Date.now() - fetchedAtRef.current) / 1000;
  }, []);

  const createPlayer = useCallback(() => {
    const r = roomRef.current;
    const track = r && r.queue.length > 0 ? r.queue[r.currentIndex] : null;

    playerRef.current = new window.YT.Player("yt-player", {
      width: "100%",
      height: "100%",
      videoId: track ? track.videoId : undefined,
      playerVars: {
        controls: 0,
        disablekb: 1,
        rel: 0,
        playsinline: 1,
        origin:
          typeof window !== "undefined" ? window.location.origin : undefined,
      },
      events: {
        onReady: () => {
          playerReadyRef.current = true;
          if (track) {
            loadedVideoRef.current = track.videoId;
            const pos = expectedPosition();
            playerRef.current.seekTo(pos, true);
            if (r.isPlaying) playerRef.current.playVideo();
          }
        },
        onStateChange: (e) => {
          const YT = window.YT;
          if (e.data === YT.PlayerState.PLAYING) setBlocked(false);
          // Host advances the queue when a track ends
          if (
            e.data === YT.PlayerState.ENDED &&
            hostTokenRef.current &&
            roomRef.current
          ) {
            act({ action: "advance" }).catch(() => {});
          }
        },
      },
    });
  }, [act, expectedPosition]);

  const join = useCallback(() => {
    setJoined(true);
    if (window.YT && window.YT.Player) {
      createPlayer();
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) prev();
      createPlayer();
    };
    if (!document.getElementById("yt-iframe-api")) {
      const s = document.createElement("script");
      s.id = "yt-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
  }, [createPlayer]);

  // ---------- sync loop ----------

  useEffect(() => {
    if (!joined) return;

    const id = setInterval(async () => {
      const r = isHost ? roomRef.current : await refresh();
      if (!r) return;

      const p = playerRef.current;
      if (!p || !playerReadyRef.current) return;

      const track = r.queue.length > 0 ? r.queue[r.currentIndex] : null;
      const YT = window.YT;
      const state = p.getPlayerState ? p.getPlayerState() : -1;

      // Nothing to play
      if (!track) {
        if (state === YT.PlayerState.PLAYING) p.stopVideo();
        loadedVideoRef.current = null;
        return;
      }

      // Wrong (or no) video loaded
      if (loadedVideoRef.current !== track.videoId) {
        loadedVideoRef.current = track.videoId;
        p.loadVideoById(track.videoId, isHost ? 0 : expectedPosition());
        if (!r.isPlaying) setTimeout(() => p.pauseVideo(), 400);
        return;
      }

      if (isHost) return; // host's player is the source of truth

      // Listener drift correction
      const expected = expectedPosition();
      const actual = p.getCurrentTime ? p.getCurrentTime() : 0;

      if (r.isPlaying) {
        if (Math.abs(actual - expected) > DRIFT_TOLERANCE) {
          p.seekTo(expected, true);
        }
        if (
          state !== YT.PlayerState.PLAYING &&
          state !== YT.PlayerState.BUFFERING
        ) {
          p.playVideo();
          // If the browser refuses (no gesture registered), surface a tap prompt
          setTimeout(() => {
            const s2 = p.getPlayerState ? p.getPlayerState() : -1;
            if (
              roomRef.current?.isPlaying &&
              s2 !== YT.PlayerState.PLAYING &&
              s2 !== YT.PlayerState.BUFFERING
            ) {
              setBlocked(true);
            }
          }, 1200);
        }
      } else if (state === YT.PlayerState.PLAYING) {
        p.pauseVideo();
      }
    }, POLL_MS);

    return () => clearInterval(id);
  }, [joined, isHost, refresh, expectedPosition]);

  // Host heartbeat: publish player position so listeners can sync
  useEffect(() => {
    if (!joined || !isHost) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      const r = roomRef.current;
      if (!p || !playerReadyRef.current || !r || r.queue.length === 0) {
        refresh();
        return;
      }
      const YT = window.YT;
      const playing = p.getPlayerState() === YT.PlayerState.PLAYING;
      act({
        action: "playback",
        position: p.getCurrentTime() || 0,
        isPlaying: playing,
      }).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [joined, isHost, act, refresh]);

  // Progress bar tick
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [joined]);

  // ---------- host actions ----------

  async function addTrack(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setAddError("");
    try {
      await act({ action: "addTrack", url });
      setUrl("");
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function togglePlay() {
    const p = playerRef.current;
    const r = roomRef.current;
    if (!p || !r || r.queue.length === 0) return;
    const pos = p.getCurrentTime ? p.getCurrentTime() : 0;
    if (r.isPlaying) {
      p.pauseVideo();
      await act({ action: "playback", isPlaying: false, position: pos });
    } else {
      p.playVideo();
      await act({ action: "playback", isPlaying: true, position: pos });
    }
  }

  async function jump(delta) {
    const r = roomRef.current;
    if (!r) return;
    const next = r.currentIndex + delta;
    if (next < 0 || next >= r.queue.length) return;
    loadedVideoRef.current = null; // force reload in sync loop
    await act({
      action: "playback",
      currentIndex: next,
      position: 0,
      isPlaying: true,
    });
    const p = playerRef.current;
    if (p && playerReadyRef.current) {
      loadedVideoRef.current = r.queue[next].videoId;
      p.loadVideoById(r.queue[next].videoId, 0);
    }
  }

  function copyLink() {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  // ---------- render ----------

  if (notFound) {
    return (
      <main className="home">
        <div className="home-card">
          <h1>
            Wave<em>room</em>
          </h1>
          <p className="lede">
            This room doesn't exist (rooms expire after 24 hours of quiet).
          </p>
          <a href="/">Start a new one</a>
        </div>
      </main>
    );
  }

  const p = playerRef.current;
  const dur =
    joined && p && playerReadyRef.current && p.getDuration
      ? p.getDuration()
      : 0;
  const cur =
    joined && p && playerReadyRef.current && p.getCurrentTime
      ? p.getCurrentTime()
      : 0;

  return (
    <main className="room">
      <header className="room-header">
        <a className="wordmark" href="/">
          Wave<em>room</em>
        </a>
        <div className="right">
          <span className={`on-air ${room?.isPlaying ? "" : "idle"}`}>
            <span className="dot" />
            {room?.isPlaying ? "ON AIR" : "QUIET"}
          </span>
          <button className="code-chip" onClick={copyLink} title="Copy invite link">
            <span>{copied ? "copied!" : "room"}</span>
            {code}
          </button>
        </div>
      </header>

      <div className="room-grid">
        <section className="player-panel">
          <div className="player-shell">
            <div id="yt-player" />
            {(!room || room.queue.length === 0) && (
              <div className="player-empty">
                {isHost
                  ? "Paste a YouTube link on the right to start the queue."
                  : "Waiting for the host to queue something up…"}
              </div>
            )}
          </div>

          {currentTrack && (
            <div className="now-playing">
              <div className="np-title">{currentTrack.title}</div>
              {currentTrack.author && (
                <div className="np-author">{currentTrack.author}</div>
              )}
              <div className="progress" aria-hidden="true">
                <div
                  className="fill"
                  style={{
                    width: dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%",
                  }}
                />
              </div>
              <div className="time-row">
                <span>{fmt(cur)}</span>
                <span>{fmt(dur)}</span>
              </div>
            </div>
          )}

          {isHost ? (
            <div className="controls">
              <button
                className="btn"
                onClick={() => jump(-1)}
                disabled={!room || room.currentIndex === 0}
              >
                ‹ Prev
              </button>
              <button
                className="btn btn-accent play"
                onClick={togglePlay}
                disabled={!room || room.queue.length === 0 || !joined}
              >
                {room?.isPlaying ? "Pause" : "Play"}
              </button>
              <button
                className="btn"
                onClick={() => jump(1)}
                disabled={
                  !room || room.currentIndex >= (room?.queue.length || 0) - 1
                }
              >
                Next ›
              </button>
            </div>
          ) : (
            <p className="listener-note">
              You're listening along — the host controls playback.
            </p>
          )}
        </section>

        <aside className="queue-panel">
          <h2>
            Queue <span>· {room?.queue.length || 0} tracks</span>
          </h2>

          {isHost && (
            <>
              <form className="add-row" onSubmit={addTrack}>
                <input
                  className="field"
                  placeholder="Paste a YouTube link"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-label="YouTube link"
                />
                <button className="btn btn-accent" disabled={adding || !url.trim()}>
                  Add
                </button>
              </form>
              {addError && <p className="add-error">{addError}</p>}
            </>
          )}

          <ul className="queue-list">
            {room?.queue.map((t, i) => (
              <li
                key={t.id}
                className={`queue-item ${i === room.currentIndex ? "current" : ""}`}
              >
                <img src={t.thumbnail} alt="" loading="lazy" />
                <div className="meta">
                  <div className="t">{t.title}</div>
                  <div className="a">{t.author}</div>
                </div>
                {isHost && (
                  <div className="ops">
                    <button
                      className="btn-icon"
                      title="Move up"
                      onClick={() => act({ action: "moveTrack", trackId: t.id, dir: "up" })}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="btn-icon"
                      title="Move down"
                      onClick={() => act({ action: "moveTrack", trackId: t.id, dir: "down" })}
                      disabled={i === room.queue.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="btn-icon"
                      title="Remove"
                      onClick={() => act({ action: "removeTrack", trackId: t.id })}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </li>
            ))}
            {room && room.queue.length === 0 && (
              <li className="queue-empty">Nothing queued yet.</li>
            )}
          </ul>
        </aside>
      </div>

      {!joined && room && (
        <div className="overlay">
          <div className="overlay-card">
            <h2>
              {isHost ? "Your room is ready" : `You're invited to ${code}`}
            </h2>
            <p>
              {isHost
                ? "Step in to start queuing and playing music."
                : "Tap below to join and hear what's playing."}
            </p>
            <button className="btn btn-accent" onClick={join}>
              {isHost ? "Enter the room" : "Join the session"}
            </button>
          </div>
        </div>
      )}

      {joined && blocked && (
        <div className="overlay">
          <div className="overlay-card">
            <h2>Playback paused by your browser</h2>
            <p>Tap to resume listening in sync.</p>
            <button
              className="btn btn-accent"
              onClick={() => {
                playerRef.current?.playVideo();
                setBlocked(false);
              }}
            >
              Resume
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
