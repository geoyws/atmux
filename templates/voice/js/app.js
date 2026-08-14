// atmux voice — client state machine (ADR-272 D5/D8/D11).
//
// One WebSocket to `atmux voice`: binary frames = PCM16LE 24 kHz audio
// both ways (codec in protocol.js), text frames = JSON control. This file
// wires the socket, the audio engine, and the single-screen console.
// Provider-neutral by contract: NOTHING here branches on ready.provider —
// it is display copy only (ADR-272 D4 / V-7 zero-client-diff swap).

import { createVoiceAudio } from "./audio.js";
import { decodeFrame, encodeFrame, nextSeq, VOICE_CLOSE, VOICE_PROTOCOL } from "./protocol.js";

const TOKEN_KEY = "atmux.voice.token";
const TEAM_KEY = "atmux.voice.team";
const HEARTBEAT_MS = 15000;
const PONG_DEADLINE_MS = HEARTBEAT_MS * 2 + 1000; // 2 missed pongs → teardown
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 8000;

const $ = (id) => document.getElementById(id);
const dotEl = $("dot");
const providerEl = $("provider");
const modelEl = $("model");
const roEl = $("readonly");
const teamBtn = $("team");
const transcriptEl = $("transcript");
const stripEl = $("errstrip");
const stripTextEl = $("errstrip-text");
const stripActionBtn = $("errstrip-action");
const micBtn = $("mic");
const micLabelEl = $("mic-label");
const resumeOverlay = $("resume-overlay");
const takeoverOverlay = $("takeover-overlay");

const MIC_LABELS = {
  idle: "HOLD TO TALK",
  listening: "LISTENING",
  thinking: "THINKING",
  working: "WORKING",
  speaking: "TAP TO INTERRUPT",
};

// ---------- token: ?token= once → localStorage → scrub the URL ----------
(() => {
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) {
    localStorage.setItem(TOKEN_KEY, fromQuery);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
})();
const token = localStorage.getItem(TOKEN_KEY);

// ---------- state ----------
const state = {
  ws: null,
  wsLive: false, // ready received on the current socket
  sessionId: null,
  teams: [],
  team: null,
  uiState: "idle",
  capturing: false,
  seq: 0,
  reconnectAttempt: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  lastPongAt: 0,
  stripTimer: null,
  terminal: false, // takeover or fatal error — no auto-reconnect
  wakeLock: null,
};

const audio = createVoiceAudio({ onFrame: sendPcmFrame, onRms: renderRms });

