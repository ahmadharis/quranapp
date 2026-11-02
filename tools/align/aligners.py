"""CTC forced aligners compared by benchmark.py; align.py uses the one picked (see README).

Each aligner turns 16 kHz audio into per-frame log-probabilities (wav2vec2-style CTC, 20 ms
frames) and maps a WORD to target tokens. `align_words` runs Viterbi forced alignment
(torchaudio.functional.forced_align) over the whole verse and returns one (start, end) frame
span per word.
"""

from __future__ import annotations

import math
import unicodedata

import numpy as np
import torch
import torchaudio.functional as AF

FRAME_SEC = 0.02  # wav2vec2 conv stride 320 samples @ 16 kHz

# Uthmanic/Indo-Pak marks that are not pronounced as separate sounds or are not in the models'
# vocabularies. Used only to make an aligner TARGET string; displayed text is never changed.
_TO_SUKUN = {"ۡ": "ْ", "ۢ": "", "ۭ": "",  # small high dotless khah -> sukun
             # Indo-Pak (`ar`) letter forms -> the Arabic code points the models know
             "ی": "ي", "ہ": "ه", "ھ": "ه", "ک": "ك",
             "ۃ": "ة", "ے": "ي", "ٴ": "ء", "ٮ": "ى",
             "ں": "ن"}
_ALIF_WASLA = {"ٱ": "ا"}


def _device():
    return torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")


class _Base:
    name = "base"
    model_id = ""
    blank = 0
    sep: int | None = None  # word separator token inserted between words, if the model has one
    chunk_s = 30.0  # emission window (s); see make()
    ctx_s = 2.0     # extra audio each side of a window (s)
    rep = False     # repeat-aware alignment

    def __init__(self):
        self.dev = _device()

    # -- emissions, chunked so very long verses don't blow up attention memory
    @torch.inference_mode()
    def emissions(self, wav: np.ndarray, chunk_s: float = 30.0, ctx_s: float = 2.0) -> torch.Tensor:
        sr = 16000
        x = torch.from_numpy(wav).float()
        n = len(x)
        hop = int(chunk_s * sr)
        ctx = int(ctx_s * sr)
        total_frames = None
        outs = []
        if n <= hop + 2 * ctx:
            return self._forward(x).cpu()
        for a in range(0, n, hop):
            lo, hi = max(0, a - ctx), min(n, a + hop + ctx)
            em = self._forward(x[lo:hi]).cpu()
            f0 = round((a - lo) / 320)
            f1 = f0 + math.ceil(min(hop, n - a) / 320)
            outs.append(em[f0:min(f1, em.shape[0])])
        em = torch.cat(outs)
        total_frames = n // 320
        return em[: max(total_frames, 1)]

    def _forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError

    def tokens(self, word: str) -> list[int]:
        raise NotImplementedError


class HFCTC(_Base):
    """Any Hugging Face Wav2Vec2ForCTC model with an Arabic-letter vocabulary."""

    def __init__(self, model_id: str, name: str, keep_harakat: bool):
        super().__init__()
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        self.name, self.model_id, self.keep_harakat = name, model_id, keep_harakat
        self.proc = Wav2Vec2Processor.from_pretrained(model_id)
        self.model = Wav2Vec2ForCTC.from_pretrained(model_id).to(self.dev).eval()
        self.vocab = self.proc.tokenizer.get_vocab()
        self.blank = self.proc.tokenizer.pad_token_id
        self.sep = self.vocab.get("|")

    def _forward(self, x):
        x = (x - x.mean()) / (x.std() + 1e-7)  # processor's do_normalize
        logits = self.model(x[None].to(self.dev)).logits[0]
        return torch.log_softmax(logits.float(), -1)

    def target_text(self, word: str) -> str:
        w = unicodedata.normalize("NFC", word)
        w = "".join(_TO_SUKUN.get(c, c) for c in w)
        if "ٱ" not in self.vocab:
            w = "".join(_ALIF_WASLA.get(c, c) for c in w)
        out = []
        for c in w:
            if c not in self.vocab or c in ("|", "-"):
                continue
            if not self.keep_harakat and unicodedata.category(c) == "Mn":
                continue
            out.append(c)
        return "".join(out)

    def tokens(self, word):
        return [self.vocab[c] for c in self.target_text(word)]


