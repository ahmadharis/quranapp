"""Turn aligner frame spans into the app's [start_ms, end_ms] list, plus energy-based checks."""

from __future__ import annotations

import numpy as np

from aligners import FRAME_SEC

HOP = 0.01  # energy analysis hop (s)


def energy_db(wav: np.ndarray, sr: int = 16000) -> np.ndarray:
    """RMS level in dB per 10 ms hop (25 ms window)."""
    h, w = int(HOP * sr), int(0.025 * sr)
    n = max(1, (len(wav) - w) // h + 1)
    idx = np.arange(w)[None] + h * np.arange(n)[:, None]
    x = wav[np.minimum(idx, len(wav) - 1)]
    return 10 * np.log10((x ** 2).mean(1) + 1e-10)


def silence_mask(db: np.ndarray, rel: float = 30.0) -> np.ndarray:
    ref = np.percentile(db, 95)
    return db < ref - rel


def pauses(db: np.ndarray, min_len: float = 0.15) -> list[tuple[float, float]]:
    """Internal silent stretches (s) of at least `min_len`, between the first and last speech."""
    sil = silence_mask(db)
    speech = np.flatnonzero(~sil)
    if len(speech) == 0:
        return []
    a0, a1 = speech[0], speech[-1]
    out, i = [], a0
    while i <= a1:
        if sil[i]:
            j = i
            while j <= a1 and sil[j]:
                j += 1
            if (j - i) * HOP >= min_len:
                out.append((i * HOP, j * HOP))
            i = j
        else:
            i += 1
    return out


LEAD = 0.08  # s; CTC onsets run late - both judges in benchmark.py were best at -80 ms (feroz)

# Per-reciter lead (s), measured by calibrate.py (independent judge, per-boundary sweep on the
# 69-verse test set). Reciters not listed use LEAD. See README "Per-reciter calibration".
# Measured 2026-11-01 (two judges, 527 boundaries each; the optimum relative to feroz, averaged
# over the aggregate-curve and per-boundary estimators): rashid, aiman and idir-iken were lit
# 15-20 ms too early with 80 ms; ashiq matched feroz.
LEADS: dict[str, float] = {"feroz": 0.08, "ashiq": 0.08, "rashid": 0.06, "aiman": 0.06, "idir-iken": 0.065}


def lead_for(reciter: str) -> float:
    return LEADS.get(reciter, LEAD)


def to_ms(spans, wav: np.ndarray, duration_s: float, snap: bool = True, lead: float = 0.0,
          snapped: list | None = None) -> list[list[int]]:
    """Frame spans -> contiguous [start_ms, end_ms] per word.

    Word i ends where word i+1 starts, so a pause belongs to the word before it and the highlight
    moves on as the next word is voiced. With `snap`, each boundary moves to the end of the
    silence (the next word's onset) found between the two words' aligned spans, when there is one.
    The first start is the first word's aligned onset (snapped back to speech onset); the last end
    is the last word's aligned offset, extended over trailing voicing to the end of speech.
    `lead` moves every start (not the last end) earlier, correcting CTC's late onsets.
    If `snapped` is a list, one bool per internal boundary is appended: True when it was moved
    to the end of a silence (calibrate.py judges those separately).
    """
    db = energy_db(wav)
    sil = silence_mask(db)
    nh = len(db)

    def hop(t):
        return int(np.clip(round(t / HOP), 0, nh - 1))

    starts = [s * FRAME_SEC for s, _ in spans]
    ends = [e * FRAME_SEC for _, e in spans]
    bounds = []
    for i in range(1, len(spans)):
        b = starts[i]
        hit = False
        if snap:
            lo, hi = hop(min(ends[i - 1], starts[i]) - 0.04), hop(starts[i] + 0.06)
            seg = sil[lo:hi + 1]
            if seg.any():
                last = lo + np.flatnonzero(seg)[-1]
                b = (last + 1) * HOP + 0.0125  # first non-silent hop (window centre)
                b = max(b, ends[i - 1] - 0.04)
                hit = True
        if snapped is not None:
            snapped.append(hit)
        bounds.append(b)
    first = starts[0]
    if snap:
        k = hop(first)
        while k > 0 and not sil[k - 1] and (first - (k - 1) * HOP) < 0.15:
            k -= 1
        first = min(first, k * HOP + 0.0125)
    last = ends[-1]
    if snap:
        # CTC fires early on a word's last letter and a held madd can last seconds, so the last
        # word runs to the end of speech in the file.
        speech = np.flatnonzero(~sil)
        if len(speech):
            last = max(last, (speech[-1] + 1) * HOP + 0.0125)
    edges = [first - lead] + [b - lead for b in bounds] + [last]
    ms = [int(round(t * 1000)) for t in edges]
    dur_ms = int(duration_s * 1000)
    ms = [min(max(0, x), dur_ms) for x in ms]
    for i in range(1, len(ms)):  # monotonic, every word at least 20 ms where possible
        ms[i] = max(ms[i], ms[i - 1] + 20) if ms[i - 1] + 20 <= dur_ms else max(ms[i], ms[i - 1])
    return [[ms[i], ms[i + 1]] for i in range(len(ms) - 1)]


def check(words_ms: list[list[int]], n_words: int, duration_s: float, wav: np.ndarray) -> list[str]:
    """Automatic validation. Returns a list of problems (empty = OK)."""
    p = []
    if len(words_ms) != n_words:
        p.append(f"count {len(words_ms)} != {n_words}")
    dur = int(duration_s * 1000)
    for i, (a, b) in enumerate(words_ms):
        if b <= a:
            p.append(f"w{i} non-positive")
        if b - a > 12000 and n_words > 2:  # a lone muqatta'at word may legitimately run 15 s+
            p.append(f"w{i} {b - a}ms long")
        if i and a != words_ms[i - 1][1]:
            p.append(f"w{i} not contiguous")
    if words_ms and (words_ms[0][0] < 0 or words_ms[-1][1] > dur):
        p.append("out of file")
    db = energy_db(wav)
    speech = np.flatnonzero(~silence_mask(db))
    if len(speech) and words_ms:
        s0, s1 = speech[0] * HOP * 1000, speech[-1] * HOP * 1000
        if words_ms[0][0] - s0 > 400:
            p.append(f"starts {words_ms[0][0] - s0:.0f}ms after speech onset")
        if s1 - words_ms[-1][1] > 100:
            p.append(f"ends {s1 - words_ms[-1][1]:.0f}ms before speech end")
    return p


def pause_metrics(words_ms, wav) -> tuple[int, int, list[float]]:
    """(internal pauses, pauses holding a boundary, |boundary - pause end| ms for those)."""
    ps = pauses(energy_db(wav))
    bounds = [a for a, _ in words_ms[1:]]
    hit, err = 0, []
    for a, b in ps:
        inside = [x for x in bounds if a * 1000 - 30 <= x <= b * 1000 + 60]
        if inside:
            hit += 1
            err.append(min(abs(x - b * 1000) for x in inside))
    return len(ps), hit, err