// ---------- websocket lifecycle ----------
function connect() {
  if (state.terminal || !token) return;
  // Never race a second socket against one still connecting/open — the
  // server's latest-wins takeover (D8) would let us displace ourselves.
  const existing = state.ws;
  if (
    existing &&
    (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  state.wsLive = false;
  setDot("connecting");
  ws.onopen = () => {
    // hello within 3 s or the server closes 4408 — send immediately.
    const hello = { type: "hello", v: 1, token, mode: "ptt", ua: navigator.userAgent };
    if (state.sessionId) hello.resume = state.sessionId;
    const savedTeam = state.team || localStorage.getItem(TEAM_KEY);
    if (savedTeam) hello.team = savedTeam;
    sendJson(hello);
  };
  ws.onmessage = (event) => {
    if (typeof event.data === "string") onControlFrame(event.data);
    else onBinaryFrame(new Uint8Array(event.data));
  };
  ws.onclose = (event) => onClose(ws, event);
}

function onClose(ws, event) {
  if (state.ws !== ws) return; // superseded socket
  state.ws = null;
  state.wsLive = false;
  stopHeartbeat();
  endCaptureUi();
  setUiState("idle");
  if (state.terminal) {
    setDot("dead");
    return;
  }
  if (event.code === VOICE_CLOSE.TAKEOVER) {
    enterTakeover();
    return;
  }
  if (event.code === VOICE_CLOSE.AUTH || event.code === VOICE_CLOSE.ORIGIN) {
    // Retrying with the same credentials cannot succeed — stop.
    state.terminal = true;
    setDot("dead");
    showStrip(`auth rejected (${event.code}) — reopen the tokened link`, { sticky: true });
    return;
  }
  if (event.code === VOICE_CLOSE.RATE_LIMITED) {
    showStrip("rate limited — backing off", { sticky: false });
    state.reconnectAttempt = Math.max(state.reconnectAttempt, 4); // start near the cap
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (state.terminal || state.reconnectTimer) return;
  if (document.visibilityState !== "visible") {
    // Never burn radio in the background — the visibilitychange handler
    // reconnects the moment the page is visible again.
    setDot("dead");
    return;
  }
  setDot("connecting");
  const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** state.reconnectAttempt);
  const delay = base * (0.5 + Math.random() * 0.5); // jittered
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(connect, delay);
}

function teardownSocket() {
  const ws = state.ws;
  if (!ws) return;
  ws.onclose = null;
  state.ws = null;
  state.wsLive = false;
  stopHeartbeat();
  try {
    ws.close(VOICE_CLOSE.NORMAL);
  } catch {
    // already closing
  }
}

function sendJson(obj) {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Uplink mic frames. D8 discard rule: when the socket is down, frames are
// DROPPED here — buffered/undelivered audio is never queued or replayed
// into a resumed session (it would inject stale speech).
function sendPcmFrame(int16) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.wsLive) return;
  const payload = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  ws.send(encodeFrame({ flags: 0, seq: state.seq, payload }));
  state.seq = nextSeq(state.seq);
}

function sendTurnEnd() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.wsLive) return;
  ws.send(
    encodeFrame({
      flags: VOICE_PROTOCOL.FLAG_TURN_END,
      seq: state.seq,
      payload: new Uint8Array(0), // empty payload is legal on a bare TURN_END
    }),
  );
  state.seq = nextSeq(state.seq);
}

