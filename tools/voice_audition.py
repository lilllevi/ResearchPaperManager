"""Audition Gemini's built-in voices for "Peter explains".

Renders one Peter line and one Stewie line in several candidate voices, using
the same character direction the app uses (backend/ai.py), and writes a page
to compare them side by side:

    .venv\\Scripts\\python.exe tools\\voice_audition.py            # default shortlist
    .venv\\Scripts\\python.exe tools\\voice_audition.py --all      # every voice
    .venv\\Scripts\\python.exe tools\\voice_audition.py --peter Fenrir Algenib --stewie Iapetus
    .venv\\Scripts\\python.exe tools\\voice_audition.py --redo peter      # re-record Peter

Output: cache/voice_audition/index.html (plus one .wav per clip). Clips that
already exist are skipped, so a run cut short by the rate limit can simply be
re-run. Put the winners in .env as RPM_PETER_VOICE / RPM_STEWIE_VOICE.
"""

import argparse
import html
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import ai  # noqa: E402

# Every clip must come from the same model for a fair comparison, so wait out
# rate limits here instead of letting the app's fallback model step in.
ai.TTS_FALLBACK_MODEL = ""

OUT_DIR = ROOT / "cache" / "voice_audition"

# Gemini's prebuilt TTS voices and Google's one-word description of each.
VOICES = {
    "Zephyr": "Bright", "Puck": "Upbeat", "Charon": "Informative", "Kore": "Firm",
    "Fenrir": "Excitable", "Leda": "Youthful", "Orus": "Firm", "Aoede": "Breezy",
    "Callirrhoe": "Easy-going", "Autonoe": "Bright", "Enceladus": "Breathy",
    "Iapetus": "Clear", "Umbriel": "Easy-going", "Algieba": "Smooth",
    "Despina": "Smooth", "Erinome": "Clear", "Algenib": "Gravelly",
    "Rasalgethi": "Informative", "Laomedeia": "Upbeat", "Achernar": "Soft",
    "Alnilam": "Firm", "Schedar": "Even", "Gacrux": "Mature",
    "Pulcherrima": "Forward", "Achird": "Friendly", "Zubenelgenubi": "Casual",
    "Vindemiatrix": "Gentle", "Sadachbia": "Lively", "Sadaltager": "Knowledgeable",
    "Sulafat": "Warm",
}

# Shortlists: voices whose character is closest to each role.
PETER_SHORTLIST = ["Fenrir", "Algenib", "Puck", "Orus", "Alnilam", "Gacrux",
                   "Zubenelgenubi", "Sadachbia", "Umbriel", "Enceladus"]
STEWIE_SHORTLIST = ["Iapetus", "Erinome", "Rasalgethi", "Algieba", "Schedar",
                    "Leda", "Zephyr", "Kore", "Puck", "Sadaltager"]

LINES = {
    "peter": (
        "Heh heh heh. Okay Stewie, listen up. So these computer guys figured out "
        "that when you chop a big book into little pieces, the robot forgets "
        "what the whole thing's about. It's like when I read a cereal box. I "
        "only remember the prize! Wicked smart, right?"
    ),
    "stewie": (
        "Good lord, Peter. What they've actually shown is that splitting a "
        "document by length destroys its structure, so the retriever loses the "
        "context entirely. Honestly, explaining science to you is like teaching "
        "calculus to a houseplant."
    ),
}
DIRECTIONS = {"peter": ai.PETER_DIRECTION, "stewie": ai.STEWIE_DIRECTION}
MAX_WAITS = 6  # rate-limit waits per clip before giving up on the run


def clip_path(character, voice):
    return OUT_DIR / f"{character}_{voice}.wav"


def render(character, voice, redo=False):
    """Render one clip, waiting out per-minute rate limits. Returns
    'made' / 'skipped', or raises GeminiError when it's hopeless (daily quota)."""
    path = clip_path(character, voice)
    if path.exists() and not redo:
        return "skipped"
    for attempt in range(MAX_WAITS + 1):
        try:
            path.write_bytes(ai.speak_as(DIRECTIONS[character], voice, LINES[character]))
            return "made"
        except ai.GeminiError as e:
            msg = str(e).lower()
            daily = "per day" in msg or "perday" in msg or "exceeded your current quota" in msg
            if e.code != 429 or daily or attempt == MAX_WAITS:
                raise
            wait = min(max(e.retry_after or 20, 5), 90)
            print(f"      rate limited, waiting {wait:.0f}s...", flush=True)
            time.sleep(wait)


