// Span selection ported from dsh-live-compact 1.1.1 index.js
// (selectNewestChunk + plan.js selectCutIndexes). The DSH version walks a
// host session surface with a per-node token meter; here the same walk runs
// over plain entry records the extension builds from Pi's projected session
// entries. Pairing checks are re-expressed over tool-call ids because Pi
// has no toolPairingBalanced* helpers: a cut may not separate an assistant
// tool call from its result. The newest finished tool rounds (default 3,
// within a token budget) are reserved — the cut must end before they start.
// 1.0.7/1.0.8: selection splits by engine — local cuts only after the last
// user message; cloud drains turn by turn once the total (plus predicted
// growth) passes the keep budget. 1.0.9: ordinary cloud turns cut nothing
// at all (not even oversized-result pointers); only a drain or the urgent
// line selects, pointers stay inside the current tail segment, and the
// reservation is re-applied on every pass instead of being bypassed.
// 1.1.0: the newest checkpoint is a floor — a cut may not end at or left
// of it, so an already-cached prefix is never rewritten (issue #19).
// 1.1.1: a round holding a long read (>= CHUNK_MIN from a `read` call)
// drops out of the reservation and is tried first, cut confined to its
// own round; an oversized single result inside it is pointerised.
// 1.1.5: the reservation restarts after the newest checkpoint (#36), and
// a pointer cut never replaces a failed tool result (#33) — a span whose
// card cannot retain the complete failure diagnostics is not cut at all
// (the veto itself lives in plan.ts buildCard/toolExcerpt).
// 1.1.6/1.1.7: the legacy card marker only counts at the start of a
// message entry's text (a tool result merely mentioning it is no
// boundary); keptTokens is recounted over the retained rounds to the
// right of the actual cut; and a long-read cut that fails a later gate
// falls back to an ordinary selection with long reads disabled instead
// of returning nothing (issue #54 contests that fallback upstream; it is
// ported as released).

import {
  buildCard,
  chooseKeptSpan,
  cutLongReadRound,
  finishedToolRounds,
  isToolFailure,
  keptToolRounds,
  MARK,
  pointerOnlyText,
  pointerSpanAllowed,
  RAIL_TOKENS,
  reservedCutEnd,
  roundHasLongRead,
  selectCutIndexes,
  TRUNK_SCOPE,
  type Card,
  type CardSpan,
  type CutItem,
  type CutPick,
  type RoundEvent,
} from "./plan.ts";

// CHUNK_MIN / CHUNK_MAX are hardcoded upstream; issue #15 proposes env
// knobs with unchanged defaults. The port adopts that suggestion early
// (PORTING.md): SPINE_CHUNK_MIN / SPINE_CHUNK_MAX, invariant MIN <= MAX.
const rawChunkMin = Number.parseInt(process.env.SPINE_CHUNK_MIN || "", 10);
const rawChunkMax = Number.parseInt(process.env.SPINE_CHUNK_MAX || "", 10);
export const CHUNK_MAX = Number.isFinite(rawChunkMax) && rawChunkMax > 0 ? rawChunkMax : RAIL_TOKENS;
export const CHUNK_MIN = Math.min(
  Number.isFinite(rawChunkMin) && rawChunkMin > 0 ? rawChunkMin : 1000,
  CHUNK_MAX,
);
const rawPointer = Number.parseInt(process.env.SPINE_POINTER_TOKENS || "", 10);
export const POINTER_TOKENS = Number.isFinite(rawPointer) && rawPointer > 0 ? rawPointer : CHUNK_MAX;
export const URGENT_TOKENS = 48000;
export const KEEP_ROUNDS = Number(process.env.SPINE_KEEP_ROUNDS || 3);
export const KEEP_ROUND_TOKENS = Number(process.env.SPINE_KEEP_ROUND_TOKENS || 32000);

export interface CallInfo {
  id: string;
  name: string;
  command: string;
  filePath: string;
}

export interface SpanEntry {
  id: string;
  role: string;
  text: string;
  tokens: number;
  toolCalls: string[];
  toolResultFor: string | null;
  isError?: boolean;
  turn?: number | null;
  call?: CallInfo | null;
  backgroundStart?: boolean;
  seq: number;
}