class MMSFA(_Base):
    """torchaudio's MMS_FA bundle (Meta MMS-300m forced-alignment model) with uroman text."""

    name = "mms_fa"
    model_id = "torchaudio.pipelines.MMS_FA (facebook MMS-300m forced aligner)"

    def __init__(self):
        super().__init__()
        import torchaudio
        import uroman
        b = torchaudio.pipelines.MMS_FA
        self.model = b.get_model(with_star=False).to(self.dev).eval()
        self.dict = b.get_dict(star=None)
        self.blank = self.dict["-"]
        self.ur = uroman.Uroman()

    def _forward(self, x):
        em, _ = self.model(x[None].to(self.dev))
        return torch.log_softmax(em[0].float(), -1)

    def target_text(self, word: str) -> str:
        # Drop combining marks uroman spells out as words (maddah, small high letters, etc.)
        w = "".join(_ALIF_WASLA.get(c, c) for c in unicodedata.normalize("NFC", word))
        w = "".join(_TO_SUKUN.get(c, c) for c in w)
        w = "".join(c for c in w if not (unicodedata.category(c) == "Mn" and c not in
                                          "ًٌٍَُِّْٰ"))
        r = self.ur.romanize_string(w).lower()
        return "".join(c for c in r if c in self.dict and c != "-")

    def tokens(self, word):
        return [self.dict[c] for c in self.target_text(word)]


def make(name: str):
    """Model name, optionally with options: "quran_xlsr+w8+rep" = 8 s emission windows (+2 s
    context each side) and the repeat-aware Viterbi."""
    base, *opts = name.split("+")
    al = _make(base)
    al.name = name
    for o in opts:
        if o.startswith("w"):
            al.chunk_s = float(o[1:])
            al.ctx_s = 1.0 if al.chunk_s < 8 else 2.0
        elif o == "rep":
            al.rep = True
        elif o == "auto":
            al.rep = "auto"
        else:
            raise ValueError(o)
    if opts:
        al.model_id = f"{al.model_id}+{'+'.join(opts)}"
    return al


def run(al: _Base, wav: np.ndarray, words: list[str]):
    """Emissions + alignment with the aligner's options -> (spans, score, repeats).

    "auto" (the production setting): plain forced alignment on 30 s windows, which judged best,
    unless the repeat-aware Viterbi on short (6 s + 1 s context) windows finds the reciter
    repeating words - the long-context model tends to emit blanks over a repeated phrase, so
    repeats are only visible with short windows. Then the repeat-aware result is used.
    """
    if al.rep == "auto":
        short = al.emissions(wav, chunk_s=6.0, ctx_s=1.0)
        spans_r, score_r, reps = align_words_rep(al, short, words)
        if reps:
            return spans_r, score_r, reps
        em = al.emissions(wav, chunk_s=al.chunk_s, ctx_s=al.ctx_s)
        spans, score = align_words(al, em, words)
        return spans, score, 0
    em = al.emissions(wav, chunk_s=al.chunk_s, ctx_s=al.ctx_s)
    if al.rep:
        return align_words_rep(al, em, words)
    spans, score = align_words(al, em, words)
    return spans, score, 0


def _make(name: str):
    if name == "mms_fa":
        return MMSFA()
    if name == "xlsr_ar":
        return HFCTC("jonatasgrosman/wav2vec2-large-xlsr-53-arabic", "xlsr_ar", keep_harakat=False)
    if name == "xlsr_ar_h":
        return HFCTC("jonatasgrosman/wav2vec2-large-xlsr-53-arabic", "xlsr_ar_h", keep_harakat=True)
    if name == "quran_xlsr":
        return HFCTC("rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final", "quran_xlsr", keep_harakat=True)
    if name == "quran_xlsr_noh":
        return HFCTC("rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final", "quran_xlsr_noh", keep_harakat=False)
    raise ValueError(name)


def align_words(al: _Base, em: torch.Tensor, words: list[str]):
    """Forced-align `words` to emissions. Returns ([(start_frame, end_frame)], mean token score)."""
    toks = [al.tokens(w) for w in words]
    seq, owner = [], []
    for i, t in enumerate(toks):
        if not t:  # nothing alignable: borrow the separator so the word still gets a slot
            t = [al.sep] if al.sep is not None else []
        if al.sep is not None and seq:
            seq.append(al.sep)
            owner.append(-1)
        seq += t
        owner += [i] * len(t)
    T = em.shape[0]
    # CTC needs T >= L + repeats; trim the target only in pathological cases
    targets = torch.tensor([seq], dtype=torch.int32)
    ali, scores = AF.forced_align(em[None], targets, blank=al.blank)
    ali, scores = ali[0], scores[0].exp()
    spans = AF.merge_tokens(ali, scores, blank=al.blank)
    assert len(spans) == len(seq), (len(spans), len(seq))
    out = [[None, None] for _ in words]
    sc = []
    for s, o in zip(spans, owner):
        if o < 0:
            continue
        if out[o][0] is None:
            out[o][0] = s.start
        out[o][1] = s.end
        sc.append(s.score)
    # words with no tokens: give them the gap before the next aligned word
    for i, (a, b) in enumerate(out):
        if a is None:
            prev = out[i - 1][1] if i else 0
            out[i] = [prev, prev + 1]
    return [tuple(x) for x in out], float(np.mean(sc)) if sc else 0.0


