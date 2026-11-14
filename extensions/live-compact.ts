// Live Compact for Pi — a faithful port of dsh-live-compact 1.1.7
// (MIT, MerkyorLynn) to Pi's extension boundary API.
//
// The DSH original hooks its host's compaction engine on agent idle and
// replaces the newest finished chunk with a locally built extractive card.
// Pi has no surface-replace compaction, but its turn_end boundary accepts
// context_edit drafts with exactly that effect: the first entry of the span
// is replaced by the card, the rest are omitted, and the raw entries stay in
// the session file (so Pi needs no shadow directory — see PORTING.md).
//
// Behaviour carried over: selection splits by engine (local endpoints
// cut like the original; cloud endpoints cut nothing on an ordinary
// turn — not even oversized-result pointers — and only drain,
// turn-segment by turn-segment, once the total plus an observed growth
// baseline projects past the keep budget, or at the urgent line).
// 1.1.0 adds the checkpoint floor: no cut may end at or left of the
// newest card, so a pass that lands a card is not followed by another
// cut reaching past it into the cached prefix. 1.1.1 adds the
// long-read exception: a round holding a `read` result of at least
// CHUNK_MIN drops out of the kept-rounds reservation and may be cut
// confined to its own round, even on an ordinary cloud turn.
// Upstream's multi-pass drain is folded into one turn_end by selecting
// against a simulated entry list and returning every pass's edits
// together. After Pi's own compaction lands a fresh summary, one pass
// yields (cooldown, PORTING.md #22); a summary already present when the
// instance starts only primes the baseline and never yields (1.1.2,
// PORTING.md #27). Failed tool results keep their exit code and the
// key causes from both output streams on the card (1.1.2, PORTING.md
// #26). 1.1.5 tightens that further (PORTING.md #30): diagnostics that
// fit are kept verbatim, and a span whose failed diagnostics cannot
// all be retained is not cut at all; identified failures are never
// pointerised. The kept-rounds reservation now restarts after the
// newest card (1.1.5, issue #36, PORTING.md #31). 1.1.6/1.1.7 add the
// stand-down switch (SPINE_STAND_DOWN=1 yields every pass, PORTING.md
// #32), mark tool evidence on the card as untrusted with its protected
// facts listed separately, reshape the protected-fact and
// assistant-decision shapes (region facts in, bare kebab ids out),
// prefer model-level provider URLs (issue #45), narrow card recognition
// to marker-at-text-start on message entries, recount kept tokens over
// the rounds right of the actual cut, and fall back to an ordinary
// selection when a long-read cut fails a later gate.
//
// No model is called for the cuts themselves, exactly like the original's
// spine cuts. When the card gate refuses (prose-heavy span), nothing is cut
// and Pi's own compaction remains in charge, mirroring the original's
// "wait-80" route.
//
// One tool IS added, unlike the original: spine_recall hands back the
// original text of a cut tool result by the entry-id ref printed on the
// card. Upstream's host covers that need with its shadow store and search
// API; Pi has neither, so the port keeps a sidecar archive next to the
// session file and serves it through the tool (PORTING.md #19).

import {
  backgroundJobId,
  callCommand,
  callFilePath,
  estimateTokens,
  fallbackProviderURL,
  lookupProviderURL,
  resolveEngine,
} from "./plan.ts";
import { Type } from "typebox";
import { createOfficialCompactionTracker, inCooldownWindow, latestOfficialCompaction, resolveCooldownMs } from "./cooldown.ts";
import { RecallStore, recallHint, recallResult, type RecallItem } from "./recall.ts";
import { KEEP_ROUND_TOKENS, selectNewestChunk, URGENT_TOKENS, type CallInfo, type SpanEntry } from "./select.ts";

const BIG_GATE = 650000;
const MAX_TAIL = 2200;
const MIN_PRESSURE = Number(process.env.SPINE_MIN_TOKENS || 20000);
const COOLDOWN_MS = resolveCooldownMs();

function blockText(block: any): string {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return "";
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter((part) => part.length > 0).join("\n");
}