export interface Chunk {
  start: number;
  end: number;
  tokens: number;
  after: number;
  keptTokens: number;
  card: Card;
  pointerOnly?: boolean;
}

// 1.1.6: the legacy marker is only meaningful on a message entry and only
// at the beginning of its text. A tool result or an ordinary sentence
// that merely mentions the marker must not create a permanent cut
// boundary. (Upstream restricts this to user/message events; a Pi card
// keeps the role of the entry it replaced, so any non-toolResult message
// role counts here — PORTING.md #33.)
export function isCardEntry(entry: SpanEntry): boolean {
  if (entry.role === "toolResult") return false;
  const text = entry.text.trimStart();
  return text === MARK || text.startsWith(`${MARK}\n`) || text.startsWith(`${MARK}\r\n`);
}

// Checkpoints stop span expansion and tail walks: our own cards, plus
// Pi's official compaction summaries (upstream isCheckpoint likewise
// covers both the spine kind and the official compact-checkpoint kind).
export function isCheckpointEntry(entry: SpanEntry): boolean {
  return isCardEntry(entry) || entry.role === "compactionSummary";
}

function balancedAfter(entries: SpanEntry[], spanStart: number, end: number): boolean {
  const resultIndex = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (entry.toolResultFor) resultIndex.set(entry.toolResultFor, i);
  });
  for (let i = spanStart; i <= end; i += 1) {
    for (const callId of entries[i].toolCalls) {
      const at = resultIndex.get(callId);
      if (at === undefined || at > end) return false;
    }
  }
  return true;
}

function balancedBefore(entries: SpanEntry[], start: number): boolean {
  const first = entries[start];
  if (!first.toolResultFor) return true;
  const callAt = entries.findIndex((entry) => entry.toolCalls.includes(first.toolResultFor as string));
  return callAt >= start;
}

function itemType(entry: SpanEntry): string {
  if (entry.role === "toolResult") return "tool";
  if (entry.role === "user" || entry.role === "assistant" || entry.role === "system") return entry.role;
  return "other";
}

function toCardSpan(entry: SpanEntry, callSeqOf: Map<string, number>): CardSpan {
  return {
    role: entry.role,
    text: entry.text,
    isError: entry.isError,
    command: entry.call?.command || "",
    name: entry.call?.name || "",
    filePath: entry.call?.filePath || "",
    toolCallId: entry.toolResultFor || undefined,
    turn: entry.turn ?? null,
    backgroundStart: entry.backgroundStart,
    seq: entry.seq,
    callSeq: entry.toolResultFor ? callSeqOf.get(entry.toolResultFor) : undefined,
  };
}

export interface SelectOptions {
  engine?: string;
  totalTokens?: number;
  drain?: boolean;
}

