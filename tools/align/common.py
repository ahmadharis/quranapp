"""Shared helpers for the word-timing pipeline: text, words, audio download and decoding.

Everything Quran-specific comes from alislam.org: text from api.readquran.app, audio from
files.alislam.cloud, chapter verse counts from the app's js/quran-data.js (alislam's list).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
API = "https://api.readquran.app"
AUDIO = "https://files.alislam.cloud/audio/tilawat"
RECITERS = ["feroz", "rashid", "ashiq", "aiman", "idir-iken"]
BATCH = 10           # alislam's own app requests 10 verses per call
AUDIO_PARALLEL = 4   # be gentle with files.alislam.cloud
SR = 16000           # model input rate

# Work area outside the repo (venv, caches, audio). Override with ALIGN_WORK.
WORK = Path(os.environ.get("ALIGN_WORK", Path.home() / ".cache" / "quranapp-align"))
TEXT_CACHE = WORK / "cache" / "text"
# Temporary per-chapter audio (deleted after each chapter unless --keep-audio). ALIGN_AUDIO
# points it elsewhere, e.g. a small sample kept for calibrate.py.
AUDIO_CACHE = Path(os.environ.get("ALIGN_AUDIO", WORK / "cache" / "audio"))

UA = {"User-Agent": "quranapp-align/1.0 (offline word timing; cached, 10 verses per call)",
      "Content-Type": "application/json"}

# ---------------------------------------------------------------- chapters

def chapter_verse_counts() -> dict[int, int]:
    """Verse counts per chapter (alislam numbering) from the app's copy of alislam's list."""
    src = (REPO / "js" / "quran-data.js").read_text(encoding="utf-8")
    counts = {int(m[1]): int(m[2]) for m in re.finditer(r'^\s*\[(\d+),\s*"[^"]*",\s*"[^"]*",\s*(\d+)\]', src, re.M)}
    assert len(counts) == 114 and sum(counts.values()) == 6348, "unexpected chapter list"
    return counts

# ---------------------------------------------------------------- words

def is_arabic_letter(c: str) -> bool:
    o = ord(c)
    return (0x0621 <= o <= 0x064A or 0x066E <= o <= 0x06D3 or o == 0x06D5 or 0x06FA <= o <= 0x06FC)


def words_of(text: str) -> list[str]:
    """WORD tokens exactly as the app counts them: whitespace split, keep tokens with a letter."""
    return [t for t in text.split() if any(is_arabic_letter(c) for c in t)]

# ---------------------------------------------------------------- text

def _post(url: str, body: dict, tries: int = 4):
    data = json.dumps(body).encode()
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA, method="POST")
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(1.5 * 2 ** k)


def chapter_text(ch: int, n_verses: int) -> dict[int, dict]:
    """{v: {"ar": Indo-Pak, "ar_": Uthmanic}} for a chapter, cached on disk.

    The API returns `ar` for f=1 and `ar_` for f=2, so each 10-verse batch is two calls.
    """
    path = TEXT_CACHE / f"{ch}.json"
    if path.exists():
        return {int(k): v for k, v in json.loads(path.read_text(encoding="utf-8")).items()}
    out: dict[int, dict] = {}
    for a in range(1, n_verses + 1, BATCH):
        b = min(a + BATCH - 1, n_verses)
        for f, key in ((1, "ar"), (2, "ar_")):
            rows = _post(f"{API}/chapter/{ch}:{a}-{b}", {"f": f, "hover": 0})
            assert [int(r["v"]) for r in rows] == list(range(a, b + 1)), f"bad batch {ch}:{a}-{b}"
            for r in rows:
                assert r.get(key), f"missing {key} in {ch}:{r['v']}"
                out.setdefault(int(r["v"]), {})[key] = r[key]
        time.sleep(0.3)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    return out

# ---------------------------------------------------------------- audio

def audio_url(reciter: str, ch: int, v: int) -> str:
    return f"{AUDIO}/{reciter}/{ch:03d}-{v:03d}-AR.mp3"


def audio_path(reciter: str, ch: int, v: int) -> Path:
    return AUDIO_CACHE / reciter / f"{ch:03d}-{v:03d}-AR.mp3"


def _id3_size(head: bytes) -> int:
    """Total size of a leading ID3v2 tag (0 if none), from the file's first 10 bytes."""
    if len(head) < 10 or head[:3] != b"ID3":
        return 0
    size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
    return 10 + size + (10 if head[5] & 0x10 else 0)


