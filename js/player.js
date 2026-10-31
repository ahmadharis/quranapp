// Gapless recitation player.
//
// alislam.org serves one MP3 per verse. Playing them one after another through separate audio
// elements leaves a gap while each file loads. Instead, verse files are fetched ahead, reduced
// to their raw audio frames (mp3.js) and joined into one continuous stream played by a single
// <audio> element. One element that never stops also keeps playback alive with the screen off
// and drives the lock-screen / car "now playing" controls through the Media Session API.
//
// Two ways to join:
// - StreamBackend: Media Source Extensions — frames are appended to one growing buffer, each
//   verse placed so its encoder priming and padding fall outside the append window and are
//   cut sample-accurately. Seamless across verses and chapters. Used where MSE supports
//   audio/mpeg (Android, desktop browsers).
// - ChunkBackend: frames for a run of verses are joined into one Blob and played as a file;
//   the next run is prepared while the current one plays. Used on iPhone/iPad, where MSE is
//   unavailable or unreliable in the background. Only whole frames can be cut here, so each
//   join keeps the ~25 ms of decoder priming.

import { extractFrames, id3v2Size } from "./mp3.js";
import { CHAPTERS } from "./quran-data.js";

const AUDIO_BASE = "https://files.alislam.cloud/audio/tilawat/";

// alislam's reciters, in alislam's order; Mishary Rashid AlAfasy is alislam's default.
export const RECITERS = [
  { id: "ashiq", name: "Qari Muhammad Ashiq" },
  { id: "feroz", name: "Maulana Feroz Alam" },
  { id: "aiman", name: "Aiman Almaliki" },
  { id: "rashid", name: "Mishary Rashid AlAfasy" },
  { id: "idir-iken", name: "Idir Iken" },
];
export const DEFAULT_RECITER = "rashid";