export function selectNewestChunk(entries: SpanEntry[], opts: SelectOptions = {}): Chunk | null {
  if (entries.length === 0) return null;
  const engine = opts.engine ?? "cloud";
  const first = entries[0].role === "system" ? 1 : 0;
  let end = entries.length - 1;
  // 1.1.0: the newest checkpoint is the floor. No walk below may cross
  // it — a cut ending at or left of it would rewrite the cached prefix.
  let floorCard = -1;
  for (let index = first; index <= end; index += 1) {
    if (isCheckpointEntry(entries[index])) floorCard = index;
  }
  while (end >= first) {
    if (floorCard >= 0 && end <= floorCard) return null;
    const entry = entries[end];
    const shortTail = entry.role === "assistant" || (entry.role === "user" && entry.tokens < 400);
    if (!shortTail) break;
    end -= 1;
  }
  if (floorCard >= 0 && end <= floorCard) return null;
  while (end >= first && !balancedAfter(entries, first, end)) end -= 1;

  // Reserve the newest finished tool rounds: the cut ends before them.
  // 1.1.1: a tool result from a `read` call at >= CHUNK_MIN marks its
  // round as a long-read round; keptToolRounds drops those from the
  // reservation and the round is tried as its own cut below.
  const visible: (RoundEvent & { index: number })[] = [];
  for (let index = first; index <= end; index += 1) {
    visible.push({
      index,
      type: entries[index].role === "toolResult" ? "tool" : "other",
      toolCalls: entries[index].toolCalls.length,
      longRead:
        entries[index].role === "toolResult" &&
        entries[index].call?.name === "read" &&
        entries[index].tokens >= CHUNK_MIN,
      checkpoint: isCheckpointEntry(entries[index]),
    });
  }
  const floorVisible = visible.reduce((found, item, index) => (item.checkpoint ? index : found), -1);
  const rounds = keptToolRounds(visible, KEEP_ROUNDS, floorVisible);
  const newestLong = [...finishedToolRounds(visible)].reverse().find((round) => roundHasLongRead(visible, round));
  const span = chooseKeptSpan(rounds, (from, to) => {
    let tokens = 0;
    for (let index = visible[from.start].index; index <= visible[to.end].index; index += 1) tokens += entries[index].tokens;
    return tokens;
  }, KEEP_ROUND_TOKENS);
  const cutEnd = span ? reservedCutEnd(visible[span.start].index, first) : null;
  if (span && cutEnd === null) return null;
  if (cutEnd !== null && span) {
    end = cutEnd;
    while (end >= first && entries[end].role === "user" && !(floorCard >= 0 && end - 1 <= floorCard)) end -= 1;
    if (floorCard >= 0 && end <= floorCard) return null;
    if (isCheckpointEntry(entries[end])) return null;
    while (end >= first && !balancedAfter(entries, first, end)) {
      if (floorCard >= 0 && end - 1 <= floorCard) return null;
      end -= 1;
    }
    if (floorCard >= 0 && end <= floorCard) return null;
  }
  // Settled upstream on issue #19: when the reservation's cutEnd lands
  // on the floor card, the checks above return null before the long-read
  // span below is tried. That is intentional — never reach across a card
  // for one long read; the kept window slides right next turn and the
  // round becomes a candidate then.
  const longSpan =
    newestLong && visible[newestLong.start].index > floorCard
      ? { start: visible[newestLong.start].index, end: visible[newestLong.end].index }
      : null;
  if (!longSpan && (end < first || isCheckpointEntry(entries[end]))) return null;
  const maxEnd = end;

  const items: CutItem[] = entries.map((entry, index) => ({
    type: itemType(entry),
    tokens: entry.tokens,
    checkpoint: isCheckpointEntry(entry),
    balancedBefore: balancedBefore(entries, index),
    balancedAfter: balancedAfter(entries, first, index),
  }));
  const cutOptions = {
    engine,
    chunkMin: CHUNK_MIN,
    chunkMax: CHUNK_MAX,
    pointerMax: POINTER_TOKENS,
    maxEnd,
    totalTokens: opts.totalTokens,
    drain: opts.drain,
    urgentTokens: URGENT_TOKENS,
  };
  const callSeqOf = new Map<string, number>();
  for (const entry of entries) {
    for (const callId of entry.toolCalls) {
      if (!callSeqOf.has(callId)) callSeqOf.set(callId, entry.seq);
    }
  }
  const spanText = (a: number, b: number) => entries.slice(a, b + 1).map((e) => e.text).join("\n");
  const liveText = (a: number, b: number) =>
    entries.filter((_, i) => i < a || i > b).map((e) => e.text).join("\n");
  const spanObjs = (a: number, b: number) => entries.slice(a, b + 1).map((e) => toCardSpan(e, callSeqOf));
  const sumTokens = (a: number, b: number) => {
    let total = 0;
    for (let i = a; i <= b; i += 1) total += entries[i].tokens;
    return total;
  };
  const afterOf = (at: number) => {
    let after = 0;
    for (let i = at + 1; i < entries.length; i += 1) after += entries[i].tokens;
    return after;
  };
  // 1.1.7: keptTokens must describe retained rounds to the right of the
  // actual cut. A long-read cut can be newer than the rounds the
  // reservation selected; counting those older rounds made
  // tailBeyondKept negative in the caller and disabled the tail guard.
  const keptTokensAfter = (cutEndIndex: number): number => {
    let total = 0;
    for (const round of rounds) {
      const roundStart = visible[round.start]?.index;
      const roundEnd = visible[round.end]?.index;
      if (!Number.isInteger(roundStart) || !Number.isInteger(roundEnd) || (roundStart as number) <= cutEndIndex) continue;
      for (let index = roundStart as number; index <= (roundEnd as number); index += 1) total += entries[index].tokens;
    }
    return total;
  };

  const attempt = (disableLongRead: boolean): Chunk | null => {
    const longSpan =
      !disableLongRead && newestLong && visible[newestLong.start].index > floorCard
        ? { start: visible[newestLong.start].index, end: visible[newestLong.end].index }
        : null;
    if (!longSpan && (maxEnd < first || isCheckpointEntry(entries[maxEnd]))) return null;
    let usedLongCut = false;
    let picked: CutPick | null = null;
    if (longSpan) {
      const longPicked = cutLongReadRound(items, longSpan.start, longSpan.end, cutOptions);
      if (longPicked && longPicked.start >= longSpan.start && longPicked.end <= longSpan.end) {
        picked = longPicked;
        usedLongCut = true;
      }
    }
    if (!picked) {
      if (maxEnd < first || isCheckpointEntry(entries[maxEnd])) return null;
      picked = selectCutIndexes(items, cutOptions);
    }
    if (!picked) return null;
    // 1.1.7: a long-read cut that fails a later gate retries the whole
    // selection with long reads disabled instead of returning nothing.
    const fallback = (): Chunk | null => (usedLongCut ? attempt(true) : null);

    if (picked.pointerOnly) {
      const resultAt = picked.end;
      // 1.1.5 (#33): an identified failed result never goes pointer-only;
      // its diagnostics must go through the card gate instead.
      if (isToolFailure(entries[resultAt].text, entries[resultAt].isError)) return fallback();
      const callId = entries[resultAt].toolResultFor;
      if (!callId) return fallback();
      const pairStart = entries.findIndex((entry) => entry.toolCalls.includes(callId));
      if (pairStart < 0 || pairStart > resultAt) return fallback();
      if (usedLongCut && longSpan && pairStart < longSpan.start) return fallback();
      if (!pointerSpanAllowed(items, pairStart, resultAt, engine)) return fallback();
      if (items[pairStart].balancedBefore === false) return fallback();
      // Port-side guard (PORTING.md): replacing the call entry also drops any
      // sibling call in it; a sibling whose result lands outside the span
      // would be orphaned, so refuse the cut in that case.
      const resultIndex = new Map<string, number>();
      entries.forEach((entry, i) => {
        if (entry.toolResultFor) resultIndex.set(entry.toolResultFor, i);
      });
      for (const sibling of entries[pairStart].toolCalls) {
        if (sibling === callId) continue;
        const at = resultIndex.get(sibling);
        if (at === undefined || at > resultAt) return fallback();
      }
      const text = `${MARK}\n${pointerOnlyText(spanObjs(pairStart, resultAt))}`;
      const card: Card = {
        ok: true,
        failureDiagnosticsComplete: true,
        verdict: "ok",
        scope: TRUNK_SCOPE,
        hardLines: [],
        hardFacts: [],
        missingFacts: [],
        hardCount: 0,
        omittedHard: 0,
        deferred: 0,
        missing: [],
        omittedOrdinaryToolLines: 0,
        uncovered: "",
        keptChars: text.length,
        needsBackup: false,
        rawPaths: [],
        text,
      };
      return {
        start: pairStart,
        end: resultAt,
        tokens: sumTokens(pairStart, resultAt),
        after: afterOf(resultAt),
        keptTokens: keptTokensAfter(resultAt),
        card,
        pointerOnly: true,
      };
    }

    if (usedLongCut && longSpan && (picked.start < longSpan.start || picked.end > longSpan.end)) return fallback();

    const start = picked.start;
    const finalEnd = picked.end;
    if (isCheckpointEntry(entries[start])) return null;
    const card = buildCard(spanText(start, finalEnd), liveText(start, finalEnd), spanObjs(start, finalEnd));
    if (!card.ok) return fallback();
    if (!balancedAfter(entries, start, finalEnd)) return null;
    return {
      start,
      end: finalEnd,
      tokens: sumTokens(start, finalEnd),
      after: afterOf(finalEnd),
      keptTokens: keptTokensAfter(finalEnd),
      card,
    };
  };
  return attempt(false);
}