function toSpanEntries(projected: any[]): SpanEntry[] {
  const entries: SpanEntry[] = [];
  const callIndex = new Map<string, CallInfo>();
  let turn: number | null = null;
  for (const item of projected) {
    const messages = item?.messages ?? [];
    if (messages.length === 0) continue;
    const message = messages[0];
    const role = typeof message?.role === "string" ? message.role : "custom";
    if (role === "user") turn = (turn ?? 0) + 1;
    const content = Array.isArray(message?.content) ? message.content : [];
    const toolCalls: string[] = [];
    for (const block of content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        toolCalls.push(block.id);
        if (!callIndex.has(block.id)) {
          callIndex.set(block.id, {
            id: block.id,
            name: typeof block.name === "string" ? block.name : "",
            command: callCommand(typeof block.name === "string" ? block.name : "", block.arguments),
            filePath: callFilePath(block.arguments),
          });
        }
      }
    }
    const text = messages.map(messageText).join("\n");
    const toolResultFor = role === "toolResult" && typeof message.toolCallId === "string" ? message.toolCallId : null;
    entries.push({
      id: item.sourceEntry.id,
      role,
      text,
      tokens: estimateTokens(text),
      toolCalls,
      toolResultFor,
      isError: message?.isError === true,
      turn,
      call: toolResultFor ? callIndex.get(toolResultFor) || null : null,
      backgroundStart: toolResultFor ? Boolean(backgroundJobId(text)) : false,
      seq: entries.length,
    });
  }
  return entries;
}

// Engine identity from the session's model: provider name and base URL,
// with the registry as the lookup table, mirroring the host wiring in
// upstream index.js (requestHeader / requestContext / listProviders).
// Registry rows are grouped per provider, each carrying its models, so
// a model-level URL wins over the provider-level one (1.1.6, #45).
function engineFor(ctx: any): { engine: string; source: string } {
  let provider = "";
  let baseURL = "";
  try {
    provider = typeof ctx?.model?.provider === "string" ? ctx.model.provider : "";
    baseURL = typeof ctx?.model?.baseUrl === "string" ? ctx.model.baseUrl : "";
    if (!baseURL && provider) {
      const byProvider = new Map<string, { provider: string; id: string; baseURL: string; models: { id: string; baseURL: string }[] }>();
      for (const model of ctx?.modelRegistry?.getAll?.() || []) {
        const name = typeof model?.provider === "string" ? model.provider : "";
        if (!name) continue;
        let row = byProvider.get(name);
        if (!row) {
          row = { provider: name, id: name, baseURL: "", models: [] };
          byProvider.set(name, row);
        }
        const url = typeof model?.baseUrl === "string" ? model.baseUrl : "";
        if (!row.baseURL && url) row.baseURL = url;
        if (typeof model?.id === "string" && url) row.models.push({ id: model.id, baseURL: url });
      }
      const modelId = typeof ctx?.model?.id === "string" ? ctx.model.id : "";
      baseURL = lookupProviderURL(provider, [...byProvider.values()], modelId);
    }
  } catch {
    // Resolution must never break a turn; fall through to the fallback.
  }
  if (!baseURL) baseURL = fallbackProviderURL(provider);
  return resolveEngine({ provider, baseURL, env: process.env });
}

// Stand-down (1.1.6): SPINE_STAND_DOWN=1 means another compressor owns
// compaction for this session — never cut. Upstream also auto-detects
// active peers in the host's plugin registry; Pi exposes no registry of
// other extensions, so the env is the only signal (PORTING.md #32).
// Read per turn, matching upstream's per-call check.
function standDownActive(): boolean {
  return process.env.SPINE_STAND_DOWN === "1";
}

