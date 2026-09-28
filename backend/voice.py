"""Optional custom voices for Peter and Stewie in "Peter explains", via RVC.

When RPM_PETER_RVC_MODEL and/or RPM_STEWIE_RVC_MODEL point at an RVC voice
model (.pth) — e.g. one trained on your own recordings — that character's
lines are converted to that voice:

  1. Gemini TTS reads all of Peter's lines in one request and all of Stewie's
     in another (2 TTS requests per clip), with long silences between lines.
  2. Each recording is split back into lines at its longest silences.
  3. Each character with a model goes through RVC (tools/rvc_worker.py, run in the separate
     .rvc-env environment so this app stays dependency-light).
  4. The turns are interleaved into the finished scene.

RVC only changes the timbre: timing, accent and delivery come from step 1.
Everything here uses the standard library; heavy lifting is in the worker.
"""

import array
import io
import json
import math
import os
import re
import shutil
import subprocess
import uuid
import wave
from pathlib import Path

import ai

BASE_DIR = Path(__file__).resolve().parent.parent
RVC_DIR = BASE_DIR / ".rvc-env"
RVC_PYTHON = RVC_DIR / "env" / "python.exe"
APPLIO_DIR = RVC_DIR / "Applio"
WORKER = BASE_DIR / "tools" / "rvc_worker.py"
TMP_DIR = BASE_DIR / "cache" / "rvc_tmp"

SAMPLE_RATE = 24000        # Gemini TTS output; the worker resamples to match
TURN_GAP_S = 0.25          # silence between turns in the finished scene
EDGE_PAD_S = 0.06          # silence kept around each line when trimming
WIN_S = 0.02               # loudness window for finding pauses
WORKER_TIMEOUT_S = 900


class VoiceError(RuntimeError):
    pass


def _setting(name, default=""):
    return (os.environ.get(name) or default).strip().strip('"')


SPEAKERS = ("Peter", "Stewie")


def model_path(speaker):
    return _setting(f"RPM_{speaker.upper()}_RVC_MODEL")


def enabled():
    """True when any custom voice model is configured (errors surface on use,
    so a typo'd path is reported instead of silently ignored)."""
    return any(model_path(s) for s in SPEAKERS)


def _voice_config(speaker):
    """RVC settings for a speaker, or None when they use the plain TTS voice."""
    if not model_path(speaker):
        return None
    prefix = f"RPM_{speaker.upper()}_RVC"
    model = Path(model_path(speaker))
    if not model.is_file():
        raise VoiceError(f"{speaker}'s voice model wasn't found: {model} ({prefix}_MODEL in .env).")
    index = _setting(f"{prefix}_INDEX")
    if index and not Path(index).is_file():
        raise VoiceError(f"{speaker}'s voice index wasn't found: {index} ({prefix}_INDEX in .env).")
    if not RVC_PYTHON.is_file() or not APPLIO_DIR.is_dir():
        raise VoiceError("The RVC environment isn't set up. Run setup-rvc.bat in the project folder.")
    return {"model": str(model), "index": index,
            "pitch": int(_setting(f"{prefix}_PITCH", "0") or 0)}


# ------------------------------------------------------------ WAV helpers

def _read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise VoiceError("Expected 16-bit mono audio from TTS.")
        return array.array("h", w.readframes(w.getnframes())), w.getframerate()


def _wav_bytes(samples, rate):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


def _envelope(samples, rate):
    """RMS loudness per WIN_S window, and the window size in samples."""
    win = max(1, int(rate * WIN_S))
    rms = []
    for i in range(0, len(samples), win):
        chunk = samples[i:i + win]
        rms.append((sum(s * s for s in chunk) / max(1, len(chunk))) ** 0.5)
    return rms, win


def _pauses(rms, min_s):
    """Silent runs of at least min_s seconds with sound on both sides, as
    (length, first_window, end_window)."""
    loud = sorted(rms)[int(len(rms) * 0.95)] if rms else 0
    threshold = max(loud * 0.04, 40)
    runs, start = [], None
    for i, r in enumerate(rms + [threshold + 1]):
        if r < threshold and start is None:
            start = i
        elif r >= threshold and start is not None:
            if start > 0 and i < len(rms):
                runs.append((i - start, start, i))
            start = None
    return [r for r in runs if r[0] >= int(min_s / WIN_S)]


PAUSE_BONUS = 1.5  # how much a longer pause counts, vs. a line fitting its text