const pad3 = (n) => String(n).padStart(3, "0");
const audioUrl = (reciter, { ch, v }) => `${AUDIO_BASE}${reciter}/${pad3(ch)}-${pad3(v)}-AR.mp3`;
const key = ({ ch, v }) => `${ch}:${v}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 20000; // a request stuck while the phone changes networks is retried

// fetch() that gives up after FETCH_TIMEOUT_MS instead of hanging for minutes.
function fetchWithTimeout(url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

class NotFound extends Error {}

// A third of a second of silent MP3 (12 empty MPEG-1 Layer III frames, 128 kbps, 44.1 kHz).
// Playing it inside the user's tap unlocks the audio element on iOS, so later chunks — which
// only arrive after network requests — are allowed to play.
const SILENCE_URL = (() => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  return URL.createObjectURL(new Blob(Array(12).fill(frame), { type: "audio/mpeg" }));
})();

export function nextVerse({ ch, v }) {
  if (v < CHAPTERS[ch - 1][3]) return { ch, v: v + 1 };
  return ch < 114 ? { ch: ch + 1, v: 1 } : null;
}

export function prevVerse({ ch, v }) {
  if (v > 1) return { ch, v: v - 1 };
  return ch > 1 ? { ch: ch - 1, v: CHAPTERS[ch - 2][3] } : null;
}

// Widens a verse's trim to cover the pure digital silence beside the encoder's priming and
// padding — some reciters' files have no padding information (Aiman Almaliki), others carry
// long silent lead-ins (Qari Muhammad Ashiq). Measured by decoding the verse once. Short runs
// (up to 100 ms) are trimmed away; longer ones are trimmed to leave 20 ms, so a join keeps a
// breath (about 40–60 ms) instead of a gap. At most 480 ms is trimmed per side.
async function trimSilentEdges(f) {
  const total = f.frames * f.samplesPerFrame;
  if (!total || typeof OfflineAudioContext === "undefined") return f;
  try {
    const buf = await new OfflineAudioContext(1, 1, f.sampleRate).decodeAudioData(f.bytes.slice().buffer);
    if (buf.length !== total) return f; // this decoder trims on its own; the header values stand
    const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    const silent = (i) => ch.every((x) => Math.abs(x[i]) < 3e-4); // below -70 dBFS: inaudible
    const ms = (x) => Math.round((f.sampleRate * x) / 1000);
    const look = ms(500); // a run longer than this is left alone beyond the cap
    const trimOf = (run) => (run <= ms(100) ? run : Math.min(ms(480), run - ms(20)));
    let run = 0;
    while (run < look && f.skipStart + run < total - f.skipEnd - 1 && silent(f.skipStart + run)) run++;
    const start = f.skipStart + trimOf(run);
    run = 0;
    while (run < look && total - f.skipEnd - run - 1 > start && silent(total - f.skipEnd - run - 1)) run++;
    const endSkip = f.skipEnd + trimOf(run);
    return { ...f, skipStart: start, skipEnd: endSkip, duration: (total - start - endSkip) / f.sampleRate };
  } catch {
    return f;
  }
}

// Fetches and parses verse audio, keeping recent verses in memory.
class VerseLoader {
  constructor({ measureEdges = false } = {}) {
    this.cache = new Map();
    this.measureEdges = measureEdges; // only the stream backend can trim to the sample
    // Some reciters' files carry large embedded artwork (Feroz Alam's: ~4.6 MB of a 5 MB
    // verse), so by default the 10-byte tag header is read first and only the audio after the
    // tag is requested. Reciters found to have small tags are fetched whole from then on.
    this.smallTags = new Set();
    this.rangeWorks = true;
  }

  load(reciter, pos) {
    const k = `${reciter}/${key(pos)}`;
    let p = this.cache.get(k);
    if (!p) {
      p = this.#fetch(reciter, audioUrl(reciter, pos));
      p.catch(() => this.cache.get(k) === p && this.cache.delete(k));
      this.cache.set(k, p);
      while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    }
    return p;
  }

  forget(reciter, pos) {
    this.cache.delete(`${reciter}/${key(pos)}`);
  }

  prefetch(reciter, pos, count) {
    for (let p = pos, i = 0; p && i < count; p = nextVerse(p), i++) this.load(reciter, p);
  }

  async #get(url, range) {
    const res = await fetchWithTimeout(url, range ? { headers: { Range: range } } : {});
    if (res.status === 404) throw new NotFound(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  // The file without its leading ID3 tag, or the whole file if ranges aren't honored.
  async #audioOnly(url, reciter) {
    const head = await this.#get(url, "bytes=0-9");
    const headBytes = new Uint8Array(await head.arrayBuffer());
    if (head.status !== 206) return headBytes.buffer; // server ignored the range: full file
    const tag = id3v2Size(headBytes);
    if (tag < 64 * 1024) this.smallTags.add(reciter); // not worth a second request next time
    return (await this.#get(url, `bytes=${tag}-`)).arrayBuffer();
  }

  async #fetch(reciter, url) {
    for (let attempt = 0; ; attempt++) {
      try {
        let buf;
        if (!this.smallTags.has(reciter) && this.rangeWorks) {
          try {
            buf = await this.#audioOnly(url, reciter);
          } catch (err) {
            if (err instanceof NotFound) throw err;
            this.rangeWorks = false; // e.g. a browser that won't send Range cross-origin
          }
        }
        buf ??= await (await this.#get(url)).arrayBuffer();
        const frames = extractFrames(buf);
        // An error page or captive-portal page served as 200 has no MP3 frames.
        if (!frames.frames) throw new Error(`No audio in ${url}`);
        return this.measureEdges ? trimSilentEdges(frames) : frames;
      } catch (err) {
        if (err instanceof NotFound || attempt >= 4) throw err;
        await sleep(800 * 2 ** attempt);
      }
    }
  }
}

class StreamBackend {
  constructor(audio, loader) {
    this.audio = audio;
    this.loader = loader;
    this.session = 0;
    this.segments = [];
  }

  async start(reciter, pos) {
    const session = ++this.session;
    this.segments = [];
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    this.audio.src = url;
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    URL.revokeObjectURL(url);
    if (session !== this.session) return;
    const sb = ms.addSourceBuffer("audio/mpeg");
    this.#pump(session, ms, sb, reciter, pos);
  }

  stop() {
    this.session++;
    this.segments = [];
  }

  // Seek inside what is already buffered; false if the verse isn't there.
  seekBuffered(pos) {
    const seg = this.segments.find((s) => s.ch === pos.ch && s.v === pos.v);
    const b = this.audio.buffered;
    if (!seg || !b.length || seg.start < b.start(0)) return false;
    this.audio.currentTime = seg.start + 0.001;
    return true;
  }

  verseAt(t) {
    return this.segments.find((s) => t >= s.start && t < s.end) ?? null;
  }

  async #pump(session, ms, sb, reciter, pos) {
    const alive = () => session === this.session && ms.readyState === "open";
    const whenUpdated = (action) =>
      new Promise((resolve, reject) => {
        const done = (e) => {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", done);
          e.type === "error" ? reject(new Error("append failed")) : resolve();
        };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", done);
        action();
      });
    const remove = async (a, b) => {
      if (b - a > 1) await whenUpdated(() => sb.remove(a, b));
    };
    let end = 0; // where the next verse's first real sample goes, in seconds
    let failures = 0;
    while (pos && alive()) {
      if (end - this.audio.currentTime > 90) {
        await sleep(1000); // enough buffered ahead
        continue;
      }
      this.loader.prefetch(reciter, nextVerse(pos), 4);
      let data;
      try {
        data = await this.loader.load(reciter, pos);
      } catch (err) {
        if (!alive()) return;
        if (err instanceof NotFound) {
          pos = nextVerse(pos); // this verse's file is missing: carry on with the next one
          continue;
        }
        this.onLoadError?.(); // offline or the CDN failed: say so, keep trying
        await sleep(3000);
        continue;
      }
      if (!alive()) return;
      const before = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
      try {
        const sr = data.sampleRate;
        sb.appendWindowEnd = Infinity;
        sb.appendWindowStart = end;
        sb.appendWindowEnd = end + data.duration;
        sb.timestampOffset = end - data.skipStart / sr;
        await whenUpdated(() => sb.appendBuffer(data.bytes));
      } catch (err) {
        if (!alive()) return;
        if (err?.name === "QuotaExceededError") {
          await remove(0, this.audio.currentTime - 10);
          if (!alive()) return;
          await sleep(1000);
        } else {
          // A file the decoder rejected: fetch it again, then give up on it after three tries.
          this.loader.forget(reciter, pos);
          if (++failures >= 3) {
            failures = 0;
            pos = nextVerse(pos);
          }
          await sleep(1500);
        }
        continue;
      }
      if (!alive()) return;
      // Desktop Safari accepts the append but keeps nothing when the window or offset trims
      // the stream: hand over to the chunk backend instead of playing silence.
      const after = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
      if (end === 0 && after <= before + 0.05) {
        this.session++;
        this.onUnsupported?.();
        return;
      }
      failures = 0;
      const start = end;
      end += data.duration;
      // fileMs: where this segment starts inside the verse's original MP3 (its priming is cut).
      this.segments.push({ ...pos, start, end, fileMs: (data.skipStart / data.sampleRate) * 1000 });
      pos = nextVerse(pos);

      // Drop audio well behind the playhead to stay under the buffer quota.
      const behind = this.audio.currentTime - (sb.buffered.length ? sb.buffered.start(0) : 0);
      if (behind > 180) {
        const keepFrom = this.audio.currentTime - 60;
        await remove(0, keepFrom);
        if (!alive()) return;
        this.segments = this.segments.filter((s) => s.end > keepFrom);
      }
    }
    if (alive() && !pos && !sb.updating) ms.endOfStream();
  }
}

// Verses per chunk, growing so the first sound comes fast and later chunks are long enough
// to be fetched while the previous one plays.
const CHUNK_PLAN = [
  [2, 30],
  [4, 60],
  [8, 120],
  [16, 240],
  [25, 300],
];

class ChunkBackend {
  constructor(audio, loader) {
    this.audio = audio;
    this.loader = loader;
    this.session = 0;
    this.segments = [];
    this.next = null;
    this.url = null;
    this.step = 0;
    this.switching = false; // between chunks: the element has ended but recitation hasn't
    this.paused = false; // paused by the person: the next chunk must not start by itself
    this.waiting = false; // #advance is waiting for the next chunk
    audio.addEventListener("ended", () => this.#advance());
  }

  // Must run inside the user's tap.
  unlock() {
    this.audio.src = SILENCE_URL;
    this.audio.play().catch(() => {});
  }

  async start(reciter, pos) {
    const session = ++this.session;
    this.reciter = reciter;
    this.paused = false;
    this.#discardNext();
    this.step = 0;
    const chunk = await this.#build(session, pos);
    if (!chunk || session !== this.session) {
      if (chunk) URL.revokeObjectURL(chunk.url);
      return;
    }
    this.#play(chunk);
  }

  stop() {
    this.session++;
    this.segments = [];
    this.switching = false;
    this.paused = false;
    this.#discardNext();
  }

  pause() {
    this.paused = true;
    this.switching = false;
  }

  // play() while the next chunk is still on its way: start it when it arrives. True if handled.
  resume() {
    this.paused = false;
    if (!this.waiting) return false;
    this.switching = true;
    this.audio.dispatchEvent(new Event("waiting"));
    return true;
  }

  seekBuffered(pos) {
    const seg = this.segments.find((s) => s.ch === pos.ch && s.v === pos.v);
    if (!seg) return false;
    this.audio.currentTime = seg.start + 0.001;
    return true;
  }

  verseAt(t) {
    return this.segments.find((s) => t >= s.start && t < s.end) ?? null;
  }

  #discardNext() {
    this.next?.then((c) => c && URL.revokeObjectURL(c.url));
    this.next = null;
  }

  #play(chunk) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = chunk.url;
    this.segments = chunk.segments;
    this.switching = false;
    this.audio.src = chunk.url;
    if (!this.paused) this.audio.play().catch(() => {});
    const session = this.session;
    this.next = chunk.nextPos ? this.#build(session, chunk.nextPos) : null;
  }

  async #advance() {
    if (!this.next || this.paused) return;
    const session = this.session;
    this.switching = true;
    this.waiting = true;
    this.audio.dispatchEvent(new Event("waiting")); // shows as buffering, not paused
    const chunk = await this.next;
    this.waiting = false;
    // Paused meanwhile: the chunk is loaded but waits for play().
    if (chunk && session === this.session) this.#play(chunk);
    else this.switching = false;
  }

  async #build(session, pos) {
    const [maxVerses, maxSeconds] = CHUNK_PLAN[Math.min(this.step++, CHUNK_PLAN.length - 1)];
    const parts = [];
    const segments = [];
    let t = 0;
    while (pos && parts.length < maxVerses && t < maxSeconds) {
      this.loader.prefetch(this.reciter, nextVerse(pos), 4);
      let data;
      try {
        data = await this.loader.load(this.reciter, pos);
      } catch (err) {
        if (session !== this.session) return null;
        if (err instanceof NotFound) {
          pos = nextVerse(pos);
          continue;
        }
        if (parts.length) break; // play what we have; the next chunk retries
        this.onLoadError?.();
        await sleep(3000);
        continue;
      }
      if (session !== this.session) return null;
      // Drop a last frame that holds nothing but encoder padding; the rest plays as is.
      const dropLast = data.skipEnd >= data.samplesPerFrame && data.frames > 1;
      const bytes = dropLast ? data.bytes.subarray(0, data.bytes.length - data.lastFrameBytes) : data.bytes;
      const seconds = ((data.frames - (dropLast ? 1 : 0)) * data.samplesPerFrame) / data.sampleRate;
      parts.push(bytes);
      segments.push({ ...pos, start: t, end: t + seconds, fileMs: 0 });
      t += seconds;
      pos = nextVerse(pos);
    }
    if (!parts.length) return null;
    const url = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    return { url, segments, nextPos: pos };
  }
}

// Safari (any WebKit browser: iPhone, iPad, Mac) gets chunks: its MSE drops MP3 appends that
// are trimmed by an append window or a negative offset, and is unreliable in the background.
function prefersChunks() {
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1);
  const safari = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Android/.test(ua);
  return iOS || safari || !window.MediaSource?.isTypeSupported?.("audio/mpeg");
}

// Events: "verse" (detail: {ch, v}) when the recited verse changes; "state" when playing,
// paused or buffering changes.
export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.loadError = false; // a verse couldn't be fetched (offline, CDN, captive portal); retrying
    // Optional hook: (from, to) => true to play `from` again instead of moving on (Repeat).
    this.shouldRepeat = null;
    this.#useBackend(prefersChunks());
    this.reciter = DEFAULT_RECITER;
    this.position = { ch: 1, v: 1 };
    this.started = false; // a stream has been built for the current position/reciter
    this.buffering = false;
    this.awaitingAudio = false; // started, but the first real audio isn't loaded yet
    this.startToken = 0;
    // Optional hook: (position, reciterName) => {title, artist, album, artwork} for the lock
    // screen and car. Without it a plain default is used.
    this.describe = null;

    // Lets audio play with the iPhone silent switch on (iOS 17+).
    if (navigator.audioSession) navigator.audioSession.type = "playback";

    const a = this.audio;
    a.addEventListener("timeupdate", () => this.#sync());
    // A media error (e.g. a corrupt stream) rebuilds the stream from the current verse.
    a.addEventListener("error", () => {
      if (!this.started || a.src === SILENCE_URL) return;
      const wasPlaying = !a.paused || this.awaitingAudio;
      this.started = false;
      this.backend.stop();
      if (wasPlaying) setTimeout(() => this.play(), 1000);
    });
    a.addEventListener("playing", () => {
      this.loadError = false;
      this.#setBuffering(this.awaitingAudio);
    });
    a.addEventListener("waiting", () => this.#setBuffering(true));
    a.addEventListener("pause", () => this.#emitState());
    a.addEventListener("play", () => this.#emitState());
    this.#mediaSession();
  }

  #useBackend(chunks) {
    this.loader = new VerseLoader({ measureEdges: !chunks });
    this.backend = chunks ? new ChunkBackend(this.audio, this.loader) : new StreamBackend(this.audio, this.loader);
    this.backend.onLoadError = () => {
      if (this.loadError) return;
      this.loadError = true;
      this.#emitState();
    };
    // Safety net: MSE that keeps nothing → chunks, from the same verse.
    this.backend.onUnsupported = () => {
      const wasPlaying = this.playing || this.awaitingAudio;
      this.#useBackend(true);
      this.started = false;
      if (wasPlaying) this.play();
    };
  }

  get playing() {
    return this.started && (!this.audio.paused || !!this.backend.switching);
  }

  // Cue a verse without playing (e.g. the reader scrolled or picked a verse).
  cue(pos) {
    if (this.playing) return this.play(pos);
    this.position = { ...pos };
    this.started = false;
    this.backend.stop();
    this.#updateMetadata();
    this.dispatchEvent(new CustomEvent("verse", { detail: this.position }));
    this.#emitState();
  }

  play(pos = null) {
    if (pos && key(pos) !== key(this.position)) {
      this.position = { ...pos };
      if (this.started && this.backend.seekBuffered(pos)) {
        this.audio.play().catch(() => {});
        this.#announce();
        return;
      }
      this.started = false;
    }
    if (!this.started) {
      this.started = true;
      this.awaitingAudio = true;
      this.#setBuffering(true);
      // Runs synchronously inside the user's tap, as browsers require for starting audio.
      this.backend.unlock?.();
      const token = ++this.startToken;
      const started = this.backend.start(this.reciter, this.position);
      this.audio.play().catch(() => {});
      started.finally(() => token === this.startToken && (this.awaitingAudio = false));
    } else if (!this.backend.resume?.()) {
      this.audio.play().catch(() => {});
    }
    this.#announce();
  }

  pause() {
    this.backend.pause?.(); // between chunks, the next one must not start by itself
    this.audio.pause();
    this.#emitState();
  }

  // Where recitation is inside the current verse, in ms from the start of that verse's
  // original MP3 file — the reference used by the word timings (data/words/…). Null when
  // nothing has been buffered for the current verse.
  verseTime() {
    const t = this.audio.currentTime;
    const seg = this.backend.verseAt(t);
    if (!seg) return null;
    // startMs/endMs: the part of the original file that is heard (the verse's own duration).
    const ms = (t - seg.start) * 1000 + seg.fileMs;
    return { ch: seg.ch, v: seg.v, ms, startMs: seg.fileMs, endMs: seg.fileMs + (seg.end - seg.start) * 1000 };
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  next() {
    const p = nextVerse(this.position);
    if (p) this.playing ? this.play(p) : this.cue(p);
  }

  previous() {
    const p = prevVerse(this.position);
    if (p) this.playing ? this.play(p) : this.cue(p);
  }

  setReciter(id) {
    if (id === this.reciter) return;
    this.reciter = id;
    const wasPlaying = this.playing;
    this.started = false;
    this.backend.stop();
    if (wasPlaying) this.play();
    this.#updateMetadata();
  }

  #sync() {
    const t = this.audio.currentTime;
    const seg = this.backend.verseAt(t);
    if (!seg) return;
    if (key(seg) !== key(this.position)) {
      // Repeat: back to the start of the verse, without announcing the next one (no flicker
      // on the lock screen).
      if (this.shouldRepeat?.(this.position, seg)) {
        if (!this.backend.seekBuffered(this.position)) {
          this.started = false; // the verse is in the previous chunk: rebuild from it
          this.play();
        }
        return;
      }
      this.position = { ch: seg.ch, v: seg.v };
      this.#announce();
    }
    // The lock screen and car show progress through the current verse.
    try {
      navigator.mediaSession?.setPositionState?.({
        duration: Math.max(0.1, seg.end - seg.start),
        position: Math.min(Math.max(0, t - seg.start), seg.end - seg.start),
        playbackRate: this.audio.playbackRate || 1,
      });
    } catch {}
  }

  #announce() {
    this.#updateMetadata();
    this.dispatchEvent(new CustomEvent("verse", { detail: this.position }));
  }

  #setBuffering(on) {
    this.buffering = on && this.started;
    this.#emitState();
  }

  #emitState() {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
    }
    this.dispatchEvent(new Event("state"));
  }

  // Re-sends the now-playing details, e.g. once chapter artwork has been drawn.
  refreshMetadata() {
    this.#updateMetadata();
  }

  #updateMetadata() {
    if (!("mediaSession" in navigator)) return;
    const { ch, v } = this.position;
    const [, name] = CHAPTERS[ch - 1];
    const reciter = RECITERS.find((r) => r.id === this.reciter)?.name ?? "";
    const custom = this.describe?.(this.position, reciter);
    if (custom) {
      navigator.mediaSession.metadata = new MediaMetadata(custom);
      return;
    }
    const icon = (s) => ({ src: new URL(`icons/icon-${s}.png`, location.href).href, sizes: `${s}x${s}`, type: "image/png" });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${name} ${ch}:${v}`,
      artist: reciter,
      album: "The Holy Quran",
      artwork: [icon(192), icon(512)],
    });
  }

  #mediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {}
    };
    set("play", () => this.play());
    set("pause", () => this.pause());
    set("stop", () => this.pause());
    set("nexttrack", () => this.next());
    set("previoustrack", () => this.previous());
    // No scrubbing: car and lock-screen controls show previous/next verse instead.
    for (const a of ["seekto", "seekbackward", "seekforward"]) set(a, null);
  }
}