def _get(url: str, rng: str | None = None) -> tuple[int, bytes]:
    headers = {"User-Agent": UA["User-Agent"]}
    if rng:
        headers["Range"] = rng
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
        return r.status, r.read()


def _fetch_audio_only(url: str) -> bytes:
    """The MP3 without its leading ID3 tag. Some reciters embed ~2-5 MB of artwork per verse;
    it is not audio, so skipping it changes nothing for alignment (the timing reference is the
    first audio frame) and cuts the download ~10x. Falls back to the whole file if ranges
    aren't honoured."""
    status, head = _get(url, "bytes=0-9")
    if status != 206:
        return head  # server sent the whole file
    tag = _id3_size(head)
    if tag == 0:
        return _get(url)[1]
    return _get(url, f"bytes={tag}-")[1]


def _download(url: str, path: Path, tries: int = 4) -> Path:
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    for k in range(tries):
        try:
            data = _fetch_audio_only(url)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.rename(path)
            return path
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 * 2 ** k)


def fetch_audio(reciter: str, ch: int, verses) -> dict[int, Path]:
    """Verse -> local file. Verses the server doesn't have (HTTP 404) are left out: alislam's
    archive has a few gaps for some reciters (e.g. idir-iken 4:144-148)."""
    verses = list(verses)

    def one(v):
        try:
            return _download(audio_url(reciter, ch, v), audio_path(reciter, ch, v))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    with ThreadPoolExecutor(AUDIO_PARALLEL) as ex:
        paths = dict(zip(verses, ex.map(one, verses)))
    return {v: p for v, p in paths.items() if p is not None}


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def mp3_frames(path: Path) -> tuple[int, int, int]:
    """(audio frames, samples per frame, sample rate) — Xing/Info frame excluded, like js/mp3.js."""
    b = path.read_bytes()
    i = 0
    while b[i:i + 3] == b"ID3":
        size = (b[i + 6] << 21) | (b[i + 7] << 14) | (b[i + 8] << 7) | b[i + 9]
        i += 10 + size + (10 if b[i + 5] & 0x10 else 0)
    rates = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
    br1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    br2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    frames, spf, sr, first = 0, 0, 0, True
    while i + 4 <= len(b):
        if b[i] != 0xFF or (b[i + 1] & 0xE0) != 0xE0:
            if b[i:i + 3] == b"TAG" or b[i:i + 8] == b"APETAGEX":
                break
            i += 1
            continue
        ver = (b[i + 1] >> 3) & 3
        layer = (b[i + 1] >> 1) & 3
        bri = b[i + 2] >> 4
        sri = (b[i + 2] >> 2) & 3
        if ver == 1 or layer != 1 or bri in (0, 15) or sri == 3:
            i += 1
            continue
        mpeg1 = ver == 3
        rate = rates[ver][sri]
        kbps = (br1 if mpeg1 else br2)[bri]
        length = (144 if mpeg1 else 72) * kbps * 1000 // rate + ((b[i + 2] >> 1) & 1)
        if i + length > len(b):
            break
        mono = (b[i + 3] >> 6) == 3
        side = (17 if mono else 32) if mpeg1 else (9 if mono else 17)
        tag = b[i + 4 + side:i + 8 + side]
        if first and tag in (b"Info", b"Xing"):
            first = False  # metadata frame: decodes as silence, not counted (as in js/mp3.js)
            i += length
            continue
        first = False
        frames += 1
        sr = rate
        i += length
        spf = 1152 if mpeg1 else 576
    return frames, spf, sr


def decode(path: Path, sr: int = SR) -> tuple[np.ndarray, float]:
    """Mono float32 at `sr` of the FULL, untrimmed decode, and the file's duration in seconds.

    `-flags2 +skip_manual` stops ffmpeg from applying the LAME/Info gapless trim, so sample 0 is
    the first sample the decoder outputs for the first audio frame (the Xing/Info frame is not
    audio and is not counted). Encoder delay + 529 samples of decoder delay are therefore
    INCLUDED at the start and encoder padding at the end; duration = frames x 1152 / rate.
    """
    cmd = [ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-flags2", "+skip_manual",
           "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    wav = np.frombuffer(raw, dtype=np.float32).copy()
    frames, spf, rate = mp3_frames(path)
    dur = frames * spf / rate if frames else len(wav) / sr
    return wav, dur