def _targets(al: _Base, words: list[str]):
    seq, owner = [], []
    for i, w in enumerate(words):
        t = al.tokens(w)
        if not t:
            t = [al.sep] if al.sep is not None else []
        if al.sep is not None and seq:
            seq.append(al.sep)
            owner.append(-1)
        seq += t
        owner += [i] * len(t)
    return seq, owner


def align_words_rep(al: _Base, em: torch.Tensor, words: list[str], max_back: int = 12,
                    jump_logp: float = -12.0):
    """Viterbi CTC alignment that lets the reciter go back and repeat earlier words.

    Reciters often pause, then resume a few words back ("... lahu ad-deen | mukhlisina lahu
    ad-deen ..."). Plain forced alignment must then stretch one word over the repeat. Here, from
    the end of word j the path may jump to the start of any word i in [j - max_back, j], at a
    cost of `jump_logp`. A word's start is its FIRST recitation; its end is the end of its last
    recitation before the next word first starts.

    Returns ([(start_frame, end_frame)], mean token posterior, number of repeats).
    """
    seq, owner = _targets(al, words)
    W, L = len(words), len(seq)
    lp = em.numpy().astype(np.float64)
    T = lp.shape[0]
    S = 2 * L + 1
    ext = np.full(S, al.blank, dtype=np.int64)
    ext[1::2] = seq
    allow2 = np.zeros(S, dtype=bool)
    for s in range(3, S, 2):
        allow2[s] = ext[s] != ext[s - 2]
    tok_words = [w for w in range(W) if any(o == w for o in owner)]
    first = {w: owner.index(w) for w in tok_words}
    last = {w: len(owner) - 1 - owner[::-1].index(w) for w in tok_words}
    tw = np.array(tok_words)
    start_state = np.array([2 * first[w] for w in tok_words])        # blank before 1st token
    end_a = np.array([2 * last[w] + 1 for w in tok_words])           # last token
    end_b = np.array([2 * last[w] + 2 for w in tok_words])           # blank after it
    n = len(tok_words)
    NEG = -1e30
    alpha = np.full(S, NEG)
    alpha[0] = lp[0, ext[0]]
    if S > 1:
        alpha[1] = lp[0, ext[1]]
    bp = np.zeros((T, S), dtype=np.int32)
    idx = np.arange(S)
    for t in range(1, T):
        c0 = alpha
        c1 = np.concatenate(([NEG], alpha[:-1]))
        c2 = np.where(allow2, np.concatenate(([NEG, NEG], alpha[:-2])), NEG)
        best = c0.copy()
        arg = idx.copy()
        m = c1 > best
        best[m], arg[m] = c1[m], idx[m] - 1
        m = c2 > best
        best[m], arg[m] = c2[m], idx[m] - 2
        if n > 1:
            ea, eb = alpha[end_a], alpha[end_b]
            E = np.maximum(ea, eb)
            Es = np.where(ea >= eb, end_a, end_b)
            # J[k] = max over j in [k, k + max_back] of E[j]  (jump from word j back to word k)
            J, Js = E.copy(), Es.copy()
            for d in range(1, min(max_back, n - 1) + 1):
                cand = np.concatenate((E[d:], np.full(d, NEG)))
                cs = np.concatenate((Es[d:], np.zeros(d, dtype=Es.dtype)))
                m = cand > J
                J[m], Js[m] = cand[m], cs[m]
            J = J + jump_logp
            tgt = start_state
            m = J > best[tgt]
            best[tgt[m]] = J[m]
            arg[tgt[m]] = Js[m]
        alpha = best + lp[t, ext]
        bp[t] = arg
    s = S - 1 if S == 1 or alpha[S - 1] >= alpha[S - 2] else S - 2
    path = np.empty(T, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s = bp[t, s]
    # read word timings off the path
    tok = np.where(path % 2 == 1, (path - 1) // 2, -1)
    wpath = np.array([owner[k] if k >= 0 else -1 for k in tok])
    repeats = int(np.sum(np.diff(path) < -2))
    starts = {}
    for w in tok_words:
        f = np.flatnonzero(wpath == w)
        starts[w] = int(f[0])
    spans = []
    for i, w in enumerate(tok_words):
        nxt = starts[tok_words[i + 1]] if i + 1 < len(tok_words) else T
        f = np.flatnonzero(wpath[:nxt] == w)
        spans.append((starts[w], int(f[-1]) + 1))
    out = {w: sp for w, sp in zip(tok_words, spans)}
    res = []
    for i in range(W):
        if i in out:
            res.append(out[i])
        else:
            prev = res[-1][1] if res else 0
            res.append((prev, prev + 1))
    post = np.exp(lp[np.arange(T), ext[path]])
    score = float(post[path % 2 == 1].mean()) if (path % 2 == 1).any() else 0.0
    return res, score, repeats
