"""RVC voice conversion worker (runs inside the separate .rvc-env environment).

The app's backend stays dependency-light, so voice conversion runs here, in a
subprocess using Applio's inference code (.rvc-env/Applio) and its own Python
(.rvc-env/env). The backend calls:

    .rvc-env/env/python.exe tools/rvc_worker.py job.json

with the working directory set to .rvc-env/Applio (Applio resolves its models
relative to it). job.json:

    {"model": "C:/.../voice.pth", "index": "C:/.../voice.index" | "",
     "pitch": 0, "index_rate": 0.75, "protect": 0.33, "f0_method": "rmvpe",
     "sample_rate": 24000,
     "items": [{"in": "seg_000.wav", "out": "seg_000_rvc.wav"}, ...]}

Each converted clip is loudness-matched to its input and written as 16-bit mono
WAV at `sample_rate`. On success it prints one JSON line {"ok": true, ...};
on failure {"ok": false, "error": "..."} and exits non-zero.
"""

import json
import os
import sys
import time
import traceback


def main(job_path):
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)

    import librosa
    import numpy as np
    import soundfile as sf

    sys.path.insert(0, os.getcwd())  # .rvc-env/Applio
    from rvc.infer.infer import VoiceConverter

    vc = VoiceConverter()
    rate = int(job.get("sample_rate") or 24000)
    t0 = time.time()
    for item in job["items"]:
        tmp_out = item["out"] + ".raw.wav"
        vc.convert_audio(
            audio_input_path=item["in"],
            audio_output_path=tmp_out,
            model_path=job["model"],
            index_path=job.get("index") or "",
            pitch=int(job.get("pitch", 0)),
            f0_method=job.get("f0_method") or "rmvpe",
            index_rate=float(job.get("index_rate", 0.75)),
            protect=float(job.get("protect", 0.33)),
            volume_envelope=1.0,
            split_audio=False,
            export_format="WAV",
        )
        src, _ = librosa.load(item["in"], sr=rate, mono=True)
        out, _ = librosa.load(tmp_out, sr=rate, mono=True)
        # Match loudness to the original line so turns sit at a steady level.
        src_rms = float(np.sqrt(np.mean(src ** 2))) if src.size else 0.0
        out_rms = float(np.sqrt(np.mean(out ** 2))) if out.size else 0.0
        if src_rms > 0 and out_rms > 0:
            out = out * (src_rms / out_rms)
        peak = float(np.max(np.abs(out))) if out.size else 0.0
        if peak > 0.98:
            out = out * (0.98 / peak)
        sf.write(item["out"], out, rate, subtype="PCM_16")
        os.remove(tmp_out)
    print(json.dumps({"ok": True, "converted": len(job["items"]),
                      "seconds": round(time.time() - t0, 1)}))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as e:  # report cleanly to the backend
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}",
                          "trace": traceback.format_exc()[-2000:]}))
        sys.exit(1)
