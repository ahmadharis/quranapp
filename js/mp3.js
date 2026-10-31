// Minimal MPEG audio (MP3) frame parser.
//
// Verse files are joined into one continuous stream for gapless playback, so each file is
// reduced to its bare audio frames (ID3/APE tags and the Xing/Info header frame dropped), and
// the encoder's silent priming and padding is reported so the player can trim it exactly.
//
// A decoded MP3 starts with `encoder delay + 529` samples of priming. The encoder's `padding`
// fill sits at the end, but the decoder's 529-sample shift moves it too, so `padding - 529`
// samples of fill remain at the end of the decoded audio (LAME records delay and padding in
// its Info header). Untrimmed, these leave 40–60 ms of silence wherever two verses meet.

const BITRATES = {
  // kbps, indexed by the header's bitrate bits; [MPEG-1 Layer III, MPEG-2/2.5 Layer III]
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function readHeader(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  const brIndex = b[i + 2] >> 4;
  const srIndex = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES.v1 : BITRATES.v2)[brIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIndex];
  const padding = (b[i + 2] >> 1) & 1;
  const length = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  const samples = mpeg1 ? 1152 : 576;
  const mono = (b[i + 3] >> 6) === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { length, samples, sampleRate, sideInfo };
}

export function id3v2Size(b, i = 0) {
  if (b[i] !== 0x49 || b[i + 1] !== 0x44 || b[i + 2] !== 0x33) return 0; // "ID3"
  const size = (b[i + 6] << 21) | (b[i + 7] << 14) | (b[i + 8] << 7) | b[i + 9];
  const footer = b[i + 5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
const DECODER_DELAY = 529;

// Returns the audio frames and their timing:
//   bytes         the frames, concatenated
//   sampleRate, samplesPerFrame, frames
//   skipStart     priming samples to drop at the start
//   skipEnd       padding samples to drop at the end (0 when the file doesn't say)
//   duration      seconds of real audio once skipStart/skipEnd are trimmed
//   lastFrameBytes  size of the final frame (lets a caller drop a frame of pure padding)
export function extractFrames(buffer) {
  const b = new Uint8Array(buffer);
  let i = 0;
  for (let tag; (tag = id3v2Size(b, i)); ) i += tag;

  const frames = [];
  let sampleRate = 0;
  let samplesPerFrame = 0;
  let encoderDelay = 0;
  let encoderPadding = 0;
  let gaplessInfo = false;
  while (i < b.length) {
    const h = readHeader(b, i);
    if (!h || i + h.length > b.length) {
      if (ascii(b, i, "TAG") || ascii(b, i, "APETAGEX")) break;
      i++; // resync past junk
      continue;
    }
    // The first frame may be a Xing/Info header: metadata, decodes as silence.
    const tagAt = i + 4 + h.sideInfo;
    if (!frames.length && (ascii(b, tagAt, "Info") || ascii(b, tagAt, "Xing"))) {
      const lame = tagAt + 120;
      if (ascii(b, lame, "LAME") || ascii(b, lame, "Lavc")) {
        encoderDelay = (b[lame + 21] << 4) | (b[lame + 22] >> 4);
        encoderPadding = ((b[lame + 22] & 0x0f) << 8) | b[lame + 23];
        gaplessInfo = true;
      }
      i += h.length;
      continue;
    }
    if (!sampleRate) {
      sampleRate = h.sampleRate;
      samplesPerFrame = h.samples;
    }
    frames.push([i, i + h.length]);
    i += h.length;
  }

  if (!frames.length) {
    return { bytes: b, sampleRate: 44100, samplesPerFrame: 1152, frames: 0, skipStart: 0, skipEnd: 0, duration: 0, lastFrameBytes: 0 };
  }

  let total = 0;
  for (const [s, e] of frames) total += e - s;
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of frames) {
    bytes.set(b.subarray(s, e), o);
    o += e - s;
  }
  const totalSamples = frames.length * samplesPerFrame;
  // Without an Info header only the decoder's own delay is certain.
  const skipStart = Math.min((gaplessInfo ? encoderDelay : 0) + DECODER_DELAY, totalSamples);
  const skipEnd = Math.min(gaplessInfo ? Math.max(0, encoderPadding - DECODER_DELAY) : 0, totalSamples - skipStart);
  const [ls, le] = frames[frames.length - 1];
  return {
    bytes,
    sampleRate,
    samplesPerFrame,
    frames: frames.length,
    skipStart,
    skipEnd,
    duration: (totalSamples - skipStart - skipEnd) / sampleRate,
    lastFrameBytes: le - ls,
  };
}
