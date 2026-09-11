"use client";

import { useState } from "react";

const DEFAULT_COUNT = 15;

function buildPrompt({ language, mood, era, count }) {
  const lang = language.trim() || "[language]";
  const feel = mood.trim() || "[mood]";
  const when = era.trim();
  const n = Number(count) || DEFAULT_COUNT;
  return [
    `Give me ${n} ${lang} songs that feel ${feel}${when ? ` from ${when}` : ""}.`,
    "Only include songs with an official or well-known upload on YouTube. Search the web and open each link to confirm it plays the right song before including it.",
    "Reply with one song per line and nothing else, in exactly this format:",
    "Song title — Artist — https://www.youtube.com/watch?v=VIDEO_ID",
  ].join("\n");
}

export default function BulkAdd({ act }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState({
    language: "",
    mood: "",
    era: "",
    count: DEFAULT_COUNT,
  });
  const [promptCopied, setPromptCopied] = useState(false);
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState(null); // { found, failed }
  const [picked, setPicked] = useState(() => new Set());
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  const prompt = buildPrompt(fields);
  const setField = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1600);
    } catch {
      window.prompt("Copy this prompt", prompt);
    }
  }

  async function check(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setChecking(true);
    setError("");
    setAddedCount(0);
    try {
      const data = await act({ action: "checkLinks", text }, { raw: true });
      setReview(data);
      // Pre-tick everything that looks right and isn't already queued.
      setPicked(
        new Set(
          data.found.filter((f) => f.match !== false && !f.inQueue).map((f) => f.videoId)
        )
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  function toggle(videoId) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  async function addPicked() {
    const tracks = review.found
      .filter((f) => picked.has(f.videoId))
      .map(({ videoId, title, author }) => ({ videoId, title, author }));
    if (tracks.length === 0) return;
    setAdding(true);
    setError("");
    try {
      await act({ action: "addTracks", tracks });
      setAddedCount(tracks.length);
      setReview(null);
      setPicked(new Set());
      setText("");
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  function startOver() {
    setReview(null);
    setPicked(new Set());
    setError("");
    setAddedCount(0);
  }

  if (!open) {
    return (
      <button className="bulk-toggle" type="button" onClick={() => setOpen(true)}>
        Add many at once
      </button>
    );
  }

  return (
    <section className="bulk" aria-label="Add many songs at once">
      <div className="bulk-head">
        <h3>Add many at once</h3>
        <button className="btn-icon" type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="bulk-help">
        Ask Claude or ChatGPT for a list, paste the reply here, and check what
        YouTube actually finds before anything joins the queue.
      </p>

      <div className="bulk-step">
        <h4>1. Copy a prompt</h4>
        <div className="prompt-fields">
          <label>
            <span>Language</span>
            <input
              className="field"
              value={fields.language}
              onChange={setField("language")}
              placeholder="Tamil"
            />
          </label>
          <label>
            <span>Mood</span>
            <input
              className="field"
              value={fields.mood}
              onChange={setField("mood")}
              placeholder="romantic and slow"
            />
          </label>
          <label>
            <span>Era, if it matters</span>
            <input
              className="field"
              value={fields.era}
              onChange={setField("era")}
              placeholder="the 2000s"
            />
          </label>
          <label>
            <span>How many</span>
            <input
              className="field"
              type="number"
              min={5}
              max={30}
              value={fields.count}
              onChange={setField("count")}
            />
          </label>
        </div>
        <pre className="prompt-text">{prompt}</pre>
        <button className="btn" type="button" onClick={copyPrompt}>
          {promptCopied ? "Prompt copied" : "Copy prompt"}
        </button>
      </div>

      <form className="bulk-step" onSubmit={check}>
        <h4>2. Paste the reply</h4>
        <textarea
          className="field area"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="One song per line, or just a list of YouTube links"
          rows={6}
          aria-label="Pasted list of songs"
        />
        <button className="btn btn-accent" disabled={checking || !text.trim()}>
          {checking ? "Checking…" : "Check links"}
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}
      {addedCount > 0 && (
        <p className="bulk-done">
          Added {addedCount} {addedCount === 1 ? "song" : "songs"} to the queue.
        </p>
      )}

      {review && (
        <div className="bulk-step">
          <h4>3. Review and add</h4>
          {review.found.length === 0 ? (
            <p className="bulk-help">None of those links opened on YouTube.</p>
          ) : (
            <ul className="review">
              {review.found.map((f) => {
                const flagged = f.match === false;
                const on = picked.has(f.videoId);
                return (
                  <li key={f.videoId} className={`${flagged ? "flag" : ""} ${on ? "" : "off"}`}>
                    <label>
                      <input type="checkbox" checked={on} onChange={() => toggle(f.videoId)} />
                      <img src={f.thumbnail} alt="" loading="lazy" />
                      <span className="meta">
                        <span className="t">{f.title}</span>
                        {f.author && <span className="a">{f.author}</span>}
                        {flagged && (
                          <span className="warn">
                            The list said “{f.claimed}”. This may be a different video.
                          </span>
                        )}
                        {f.inQueue && <span className="warn">Already in the queue.</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {review.failed.length > 0 && (
            <div className="review-failed">
              <p>
                {review.failed.length === 1
                  ? "1 link didn't open on YouTube."
                  : `${review.failed.length} links didn't open on YouTube.`}{" "}
                Find them by hand if you want them:
              </p>
              <ul>
                {review.failed.map((f) => (
                  <li key={f.videoId}>
                    <span>{f.claimed || f.url}</span>
                    {f.claimed && (
                      <a
                        href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                          f.claimed
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Search YouTube
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bulk-actions">
            <button
              className="btn btn-accent"
              type="button"
              onClick={addPicked}
              disabled={adding || picked.size === 0}
            >
              {adding
                ? "Adding…"
                : picked.size === 1
                ? "Add 1 song"
                : `Add ${picked.size} songs`}
            </button>
            <button className="btn btn-quiet" type="button" onClick={startOver}>
              Start over
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
