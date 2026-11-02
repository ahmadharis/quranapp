"""Word timings for the app: data/words/{reciter}/{ch}.json, resumable.

    python -I align.py                       # everything still missing, pilot order first
    python -I align.py --reciters feroz --chapters 1,78-114
    python -I align.py --force --chapters 2  # redo a chapter

Order: reciters feroz, rashid, ashiq, aiman, idir-iken; chapters 1, 78-114, then 2-77.
A chapter is skipped when its JSON exists with the same model, the same lead and every verse
present. Word starts are moved earlier by the reciter's calibrated lead (timing.LEADS,
recorded in each file as "lead_ms"; --lead-ms overrides).
Per-chapter check reports go to $ALIGN_WORK/reports/{reciter}/{ch}.json (outside the repo).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import aligners  # noqa: E402
import common as c  # noqa: E402
import timing  # noqa: E402

DEFAULT_MODEL = "quran_xlsr+auto"  # see README: benchmark and repeat handling
PILOT_ORDER = [1] + list(range(78, 115)) + list(range(2, 78))


def parse_chapters(spec: str) -> list[int]:
    if spec == "all":
        return PILOT_ORDER
    out = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out += list(range(int(a), int(b or a) + 1))
    return out


def out_path(reciter: str, ch: int) -> Path:
    return c.REPO / "data" / "words" / reciter / f"{ch}.json"


def is_done(reciter, ch, n, model_id, lead_ms) -> bool:
    p = out_path(reciter, ch)
    if not p.exists():
        return False
    try:
        d = json.loads(p.read_text())
        return (d.get("model") == model_id and d.get("lead_ms", 80) == lead_ms
                and len(d["verses"]) + len(d.get("missing", [])) == n)
    except Exception:
        return False


def align_chapter(al, reciter, ch, n, keep_audio, lead_ms):
    text = c.chapter_text(ch, n)
    # Uthmanic `ar_` suits the Quran-trained model (it was trained on Uthmanic-style text). It is
    # used for a verse only when it has exactly as many WORDs as the displayed Indo-Pak `ar`;
    # otherwise that verse is aligned on `ar` and listed in "ar_fallback".
    fallback = [v for v in range(1, n + 1)
                if len(c.words_of(text[v]["ar"])) != len(c.words_of(text[v]["ar_"]))]
    paths = c.fetch_audio(reciter, ch, range(1, n + 1))
    verses, report, audio_s = {}, {}, 0.0
    missing = [v for v in range(1, n + 1) if v not in paths]  # no audio on the server
    for v in range(1, n + 1):
        if v in missing:
            continue
        wav, dur = c.decode(paths[v])
        audio_s += dur
        words = c.words_of(text[v]["ar" if v in fallback else "ar_"])
        spans, score, repeats = aligners.run(al, wav, words)
        ms = timing.to_ms(spans, wav, dur, snap=True, lead=lead_ms / 1000)
        probs = timing.check(ms, len(c.words_of(text[v]["ar"])), dur, wav)
        if score < 0.5:
            probs.append(f"low confidence {score:.2f}")
        verses[str(v)] = ms
        report[str(v)] = {"score": round(score, 3), "repeats": repeats, "duration_ms": int(dur * 1000),
                          "problems": probs}
    data = {"reciter": reciter, "ch": ch, "source": "ar_", "model": al.model_id, "lead_ms": lead_ms,
            "verses": verses}
    if fallback:
        data["ar_fallback"] = fallback
    if missing:
        data["missing"] = missing
    p = out_path(reciter, ch)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(p)
    rp = c.WORK / "reports" / reciter / f"{ch}.json"
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(report, indent=1))
    if not keep_audio:
        for f in paths.values():
            f.unlink(missing_ok=True)
    return audio_s, sum(1 for r in report.values() if r["problems"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reciters", nargs="+", default=c.RECITERS, choices=c.RECITERS)
    ap.add_argument("--chapters", default="all", help='"all" or e.g. "1,78-114"')
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--force", action="store_true", help="redo chapters that are already done")
    ap.add_argument("--keep-audio", action="store_true", help="keep downloaded MP3s after a chapter")
    ap.add_argument("--lead-ms", type=int, help="override the per-reciter lead (timing.LEADS), in ms")
    a = ap.parse_args()
    counts = c.chapter_verse_counts()
    chapters = parse_chapters(a.chapters)
    al = aligners.make(a.model)
    lead = {r: a.lead_ms if a.lead_ms is not None else round(timing.lead_for(r) * 1000) for r in a.reciters}
    print("lead (ms): " + ", ".join(f"{r} {x}" for r, x in lead.items()), flush=True)
    todo = [(r, ch) for r in a.reciters for ch in chapters
            if a.force or not is_done(r, ch, counts[ch], al.model_id, lead[r])]
    left_verses = sum(counts[ch] for _, ch in todo)
    print(f"{len(todo)} chapters to do ({left_verses} verses), model {al.model_id}", flush=True)
    t_all, v_done = time.time(), 0
    pool = ThreadPoolExecutor(1)  # downloads the next chapter's audio while this one aligns
    if todo:
        nxt = pool.submit(c.fetch_audio, todo[0][0], todo[0][1], range(1, counts[todo[0][1]] + 1))
    for k, (r, ch) in enumerate(todo, 1):
        t0 = time.time()
        nxt.result()
        if k < len(todo):
            r2, ch2 = todo[k]
            nxt = pool.submit(c.fetch_audio, r2, ch2, range(1, counts[ch2] + 1))
        audio_s, flagged = align_chapter(al, r, ch, counts[ch], a.keep_audio, lead[r])
        v_done += counts[ch]
        el = time.time() - t0
        rate = (time.time() - t_all) / v_done
        eta = rate * (left_verses - v_done)
        print(f"[{k}/{len(todo)}] {r} {ch}: {counts[ch]} verses, {audio_s / 60:.1f} min audio, {el:.0f}s, "
              f"{flagged} flagged | {rate:.2f}s/verse, ETA {eta / 3600:.1f} h", flush=True)
    if not a.keep_audio:
        for r in a.reciters:
            d = c.AUDIO_CACHE / r
            if d.exists() and not any(d.iterdir()):
                shutil.rmtree(d)


if __name__ == "__main__":
    main()