def write_page(peter, stewie):
    """List every recorded clip — this run's voices first, then any earlier
    ones — so a partial or narrowed re-run never hides previous takes."""
    def section(title, character, voices):
        rows = []
        for v in list(voices) + [v for v in VOICES if v not in voices]:
            p = clip_path(character, v)
            if not p.exists():
                continue
            rows.append(
                f'<div class="row"><div class="name">{html.escape(v)}'
                f'<span>{html.escape(VOICES.get(v, ""))}</span></div>'
                f'<audio controls preload="none" src="{html.escape(p.name)}"></audio></div>'
            )
        body = "".join(rows) or '<p class="none">No clips yet.</p>'
        return (f"<section><h2>{title}</h2><p class=\"line\">“{html.escape(LINES[character])}”</p>"
                f"{body}</section>")

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice Audition</title>
<style>
  :root {{ --bg:#F5F4F1; --surface:#fff; --border:#E4E3DE; --text:#17181A; --muted:#8E8E8B; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#141517; --surface:#1d1f22; --border:#2c2e32; --text:#ececea; --muted:#9a9a97; }}
  }}
  body {{ margin:0; padding:28px 16px 48px; background:var(--bg); color:var(--text);
         font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width:980px; margin:0 auto; }}
  h1 {{ margin:0 0 4px; font-size:22px; }}
  .sub {{ margin:0 0 24px; color:var(--muted); font-size:13.5px; }}
  .cols {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:18px; }}
  section {{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:18px; }}
  h2 {{ margin:0 0 6px; font-size:16px; }}
  .line {{ margin:0 0 14px; font-size:13px; color:var(--muted); font-style:italic; }}
  .row {{ display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--border); }}
  .name {{ width:120px; flex-shrink:0; font-weight:600; font-size:14px; }}
  .name span {{ display:block; font-weight:400; font-size:12px; color:var(--muted); }}
  audio {{ flex:1; min-width:0; height:36px; }}
  code {{ font-size:12.5px; }}
  .none {{ color:var(--muted); }}
</style></head>
<body><main>
  <h1>Voice audition</h1>
  <p class="sub">Same character direction as the app. Put your picks in <code>.env</code> as
  <code>RPM_PETER_VOICE=…</code> and <code>RPM_STEWIE_VOICE=…</code>, then restart the app.</p>
  <div class="cols">{section("Peter", "peter", peter)}{section("Stewie", "stewie", stewie)}</div>
</main></body></html>
"""
    (OUT_DIR / "index.html").write_text(page, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--peter", nargs="*", help="voices to try for Peter")
    ap.add_argument("--stewie", nargs="*", help="voices to try for Stewie")
    ap.add_argument("--all", action="store_true", help="try every voice for both")
    ap.add_argument("--redo", nargs="+", choices=["peter", "stewie"], default=[],
                    help="re-record existing clips for these characters (e.g. after "
                         "changing their direction in backend/ai.py)")
    ap.add_argument("--no-open", action="store_true", help="don't open the page when done")
    args = ap.parse_args()

    peter = list(VOICES) if args.all else (args.peter or PETER_SHORTLIST)
    stewie = list(VOICES) if args.all else (args.stewie or STEWIE_SHORTLIST)
    unknown = [v for v in peter + stewie if v not in VOICES]
    if unknown:
        sys.exit(f"Unknown voice(s): {', '.join(unknown)}. Choose from: {', '.join(VOICES)}")
    if not ai.has_api_key():
        sys.exit("GEMINI_API_KEY is not set in .env.")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [("peter", v) for v in peter] + [("stewie", v) for v in stewie]
    print(f"Auditioning {len(jobs)} clips with {ai.TTS_MODEL} -> {OUT_DIR}")
    try:
        for i, (character, voice) in enumerate(jobs, 1):
            t0 = time.time()
            result = render(character, voice, redo=character in args.redo)
            print(f"  [{i:>2}/{len(jobs)}] {character:<6} {voice:<14} {result}"
                  + (f" ({time.time() - t0:.0f}s)" if result == "made" else ""), flush=True)
            write_page(peter, stewie)  # keep the page current as clips arrive
    except ai.GeminiError as e:
        print(f"\nStopped: {e}\nRe-run later to finish; finished clips are kept.")
    except KeyboardInterrupt:
        print("\nStopped. Re-run to finish; finished clips are kept.")
    write_page(peter, stewie)
    page = OUT_DIR / "index.html"
    print(f"\nCompare them here: {page}")
    if not args.no_open:
        webbrowser.open(page.as_uri())


if __name__ == "__main__":
    main()
