"""
THE INFERENCE ENGINE
A Turing-machine apparatus that reads its whole tape before writing one cell.

Run:  python app.py     ->  http://127.0.0.1:5000
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

ROOT = Path(__file__).parent.resolve()
TAPE_PATH = ROOT / "tape.json"

# The machine looks for these in the project root. Missing ones are created as
# 0-byte templates so you can drop real audio in later without touching code.
SOUND_FILES = (
    "tape_forward.mp3",
    "tape_rewind.mp3",
    "head_down.mp3",
    "head_up.mp3",
    "head_read.mp3",
    "head_write.mp3",
)

MAX_CHARS = 12000

app = Flask(__name__)


# --------------------------------------------------------------------------
# Audio stubs
# --------------------------------------------------------------------------
def ensure_sound_stubs() -> list[str]:
    """Create 0-byte MP3 templates for any sound the machine can't find."""
    created = []
    for name in SOUND_FILES:
        path = ROOT / name
        if not path.exists():
            path.touch()
            created.append(name)
    return created


def sound_report() -> dict[str, bool]:
    """True where a sound file actually has audio in it."""
    return {name: (ROOT / name).stat().st_size > 0 for name in SOUND_FILES}


# --------------------------------------------------------------------------
# Tape persistence
# --------------------------------------------------------------------------
def load_tape() -> dict:
    if not TAPE_PATH.exists():
        return {"messages": []}
    try:
        data = json.loads(TAPE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return data
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        pass
    return {"messages": []}


def save_tape(tape: dict) -> None:
    TAPE_PATH.write_text(
        json.dumps(tape, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def tape_token_count(tape: dict) -> int:
    return sum(len(m.get("tokens", [])) for m in tape["messages"])


# --------------------------------------------------------------------------
# Fake tokenizer
# --------------------------------------------------------------------------
# Approximates BPE behaviour well enough to feel right: leading whitespace rides
# along with the token, punctuation and digits split off, long words break into
# sub-word chunks. Lands around 3.8-4.2 characters per token on English prose.
_PIECE = re.compile(
    r"[ \t]*(?:\r?\n|[A-Za-z]+(?:['\u2019][A-Za-z]+)?|\d+|[^\sA-Za-z\d]|[ \t]+$)"
)


def _split_long(word: str, first: int = 5, rest: int = 4) -> list[str]:
    chunks, i = [], 0
    while i < len(word):
        size = first if i == 0 else rest
        chunks.append(word[i : i + size])
        i += size
    if len(chunks) > 1 and len(chunks[-1]) == 1:
        chunks[-2] += chunks.pop()
    return chunks


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    for match in _PIECE.finditer(text):
        piece = match.group(0)
        core = piece.lstrip(" \t")
        lead = piece[: len(piece) - len(core)]

        if not core:
            tokens.append(piece)
            continue
        if core in ("\n", "\r\n"):
            tokens.append(lead + core)
            continue
        if core.isalpha() and len(core) > 6:
            chunks = _split_long(core)
        elif core.isdigit() and len(core) > 3:
            chunks = _split_long(core, first=3, rest=3)
        else:
            chunks = [core]

        chunks[0] = lead + chunks[0]
        tokens.extend(chunks)
    return [t for t in tokens if t]


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/state")
def api_state():
    """Everything already committed to tape, for redrawing the print-out."""
    tape = load_tape()
    return jsonify(
        {
            "messages": [
                {"text": m.get("text", ""), "tokens": len(m.get("tokens", []))}
                for m in tape["messages"]
            ],
            "kv_tokens": tape_token_count(tape),
            "sounds": sound_report(),
        }
    )


@app.post("/api/infer")
def api_infer():
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", ""))[:MAX_CHARS]
    if not text.strip():
        return jsonify({"error": "Nothing to infer. Paste some text first."}), 400

    tape = load_tape()
    kv_tokens = tape_token_count(tape)
    tokens = tokenize(text)

    tape["messages"].append({"text": text, "tokens": tokens, "at": time.time()})
    save_tape(tape)

    return jsonify(
        {
            "tokens": tokens,
            "kv_tokens": kv_tokens,
            "index": len(tape["messages"]) - 1,
        }
    )


@app.post("/api/clear")
def api_clear():
    """Wipe tape.json. The KV cache is gone; the next run starts cold."""
    if TAPE_PATH.exists():
        TAPE_PATH.unlink()
    return jsonify({"messages": [], "kv_tokens": 0})


@app.get("/audio/<path:name>")
def audio(name: str):
    if name not in SOUND_FILES:
        return ("Unknown sound.", 404)
    return send_from_directory(ROOT, name, mimetype="audio/mpeg")


# --------------------------------------------------------------------------
if __name__ == "__main__":
    made = ensure_sound_stubs()
    if made:
        print(f"Created {len(made)} silent audio template(s): {', '.join(made)}")
        print("Drop real MP3s over them to give the machine a voice.\n")
    live = [n for n, ok in sound_report().items() if ok]
    print(f"Audio: {len(live)}/{len(SOUND_FILES)} files carry sound.")
    print("Apparatus online at http://127.0.0.1:5000\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