def _choose_cuts(runs, texts, total):
    """The n-1 pauses (of `runs`) between n lines. Picks long pauses, placed
    so each line's length fits its text, since people speak at a fairly
    steady pace: a pause inside a line can be longer than one between lines.
    Dynamic programming over the pauses in time order."""
    runs = sorted(runs, key=lambda r: r[1])
    n, m = len(texts), len(runs)
    weights = [len(t) + 5 for t in texts]
    per = total / sum(weights)  # windows per character

    def cost(a, b, i):  # line i spanning windows a..b
        return math.log(max(b - a, 1) / (weights[i] * per)) ** 2

    inf = float("inf")
    best = [[inf] * m for _ in range(n - 1)]  # best[k][j]: cut k is runs[j]
    back = [[-1] * m for _ in range(n - 1)]
    for j in range(m):
        best[0][j] = cost(0, runs[j][1], 0) - PAUSE_BONUS * runs[j][0] * WIN_S
    for k in range(1, n - 1):
        for j in range(k, m):
            for i in range(k - 1, j):
                v = best[k - 1][i] + cost(runs[i][2], runs[j][1], k)
                if v < best[k][j]:
                    best[k][j], back[k][j] = v, i
            best[k][j] -= PAUSE_BONUS * runs[j][0] * WIN_S
    j = min(range(m), key=lambda j: best[n - 2][j] + cost(runs[j][2], total, n - 1))
    cuts = []
    for k in range(n - 2, -1, -1):
        cuts.append(runs[j])
        j = back[k][j]
    return cuts[::-1]