// ---------- heartbeat ----------
function startHeartbeat() {
  stopHeartbeat();
  state.lastPongAt = Date.now();
  state.heartbeatTimer = setInterval(() => {
    if (Date.now() - state.lastPongAt > PONG_DEADLINE_MS) {
      teardownSocket();
      scheduleReconnect();
      return;
    }
    sendJson({ type: "ping", t: Date.now() });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

// ---------- inbound frames ----------
function onBinaryFrame(bytes) {
  const frame = decodeFrame(bytes);
  if (!frame.ok || frame.payload.length === 0) return;
  // Ordering invariant: audio.clear always precedes the interrupting
  // turn's audio, so enqueueing everything that arrives is safe.
  audio.enqueuePcm(
    new Int16Array(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength >> 1),
  );
}

function onControlFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (!frame || typeof frame.type !== "string") return;
  const handler = HANDLERS[frame.type];
  if (handler) handler(frame);
}

const HANDLERS = {
  ready(f) {
    state.sessionId = f.sessionId;
    state.teams = f.teams || [];
    state.team = f.team;
    state.wsLive = true;
    state.reconnectAttempt = 0;
    state.lastPongAt = Date.now();
    providerEl.textContent = f.provider;
    modelEl.textContent = f.model;
    roEl.hidden = !f.readonly;
    renderTeam();
    if (!f.resumed) clearTranscript();
    setDot("live");
    startHeartbeat();
    acquireWakeLock();
  },
  status(f) {
    setUiState(f.state);
  },
  "transcript.user"(f) {
    upsertUtterance("user", f);
  },
  "transcript.assistant"(f) {
    upsertUtterance("assistant", f);
  },
  "tool.start"(f) {
    upsertToolChip(f.id, { phase: "running", name: f.name, args: f.args });
  },
  "tool.done"(f) {
    upsertToolChip(f.id, {
      phase: f.ok ? "ok" : "fail",
      summary: f.summary,
      ms: f.ms,
      needsConfirmation: f.needs_confirmation === true,
    });
  },
  "audio.clear"() {
    audio.flushAll();
  },
  takeover() {
    enterTakeover();
  },
  error(f) {
    showStrip(f.message || `error: ${f.code}`, { sticky: f.fatal });
    if (f.fatal) {
      state.terminal = true;
      teardownSocket();
      setDot("dead");
      offerStripAction("reconnect", () => {
        state.terminal = false;
        state.reconnectAttempt = 0;
        hideStrip();
        connect();
      });
    }
  },
  pong() {
    state.lastPongAt = Date.now();
  },
};

function enterTakeover() {
  // D8 latest-wins: another device claimed the session. Terminal — no
  // auto-reconnect (it would fight the winner for the slot).
  state.terminal = true;
  teardownSocket();
  releaseWakeLock();
  setDot("dead");
  takeoverOverlay.hidden = false;
}

// ---------- push-to-talk ----------
let micBusy = false; // serializes async down/up handlers

async function onMicDown(event) {
  event.preventDefault();
  if (micBusy || state.terminal) return;
  micBusy = true;
  try {
    if (micBtn.setPointerCapture && event.pointerId !== undefined) {
      try {
        micBtn.setPointerCapture(event.pointerId);
      } catch {
        // capture unsupported — harmless
      }
    }
    if (!audio.isInited()) {
      // FIRST user gesture — the only legal place to build the audio
      // stack (convoke guard #4; details in audio.js).
      try {
        await audio.init();
      } catch {
        showStrip("microphone unavailable — check permissions", { sticky: true });
        return;
      }
    }
    if (audio.state() === "suspended") await audio.resume();
    hideResumeOverlay();
    if (state.uiState === "speaking") {
      // Barge-in: kill local playback FIRST (≈0 ms perceived), then tell
      // the server. Waiting for the round trip would leave the assistant
      // talking over the operator.
      audio.flushAll();
      sendJson({ type: "cancel" });
    }
    if (!state.wsLive) {
      showStrip("not connected — reconnecting", {});
      scheduleReconnect();
      return;
    }
    state.capturing = true;
    micBtn.setAttribute("aria-pressed", "true");
    micBtn.classList.add("held");
    sendJson({ type: "ptt", down: true });
    audio.startCapture();
  } finally {
    micBusy = false;
  }
}

async function onMicUp() {
  if (!state.capturing) return;
  state.capturing = false;
  micBtn.setAttribute("aria-pressed", "false");
  micBtn.classList.remove("held");
  // stopCapture resolves after the worklet flushed its final padded
  // frame, so TURN_END lands after the last audio frame.
  await audio.stopCapture();
  sendTurnEnd();
  sendJson({ type: "ptt", down: false });
}

function endCaptureUi() {
  state.capturing = false;
  micBtn.setAttribute("aria-pressed", "false");
  micBtn.classList.remove("held");
}

micBtn.addEventListener("pointerdown", onMicDown);
micBtn.addEventListener("pointerup", onMicUp);
micBtn.addEventListener("pointercancel", onMicUp);
micBtn.addEventListener("contextmenu", (e) => e.preventDefault());

function renderRms(value) {
  // Worklet posts ~every 40 ms; a CSS var drives the meter disc.
  micBtn.style.setProperty("--rms", Math.min(1, value * 4).toFixed(3));
}

// ---------- ui state ----------
function setUiState(uiState) {
  state.uiState = uiState;
  document.body.dataset.state = uiState;
  micLabelEl.textContent = MIC_LABELS[uiState] || MIC_LABELS.idle;
  micBtn.setAttribute(
    "aria-label",
    uiState === "speaking" ? "Interrupt the assistant" : "Push to talk",
  );
}

function setDot(mode) {
  dotEl.className = `dot ${mode}`; // live=solid · connecting=pulse · dead=hollow
}

function renderTeam() {
  teamBtn.textContent = state.team || "no team";
  teamBtn.disabled = state.teams.length === 0;
}

teamBtn.addEventListener("click", () => {
  if (state.teams.length === 0) return;
  const idx = state.teams.indexOf(state.team);
  const next = state.teams[(idx + 1) % state.teams.length];
  state.team = next;
  localStorage.setItem(TEAM_KEY, next);
  renderTeam();
  sendJson({ type: "team", team: next });
});

// ---------- transcript ----------
const utterances = new Map(); // transcript id → element
const toolChips = new Map(); // tool id → element

function nearBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 48;
}

function autoScroll(wasNear) {
  if (wasNear) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function upsertUtterance(role, f) {
  const wasNear = nearBottom();
  let el = utterances.get(f.id);
  if (!el) {
    el = document.createElement("div");
    el.className = `utt ${role}`;
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = role === "user" ? "❯" : "◆"; // ❯ / ◆
    const body = document.createElement("span");
    body.className = "text";
    el.append(glyph, body);
    transcriptEl.append(el);
    utterances.set(f.id, el);
  }
  el.querySelector(".text").textContent = f.text;
  el.classList.toggle("partial", !f.final);
  autoScroll(wasNear);
}

function upsertToolChip(id, info) {
  const wasNear = nearBottom();
  let el = toolChips.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "chip";
    const icon = document.createElement("span");
    icon.className = "chip-icon";
    const name = document.createElement("span");
    name.className = "chip-name";
    const meta = document.createElement("span");
    meta.className = "chip-meta";
    el.append(icon, name, meta);
    transcriptEl.append(el);
    toolChips.set(id, el);
  }
  const icon = el.querySelector(".chip-icon");
  const meta = el.querySelector(".chip-meta");
  if (info.name) el.querySelector(".chip-name").textContent = info.name;
  el.dataset.phase = info.phase;
  if (info.phase === "running") {
    icon.textContent = "⚙"; // ⚙
    meta.textContent = info.args || "";
  } else {
    icon.textContent = info.phase === "ok" ? "✓" : "✗"; // ✓ / ✗
    const bits = [];
    if (info.summary) bits.push(info.summary);
    bits.push(`${Math.round(info.ms)}ms`);
    if (info.needsConfirmation) bits.push("needs confirm");
    meta.textContent = bits.join(" · ");
    el.classList.toggle("confirm", info.needsConfirmation);
  }
  autoScroll(wasNear);
}

function clearTranscript() {
  transcriptEl.replaceChildren();
  utterances.clear();
  toolChips.clear();
}

// ---------- error strip (non-blocking — NEVER a modal) ----------
function showStrip(message, { sticky = false } = {}) {
  clearTimeout(state.stripTimer);
  stripTextEl.textContent = message;
  stripActionBtn.hidden = true;
  stripEl.hidden = false;
  if (!sticky) state.stripTimer = setTimeout(hideStrip, 6000);
}

function offerStripAction(label, fn) {
  stripActionBtn.textContent = label;
  stripActionBtn.hidden = false;
  stripActionBtn.onclick = fn;
}

function hideStrip() {
  stripEl.hidden = true;
}

$("errstrip-dismiss").addEventListener("click", hideStrip);

// ---------- suspension overlay + wake lock ----------
function showResumeOverlay() {
  resumeOverlay.hidden = false;
}

function hideResumeOverlay() {
  resumeOverlay.hidden = true;
}

resumeOverlay.addEventListener("click", async () => {
  // User gesture — the only context in which resume() is honoured.
  await audio.resume();
  hideResumeOverlay();
});

async function acquireWakeLock() {
  if (!navigator.wakeLock || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    // denied (low battery etc.) — cosmetic, not fatal
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

function checkSuspended() {
  if (audio.isInited() && audio.state() === "suspended") showResumeOverlay();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    // Server parks the provider leg 90 s (D8); hello.resume re-attaches.
    sendJson({ type: "suspend" });
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    return;
  }
  // → visible
  if (state.terminal) return;
  acquireWakeLock();
  checkSuspended();
  const wsUp = state.ws && state.ws.readyState === WebSocket.OPEN;
  if (!wsUp) {
    state.reconnectAttempt = 0;
    connect();
  }
});

// ---------- boot ----------
setUiState("idle");
if (token) {
  connect();
} else {
  setDot("dead");
  showStrip("no token — open the tokened voice link once to pair", { sticky: true });
}
