# The Inference Engine

A Turing machine that has to rewind and re-read its entire tape before it can
write the single cell that follows. Which is, roughly, what an LLM does.

## Run it

```bash
pip install flask
python app.py
```

Then open <http://127.0.0.1:5000>. On first start the app creates six 0-byte MP3
templates in the project root; drop real audio over them and reload.

## Using it

| Control | What happens |
| --- | --- |
| **Infer** | The pasted text turns to dust, blows into the apparatus, and the machine begins. During a run the button becomes **Halt**. |
| **tok/s** | Sets the speed of the *final* pass. Earlier passes are faster, because the tape is shorter. |
| **Lorem** | Loads 1,000 characters into the feed. |
| **Clear tape** | Wipes `tape.json`. The cache goes with it. |

`Ctrl`/`Cmd` + `Enter` in the feed box also fires Infer.

## The lamps

| Lamp | Meaning |
| --- | --- |
| **READ** (teal) | The head is down and the tape is moving under it. |
| **WRITE** (molten) | The head is stamping the one new cell. |
| **KV** (indigo) | The stretch of tape being read is cache from earlier messages — it runs at 4×. |
| **INFER** (brass) | The stretch being read is the live message, at full cost. |

## What the timing actually models

Each token costs one full pass over everything on the tape:

```
cost(i) = cached_tokens / 4  +  (i + 1)
```

The pass at the end of the run takes `1000 / tok_s` milliseconds; every earlier
pass is scaled down by `cost(i) / cost(final)`. So a run visibly decelerates,
and a run that starts with a warm cache never gets to be fast at all — its first
pass already carries the whole cache.

Cached tape is traversed at exactly 4× the speed of live tape. The reels show
this directly: they spin four times faster while the KV lamp is lit.

Two honest limits:

- Below ~110 ms per pass the linkage can't animate a full down / read / write /
  up / rewind cycle, so the mechanism caps out near 9 tok/s of *final* speed.
  Above that the **Measured** gauge shows what you are really getting. The
  default of 100 tok/s runs the machine flat out.
- Tokenization is simulated, not real. `tokenize()` in `app.py` splits on word,
  digit, and punctuation boundaries and breaks long words into sub-word chunks,
  landing around 4.0 characters per token — close to real BPE on English prose.

## State

`tape.json` holds every message ever inferred and is gitignored. It is the KV
cache: on reload, past messages come back onto the sheet as cold blocks, and the
next run has to read past all of them first.

## Layout

```
app.py                     server, tokenizer, tape persistence, audio stubs
templates/index.html       the page; the apparatus is inline SVG
static/css/machine.css     palette and chassis
static/js/machine.js       cycle sequencing, tape kinematics, dust, audio
tape.json                  gitignored; created on first inference
*.mp3                      gitignored; created empty on first start
```