def _split_spans(samples, rate, n, texts=None):
    """(start, end) sample bounds of n lines, cut at the recording's pauses
    and trimmed. With the lines' `texts`, pauses are chosen to fit them (see
    _choose_cuts); without, the n-1 longest are used."""
    if n == 1:
        return [_trim_span(samples, 0, len(samples), rate)]
    rms, win = _envelope(samples, rate)
    runs = _pauses(rms, 0.15)  # a real between-line pause is >= 150 ms
    if len(runs) < n - 1:
        raise VoiceError(
            f"Couldn't split the recording into {n} lines (found {len(runs) + 1}). "
            "Try \"New take\"."
        )
    if texts:
        cuts = _choose_cuts(runs, texts, len(rms))
    else:
        cuts = sorted(sorted(runs, reverse=True)[: n - 1], key=lambda r: r[1])
    bounds = [0] + [((s + e) // 2) * win for _, s, e in cuts] + [len(samples)]
    return [_trim_span(samples, a, b, rate) for a, b in zip(bounds, bounds[1:])]


def split_lines(data, texts):
    """Split a recording of the lines `texts` into one clip per line.
    Returns ([array('h'), ...], rate)."""
    samples, rate = _read_wav(data)
    return [samples[a:b] for a, b in _split_spans(samples, rate, len(texts), texts)], rate


def _trim_span(samples, a, b, rate, threshold=60):
    """Bounds of samples[a:b] without leading/trailing silence, keeping a
    little padding."""
    pad = int(EDGE_PAD_S * rate)
    first = next((i for i in range(a, b) if abs(samples[i]) > threshold), a)
    last = next((i for i in range(b - 1, a - 1, -1) if abs(samples[i]) > threshold), b - 1)
    return max(a, first - pad), min(b, last + pad + 1)


# -------------------------------------------------------------- subtitles
# Word timings for the player's subtitles. TTS returns no timestamps, so they
# are estimated: each line's pauses are found, and its words are spread over
# the remaining speech time by length, so no word lands in a pause.

def _turns(script):
    return [line.split(": ", 1) for line in script.splitlines() if ": " in line]


def _word_times(clip, rate, text, offset):
    words = text.split()
    if not words:
        return []
    rms, win = _envelope(clip, rate)
    spans, pos = [], 0  # speech, in windows: the line minus its pauses
    for _, s, e in sorted(_pauses(rms, 0.1), key=lambda r: r[1]):
        spans.append((pos, s))
        pos = e
    spans.append((pos, len(rms)))
    speech = sum(b - a for a, b in spans) or 1

    def clock(x, starting):
        """Seconds for x windows into the speech. A word starting exactly at
        a pause begins after it; one ending there ends before it."""
        for a, b in spans:
            if x < b - a or (not starting and x == b - a):
                return offset + (a + x) * win / rate
            x -= b - a
        return offset + len(rms) * win / rate

    weights = [len(re.sub(r"\W", "", w)) + 1 for w in words]
    total, acc, out = sum(weights), 0, []
    for w, wt in zip(words, weights):
        s = clock(acc * speech / total, True)
        acc += wt
        out.append({"w": w, "s": round(s, 3), "e": round(clock(acc * speech / total, False), 3)})
    return out


def _timed_line(who, text, clip, rate, offset):
    return {"who": who, "text": text,
            "start": round(offset, 3), "end": round(offset + len(clip) / rate, 3),
            "words": _word_times(clip, rate, text, offset)}


def subtitles(wav, script):
    """Subtitle timings for a whole-scene recording (one multi-speaker TTS
    take): turns are found at its longest pauses or, failing that, spread
    over it by length. Returns [{who, text, start, end, words: [{w, s, e}]}]."""
    samples, rate = _read_wav(wav)
    turns = _turns(script)
    if not turns or not samples:
        return []
    try:
        spans = _split_spans(samples, rate, len(turns), [t for _, t in turns])
    except VoiceError:
        weights = [len(t) + 5 for _, t in turns]
        total, pos, spans = sum(weights), 0, []
        for wt in weights:
            n = len(samples) * wt // total
            spans.append((pos, pos + n))
            pos += n
    return [_timed_line(who, text, samples[a:b], rate, a / rate)
            for (who, text), (a, b) in zip(turns, spans)]


# -------------------------------------------------------------- the scene

def perform(script):
    """Perform a normalized 'Peter: …' / 'Stewie: …' script with each
    character that has a model in their custom RVC voice. Returns
    (WAV bytes, subtitle timings as in subtitles())."""
    configs = {s: _voice_config(s) for s in SPEAKERS}
    turns = _turns(script)
    lines = {s: [t for who, t in turns if who == s] for s in SPEAKERS}
    if not any(configs[s] and lines[s] for s in SPEAKERS):
        wav = ai.speak_dialogue(script)
        return wav, subtitles(wav, script)

    tts = {"Peter": (ai.PETER_DIRECTION, ai.PETER_VOICE),
           "Stewie": (ai.STEWIE_DIRECTION, ai.STEWIE_VOICE)}
    clips, rate = {}, None
    for s in SPEAKERS:
        if not lines[s]:
            continue
        clips[s], s_rate = split_lines(ai.speak_lines(*tts[s], lines[s]), lines[s])
        if rate is not None and s_rate != rate:
            raise VoiceError("TTS returned mismatched sample rates.")
        rate = s_rate
    for s in clips:  # one worker run per model, so only one is in memory
        if configs[s]:
            clips[s] = _convert(clips[s], rate, configs[s])

    gap = array.array("h", [0]) * int(TURN_GAP_S * rate)
    out, its = array.array("h"), {s: iter(c) for s, c in clips.items()}
    timed = []
    for who, text in turns:
        clip = next(its[who])
        timed.append(_timed_line(who, text, clip, rate, len(out) / rate))
        out.extend(clip)
        out.extend(gap)
    return _wav_bytes(out, rate), timed


def _convert(clips, rate, config):
    """Run clips through the RVC worker; returns converted clips at `rate`."""
    job_dir = TMP_DIR / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        items = []
        for i, clip in enumerate(clips):
            src = job_dir / f"line_{i:03d}.wav"
            src.write_bytes(_wav_bytes(clip, rate))
            items.append({"in": str(src), "out": str(job_dir / f"line_{i:03d}_rvc.wav")})
        job = {
            **config,
            "index_rate": float(_setting("RPM_RVC_INDEX_RATE", "0.75")),
            "protect": float(_setting("RPM_RVC_PROTECT", "0.33")),
            "f0_method": _setting("RPM_RVC_F0_METHOD", "rmvpe"),
            "sample_rate": rate,
            "items": items,
        }
        job_path = job_dir / "job.json"
        job_path.write_text(json.dumps(job), encoding="utf-8")
        try:
            proc = subprocess.run(
                [str(RVC_PYTHON), str(WORKER), str(job_path)],
                cwd=str(APPLIO_DIR), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=WORKER_TIMEOUT_S,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            raise VoiceError("Voice conversion timed out.")
        result = _last_json(proc.stdout)
        if proc.returncode != 0 or not result.get("ok"):
            detail = result.get("error") or (proc.stderr or proc.stdout or "").strip()[-400:]
            raise VoiceError(f"Voice conversion failed: {detail}")
        return [_read_wav(Path(it["out"]).read_bytes())[0] for it in items]
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _last_json(stdout):
    """The worker's result line (Applio logs to stdout before it)."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                pass
    return {}
