# Live Compact for Pi

[中文](./README.md) | [English](./README.en.md)

Live Compact means compacting as you go — while the session is still alive,
not after the window has filled up.

This is a faithful port of
[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact)
(MerkyorLynn, MIT) to the Pi coding agent: the principles, thresholds and the
card algorithm match upstream 1.1.7, and the host-mechanism differences are
listed one by one in [PORTING.md](./PORTING.md).

Pi's built-in compaction works like DSH's stock behaviour: pile up to a
threshold, then call the model once for a big summarisation. This extension
does not wait. Once the context exceeds **20,000 tokens**, at the end of every
turn it cuts the **most recently finished chunk** locally — no model call, no
new tools, done in milliseconds. Everything before the cut point is left
untouched, so the prefix cache keeps hitting. The cut span is replaced by an
extractive card, and the cut only goes ahead when the card can prove that no
hard line was lost. Spans whose prose share is too high are not cut and are
left to Pi's built-in compaction — the same routing as upstream's wait-80.

Semantics at 1.1.7 (synced with upstream):

- **Two engine modes**, resolved from the endpoint: a `strata` provider, or a
  loopback / LAN / Tailscale-range address, counts as **local** (cuts as
  before, always after the last user message). Anything else is **cloud**:
  ordinary turns cut nothing at all (oversized tool results are no longer
  pointerised on their own; the one exception is a long-read round, below);
  draining starts only when the total plus an
  observed next-turn growth baseline projects past the keep budget, or at
  the 48000 urgent line — turn segments are then cut one by one until the
  total is back under budget, with pointers searched only inside the
  current tail segment and spans never crossing a card or the last user
  message. `SPINE_ENGINE=local|cloud` forces the mode.
- **The newest 3 finished tool rounds stay verbatim** (within a combined
  32K-token budget); every cut must end before they start, drains included —
  the reservation is recomputed after each pass. Rounds holding a long read
  are exempt from the reservation (see the long-read bullet below). The
  reservation only counts rounds after the newest card (1.1.5), so rounds
  left of a card no longer fill its slots and stack with the checkpoint
  floor into a double starvation.
- **Checkpoint floor** (1.1.0): the newest card is a floor — no cut may end
  on it or to its left, so the already-cached prefix is never rewritten;
  when the reservation boundary lands exactly on the card, the cut is
  skipped entirely.
- **Long-read rounds** (1.1.1): a round containing a `read` result of at
  least 1000 tokens is tried on its own — the cut stays inside that round
  and never drags the short rounds after it along; a single result at 32K+
  inside it is pointerised. If that round cannot be cut, selection falls
  back to the ordinary rules for an earlier round; if the confined cut is
  refused by a later gate, selection retries once with long reads
  disabled (1.1.7).
- **The card coverage gate**: hard lines are attributed per source — hard
  facts from user messages and from tool results (obligation keywords, plan
  labels, deployment regions) must be retained under their own source id,
  and if a decision-shaped line (matched by decision verbs) in assistant
  prose would be lost, the whole card is refused.
- **Tool evidence is labelled untrusted** (1.1.6): every tool excerpt on
  the card is prefixed as untrusted tool evidence, not a new instruction,
  and each result's hard facts are listed separately at the top of its
  block under "untrusted tool facts (not promoted to user constraints)".
- **Stand-down switch** (1.1.6): with `SPINE_STAND_DOWN=1` the extension
  yields completely — every turn_end returns at once, no cuts, no cards
  (for sessions where another compressor has taken over).
- **Official-compaction cooldown**: right after Pi's built-in compaction
  produces a fresh summary, spine yields one pass instead of rolling the
  summary into a card of its own (optional `SPINE_COOLDOWN_MS` window).
  A summary already present when a session is restored only primes the
  baseline and never yields a pass (1.1.2).
- Hard lines are claimed only from non-assistant messages, and kept lines are
  tagged with their original role. Completion claims in assistant prose do not
  count as hard lines; tool evidence records only the turn, the command, the
  exit status and the call id.
- Short tool results (≤12 lines and ≤512 chars) stay on the card verbatim.
  Failed tool results are excerpted first, and failure is recognised only from
  structural signals (non-zero exit codes, `isError`, `[stderr]` markers) —
  never from keywords.