export default function liveCompact(pi: any) {
  // Turn-growth bookkeeping for the cloud drain trigger. Pi runs one
  // process per invocation, so this resets between `pi -p` runs; the
  // urgent-line trigger inside selection does not depend on it.
  let turnBase: number | null = null;
  let maxTurnGrowth = 0;
  // Cooldown tracker: restored official compactions only prime the
  // baseline; each live one yields exactly one pass (PORTING.md #27).
  const compactionTracker = createOfficialCompactionTracker();

  // Archive of cut tool-result originals, served by spine_recall.
  const store = new RecallStore();
  const bindStore = (ctx: any) => {
    try {
      store.bind(ctx?.sessionManager?.getSessionFile?.());
    } catch {
      // Archive binding must never break a turn.
    }
  };
  pi.on("session_start", async (_event: any, ctx: any) => {
    bindStore(ctx);
  });
  pi.registerTool({
    name: "spine_recall",
    label: "Spine Recall",
    description:
      "取回被 Spine 卡片切掉的工具原文存档。卡片上的指针只剩摘录；需要确切原文时，用卡片「原文存档」行给出的 ref（条目 id）调用本工具，不要为了拿回被切内容而重新读取源文件。Retrieves the archived original tool output that a Spine extract card replaced, by the entry-id ref printed on the card.",
    promptSnippet: "spine_recall: get back tool output a Spine card cut, by the ref on the card",
    promptGuidelines: [
      "When a Spine extract card cut tool output you still need, call spine_recall with the ref printed on the card instead of re-reading the source file.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "The entry id printed on the Spine card's 原文存档 line" }),
      toFile: Type.Optional(
        Type.Boolean({ description: "Write the original to a file and return its path instead of returning it inline" }),
      ),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      bindStore(ctx);
      const result = recallResult(store, String(params?.ref ?? ""), params?.toFile === true);
      return { content: [{ type: "text" as const, text: result.text }], details: { found: result.found } };
    },
  });

  pi.on("turn_end", async (event: any, ctx: any) => {
    if (standDownActive()) return;
    bindStore(ctx);
    const usage = ctx.getContextUsage?.();
    const projected = event.context?.contextEntries ?? [];
    let work = toSpanEntries(projected);
    const hostTotal = typeof usage?.tokens === "number" ? usage.tokens : work.reduce((sum, e) => sum + e.tokens, 0);
    if (hostTotal < MIN_PRESSURE || hostTotal >= BIG_GATE) return;

    // Cooldown (1.0.9, baseline rule 1.1.2): a fresh official compaction
    // makes this pass yield once, so its summary is not rolled into a
    // spine card right away; one already present at the first pass is
    // restored history and never yields.
    const official = latestOfficialCompaction(projected);
    if (compactionTracker.observe(official)) return;
    if (inCooldownWindow(official, COOLDOWN_MS)) return;

    const { engine } = engineFor(ctx);
    const cloud = engine !== "local";
    const growth = Math.max(0, hostTotal - (turnBase ?? hostTotal));
    maxTurnGrowth = Math.max(maxTurnGrowth, growth);
    // Drain when the next turn is projected to pass the keep budget (an
    // observed growth baseline is required), or at the urgent line.
    const projectedOver = maxTurnGrowth > 0 && hostTotal + maxTurnGrowth > KEEP_ROUND_TOKENS;
    const drain = cloud && (projectedOver || hostTotal >= URGENT_TOKENS);

    let simTotal = hostTotal;
    const drafts: any[] = [];
    let cuts = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      if (drain && simTotal <= KEEP_ROUND_TOKENS) break;
      const chunk = selectNewestChunk(work, { engine, totalTokens: simTotal, drain });
      if (!chunk) break;
      const tailBeyondKept = chunk.after - (chunk.keptTokens || 0);
      if (!drain && tailBeyondKept > MAX_TAIL && simTotal < URGENT_TOKENS) break;
      const span = work.slice(chunk.start, chunk.end + 1);
      let cardText = chunk.card.text;
      // Archive the span's largest tool results and name their recall
      // refs on the card, so cut content stays reachable by tool call
      // instead of by re-reading the source (PORTING #19).
      const recallItems: RecallItem[] = span
        .filter((entry) => entry.role === "toolResult" && entry.text.length > 0)
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, 3)
        .map((entry) => ({
          id: entry.id,
          label: entry.call
            ? `${entry.call.name}${entry.call.command ? ` "${entry.call.command}"` : ""}`
            : "tool",
          text: entry.text,
        }));
      if (recallItems.length > 0) cardText += `\n${recallHint(recallItems)}`;
      const cardTokens = estimateTokens(cardText);
      if (cardTokens >= chunk.tokens) break;
      for (const item of recallItems) store.put(item);
      for (let i = 0; i < span.length; i += 1) {
        drafts.push(
          i === 0
            ? { type: "context_edit", targetId: span[i].id, replacement: { content: [{ type: "text", text: cardText }] } }
            : { type: "context_edit", targetId: span[i].id, replacement: null },
        );
      }
      const cardEntry: SpanEntry = {
        id: span[0].id,
        role: "assistant",
        text: cardText,
        tokens: cardTokens,
        toolCalls: [],
        toolResultFor: null,
        isError: false,
        turn: span[0].turn ?? null,
        call: null,
        backgroundStart: false,
        seq: span[0].seq,
      };
      work = [...work.slice(0, chunk.start), cardEntry, ...work.slice(chunk.end + 1)];
      simTotal -= chunk.tokens - cardTokens;
      cuts += 1;
      if (!drain) break;
    }
    turnBase = simTotal;
    if (cuts === 0) return;
    ctx.ui?.notify?.(`spine cut x${cuts} total=${hostTotal} -> ${simTotal}`, "info");
    return { entries: drafts };
  });
}
