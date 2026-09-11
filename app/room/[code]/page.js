"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Logo from "../../logo";

const POLL_MS = 3000; // everyone syncs with the room on this beat
const DRIFT_TOLERANCE = 1.75; // seconds before a listener re-seeks

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clock(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function RoomPage() {
  const { code: rawCode } = useParams();
  const router = useRouter();
  const code = String(rawCode || "").toUpperCase();

  const [me, setMe] = useState(null); // { clientId, name, hostToken }
  const [room, setRoom] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ok | notfound | ended | kicked
  const [joined, setJoined] = useState(false);
  const [blocked, setBlocked] = useState(false); // autoplay blocked → tap to resume
  const [copied, setCopied] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [, setTick] = useState(0); // drives the progress bar

  const playerRef = useRef(null);
  const playerReadyRef = useRef(false);
  const loadedVideoRef = useRef(null);
  const roomRef = useRef(null);
  const meRef = useRef(null);
  const fetchedAtRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const leavingRef = useRef(false);
  const chatLogRef = useRef(null);

  roomRef.current = room;

  const isHost = !!(me && me.hostToken);
  const listeners = room?.listeners || [];
  const messages = room?.messages || [];
  const currentTrack =
    room && room.queue?.length > 0 ? room.queue[room.currentIndex] : null;

  // ---------- who am I ----------

  useEffect(() => {
    let clientId = localStorage.getItem("waveroom:client");
    if (!clientId) {
      clientId = newId();
      localStorage.setItem("waveroom:client", clientId);
    }
    const name = localStorage.getItem("waveroom:name") || "";
    const hostToken = localStorage.getItem(`waveroom:host:${code}`) || "";
    const m = { clientId, name, hostToken };
    meRef.current = m;
    setMe(m);
    setNameInput(name);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, [code]);

  // ---------- server helpers ----------

  const apply = useCallback((res, data) => {
    if (res.status === 404) {
      setStatus("notfound");
      return null;
    }
    if (data && data.ended) {
      if (!leavingRef.current) setStatus("ended");
      return null;
    }
    if (res.status === 403 && data?.error === "kicked") {
      setStatus("kicked");
      return null;
    }
    if (!res.ok) throw new Error(data?.error || "Something went wrong. Try again.");
    fetchedAtRef.current = Date.now();
    setRoom(data);
    setStatus("ok");
    return data;
  }, []);

  const post = useCallback(
    async (payload) => {
      const m = meRef.current || {};
      const res = await fetch(`/api/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostToken: m.hostToken || undefined,
          clientId: m.clientId,
          name: m.name,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      return apply(res, data);
    },
    [code, apply]
  );

  // Requests run one at a time so a heartbeat never overlaps a queue edit.
  const act = useCallback(
    (payload) => {
      const run = chainRef.current.then(() => post(payload));
      chainRef.current = run.catch(() => {});
      return run;
    },
    [post]
  );

  // First look at the room, before joining.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) apply(res, data);
      } catch {
        if (!cancelled) setStatus("notfound");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, apply]);

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

    // Passing `videoId: undefined` makes the YouTube API throw "Invalid video
    // id", so the key is only present when there is something to load.
    playerRef.current = new window.YT.Player("yt-player", {
      width: "100%",
      height: "100%",
      ...(track ? { videoId: track.videoId } : {}),
      playerVars: {
        controls: 0,
        disablekb: 1,
        rel: 0,
        playsinline: 1,
        origin: typeof window !== "undefined" ? window.location.origin : undefined,
      },
      events: {
        onReady: () => {
          playerReadyRef.current = true;
          if (track) {
            loadedVideoRef.current = track.videoId;
            playerRef.current.seekTo(expectedPosition(), true);
            if (r.isPlaying) playerRef.current.playVideo();
          }
        },
        onStateChange: (e) => {
          const YT = window.YT;
          if (e.data === YT.PlayerState.PLAYING) setBlocked(false);
          // Host advances the queue when a track ends
          if (e.data === YT.PlayerState.ENDED && meRef.current?.hostToken && roomRef.current) {
            act({ action: "advance" }).catch(() => {});
          }
        },
      },
    });
  }, [act, expectedPosition]);

  const loadPlayer = useCallback(() => {
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

  function join(e) {
    e.preventDefault();
    const name = nameInput.replace(/\s+/g, " ").trim().slice(0, 24);
    if (!name) return;
    localStorage.setItem("waveroom:name", name);
    const m = { ...(meRef.current || {}), name };
    meRef.current = m;
    setMe(m);
    setJoined(true);
    loadPlayer();
    // Show up in the room right away instead of waiting for the first beat.
    act({ action: "sync" }).catch(() => {});
  }

  // ---------- the beat: everyone syncs every POLL_MS ----------

  useEffect(() => {
    if (!joined || status !== "ok") return;

    const id = setInterval(async () => {
      const p = playerRef.current;
      const ready = !!p && playerReadyRef.current;
      const YT = window.YT;

      let r;
      try {
        if (isHost) {
          const cur = roomRef.current;
          if (ready && cur && cur.queue.length > 0) {
            // Host's player is the source of truth: publish where it is.
            r = await act({
              action: "playback",
              position: p.getCurrentTime() || 0,
              isPlaying: p.getPlayerState() === YT.PlayerState.PLAYING,
            });
          } else {
            r = await act({ action: "sync" });
          }
        } else {
          r = await act({ action: "sync" });
        }
      } catch {
        return;
      }
      if (!r || !ready) return;

      const track = r.queue.length > 0 ? r.queue[r.currentIndex] : null;
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

      if (isHost) return;

      // Listener drift correction
      const expected = expectedPosition();
      const actual = p.getCurrentTime ? p.getCurrentTime() : 0;

      if (r.isPlaying) {
        if (Math.abs(actual - expected) > DRIFT_TOLERANCE) p.seekTo(expected, true);
        if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
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
  }, [joined, status, isHost, act, expectedPosition]);

  // Coming back to a backgrounded tab: catch up right away instead of waiting a beat.
  useEffect(() => {
    if (!joined || status !== "ok") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") act({ action: "sync" }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [joined, status, act]);

  // Progress bar tick
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [joined]);

  // Follow new messages, but don't yank someone who scrolled up to read.
  const lastMsg = messages[messages.length - 1];
  useEffect(() => {
    const el = chatLogRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const mine = lastMsg && me && lastMsg.clientId === me.clientId;
    if (nearBottom || mine) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMsg?.id]);

  // ---------- actions ----------

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
    const p = playerRef.current;
    if (p && playerReadyRef.current) {
      loadedVideoRef.current = r.queue[next].videoId;
      p.loadVideoById(r.queue[next].videoId, 0);
    } else {
      loadedVideoRef.current = null;
    }
    await act({ action: "playback", currentIndex: next, position: 0, isPlaying: true });
  }

  async function sendChat(e) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setSending(true);
    try {
      await act({ action: "chat", text });
      setChatInput("");
    } catch {
      // keep the draft so they can retry
    } finally {
      setSending(false);
    }
  }

  async function endSession() {
    if (!window.confirm("End the session for everyone? The queue and chat are cleared.")) return;
    setEnding(true);
    leavingRef.current = true;
    try {
      await act({ action: "end" });
    } catch {
      // the room may already be gone; leave anyway
    }
    localStorage.removeItem(`waveroom:host:${code}`);
    router.push("/");
  }

  function removeListener(l) {
    if (!window.confirm(`Remove ${l.name} from the room?`)) return;
    act({ action: "kick", targetId: l.clientId }).catch(() => {});
  }

  async function shareLink() {
    const link = window.location.href;
    // Phones: the native share sheet. Elsewhere: clipboard, then a last-resort prompt.
    if (canShare) {
      try {
        await navigator.share({ title: `Waveroom ${code}`, url: link });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  // ---------- render ----------

  if (status === "loading" || !me) {
    return (
      <main className="home">
        <p className="opening">Opening room {code}…</p>
      </main>
    );
  }
  if (status === "notfound") {
    return (
      <Notice title="This room doesn't exist">
        Check the code, or it may have closed after a day of quiet.
      </Notice>
    );
  }
  if (status === "ended") {
    return (
      <Notice title="The host ended the session">
        Thanks for listening along.
      </Notice>
    );
  }
  if (status === "kicked") {
    return (
      <Notice title="You've been removed from this room">
        The host removed you. You can still start a room of your own.
      </Notice>
    );
  }

  const p = playerRef.current;
  const ready = joined && p && playerReadyRef.current;
  const dur = ready && p.getDuration ? p.getDuration() : 0;
  const cur = ready && p.getCurrentTime ? p.getCurrentTime() : 0;
  const queue = room?.queue || [];
  const others = listeners.length;

  return (
    <main className="room">
      <header className="bar">
        <a className="wordmark" href="/">
          <Logo />
          Waveroom
        </a>
        <div className="bar-right">
          <span className={`live ${room?.isPlaying ? "on" : ""}`}>
            <span className="dot" />
            {room?.isPlaying ? "On air" : "Quiet"}
          </span>
          <button className="invite" onClick={shareLink} title="Share the invite link">
            <span className="invite-code">{code}</span>
            <span className="invite-hint">
              {copied ? "Link copied" : canShare ? "Share invite" : "Copy invite"}
            </span>
          </button>
          {isHost && joined && (
            <button className="btn btn-quiet" onClick={endSession} disabled={ending}>
              {ending ? "Ending…" : "End session"}
            </button>
          )}
        </div>
      </header>

      <div className="layout">
        <div className="main-col">
          <section className={`stage ${room?.isPlaying ? "playing" : ""}`}>
            <div className="screen">
              <div id="yt-player" />
              {(!room || queue.length === 0) && (
                <div className="screen-empty">Nothing playing</div>
              )}
            </div>

            <div className="stage-body">
              {currentTrack ? (
                <>
                  <h1 className="track-title">{currentTrack.title}</h1>
                  {currentTrack.author && <p className="track-author">{currentTrack.author}</p>}
                  <div className="progress" aria-hidden="true">
                    <div
                      className="fill"
                      style={{ width: dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%" }}
                    />
                  </div>
                  <div className="times">
                    <span>{fmt(cur)}</span>
                    <span>{fmt(dur)}</span>
                  </div>
                </>
              ) : (
                <>
                  <h1 className="track-title quiet">
                    {isHost ? "Your room is open." : "Waiting for the first track."}
                  </h1>
                  <p className="track-author">
                    {isHost
                      ? "Paste a YouTube link into the queue, then press Play."
                      : "The host is picking something."}
                  </p>
                </>
              )}

              {isHost ? (
                <div className="controls">
                  <button
                    className="btn"
                    onClick={() => jump(-1)}
                    disabled={!room || room.currentIndex === 0 || !joined}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-accent play"
                    onClick={togglePlay}
                    disabled={!room || queue.length === 0 || !joined}
                  >
                    {room?.isPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => jump(1)}
                    disabled={!room || room.currentIndex >= queue.length - 1 || !joined}
                  >
                    Next
                  </button>
                </div>
              ) : (
                <p className="note">The host controls playback. You stay in sync.</p>
              )}
            </div>
          </section>

          <section className="queue">
            <div className="section-head">
              <h2>Queue</h2>
              <span className="count">
                {queue.length} {queue.length === 1 ? "track" : "tracks"}
              </span>
            </div>

            {isHost && (
              <form className="add" onSubmit={addTrack}>
                <input
                  className="field"
                  placeholder="Paste a YouTube link"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-label="YouTube link"
                />
                <button className="btn btn-accent" disabled={adding || !url.trim()}>
                  {adding ? "Adding…" : "Add to queue"}
                </button>
              </form>
            )}
            {addError && <p className="form-error">{addError}</p>}

            <ol className="tracks">
              {queue.map((t, i) => (
                <li
                  key={t.id}
                  className={`track ${i === room.currentIndex ? "current" : ""} ${
                    i < room.currentIndex ? "played" : ""
                  }`}
                >
                  <span className="num">{i + 1}</span>
                  <img src={t.thumbnail} alt="" loading="lazy" />
                  <div className="meta">
                    <div className="t">{t.title}</div>
                    {t.author && <div className="a">{t.author}</div>}
                  </div>
                  {isHost && (
                    <div className="ops">
                      <button
                        className="btn-icon"
                        title="Move up"
                        aria-label="Move up"
                        onClick={() => act({ action: "moveTrack", trackId: t.id, dir: "up" })}
                        disabled={i === 0}
                      >
                        ↑
                      </button>
                      <button
                        className="btn-icon"
                        title="Move down"
                        aria-label="Move down"
                        onClick={() => act({ action: "moveTrack", trackId: t.id, dir: "down" })}
                        disabled={i === queue.length - 1}
                      >
                        ↓
                      </button>
                      <button
                        className="btn-icon"
                        title="Remove from queue"
                        aria-label="Remove from queue"
                        onClick={() => act({ action: "removeTrack", trackId: t.id })}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </li>
              ))}
              {room && queue.length === 0 && (
                <li className="tracks-empty">
                  {isHost ? "Nothing queued yet. Paste a link above." : "Nothing queued yet."}
                </li>
              )}
            </ol>
          </section>
        </div>

        <aside className="side-col">
          <section className="people">
            <div className="section-head">
              <h2>Here now</h2>
              <span className="count">{others}</span>
            </div>
            <ul className="people-list">
              {listeners.map((l) => {
                const isMe = me && l.clientId === me.clientId;
                return (
                  <li key={l.clientId} className={l.host ? "is-host" : ""}>
                    <span className="avatar" aria-hidden="true">
                      {(l.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="pname">
                      {l.name}
                      {isMe && <em> (you)</em>}
                    </span>
                    {l.host && <span className="tag">host</span>}
                    {isHost && !l.host && !isMe && (
                      <button
                        className="btn-icon"
                        title={`Remove ${l.name} from the room`}
                        onClick={() => removeListener(l)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
              {joined && listeners.length <= 1 && (
                <li className="people-empty">
                  Just you so far. Share the invite from the top bar.
                </li>
              )}
            </ul>
          </section>

          <section className="chat">
            <div className="section-head">
              <h2>Chat</h2>
            </div>
            <div className="chat-log" ref={chatLogRef}>
              {messages.length === 0 && (
                <p className="chat-empty">Say hi. Messages stay while the room is open.</p>
              )}
              {messages.map((m) => {
                const mine = me && m.clientId === me.clientId;
                return (
                  <div key={m.id} className={`msg ${mine ? "mine" : ""}`}>
                    <div className="msg-head">
                      <span className="msg-name">
                        {mine ? "You" : m.name}
                        {m.host && !mine && <span className="tag">host</span>}
                      </span>
                      <time dateTime={new Date(m.at).toISOString()}>{clock(m.at)}</time>
                    </div>
                    <p className="msg-text">{m.text}</p>
                  </div>
                );
              })}
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input
                className="field"
                placeholder={joined ? "Message everyone" : "Join to chat"}
                value={chatInput}
                maxLength={300}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={!joined}
                aria-label="Chat message"
              />
              <button className="btn" disabled={!joined || sending || !chatInput.trim()}>
                Send
              </button>
            </form>
          </section>
        </aside>
      </div>

      {!joined && status === "ok" && me && (
        <div className="overlay">
          <form className="door" onSubmit={join}>
            <p className="door-code">Room {code}</p>
            <h2>{isHost ? "Your room is open" : "You're invited"}</h2>
            <p className="door-lede">
              {others === 0
                ? isHost
                  ? "Step in, then share the invite from the top bar."
                  : "You'd be the first one here."
                : `${others} ${others === 1 ? "person is" : "people are"} already here.`}
            </p>
            <label className="door-field">
              <span>Your name</span>
              <input
                className="field"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={24}
                autoFocus
                autoComplete="nickname"
                placeholder="What should we call you?"
              />
            </label>
            <button className="btn btn-accent" disabled={!nameInput.trim()}>
              {isHost ? "Step in" : "Join and listen"}
            </button>
          </form>
        </div>
      )}

      {joined && blocked && (
        <div className="overlay">
          <div className="door">
            <h2>Your browser paused playback</h2>
            <p className="door-lede">Tap to catch up with everyone.</p>
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

function Notice({ title, children }) {
  return (
    <main className="home">
      <div className="home-card">
        <a className="wordmark" href="/">
          <Logo />
          Waveroom
        </a>
        <h1 className="notice-title">{title}</h1>
        <p className="lede">{children}</p>
        <a className="btn btn-accent" href="/">
          Start a new room
        </a>
      </div>
    </main>
  );
}