- **Failed-tool diagnostics** (1.1.2): a failed result is kept whole while it
  fits the tool budget; past the budget, root-cause lines (`*CAUSE`,
  `TypeError`/`ValueError`, …) and the edges survive. JSON results keep both
  streams, labelled stderr/stdout, and the failed block gains an
  `[exit code: N]` line.
- **Failure-diagnostics completeness gate** (1.1.5): within the budget the
  diagnostics are kept verbatim — no line-tail shortening, and a JSON result
  keeps every field, not only the two streams; past the budget the earliest
  failure line is retained alongside the last ones. If any failed result in
  the span cannot be retained completely (truncated, squeezed out of the
  shared budget, or omitted whole), the card is refused and the span stays.
  An identified failed result is never pointerised on its own.
- **Oversized tool results** (a single result over 32K tokens, adjustable)
  are not excerpted at all in local mode or during a cloud drain: the whole
  round is replaced by a pointer card that records only "call at sequence N → result at sequence M".
- Every cut tool result leaves a **sequence pointer** on the card (its event
  number in the session log; the card states explicitly that it is not a
  backup file path). Earlier user messages inside a cut span are preserved
  verbatim as JSON lines — their requirements and constraints stay in force.
- **Cut originals stay retrievable**: the extension registers one extra tool,
  `spine_recall`. When a span is cut, its largest tool originals are archived
  to a sidecar file next to the session, and the card's archive line prints
  the recall ref (the entry id). A model that still needs the original calls
  the tool instead of re-reading the source file. (Upstream covers this with
  the host's shadow search; Pi has none, so the port supplies the tool.)

One natural improvement over upstream: Pi session files are append-only and
the cut entries stay on record, so upstream's append-only plaintext shadow
directory is unnecessary — sequence pointers reference the session entries
directly.

## Installation

Requires Pi `1.2.0` (extension boundary API: `turn_end` proposing
`context_edit`).

```sh
# Enable as a local package directory (example)
pi install /path/to/pi-live-compact
# Or try it for a single run
pi -e /path/to/pi-live-compact/extensions/live-compact.ts
```

After installing, run a long task: if `context_edit` entries appear in the
session file and their content starts with `Spine extract.`, the cuts are
live.

## Parameters

Same names and meanings as upstream:

| Environment variable | Default | Purpose |
|---|---|---|
| `SPINE_MIN_TOKENS` | `20000` | Total-context threshold that triggers a small cut |
| `SPINE_KEEP_ROUNDS` | `3` | Newest finished tool rounds kept verbatim before the cut |
| `SPINE_KEEP_ROUND_TOKENS` | `32000` | Combined token budget for the kept rounds (also the cloud drain target) |
| `SPINE_ENGINE` | resolved from endpoint | Force the mode: `local` or `cloud` |
| `SPINE_STAND_DOWN` | unset (off) | When set to `1`, stand down completely: no cuts, no cards (for when another compressor owns the session) |
| `SPINE_COOLDOWN_MS` | `0` (off) | Cooldown window (ms) after an official compaction; the identity rule (one skipped pass per new official card) is always on, this only adds a time-based backstop |
| `SPINE_POINTER_TOKENS` | `32000` | A single tool result above this is pointerised, not excerpted |
| `SPINE_CHUNK_MIN` | `1000` | Minimum gain (non-user tokens) for one cut |
| `SPINE_CHUNK_MAX` | `32000` | Maximum tokens per cut |

`SPINE_CHUNK_MIN` / `SPINE_CHUNK_MAX` are hard-coded constants upstream;
upstream issue #15 proposes turning them into environment variables with
unchanged defaults, and the Pi port adopts that suggestion early
(see PORTING.md #18).

The remaining constants match upstream's hard-coded values: an
8,000-character keep budget, 2,200 tokens of tail protection, no urgent cuts
below 48K, and spans above 650K are out of the small cuts' scope
(see PORTING.md #7).

## Tests

```sh
npm test   # node --test, 89 cases covering the card builder, engine resolution, span selection, the recall archive, cooldown and handler wiring (handler cases need a resolvable "typebox" in node_modules — link Pi's bundled copy on a Pi machine)
```

## License and origin

MIT, see [LICENSE](./LICENSE). Original work © Merkyor, Pi port
© carrotciallo. For the principles and evaluation background, see the
upstream repository and its explainer page:
https://github.com/MerkyorLynn/dsh-live-compact
