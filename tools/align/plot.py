"""Hand-check sample: spectrogram + level PNG per verse with word boundaries drawn and labelled.

    python -I plot.py --reciter feroz --verses 1:1 2:2 112:2 ... [--compare bench.json]

Reads data/words/{reciter}/{ch}.json (the published timings). Thick orange lines are those
boundaries; with --compare, thin coloured ticks along the top show other models' boundaries
from a benchmark JSON. Labels are the app's `ar` words, numbered 0.. in order.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import matplotlib  # noqa: E402

matplotlib.use("Agg")  # never opens a window
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402

import common as c  # noqa: E402
import timing  # noqa: E402

ROW_S = 15.0


def _shape(s: str) -> str:
    """Label only: marks are dropped so matplotlib (no OpenType mark positioning) stays legible."""
    import unicodedata
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    try:
        import arabic_reshaper
        from bidi import get_display
        return get_display(arabic_reshaper.reshape(s))
    except Exception:
        return s


def _font():
    p = c.REPO / "assets" / "fonts" / "NotoNaskhArabic-Regular.ttf"
    if p.exists():
        font_manager.fontManager.addfont(str(p))
        return font_manager.FontProperties(fname=str(p))
    return None


def plot_verse(reciter, ch, v, words_ms, words, out: Path, others=None, model=""):
    wav, dur = c.decode(c.audio_path(reciter, ch, v))
    fp = _font()
    rows = max(1, int(np.ceil(dur / ROW_S)))
    fig, axes = plt.subplots(rows * 2, 1, figsize=(18, 3.4 * rows),
                             gridspec_kw={"height_ratios": [3, 1] * rows}, squeeze=False)
    axes = axes[:, 0]
    db = timing.energy_db(wav)
    thr = np.percentile(db, 95) - 30
    for r in range(rows):
        t0, t1 = r * ROW_S, min(dur, (r + 1) * ROW_S) if rows > 1 else dur
        ax, ax2 = axes[2 * r], axes[2 * r + 1]
        seg = wav[int(t0 * 16000):int(t1 * 16000)]
        if len(seg) > 512:
            ax.specgram(seg, NFFT=512, Fs=16000, noverlap=384, cmap="magma", xextent=(t0, t1), vmin=-120)
        ax.set_ylim(0, 6000)
        ax.set_xlim(t0, t0 + ROW_S if rows > 1 else t1)
        ax.set_ylabel("Hz")
        tt = np.arange(len(db)) * timing.HOP
        m = (tt >= t0) & (tt <= t1)
        ax2.plot(tt[m], db[m], lw=0.8, color="#333")
        ax2.axhline(thr, color="#999", lw=0.6, ls="--")
        ax2.set_xlim(ax.get_xlim())
        ax2.set_ylabel("dB")
        for i, ((a, b), w) in enumerate(zip(words_ms, words)):
            a, b = a / 1000, b / 1000
            if b < t0 or a > t0 + ROW_S:
                continue
            for x in (a, b):
                ax.axvline(x, color="#ff9d00", lw=1.6)
                ax2.axvline(x, color="#ff9d00", lw=1.0)
            y = 5400 if i % 2 == 0 else 4500
            ax.text((a + b) / 2, y, f"{_shape(w)}\n{i}", color="white", ha="center", va="top",
                    fontsize=12, fontproperties=fp, bbox=dict(fc="black", alpha=0.45, lw=0))
        for k, (name, ws) in enumerate((others or {}).items()):
            col = ["#00e5ff", "#7CFC00", "#ff4dd2"][k % 3]
            for a, _ in ws[1:]:
                if t0 <= a / 1000 <= t0 + ROW_S:
                    ax.plot([a / 1000] * 2, [0, 700 + 250 * k], color=col, lw=1.4)
            if r == 0:
                ax.plot([], [], color=col, label=name)
        if r == 0:
            ax.plot([], [], color="#ff9d00", label=f"published ({model})")
            ax.legend(loc="lower left", bbox_to_anchor=(0, 1.08), ncol=4, fontsize=8, frameon=False)
            ax.set_title(f"{reciter} {ch}:{v} - {len(words)} words - {dur:.2f}s (t=0 is sample 0 of the untrimmed decode)", loc="right")
    axes[-1].set_xlabel("seconds")
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=80)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reciter", default="feroz")
    ap.add_argument("--verses", nargs="+", required=True)
    ap.add_argument("--compare", nargs="*", default=[], help="benchmark JSON(s) with other models' boundaries")
    ap.add_argument("--out", default=str(c.WORK / "plots"))
    a = ap.parse_args()
    counts = c.chapter_verse_counts()
    bench = {}
    for f in a.compare:
        bench.update(json.loads(Path(f).read_text())["models"])
    for ref in a.verses:
        ch, v = map(int, ref.split(":"))
        dp = c.REPO / "data" / "words" / a.reciter / f"{ch}.json"
        if dp.exists():
            data = json.loads(dp.read_text())
        else:  # chapter not aligned yet: take the production config's spans from the benchmark
            lead = int(timing.LEAD * 1000)
            m = next(k for k in bench if k.endswith("+auto"))
            data = {"model": bench[m]["model_id"],
                    "verses": {str(v): [[x - lead, y] for x, y in bench[m]["verses"][ref]["snap"]]}}
        words = c.words_of(c.chapter_text(ch, counts[ch])[v]["ar"])
        c.fetch_audio(a.reciter, ch, [v])
        # benchmark spans have no lead; apply the same lead so all models are comparable
        lead = int(timing.LEAD * 1000)
        others = {m: [[x - lead, y] for x, y in r["verses"][ref]["snap"]] for m, r in bench.items()
                  if ref in r["verses"] and m in ("mms_fa", "xlsr_ar")}
        if str(v) not in data["verses"]:
            continue
        out = Path(a.out) / a.reciter / f"{ch:03d}-{v:03d}.png"
        plot_verse(a.reciter, ch, v, data["verses"][str(v)], words, out, others, data["model"])
        print(out)


if __name__ == "__main__":
    main()
