/* ============================================================
   Contomo - Pomodoro with XP, streaks, ranks & an on-device
   LFM2.5-350M task breaker (WebGPU via transformers.js).

   Classic scripts by design: type="module" local imports are
   CORS-blocked when this app is opened from file://. The CDN
   model import happens lazily at runtime through import(),
   which works fine cross-origin.

   Structure:
     1. utils            6. feedback (audio, fx, toasts)
     2. persistent state 7. tasks UI
     3. gamification math 8. breakdown engine (LFM2.5 + fallback)
     4. theme            9. timer engine
                          10. boot / event wiring
   ============================================================ */
(function () {
  "use strict";

  /* ----------------------------------------------------------
     1. Utils
     ---------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Consulted per-use, not cached: toggling the OS setting mid-session
  // takes effect without a reload.
  const REDUCED_MOTION = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function todayKey(d = new Date()) {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }
  function yesterdayKey() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return todayKey(d);
  }

  /** Monday-anchored local date - the week "changes" at Sunday 23:59,
      i.e. the first moment the calendar shows a new Monday. */
  function weekKey(d = new Date()) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to this week's Monday
    return todayKey(x);
  }

  const ICONS = {
    sparkle:
      '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3 L13.7 9.3 L20 11 L13.7 12.7 L12 19 L10.3 12.7 L4 11 L10.3 9.3 Z" fill="currentColor"/><path d="M18.5 15.5 L19.2 17.8 L21.5 18.5 L19.2 19.2 L18.5 21.5 L17.8 19.2 L15.5 18.5 L17.8 17.8 Z" fill="currentColor"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7 H20 M9 7 V5 h6 v2 M6.5 7 l1 13 h9 l1 -13 M10 11 v6 M14 11 v6"/></svg>',
    grip:
      '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    check:
      '<svg viewBox="0 0 24 24"><path d="M4.5 12.5 L10 18 L19.5 6.5"/></svg>',
    // Same flame path as the HUD streak pill - reused in toasts and
    // friend rows so no emoji ever ships in user-visible text.
    flame:
      '<svg class="flame-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.2 2 C13 5 12.8 8 11.5 10.4 C12.6 9.9 13.6 8.9 14.2 7.4 C15.4 9.2 16.5 11.2 16.5 13.6 A4.7 4.7 0 0 1 7.1 13.6 C7.1 9 11.4 6.4 12.2 2 Z"/></svg>',
    play:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5 L19 12 L8 19 Z"/></svg>',
    x:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>',
  };

  /* ----------------------------------------------------------
     2. Persistent state - encrypted at rest (AES-GCM + HMAC).
        Tamper-RESISTANCE, not security: the key lives beside the
        data by definition. What it buys is that hand-editing
        localStorage no longer works - a bad MAC reseeds instead
        of trusting the payload, and ONLY "c1:" envelopes are
        ever adopted (plaintext in the slot is treated as
        tampering, never as a legacy save).
     ---------------------------------------------------------- */
  const LS_KEY = "chrono.v1";
  const KEY_KEY = "contomo.k";
  const STATE_VERSION = 2;

  function defaultState() {
    return {
      v: STATE_VERSION,
      xp: 0,
      bestLevel: 1,
      streak: { current: 0, best: 0, lastDay: null },
      daily: { date: todayKey(), count: 0, bonusGiven: false, minutes: 0 },
      week: { lastKey: weekKey(), rank: "bronze", minutes: 0, defended: false },
      profile: { name: "", code: "" },
      friends: {},
      completedWorkTotal: 0,
      cycleCount: 0,
      activeTaskId: null,
      timerLive: null,
      tasks: [],
      settings: { work: 25, short: 5, long: 15, theme: "system" },
    };
  }

  /* ---- storage crypto: one random seed, two derived keys ---- */
  const te = new TextEncoder();
  const td = new TextDecoder();
  const toHex = (buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const concatBytes = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  let keysPromise = null;
  /** Resolves to { aes, mac } via HKDF from the per-install seed, or
      null when crypto.subtle is unavailable (obfuscated fallback). */
  function storageKeys() {
    if (keysPromise) return keysPromise;
    keysPromise = (async () => {
      let seedHex = null;
      try { seedHex = localStorage.getItem(KEY_KEY); } catch {}
      if (!seedHex || !/^[0-9a-f]{64}$/.test(seedHex)) {
        seedHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
        try { localStorage.setItem(KEY_KEY, seedHex); } catch {}
      }
      if (!crypto.subtle) return { seed: seedHex };
      const seed = Uint8Array.from(seedHex.match(/../g), (h) => parseInt(h, 16));
      const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
      const derive = (info) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: te.encode("contomo-store"), info: te.encode(info) },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
      const aes = await derive("contomo/aes-v1");
      const mac = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: te.encode("contomo-store"), info: te.encode("contomo/hmac-v1") },
        base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]
      );
      return { aes, mac };
    })();
    keysPromise.catch(() => { keysPromise = null; });
    return keysPromise;
  }

  /* No-subtle fallback: XOR keystream + checksum, same envelope shape.
     Obscurity, not crypto - only reached on engines without WebCrypto. */
  function xorKeystream(seedHex, iv, n) {
    const out = new Uint8Array(n);
    let h = 0x811c9dc5;
    for (let i = 0; i < seedHex.length; i++) h = Math.imul(h ^ seedHex.charCodeAt(i), 16777619) >>> 0;
    for (let i = 0; i < iv.length; i++) h = Math.imul(h ^ iv[i], 16777619) >>> 0;
    for (let i = 0; i < n; i++) {
      h = Math.imul(h ^ (i + 1), 16777619) + 0x9e3779b9 >>> 0;
      h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
      out[i] = h & 0xff;
    }
    return out;
  }
  const fnv1a = (bytes) => {
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
    return h.toString(16);
  };
  function xorEnvelope(json, iv, seedHex) {
    const data = te.encode(json);
    const ks = xorKeystream(seedHex, iv, data.length);
    const ct = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) ct[i] = data[i] ^ ks[i];
    const all = concatBytes(iv, ct);
    return JSON.stringify({ fmt: "x1", iv: b64(iv), ct: b64(ct), mac: fnv1a(all) });
  }
  function xorUnseal(env) {
    const iv = unb64(env.iv), ct = unb64(env.ct);
    if (fnv1a(concatBytes(iv, ct)) !== env.mac) throw new Error("checksum mismatch");
    const seedHex = (storageKeyCache && storageKeyCache.seed) || "";
    const ks = xorKeystream(seedHex, iv, ct.length);
    const out = new Uint8Array(ct.length);
    for (let i = 0; i < ct.length; i++) out[i] = ct[i] ^ ks[i];
    return td.decode(out);
  }
  let storageKeyCache = null;

  const ENV_PREFIX = "c1:"; // marks an envelope; '{' alone is legacy plaintext
  async function encryptState(json) {
    const keys = await storageKeys();
    storageKeyCache = keys;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    if (!keys.aes) return ENV_PREFIX + xorEnvelope(json, iv, keys.seed);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, te.encode(json)));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, concatBytes(iv, ct)));
    return ENV_PREFIX + JSON.stringify({ fmt: 2, iv: b64(iv), ct: b64(ct), mac: b64(mac) });
  }

  async function decryptState(raw) {
    if (raw.startsWith(ENV_PREFIX)) raw = raw.slice(ENV_PREFIX.length);
    const env = JSON.parse(raw);
    if (!env || typeof env !== "object" || !env.ct) throw new Error("bad envelope");
    const keys = await storageKeys();
    storageKeyCache = keys;
    if (env.fmt === "x1" || !keys.aes) {
      const plain = xorUnseal(env);
      if (env.fmt === "x1") return plain;
      throw new Error("format mismatch"); // never decrypt an AES envelope without AES
    }
    const iv = unb64(env.iv), ct = unb64(env.ct);
    const ok = await crypto.subtle.verify("HMAC", keys.mac, unb64(env.mac), concatBytes(iv, ct));
    if (!ok) throw new Error("mac mismatch");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keys.aes, ct);
    return td.decode(pt);
  }

  let S = defaultState();

  const POISON_KEYS = ["__proto__", "constructor", "prototype"];
  /** Recursively drop structural keys from a parsed save. JSON.parse
      materializes "__proto__" as a plain own property, and Object.assign
      replays own keys with [[Set]] - i.e. a prototype swap on the state
      object. A legit save never contains these keys. */
  function scrubProto(obj) {
    for (const k of Object.keys(obj)) {
      if (POISON_KEYS.includes(k)) { delete obj[k]; continue; }
      const v = obj[k];
      if (v && typeof v === "object") scrubProto(v);
    }
    return obj;
  }

  /** hydrate() is the only place untrusted bytes become state, so this is
      the choke point for shape: every field is coerced to its real type and
      range before anything reads it. Anything that later reaches innerHTML
      (streak counts, task fields, friend rows) leaves this function a number
      or a bounded string - a saved "<img onerror=...>" can never ride a
      number-shaped field into markup, and junk deep in a tampered save
      can't wedge a render or poison the math. */
  function sanitizeState() {
    const fresh = defaultState();

    S.xp = clamp(Math.round(Number(S.xp) || 0), 0, XP_CAP);
    S.bestLevel = clamp(Math.round(Number(S.bestLevel) || 1), 1, 100);
    S.v = STATE_VERSION;
    S.completedWorkTotal = clamp(Math.round(Number(S.completedWorkTotal) || 0), 0, 1e6);
    S.cycleCount = clamp(Math.round(Number(S.cycleCount) || 0), 0, 1e6);
    S.activeTaskId = typeof S.activeTaskId === "string" ? S.activeTaskId.slice(0, 64) : null;

    if (!S.streak || typeof S.streak !== "object") S.streak = fresh.streak;
    S.streak = {
      current: clamp(Math.round(Number(S.streak.current) || 0), 0, 9999),
      best: clamp(Math.round(Number(S.streak.best) || 0), 0, 9999),
      // A malformed day key must never match todayKey/yesterdayKey.
      lastDay: /^\d{4}-\d{2}-\d{2}$/.test(S.streak.lastDay) ? S.streak.lastDay : null,
    };

    if (!S.daily || typeof S.daily !== "object") S.daily = fresh.daily;
    S.daily = {
      // "" fails the rollover check below, so a garbage date resets the day.
      date: /^\d{4}-\d{2}-\d{2}$/.test(S.daily.date) ? S.daily.date : "",
      count: clamp(Math.round(Number(S.daily.count) || 0), 0, 999),
      bonusGiven: !!S.daily.bonusGiven,
      minutes: clamp(Math.round(Number(S.daily.minutes) || 0), 0, 1440),
      bonusXP: clamp(Math.round(Number(S.daily.bonusXP) || DAILY_GOAL_BONUS_XP), 1, 1e5),
    };

    if (!S.week || typeof S.week !== "object") S.week = fresh.week;
    S.week = {
      lastKey: /^\d{4}-\d{2}-\d{2}$/.test(S.week.lastKey) ? S.week.lastKey : "",
      // Only real rank keys may build a "rk-*" class or drive resetTargetXP.
      rank: RANKS.some((r) => r.key === S.week.rank) ? S.week.rank : "bronze",
      minutes: clamp(Math.round(Number(S.week.minutes) || 0), 0, 10080),
      defended: !!S.week.defended,
    };

    if (!S.profile || typeof S.profile !== "object") S.profile = fresh.profile;
    S.profile = {
      name: String(S.profile.name || "").slice(0, 24),
      code: /^\d{8}$/.test(S.profile.code) ? S.profile.code : "",
    };

    // Friend keys become "data-code" attributes, so only 8-digit codes
    // survive; every profile field is re-typed with the same clamps
    // handleFriendMsg applies to live P2P traffic.
    const friends = {};
    if (S.friends && typeof S.friends === "object" && !Array.isArray(S.friends)) {
      for (const [code, f] of Object.entries(S.friends)) {
        if (!/^\d{8}$/.test(code) || !f || typeof f !== "object") continue;
        const lvl = clamp(Math.round(Number(f.level) || 1), 1, 100);
        friends[code] = {
          name: String(f.name || "Player").slice(0, 24),
          xp: clamp(Math.round(Number(f.xp) || 0), 0, 10000000),
          level: lvl,
          rank: RANKS.some((r) => r.key === f.rank) ? f.rank : rankForLevel(lvl).key,
          streak: clamp(Math.round(Number(f.streak) || 0), 0, 9999),
          weekMinutes: clamp(Math.round(Number(f.weekMinutes) || 0), 0, 10080),
          lastSeen: clamp(Math.round(Number(f.lastSeen) || 0), 0, Date.now() + 60000),
          lastTs: clamp(Math.round(Number(f.lastTs) || 0), 0, Date.now() + 60000),
        };
      }
    }
    S.friends = friends;

    if (S.timerLive && typeof S.timerLive === "object") {
      const tl = S.timerLive;
      S.timerLive = {
        mode: ["work", "short", "long"].includes(tl.mode) ? tl.mode : "work",
        running: !!tl.running,
        left: clamp(Math.round(Number(tl.left) || 0), 0, 7200),
        total: clamp(Math.round(Number(tl.total) || 1500), 60, 7200),
      };
    } else {
      S.timerLive = null;
    }

    // Session lengths: the input handler clamps edits, but a state written
    // by an older build (or a mangled field) must not reach durationFor raw.
    if (!S.settings || typeof S.settings !== "object") S.settings = fresh.settings;
    ["work", "short", "long"].forEach((k) => {
      const v = Number(S.settings[k]);
      S.settings[k] = clamp(Number.isFinite(v) ? Math.round(v) : 25, k === "short" ? 1 : 5, 120);
    });
    if (!["system", "light", "dark"].includes(S.settings.theme)) S.settings.theme = "system";

    // Tasks: the same ceilings the input handlers enforce, applied to
    // whatever the save carried. Junk entries are dropped, not crashed on.
    const tasks = Array.isArray(S.tasks) ? S.tasks : [];
    const clean = [];
    for (const t of tasks.slice(0, TASKS_CAP)) {
      if (!t || typeof t !== "object") continue;
      const title = String(t.title || "").slice(0, TASK_TITLE_MAX).trim();
      if (!title) continue;
      clean.push({
        id: typeof t.id === "string" && t.id ? t.id.slice(0, 64) : uid(),
        title,
        tags: (Array.isArray(t.tags) ? t.tags : [])
          .map((x) => String(x).toLowerCase().slice(0, TAG_MAX))
          .filter(Boolean)
          .slice(0, 4),
        estimateMin: clamp(Math.round(Number(t.estimateMin) || 0), 0, 1440),
        done: !!t.done,
        // Pre-anti-farm tasks are treated as already paid out, so upgrading
        // can't mint a refund farm out of previously-completed work.
        awardedDone: typeof t.awardedDone === "boolean" ? t.awardedDone : !!t.done,
        subtasks: (Array.isArray(t.subtasks) ? t.subtasks : [])
          .slice(0, 24)
          .map((st) => ({
            title: String((st && st.title) || "").slice(0, 80),
            done: !!(st && st.done),
          }))
          .filter((st) => st.title),
        source: typeof t.source === "string" ? t.source.slice(0, 80) : null,
      });
    }
    S.tasks = clean;
  }

  /** Load + adopt state + weekly rollover, all before the UI paints.
      init() awaits this; every render reads hydrated state. */
  async function hydrate() {
    let loaded = null;
    let corrupted = false;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        // Only our own "c1:" envelopes are ever trusted. The old build
        // adopted any value starting with '{' as legacy plaintext, which
        // voided the MAC entirely: hand-writing {"xp":999999} into the key
        // was adopted, trusted, and re-encrypted on the next save. decryptState
        // returns an already-decoded string; decoding it again would throw
        // and strand every legitimate load in the catch below.
        loaded = JSON.parse(await decryptState(raw));
      }
    } catch {
      corrupted = true; // bad MAC / bad cipher / bad JSON: never trust it
      loaded = null;
    }

    if (loaded && typeof loaded === "object") scrubProto(loaded);

    if (loaded && typeof loaded === "object" && typeof loaded.xp === "number") {
      const wasV1 = loaded.v === 1;
      S = Object.assign(defaultState(), loaded);
      if (wasV1 && typeof S.xp === "number") S.xp = migrateXP(S.xp);
    } else {
      // Parsed but isn't app state (e.g. a stale prefix-less envelope):
      // treat exactly like tampering.
      if (loaded) corrupted = true;
      S = defaultState();
    }

    // Every field is now coerced to type and range - a tampered or mangled
    // save lands as a fully-typed state or as defaults, never half-raw.
    sanitizeState();

    // Daily rollover (checked after sanitize, so a garbage date resets it).
    if (S.daily.date !== todayKey()) {
      S.daily = { date: todayKey(), count: 0, bonusGiven: false, minutes: 0, bonusXP: DAILY_GOAL_BONUS_XP };
    }

    checkWeeklyReset();
    save(); // re-encrypt whatever shape we ended with
    if (corrupted) {
      toast("Stored progress was tampered with or unreadable, so it was reset.", "info", 6000);
    }
  }

  let saveSeq = 0;
  let writeChain = Promise.resolve();
  /** Fire-and-forget encrypted write. The snapshot is taken synchronously
      so callers keep today's semantics; writes serialize and the newest
      snapshot wins. */
  function save() {
    const seq = ++saveSeq;
    const snap = JSON.stringify(S);
    writeChain = writeChain.then(() => store(snap, seq)).catch(() => {});
    return writeChain;
  }

  let storeWarned = false;
  async function store(json, seq) {
    if (seq !== saveSeq) return; // superseded by a newer save
    try {
      localStorage.setItem(LS_KEY, await encryptState(json));
    } catch {
      // file:// in some browsers denies storage; a full quota fails too.
      // Either way the app keeps running memory-only - say so once.
      if (!storeWarned) {
        storeWarned = true;
        toast(
          "Progress can't be saved (storage full or blocked) - the app works, but a refresh loses this session.",
          "info", 6000
        );
      }
    }
  }

  /* ----------------------------------------------------------
     3. Gamification math (pure)
     ---------------------------------------------------------- */
  const RANKS = window.ChronoBadges.RANKS;
  const { rankForLevel, badgeSVG } = window.ChronoBadges;

  /** Cumulative XP needed to *be* at `level`. The band between levels
      grows linearly (16L+42), so climbing stays achievable at every
      rank instead of squaring away into the tens of thousands. */
  const XP_CAP = 83358; // xpForLevel(100)
  function xpForLevel(level) {
    const n = clamp(level, 1, 100) - 1;
    return 8 * n * n + 50 * n;
  }

  /** The retired v1 curve - kept only to migrate old saves. */
  function legacyXpForLevel(level) {
    return Math.ceil(Math.pow(level - 1, 2) * 25);
  }

  /** v1 → v2: recompute the level from the old curve, then place the
      player at the same within-level fraction of the new curve. */
  function migrateXP(oldXP) {
    let lvl = 1;
    while (lvl < 100 && oldXP >= legacyXpForLevel(lvl + 1)) lvl++;
    const lo = legacyXpForLevel(lvl);
    const hi = legacyXpForLevel(Math.min(100, lvl + 1));
    const f = hi > lo ? clamp((oldXP - lo) / (hi - lo), 0, 1) : 1;
    return Math.min(
      XP_CAP,
      Math.round(xpForLevel(lvl) + f * (xpForLevel(lvl + 1) - xpForLevel(lvl)))
    );
  }

  function levelFromXP(xp) {
    let lvl = 1;
    while (lvl < 100 && xp >= xpForLevel(lvl + 1)) lvl++;
    return lvl;
  }

  function streakMultiplier(streak) {
    if (streak >= 7) return 2;
    if (streak >= 3) return 1.5;
    if (streak >= 1) return 1.2;
    return 1;
  }

  /** Difficulty buckets derived from a task's own estimate. */
  function difficultyFactor(task) {
    const m = task ? Number(task.estimateMin) || 0 : 0;
    if (!m) return 1;
    if (m <= 30) return 1.25;
    if (m <= 75) return 1.5;
    return 1.8;
  }

  /** Higher ranks pay more per task, so climbing stays viable while
      the ladder keeps getting longer. Read from S.xp BEFORE the award
      lands: the work pays at the rank it was done in. */
  const RANK_XP_MULT = { bronze: 1, silver: 1.15, gold: 1.35, diamond: 1.65, mythic: 2.05, master: 2.6 };
  function rankMult() {
    return RANK_XP_MULT[rankForLevel(levelFromXP(S.xp)).key] ?? 1;
  }
  function scaleXP(n) {
    return Math.max(1, Math.round(n * rankMult()));
  }

  /** Base XP = session minutes; breaks pay 40%. Work scales with
      streak multiplier × task difficulty, all lifted by the rank
      multiplier. */
  function xpForSession(mode, minutes, task) {
    const base = mode === "work" ? minutes : Math.round(minutes * 0.4);
    const mult = mode === "work"
      ? streakMultiplier(S.streak.current) * difficultyFactor(task)
      : 1;
    return scaleXP(Math.max(1, Math.round(base * mult)));
  }

  const TASK_BONUS_XP = 25;
  const TASK_BONUS_XP_MAX = 150;
  /** Completion bonus scales with the task's own estimate, so a big
      commitment pays meaningfully more than a small one. Unestimated
      tasks pay the flat base. */
  function taskCompletionXP(task) {
    const m = Number(task?.estimateMin) || 0;
    return m
      ? scaleXP(clamp(Math.round(m * 0.8), TASK_BONUS_XP, TASK_BONUS_XP_MAX))
      : scaleXP(TASK_BONUS_XP);
  }
  const DAILY_GOAL_BONUS_XP = 75;

  /* ----------------------------------------------------------
     4. Theme - "system | light | dark", resolved for icons
        onto data-effective so CSS needs no duplicate blocks.
     ---------------------------------------------------------- */
  const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");

  function effectiveTheme() {
    const pref = S.settings.theme;
    if (pref === "light" || pref === "dark") return pref;
    return mediaDark.matches ? "dark" : "light";
  }

  function applyTheme() {
    const eff = effectiveTheme();
    document.documentElement.dataset.theme = S.settings.theme === "system"
      ? (mediaDark.matches ? "dark" : "light")
      : S.settings.theme;
    document.documentElement.dataset.effective = eff;
  }

  function cycleTheme() {
    const order = ["system", "light", "dark"];
    const cur = S.settings.theme;
    S.settings.theme = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme();
    save();
    toast(`Theme: ${S.settings.theme}`, "info");
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen()
        .catch(() => toast("Fullscreen was blocked by the browser.", "info"));
    }
  }
  mediaDark.addEventListener("change", () => {
    applyTheme(); // live-follow system changes
  });

  /* ----------------------------------------------------------
     5a. Audio - tiny WebAudio synth, zero assets.
     ---------------------------------------------------------- */
  let AC = null;
  function ac() {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === "suspended") AC.resume();
    return AC;
  }

  function tone(freq, t0, dur, { type = "sine", gain = 0.08, slideTo = null } = {}) {
    const ctx = ac();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + t0 + dur);
    g.gain.setValueAtTime(0, ctx.currentTime + t0);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(ctx.currentTime + t0);
    osc.stop(ctx.currentTime + t0 + dur + 0.05);
  }

  const Sound = {
    click() { tone(1750, 0, 0.05, { type: "triangle", gain: 0.05 }); },
    workEnd() {
      tone(659.25, 0, 0.16);              // E5
      tone(880.0, 0.14, 0.16);            // A5
      tone(1174.66, 0.28, 0.34);          // D6 - resolve upward: achievement
    },
    breakEnd() {
      tone(587.33, 0, 0.18);              // D5 soft, invites refocus
      tone(440.0, 0.16, 0.26, { gain: 0.06 });
    },
    taskDone() {
      tone(523.25, 0, 0.09, { type: "triangle" });
      tone(783.99, 0.07, 0.14, { type: "triangle" });
    },
    levelUp() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.22));
      tone(1567.98, 0.38, 0.4, { gain: 0.07 }); // C6 sparkle on top
    },
    error() { tone(196, 0, 0.18, { type: "sawtooth", gain: 0.05 }); },
  };

  // Tactile click on every button interaction.
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) Sound.click();
  }, { capture: true });

  /* ----------------------------------------------------------
     5b. Feedback layer - particles, XP fly-ups, level overlay
     ---------------------------------------------------------- */
  const fxLayer = document.createElement("div");
  fxLayer.className = "fx-layer";
  document.body.appendChild(fxLayer);

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** XP chip flies from the award site into the HUD XP vault,
      then the vault pill bounces - the Duolingo "bank it" moment. */
  function flyXP(text, x, y) {
    const pill = $("#pill-xp");
    if (REDUCED_MOTION() || !pill) return;
    const target = centerOf(pill);

    const el = document.createElement("div");
    el.className = "xp-fly";
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    fxLayer.appendChild(el);

    const dx = target.x - x;
    const dy = target.y - y - 6;
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
        { transform: "translate(-50%,-50%) translateY(-26px) scale(1.12)", opacity: 1, offset: 0.25 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.45)`, opacity: 0.9, offset: 0.9 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2)`, opacity: 0 },
      ],
      { duration: 950, easing: "cubic-bezier(.45,.05,.55,.95)" }
    ).onfinish = () => {
      el.remove();
      pill.classList.remove("bump");
      void pill.offsetWidth;
      pill.classList.add("bump");
    };
  }

  const PARTICLE_COLORS = ["#6D8196", "#d9a94a", "#7e9c6b", "#c0684b", "#4A4A4A"];

  function burst(x, y, n = 14) {
    if (REDUCED_MOTION()) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("div");
      p.className = "particle";
      p.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      fxLayer.appendChild(p);

      const angle = Math.random() * Math.PI * 2;
      const dist = 46 + Math.random() * 70;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 26;
      p.animate(
        [
          { transform: "translate(-50%,-50%) scale(1) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.35) rotate(${angle > Math.PI ? -180 : 180}deg)`,
            opacity: 0,
          },
        ],
        { duration: 520 + Math.random() * 320, easing: "cubic-bezier(.2,.7,.4,1)" }
      ).onfinish = () => p.remove();
    }
  }

  /* ---- canvas confetti - full-screen celebrations ---- */
  const Confetti = (() => {
    const canvas = document.createElement("canvas");
    canvas.className = "confetti-canvas";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let parts = [];
    let raf = null;

    function fit() {
      canvas.width = innerWidth * devicePixelRatio;
      canvas.height = innerHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }
    addEventListener("resize", fit);
    fit();

    function frame() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 40);
      for (const p of parts) {
        p.vy += 0.16;               // gravity
        p.vx *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life / 40);
        ctx.fillStyle = p.color;
        if (p.shape === "circle") {
          ctx.beginPath();
          ctx.arc(0, 0, p.s / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62);
        }
        ctx.restore();
      }
      if (parts.length) raf = requestAnimationFrame(frame);
      else { raf = null; ctx.clearRect(0, 0, innerWidth, innerHeight); }
    }

    function spawn(x, y, n, spread) {
      if (REDUCED_MOTION()) return;
      for (let i = 0; i < n; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
        const speed = 7 + Math.random() * 9;
        parts.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          s: 7 + Math.random() * 7,
          color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
          shape: Math.random() < 0.35 ? "circle" : "rect",
          life: 130 + Math.random() * 60,
        });
      }
      if (!raf) raf = requestAnimationFrame(frame);
    }

    return {
      /** Cannon burst from a point. */
      burst(x, y, n = 70) { spawn(x, y, n, Math.PI * 0.9); },
      /** Celebration rain across the top of the viewport. */
      rain(n = 120) {
        if (REDUCED_MOTION()) return;
        for (let i = 0; i < n; i++) {
          parts.push({
            x: Math.random() * innerWidth,
            y: -20 - Math.random() * innerHeight * 0.4,
            vx: (Math.random() - 0.5) * 2.4,
            vy: 2 + Math.random() * 3.2,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.24,
            s: 7 + Math.random() * 7,
            color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
            shape: Math.random() < 0.35 ? "circle" : "rect",
            life: 240 + Math.random() * 80,
          });
        }
        if (!raf) raf = requestAnimationFrame(frame);
      },
    };
  })();

  function showLevelOverlay(fromLevel, toLevel) {
    const rank = rankForLevel(toLevel);
    const ov = document.createElement("div");
    ov.className = "level-overlay";
    ov.innerHTML = `
      <div class="level-card">
        <div class="level-banner">Level up</div>
        <div class="level-stage">
          <div class="badge-big rk-${rank.key}">${badgeSVG(rank.key)}</div>
          <div class="level-figures">
            <div class="level-value">${toLevel}</div>
            <div class="level-from">from level ${fromLevel}</div>
            <div class="level-rank rk-${rank.key}">${rank.name}</div>
          </div>
        </div>
        <div class="level-hint">click anywhere to continue</div>
      </div>`;
    const close = () => {
      ov.classList.add("closing");
      setTimeout(() => ov.remove(), 220);
    };
    ov.addEventListener("click", close);
    document.body.appendChild(ov);
    Sound.levelUp();
    Confetti.rain(150);
    setTimeout(() => Confetti.rain(90), 450);
    announce(`Level up! From level ${fromLevel} to ${toLevel}. Rank ${rank.name}.`);
  }

  function announce(msg) {
    const live = $("#model-status");
    if (live) live.textContent = msg;
  }

  /* ----------------------------------------------------------
     5c. Toasts
     ---------------------------------------------------------- */
  const toastStack = $("#toast-stack");

  function toast(html, type = "info", ms = 3400) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = html;
    toastStack.appendChild(el);
    announce(el.textContent.trim());
    setTimeout(() => {
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, ms);
  }

  /* ----------------------------------------------------------
     6. Timer engine - timestamp-driven so background-tab
        throttling never loses time. Face is the ink ring: the
        stroke fills with ink as elapsed focus accumulates, and
        60 inner dots tick around like fine watch markings.
     ---------------------------------------------------------- */
  const ringFg = $("#ring-fg");
  const ringDots = $("#ring-dots");
  const TICK_COUNT = 60;
  const RING_C = 2 * Math.PI * 80;   // matches stroke-dasharray in CSS

  function buildRingDots() {
    const ns = "http://www.w3.org/2000/svg";
    for (let i = 0; i < TICK_COUNT; i++) {
      const dot = document.createElementNS(ns, "circle");
      const angle = (i / TICK_COUNT) * Math.PI * 2 - Math.PI / 2;
      const rr = 63;
      dot.setAttribute("cx", (100 + rr * Math.cos(angle)).toFixed(2));
      dot.setAttribute("cy", (100 + rr * Math.sin(angle)).toFixed(2));
      dot.setAttribute("r", i % 5 === 0 ? 2 : 1.3);
      ringDots.appendChild(dot);
    }
  }

  /** Ink fills the ring: offset shrinks as the session is earned.
      Dots go "spent" clockwise alongside it. */
  function renderRing(secondsShown) {
    const elapsedFrac = clamp((T.total - secondsShown) / Math.max(1, T.total), 0, 1);
    ringFg.style.strokeDashoffset = String(RING_C * (1 - elapsedFrac));
    // A zero-length dash still paints its round cap - hide the stroke
    // entirely until the first sliver of focus is earned.
    ringFg.style.opacity = elapsedFrac > 0 ? "1" : "0";
    const spentCount = Math.floor(elapsedFrac * TICK_COUNT);
    const dots = ringDots.children;
    for (let i = 0; i < TICK_COUNT; i++) {
      dots[i].classList.toggle("spent", i < spentCount);
    }
  }

  const T = {
    mode: "work",            // work | short | long
    total: S.settings.work * 60,
    left: S.settings.work * 60,
    running: false,
    endAt: 0,
    ticker: null,
    tickCount: 0,
  };

  const MODE_LABEL = { work: "Focus", short: "Short break", long: "Long break" };
  const MODE_TITLE = { work: "Focus block", short: "Short break", long: "Long break" };
  const cdMins = $("#cd-mins");
  const cdSecs = $("#cd-secs");
  const modeLabelEl = $("#mode-label");
  const liveDotEl = $("#live-dot");
  const bodyEl = document.body;

  function durationFor(mode) {
    const key = mode === "work" ? "work" : mode;
    return (S.settings[key] || 25) * 60;
  }

  function setMode(mode, { autostart = false } = {}) {
    T.mode = mode;
    T.total = durationFor(mode);
    T.left = T.total;
    stopTicker();
    T.running = false;
    updateModeUI();
    renderTime();
    persistTimer();
    if (autostart) start();
  }

  function stopTicker() {
    if (T.ticker) { clearInterval(T.ticker); T.ticker = null; }
  }

  /** Snapshot the live timer so a refresh (or tomorrow) resumes it.
      endAt is performance-relative, so we persist the remaining
      seconds and rebuild endAt on the other side. */
  function persistTimer() {
    S.timerLive = {
      mode: T.mode,
      running: T.running,
      left: T.running
        ? Math.max(0, Math.ceil((T.endAt - performance.now()) / 1000))
        : Math.ceil(T.left),
      total: T.total,
    };
    save();
  }

  // Losing a 24-minute run to an accidental refresh is unforgivable,
  // so the snapshot also re-writes every few seconds while running.
  addEventListener("pagehide", () => { if (T.running) persistTimer(); });

  function start() {
    if (T.left <= 0) return;
    T.endAt = performance.now() + T.left * 1000;
    T.running = true;
    T.ticker = setInterval(tick, 200);
    bodyEl.classList.add("running");
    renderControls();
    persistTimer();
    tick();
  }

  function pause() {
    if (!T.running) return;
    T.left = Math.max(0, Math.ceil((T.endAt - performance.now()) / 1000));
    stopTicker();
    T.running = false;
    bodyEl.classList.remove("running");
    renderControls();
    persistTimer();
  }

  function toggle() {
    if (T.running) pause();
    else start();
    renderControls();
  }

  function reset() {
    setMode(T.mode);
  }

  function tick() {
    const remainingMs = T.endAt - performance.now();
    if (remainingMs <= 0) {
      renderTime(0);
      completeSession();
      return;
    }
    renderTime(Math.ceil(remainingMs / 1000));
    // periodic snapshot while running (every ~2s) so refreshes
    // never rewind the clock by more than a heartbeat
    if (++T.tickCount % 10 === 0) persistTimer();
  }

  /** Split display: minutes stay still, seconds flip each tick. */
  function renderTime(secondsOverride) {
    const shown = T.running
      ? (secondsOverride !== undefined
          ? secondsOverride
          : Math.max(0, Math.ceil((T.endAt - performance.now()) / 1000)))
      : Math.ceil(T.left);

    const m = Math.floor(shown / 60);
    const s = shown % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");

    if (cdMins.textContent !== mm) cdMins.textContent = mm;
    if (cdSecs.textContent !== ss) cdSecs.textContent = ss;

    renderRing(shown);
    liveDotEl.textContent = T.running ? "RUNNING" : "STANDBY";

    document.title = T.running ? `${mm}:${ss} · ${MODE_TITLE[T.mode]} · Contomo` : "Contomo";
  }

  function renderControls() {
    const btn = $("#btn-start");
    btn.textContent = T.running ? "Pause" : (T.left < T.total ? "Resume" : "Start");
    btn.classList.toggle("breathe", !T.running);
  }

  function updateModeUI() {
    $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === T.mode));
    modeLabelEl.textContent = MODE_LABEL[T.mode];
    $("#session-title").textContent = MODE_TITLE[T.mode];
    bodyEl.dataset.mode = T.mode;        // state-coded CSS: tape, labels, ticks
    bodyEl.classList.toggle("running", T.running);
    renderControls();

    // cycle dots: filled for completed work sessions in this set of four.
    // The 4th session makes cycleCount % 4 wrap to 0 - show the set as
    // complete (4 filled) rather than emptying the dots at the finish line.
    const inSet = S.cycleCount % 4;
    const filled = inSet === 0 && S.cycleCount > 0 ? 4 : inSet;
    const dotsEl = $("#cycle-dots");
    dotsEl.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("span");
      d.className = "cycle-dot" +
        (i < filled ? " filled" : "") +
        (i === inSet && inSet < 4 ? " current" : "");
      dotsEl.appendChild(d);
    }
  }

  /* ----------------------------------------------------------
     7. Awarding XP & advancing state on session completion.
        Work completion is also what feeds streaks and goals.
     ---------------------------------------------------------- */
  function activeTask() {
    return S.tasks.find((t) => t.id === S.activeTaskId && !t.done) || null;
  }

  function creditStreakAndDaily() {
    const tk = todayKey();
    let leveledStreakNote = "";
    let streakLeveled = false;

    if (S.streak.lastDay !== tk) {
      S.streak.current = S.streak.lastDay === yesterdayKey() ? S.streak.current + 1 : 1;
      S.streak.best = Math.max(S.streak.best, S.streak.current);
      S.streak.lastDay = tk;
      streakLeveled = true;
      leveledStreakNote = S.streak.current > 1 ? ` · ${S.streak.current}-day streak` : "";
    }

    S.daily.count += 1;
    S.completedWorkTotal += 1;

    let bonusToast = "";
    let questJustCompleted = false;
    if (!S.daily.bonusGiven && S.daily.count >= dailyGoal()) {
      S.daily.bonusGiven = true;
      questJustCompleted = true;
      const questXP = scaleXP(DAILY_GOAL_BONUS_XP);
      const banked = awardXP(questXP, null); // no coordinates → no fly-up
      S.daily.bonusXP = banked;              // record what was actually banked
      bonusToast = banked > 0 ? ` Daily quest hit! +${banked} XP` : " Daily quest hit!";
    }
    save();
    return { streakNote: leveledStreakNote, bonusToast, streakLeveled, questJustCompleted };
  }

  function completeSession() {
    stopTicker();
    T.running = false;
    // Rollover FIRST: a session finishing just after Sunday 23:59 belongs
    // to the new week. If the reset ran at the bottom of this function it
    // would clip the XP just earned and erase it from the weekly minutes.
    checkWeeklyReset();
    const wasWork = T.mode === "work";
    // The focus length must be captured before any setMode() below - the
    // auto-switch replaces T.total with the BREAK length, and reading it
    // after the switch credits the break to the week instead of the focus.
    const focusMinutes = Math.round(T.total / 60);

    let gained = 0;
    let notes = "";
    let info = null;

    if (wasWork) {
      const task = activeTask();
      // Streak credit lands BEFORE the session is priced, so the session
      // that completes a streak is paid at the multiplier the streak toast
      // announces - day 7 pays ×2, not the day-6 ×1.5.
      info = creditStreakAndDaily();
      gained = xpForSession("work", focusMinutes, task);
      notes = info.streakNote + info.bonusToast;
      S.cycleCount += 1;
      S.daily.minutes += focusMinutes;
    } else {
      gained = xpForSession(T.mode, Math.round(T.total / 60), null);
    }

    const ringCenter = centerOf($(".ring-wrap"));
    const banked = awardXP(gained, wasWork ? ringCenter : null);
    save();

    if (wasWork) {
      Sound.workEnd();
      Confetti.burst(ringCenter.x, ringCenter.y, 80);
      toast(
        banked > 0
          ? `<strong>+${banked} XP</strong> · ${MODE_LABEL.work} complete${notes}`
          : `${MODE_LABEL.work} complete${notes} · XP vault is at its cap`,
        "success"
      );
      if (info?.streakLeveled) {
        setTimeout(() => toast(`${ICONS.flame} ${S.streak.current}-day streak! XP multiplier is now ×${streakMultiplier(S.streak.current)}.`, "rankup", 4200), 700);
      }
      if (info?.questJustCompleted) {
        setTimeout(() => {
          Confetti.burst(innerWidth * 0.72, innerHeight * 0.4, 70);
          toast(`Daily quest complete, <strong>+${S.daily.bonusXP ?? DAILY_GOAL_BONUS_XP} XP</strong> claimed!`, "success", 4200);
        }, 900);
      }
      if (S.cycleCount % 4 === 0) setMode("long"); else setMode("short");
    } else {
      Sound.breakEnd();
      toast(`Break over. Ready to focus? <strong>+${gained} XP</strong>`, "info");
      setMode("work");
    }
    if (wasWork && S.week) {
      S.week.minutes = (S.week.minutes || 0) + focusMinutes;
    }
    renderAllStats();
    broadcastProfile(); // live friends see the new numbers right away
  }

  /** Single choke point for XP changes: updates bar, detects
      level/rank crossings, plays their moments. Career-first levels
      get the full overlay; levels re-crossed after a Monday reset
      stay quiet - the ladder already celebrated them once. */
  function awardXP(amount, coords) {
    const before = levelFromXP(S.xp);
    const beforeRank = rankForLevel(before).key;
    const careerHigh = Math.max(1, Number(S.bestLevel) || 1);
    const defIdxBefore = rankIndexOf(S.week?.rank || "bronze");
    // Level 100 is the top of the ladder - bank the cap, never past it.
    // Callers print what was ACTUALLY banked, not what was requested.
    const applied = Math.max(0, Math.min(amount, XP_CAP - S.xp));
    S.xp = Math.min(XP_CAP, S.xp + amount);

    const after = levelFromXP(S.xp);
    const afterRankObj = rankForLevel(after);
    const afterRankIdx = rankIndexOf(afterRankObj.key);

    // The weekly ladder tracks the highest rank held this week.
    if (afterRankIdx > defIdxBefore) S.week.rank = afterRankObj.key;
    else if (
      afterRankIdx === defIdxBefore && defIdxBefore > 0 && !S.week.defended &&
      // Only a re-crossing from BELOW defends the rank - a player who has
      // been sitting at their floor all week shouldn't be told they
      // "defended" it on their first ordinary task.
      rankIndexOf(rankForLevel(before).key) < defIdxBefore
    ) {
      S.week.defended = true;
      toast(
        `<strong class="rk-${afterRankObj.key}">${afterRankObj.name} defended</strong> - rank held. See you Sunday.`,
        "success", 4200
      );
    }

    renderXPBar();
    if (coords && applied > 0) flyXP(`+${applied} XP`, coords.x, coords.y - 8);

    if (after > before) {
      const careerRankIdx = rankIndexOf(rankForLevel(careerHigh).key);
      const careerFirstRank = afterRankIdx > careerRankIdx;
      if (after > careerHigh) {
        showLevelOverlay(before, after);
        if (careerFirstRank) {
          toast(`New rank: <strong class="rk-${afterRankObj.key}">${afterRankObj.name}</strong>!`, "rankup");
        }
      }
    }
    if (after > (Number(S.bestLevel) || 1)) S.bestLevel = after;
    save();
    return applied;
  }

  /* ----------------------------------------------------------
     7b. Weekly rank reset - Sunday 23:59. XP drops to just below
         the rank you held, so 2-3 tasks defend it. The defended
         rank is persisted and never recomputed from XP, which now
         sits BELOW the floor and would compound downwards forever.
     ---------------------------------------------------------- */
  const RESET_MARGIN_XP = { bronze: 0, silver: 120, gold: 160, diamond: 210, mythic: 270, master: 340 };

  function rankIndexOf(key) {
    const i = RANKS.findIndex((r) => r.key === key);
    return i === -1 ? 0 : i;
  }

  /** XP a player lands on when their week rolls over. */
  function resetTargetXP(rankKey) {
    const rank = RANKS[clamp(rankIndexOf(rankKey), 0, RANKS.length - 1)];
    return Math.max(0, xpForLevel(rank.minLevel) - (RESET_MARGIN_XP[rank.key] || 0));
  }

  function checkWeeklyReset() {
    if (!S.week || typeof S.week !== "object") S.week = defaultState().week;
    const wk = weekKey();
    if (S.week.lastKey === wk) return false;

    const defended = RANKS[clamp(rankIndexOf(S.week.rank || "bronze"), 0, RANKS.length - 1)];
    const before = S.xp;
    S.xp = Math.min(S.xp, resetTargetXP(defended.key));
    S.week.lastKey = wk;
    S.week.minutes = 0;
    S.week.defended = false;
    // S.week.rank deliberately stays: it is the rank being defended.
    save();

    if (before !== S.xp) {
      const deficit = before - S.xp;
      renderAllStats();
      if (defended.key === "bronze") {
        toast(`New week - the ladder resets. Time to climb again.`, "info", 5200);
      } else {
        toast(
          `New week - you'll defend <strong class="rk-${defended.key}">${defended.name}</strong>. ` +
          `−${deficit.toLocaleString()} XP; a few tasks put it back.`,
          "rankup", 6000
        );
      }
    }
    return true;
  }

  /* ----------------------------------------------------------
     8. Rendering stats / HUD pills / daily quest
     ---------------------------------------------------------- */
  function dailyGoal() { return 3; }

  function buildStaticUI() {
    buildRingDots();
  }

  function renderLevelBadge() {
    const lvl = levelFromXP(S.xp);
    const rank = rankForLevel(lvl);
    $("#stat-level").textContent = lvl;

    const frame = $("#stat-rank-badge");
    frame.innerHTML = badgeSVG(rank.key);
    frame.className = `badge-inline rk-${rank.key}`;

    const nameEl = $("#stat-rank-name");
    nameEl.textContent = rank.name;
    nameEl.className = `rank-name rk-${rank.key}`;
  }

  function renderStreak() {
    $("#stat-streak").textContent = S.streak.current;
    const pill = $("#pill-streak");
    if (pill) {
      pill.classList.toggle("lit", S.streak.current > 0);
      pill.title = S.streak.current > 0
        ? `${S.streak.current}-day streak · best ${S.streak.best} · ×${streakMultiplier(S.streak.current)} XP`
        : `Complete a focus session today to start a streak (best: ${S.streak.best})`;
    }
  }

  function nextRankFor(lvl) {
    return RANKS.find((r) => r.minLevel > lvl) || null;
  }

  function renderXPBar() {
    const lvl = levelFromXP(S.xp);
    const maxed = lvl >= 100;
    const curFloor = xpForLevel(lvl);
    const into = S.xp - curFloor;
    // xpForLevel clamps at 100, so lvl+1's ceiling equals the floor at the
    // cap - need would be 0 and the "0 / 0 XP" line meaningless there.
    const need = maxed ? 0 : xpForLevel(lvl + 1) - curFloor;

    $("#xp-total").textContent = S.xp.toLocaleString();
    $("#rank-progress").textContent = maxed ? "MAX LEVEL" : `${into} / ${need} XP`;
    $("#pill-rank").title = maxed
      ? "Level 100 · the ladder is climbed"
      : `Level ${lvl} · ${need - into} XP to level ${lvl + 1}`;

    renderLevelBadge();
    renderStreak();
  }

  function renderDailyGoal() {
    const goal = dailyGoal();
    const done = Math.min(S.daily.count, goal);
    $("#quest-count").textContent = `${done} / ${goal}`;
    $("#quest-fill").style.width = `${(done / goal) * 100}%`;
    $("#quest-sub").textContent = S.daily.bonusGiven
      ? `Claimed! +${S.daily.bonusXP ?? DAILY_GOAL_BONUS_XP} XP banked · ${S.daily.count} sessions today`
      : `Finish ${goal - done} more focus session${goal - done === 1 ? "" : "s"} to claim +${scaleXP(DAILY_GOAL_BONUS_XP)} XP`;
    $("#quest").classList.toggle("complete", S.daily.bonusGiven);
  }

  function renderTodayStrip() {
    $("#today-sessions").textContent = S.daily.count;
    $("#today-mins").textContent = S.daily.minutes;
    $("#today-total").textContent = S.completedWorkTotal;
  }

  function renderAllStats() {
    renderXPBar();
    renderDailyGoal();
    renderTodayStrip();
    updateModeUI(); // refreshes cycle dots, chips, state-coded chrome
    $("#session-count").textContent =
      `S-${String(S.completedWorkTotal).padStart(2, "0")}`;
  }

  /* ----------------------------------------------------------
     8b. Rank ladder modal - the long-game view: every rank,
         where you stand, and exactly how far the next one is.
     ---------------------------------------------------------- */
  const ranksModal = $("#ranks-modal");

  function openRanks() {
    renderRanks();
    ranksModal.classList.add("open");
    ranksModal.setAttribute("aria-hidden", "false");
  }
  function closeRanks() {
    ranksModal.classList.remove("open");
    ranksModal.setAttribute("aria-hidden", "true");
  }

  function renderRanks() {
    const lvl = levelFromXP(S.xp);
    const curRank = rankForLevel(lvl);
    const nr = nextRankFor(lvl);
    const defending = RANKS[clamp(rankIndexOf(S.week?.rank || "bronze"), 0, RANKS.length - 1)];

    $("#ranks-level").textContent = lvl;
    const into = S.xp - xpForLevel(lvl);
    const need = xpForLevel(Math.min(100, lvl + 1)) - xpForLevel(lvl);
    $("#ranks-next").textContent = lvl >= 100
      ? "Every level climbed"
      : `${need - into} XP to level ${lvl + 1}`;
    $("#ranks-fill").style.width = lvl >= 100 ? "100%" : `${(into / need) * 100}%`;
    $("#ranks-rank-line").textContent = nr
      ? `${(xpForLevel(nr.minLevel) - S.xp).toLocaleString()} XP to ${nr.name} (level ${nr.minLevel})`
      : `${curRank.name}. The ladder is climbed.`;

    const margin = RESET_MARGIN_XP[defending.key] || 0;
    $("#ranks-week-line").innerHTML =
      `Week resets Sunday 23:59 · you'll drop just below ` +
      `<strong class="rk-${defending.key}">${defending.name}</strong>` +
      (margin ? ` (−${margin} XP)` : ``) +
      ` · career high Level ${Math.max(1, Number(S.bestLevel) || 1)}`;

    $("#ranks-list").innerHTML = RANKS.map((r) => {
      const state =
        lvl >= r.maxLevel ? "achieved" :
        r === curRank ? "current" : "locked";
      const stateText =
        state === "achieved" ? "Reached" :
        state === "current" ? "You are here" :
        `Level ${r.minLevel} · ${xpForLevel(r.minLevel).toLocaleString()} XP`;
      const levels = (r.maxLevel === Infinity
        ? `Level ${r.minLevel}+`
        : `Levels ${r.minLevel}-${r.maxLevel}`) +
        ` · ×${RANK_XP_MULT[r.key]} XP`;
      return `
        <li class="rank-row ${state} rk-${r.key}">
          <span class="rank-badge">${badgeSVG(r.key)}</span>
          <div>
            <div class="rr-name">${r.name}</div>
            <div class="rr-levels">${levels}</div>
          </div>
          <span class="rr-state">${stateText}</span>
        </li>`;
    }).join("");
  }

  /* ----------------------------------------------------------
     8c. Friends - P2P leaderboards over WebRTC DataChannels.
         The PeerJS cloud broker does signaling only; profile data
         flows peer-to-peer. An 8-digit code maps to the broker ID
         "contomo-<code>", so either side can redial at any time.
         Friends' numbers are self-reported over an unauthenticated
         channel - fine for bragging rights, not for audits.
     ---------------------------------------------------------- */
  const PEER_ID_PREFIX = "contomo-";
  const FRIENDS_CAP = 40;
  const FRIENDS_SCRIPTS = [
    "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js",
    "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js",
  ];

  const friendsModal = $("#friends-modal");
  const liveConns = new Map();   // friend code -> open-ish DataConnection
  const dialAttempts = new Map(); // friend code -> last dial timestamp
  // Unsolicited contacts (strangers who dialed our code): shown for this
  // session only, never written into the save - a code-scanner could
  // otherwise plant permanent rows and crowd real friends out of the cap.
  const sessionGuests = new Map();
  const acceptedAt = new Map();  // friend code -> last accepted profile time
  let peer = null;
  let peerLoading = null;
  let inflightDials = 0;

  function myCode() {
    if (!/^\d{8}$/.test(S.profile.code || "")) {
      S.profile.code = String(Math.floor(10000000 + Math.random() * 90000000));
      save();
    }
    return S.profile.code;
  }

  function myProfile() {
    const lvl = levelFromXP(S.xp);
    return {
      name: (S.profile.name || "Player").slice(0, 24),
      xp: S.xp,
      level: lvl,
      rank: rankForLevel(lvl).key,
      streak: S.streak.current,
      weekMinutes: (S.week && S.week.minutes) || 0,
      ts: Date.now(),
    };
  }

  function setFriendsNote(text) {
    const el = $("#friends-note");
    if (el) el.textContent = text || "";
  }

  async function ensurePeer() {
    if (peer && !peer.destroyed && !peer.disconnected) return peer;
    if (peerLoading) return peerLoading;
    peerLoading = (async () => {
      if (!window.Peer) {
        let lastErr = null;
        for (const url of FRIENDS_SCRIPTS) {
          try {
            await import(/* webpackIgnore: true */ url);
            if (window.Peer) break;
          } catch (err) { lastErr = err; }
        }
        if (!window.Peer) throw lastErr || new Error("PeerJS failed to load");
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const p = new window.Peer(PEER_ID_PREFIX + myCode());
        try {
          await new Promise((resolve, reject) => {
            const onErr = (err) => { cleanup(); reject(err); };
            const cleanup = () => { p.off("error", onErr); clearTimeout(timer); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("broker timeout")); }, 12000);
            p.on("error", onErr);
            p.on("open", () => { cleanup(); resolve(); });
          });
        } catch (err) {
          p.destroy();
          if (err?.type === "unavailable-id" && attempt < 4) {
            S.profile.code = ""; // code taken on the broker - mint a fresh one
            myCode();
            continue;
          }
          throw err;
        }
        wirePeer(p);
        peer = p;
        return p;
      }
      throw new Error("could not claim a friend code");
    })().catch((err) => { peerLoading = null; throw err; });
    return peerLoading;
  }

  function wirePeer(p) {
    p.on("connection", (conn) => attachConn(conn));
    p.on("disconnected", () => { try { p.reconnect(); } catch { /* broker gone; next sync retries */ } });
    // peer-unavailable just means a friend is offline: stay quiet about it.
    p.on("error", (err) => {
      if (err?.type && err.type !== "peer-unavailable") {
        setFriendsNote("Connection hiccup - will retry in a few minutes.");
      }
    });
  }

  function safeSend(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch { /* dying conn; drop handles it */ }
  }

  function attachConn(conn) {
    if (!conn) return;
    const code = String(conn.peer || "").replace(PEER_ID_PREFIX, "");
    if (!/^\d{8}$/.test(code)) { try { conn.close(); } catch {} return; }
    // Track immediately so the 60s sweep can reap a dial that never opens.
    // The one-channel-per-code decision happens on open, once we know
    // which channel actually came alive - simultaneous dials (both sides
    // connect at once) create two channels, and closing the not-yet-open
    // loser here would kill the channel the other peer is tracking too.
    liveConns.set(code, conn);

    conn.on("open", () => {
      const other = liveConns.get(code);
      if (other && other !== conn && other.open) {
        try { conn.close(); } catch {} // duplicate channel: keep the first to open
        return;
      }
      liveConns.set(code, conn);
      safeSend(conn, { t: "hello", p: myProfile() });
      renderFriends();
    });
    conn.on("data", (msg) => handleFriendMsg(code, msg, conn));
    const drop = () => {
      if (liveConns.get(code) === conn) liveConns.delete(code);
      renderFriends();
    };
    conn.on("close", drop);
    conn.on("error", drop);
    // A dialed conn that never opens shouldn't squat on the code forever.
    setTimeout(() => {
      if (!conn.open && liveConns.get(code) === conn) {
        try { conn.close(); } catch {}
      }
    }, 60000);
  }

  function handleFriendMsg(code, msg, conn) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t !== "hello" && msg.t !== "profile") return;
    try { if (JSON.stringify(msg).length > 4096) return; } catch { return; }
    const p = msg.p;
    if (!p || typeof p !== "object") return;

    // A hostile or broken ts must not freeze the row forever: a finite
    // huge value would survive JSON.stringify and out-rank every future
    // update, so anything implausible falls back to "now".
    let ts = Number(p.ts);
    if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 60000) ts = Date.now();

    // Flood control: one accepted profile per code per second. Everything
    // expensive (save + full list re-render) only runs on accept, so a
    // peer streaming messages can't lock the main thread or churn quota.
    const now = Date.now();
    if (now - (acceptedAt.get(code) || 0) < 1000) return;
    acceptedAt.set(code, now);

    const prev = S.friends[code];
    if (prev && ts <= prev.lastTs) return; // stale replay

    const lvl = clamp(Number(p.level) || 1, 1, 100);
    const entry = {
      name: String(p.name || "Player").slice(0, 24),
      xp: clamp(Number(p.xp) || 0, 0, 10000000),
      level: lvl,
      rank: RANKS.some((r) => r.key === p.rank) ? p.rank : rankForLevel(lvl).key,
      streak: clamp(Number(p.streak) || 0, 0, 9999),
      weekMinutes: clamp(Number(p.weekMinutes) || 0, 0, 10080),
      lastSeen: Date.now(),
      lastTs: ts,
    };

    if (prev) {
      S.friends[code] = entry;
      trimFriends();
      save();
      // First contact answers addFriendByCode's "Looking for your friend…" -
      // the placeholder it left has lastSeen 0, so data arriving means found.
      if (prev.lastSeen === 0) setFriendsNote("");
    } else {
      sessionGuests.set(code, entry);
    }
    renderFriends();
    if (msg.t === "hello") safeSend(conn, { t: "profile", p: myProfile() });
  }

  function trimFriends() {
    const codes = Object.keys(S.friends);
    if (codes.length <= FRIENDS_CAP) return;
    codes
      .sort((a, b) => (S.friends[a].lastSeen || 0) - (S.friends[b].lastSeen || 0))
      .slice(0, codes.length - FRIENDS_CAP)
      .forEach((code) => delete S.friends[code]);
  }

  async function syncFriends() {
    if (!friendsModal) return;
    try {
      await ensurePeer();
    } catch {
      setFriendsNote("Friends need internet - couldn't reach the network just now.");
      return;
    }
    const now = Date.now();
    for (const code of Object.keys(S.friends)) {
      if (liveConns.has(code)) continue;
      if (now - (dialAttempts.get(code) || 0) < 60000) continue;
      dialFriend(code);
    }
    renderFriends();
  }

  function dialFriend(code) {
    if (!peer || inflightDials >= 3) return;
    inflightDials++;
    setTimeout(() => { inflightDials = Math.max(0, inflightDials - 1); }, 60000);
    dialAttempts.set(code, Date.now());
    try {
      attachConn(peer.connect(PEER_ID_PREFIX + code, { reliable: true }));
    } catch { /* broker hiccup - the next cycle retries */ }
  }

  function broadcastProfile() {
    for (const conn of liveConns.values()) {
      safeSend(conn, { t: "profile", p: myProfile() });
    }
  }

  function relTime(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "online now";
    if (mins < 60) return `seen ${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `seen ${hrs}h ago`;
    return `seen ${Math.round(hrs / 24)}d ago`;
  }

  /** Online = an open DataChannel, not merely a dialed conn: a code that
      nobody answered sits in liveConns until the 60s sweep closes it. */
  function isOnline(code) {
    const c = liveConns.get(code);
    return !!(c && c.open);
  }

  function friendRow(code, f, online) {
    const state = online ? "current" : "achieved";
    // An open DataChannel means online regardless of when the last
    // profile arrived - lastSeen only refreshes on message receipt.
    // A never-contacted entry (addFriendByCode placeholder) is pending.
    const seen = online
      ? "online now"
      : f.lastSeen ? relTime(f.lastSeen) : "waiting to connect…";
    return `
      <li class="rank-row ${state} rk-${f.rank}" data-code="${code}">
        <span class="rank-badge">${badgeSVG(f.rank)}</span>
        <div>
          <div class="rr-name">${esc(f.name)}</div>
          <div class="rr-levels">${esc(seen)} · Level ${f.level} · ${f.streak} ${ICONS.flame}</div>
        </div>
        <span class="rr-state">${Number(f.xp).toLocaleString()} XP</span>
        <button class="unfriend" title="Remove friend" aria-label="Remove ${esc(f.name)}">${ICONS.x}</button>
      </li>`;
  }

  function renderFriends() {
    if (!friendsModal) return;

    const codeEl = $("#friends-code");
    if (codeEl) codeEl.textContent = myCode().replace(/(\d{4})(\d{4})/, "$1 $2");
    const nameEl = $("#friends-name");
    if (nameEl && document.activeElement !== nameEl) nameEl.value = S.profile.name || "";

    // Persisted friends plus this session's unsolicited guests (a guest
    // that has since been properly added is skipped in favor of the
    // persisted entry).
    const entries = Object.entries(S.friends || {})
      .concat([...sessionGuests.entries()].filter(([code]) => !S.friends[code]));
    const countEl = $("#friends-count");
    if (countEl) countEl.textContent = String(entries.length);

    $("#friends-list").innerHTML = entries.length
      ? entries
          .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
          .map(([code, f]) => friendRow(code, f, isOnline(code)))
          .join("")
      : `<li class="friends-empty">No friends yet - share your code, or add theirs.</li>`;

    const me = {
      name: S.profile.name || "You",
      xp: S.xp,
      level: levelFromXP(S.xp),
      rank: rankForLevel(levelFromXP(S.xp)).key,
      isMe: true,
    };
    const board = entries
      .filter(([, f]) => f.lastSeen > 0) // pending placeholders have no numbers yet
      .map(([code, f]) => ({ name: f.name, xp: f.xp, level: f.level, rank: f.rank, isMe: false }))
      .concat([me])
      .sort((a, b) => b.xp - a.xp);
    $("#friends-board").innerHTML = board
      .map((p) => `
        <li class="rank-row ${p.isMe ? "current" : "achieved"} rk-${p.rank}">
          <span class="rank-badge">${badgeSVG(p.rank)}</span>
          <div>
            <div class="rr-name">${esc(p.name)}${p.isMe ? " (you)" : ""}</div>
            <div class="rr-levels">Level ${p.level}</div>
          </div>
          <span class="rr-state">${Number(p.xp).toLocaleString()} XP</span>
        </li>`)
      .join("");
  }

  function openFriends() {
    renderFriends();
    friendsModal.classList.add("open");
    friendsModal.setAttribute("aria-hidden", "false");
    setFriendsNote("");
    syncFriends();
  }
  function closeFriends() {
    friendsModal.classList.remove("open");
    friendsModal.setAttribute("aria-hidden", "true");
  }

  async function addFriendByCode(raw) {
    const code = String(raw || "").replace(/\D/g, "");
    if (code.length !== 8) {
      setFriendsNote("Friend codes are exactly 8 digits.");
      return;
    }
    if (code === myCode()) {
      setFriendsNote("That's your own code - share it with a friend instead.");
      return;
    }
    if (S.friends[code]) {
      setFriendsNote("Already on your list.");
      syncFriends();
      return;
    }
    S.friends[code] = {
      name: "…",
      xp: 0, level: 1, rank: "bronze", streak: 0, weekMinutes: 0,
      lastSeen: 0, lastTs: 0,
    };
    save();
    renderFriends();
    setFriendsNote("Looking for your friend…");
    try { await ensurePeer(); } catch { setFriendsNote("Friends need internet - couldn't reach the network just now."); return; }
    dialFriend(code);
    setTimeout(() => {
      const f = S.friends[code];
      if (f && f.lastSeen === 0) setFriendsNote("No answer - they may be offline. We'll retry automatically.");
    }, 8000);
  }

  function removeFriend(code) {
    delete S.friends[code];
    sessionGuests.delete(code);
    acceptedAt.delete(code);
    const conn = liveConns.get(code);
    if (conn) { try { conn.close(); } catch {} }
    save();
    renderFriends();
  }

  async function copyMyCode() {
    const code = myCode();
    try {
      await navigator.clipboard.writeText(code);
      toast("Friend code copied.", "info", 1800);
    } catch {
      // clipboard API can be denied (file:// permissions) - select for manual copy
      const el = $("#friends-code");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast("Copy blocked - code highlighted, copy by hand.", "info", 3200);
    }
  }

  /* ----------------------------------------------------------
     9. Tasks UI
     ---------------------------------------------------------- */
  const taskListEl = $("#task-list");
  const emptyEl = $("#task-empty");
  let dragId = null;

  const uid = () =>
    "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Input ceilings: the input's maxlength is the first gate, these are the
  // real ones (Enter key and programmatic paths skip maxlength). The task
  // cap keeps a runaway script or paste from filling the 5MB store until
  // save() starts silently failing.
  const TASK_TITLE_MAX = 120;
  const TASKS_CAP = 300;
  const TAG_MAX = 24;

  function addTask(title) {
    const raw = String(title || "").trim();
    title = raw.slice(0, TASK_TITLE_MAX);
    if (!title) return;
    if (S.tasks.length >= TASKS_CAP) {
      toast(`Task log is full at ${TASKS_CAP} - finish or delete some first.`, "info");
      return;
    }
    if (raw.length > title.length) {
      toast(`Task trimmed to ${TASK_TITLE_MAX} characters.`, "info");
    }
    S.tasks.unshift({
      id: uid(),
      title,
      tags: parseTags($("#task-tags").value),
      estimateMin: clamp(parseInt($("#task-estimate").value, 10) || 0, 0, 1440),
      done: false,
      // Anti-farm flag: the +25 completion bonus can be claimed exactly
      // once, ever - unchecking and re-completing earns nothing.
      awardedDone: false,
      subtasks: [],
      source: null,
    });
    $("#task-input").value = "";
    $("#task-estimate").value = "";
    $("#task-tags").value = "";
    save();
    renderTasks();
    $("#task-input").focus();
  }

  function parseTags(raw) {
    return String(raw)
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase().slice(0, TAG_MAX))
      .filter(Boolean)
      .slice(0, 4);
  }

  function estChip(t) {
    if (!t.estimateMin) return "";
    return `<span class="chip">${t.estimateMin} min</span>`;
  }

  /** Shows the focused task in the timer head - the session is *for* something. */
  function renderFocusChip() {
    const chip = $("#focus-task-chip");
    const t = activeTask();
    chip.classList.toggle("hidden", !t);
    if (t) {
      // innerHTML (not textContent) so the SVG chevron can lead the title;
      // the title itself is escaped.
      chip.innerHTML = `${ICONS.play}${esc(t.title)}`;
      chip.title = `This session counts toward: ${t.title}`;
    }
  }

  function renderTasks() {
    taskListEl.innerHTML = "";
    emptyEl.classList.toggle("hidden", S.tasks.length > 0);
    $("#open-count").textContent =
      `${S.tasks.filter((t) => !t.done).length} OPEN`;
    renderFocusChip();

    for (const t of S.tasks) {
      const li = document.createElement("li");
      li.className =
        "task-card" +
        (t.done ? " done" : "") +
        (t.id === S.activeTaskId ? " active-task" : "");
      li.dataset.id = t.id;
      li.draggable = false;

      const subs = (t.subtasks.length
        ? `<ul class="subtask-list">` +
          t.subtasks
            .map(
              (st, i) => `
              <li class="subtask${st.done ? " done" : ""}" data-sub="${i}">
                <button class="subtask-check" aria-label="Toggle step"></button>
                <span>${esc(st.title)}</span>
              </li>`
            )
            .join("") +
          `</ul>`
        : "");

      li.innerHTML = `
        <div class="task-index">${String(S.tasks.indexOf(t) + 1).padStart(2, "0")}</div>
        <div class="task-main">
          <div class="task-topline">
            <button class="checkbox${t.done ? " checked" : ""}" aria-label="${t.done ? "Mark task not done" : "Complete task"}">
              ${ICONS.check}
            </button>
            <div class="task-body">
              <span class="task-title">${esc(t.title)}</span>
              <div class="task-chips">
                ${t.id === S.activeTaskId ? `<span class="chip chip-focus">${ICONS.play} FOCUS</span>` : ""}
                ${t.tags.map((tag) => `<span class="chip">#${esc(tag)}</span>`).join("")}
                ${estChip(t)}
                <span class="chip chip-xp">+${taskCompletionXP(t)} XP</span>
              </div>
              ${subs}
            </div>
            <div class="task-actions">
              ${t.done ? "" : `
              <button class="mini-btn ai" data-act="ai" title="Experimental: break down with LFM2.5-350M (on-device)" aria-label="Break down task with model (experimental)">
                ${ICONS.sparkle}
              </button>`}
              <button class="mini-btn danger" data-act="del" title="Delete task" aria-label="Delete task">
                ${ICONS.trash}
              </button>
            </div>
          </div>
        </div>`;

      li.querySelector(".task-title").addEventListener("click", () => {
        S.activeTaskId = t.id;
        save();
        renderTasks();
        toast(`Focusing: <strong>${esc(t.title)}</strong>`, "info", 1800);
      });
      li.querySelector(".checkbox").addEventListener("click", () => toggleTaskDone(t.id));
      const handle = li.querySelector(".task-index");
      handle.title = "Drag to reorder";
      handle.draggable = true;
      handle.addEventListener("dragstart", (e) => {
        dragId = t.id;
        li.classList.add("dragging");
        e.dataTransfer.setData("text/plain", t.id);
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        dragId = null;
      });

      // wire sub-task checkboxes by index
      li.querySelectorAll(".subtask").forEach((row) => {
        row.querySelector(".subtask-check").addEventListener("click", () => {
          const i = Number(row.dataset.sub);
          t.subtasks[i].done = !t.subtasks[i].done;
          const all = t.subtasks.every((st) => st.done);
          save();
          renderTasks();
          if (all && !t.done) {
            toast(`All steps done. Mark the whole task complete when ready.`, "info");
          }
        });
      });

      taskListEl.appendChild(li);
    }
  }

  // Delegated: AI breakdown + delete buttons
  taskListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest(".task-card");
    const task = S.tasks.find((t) => t.id === card.dataset.id);
    if (!task) return;

    if (btn.dataset.act === "ai") runBreakdown(task);
    if (btn.dataset.act === "del") {
      burstAt(btn);
      S.tasks = S.tasks.filter((x) => x.id !== task.id);
      if (S.activeTaskId === task.id) S.activeTaskId = null;
      save();
      renderTasks();
    }
  });

  function toggleTaskDone(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    if (t.done && !t.awardedDone) {
      // Payday fires once per task lifetime. Un-checking never claws XP
      // back and re-checking never re-pays - completion stays earned,
      // and the loop can't be farmed.
      t.awardedDone = true;
      const bonus = taskCompletionXP(t);
      // CSS.escape: a tampered id containing quotes would otherwise throw
      // mid-way through this function, after t.done flipped but before
      // save()/renderTasks() - desyncing the UI from disk.
      const { x, y } = centerOf(taskListEl.querySelector(`[data-id="${CSS.escape(id)}"]`) || taskListEl);
      const banked = awardXP(bonus, { x, y });
      Confetti.burst(x, y, 55);
      Sound.taskDone();
      toast(
        banked > 0
          ? `<strong>+${banked} XP</strong> · Task complete!`
          : "Task complete! · XP vault is at its cap",
        "success"
      );
      if (S.activeTaskId === id) S.activeTaskId = null;
      // One-way street: unchecking never claws XP back - completion stays earned.
    }
    save();
    renderTasks();
  }

  // Reorder: drop target swaps positions of dragId with hovered card.
  taskListEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    const over = e.target.closest(".task-card");
    $$(".task-card").forEach((c) => c.classList.remove("drag-over"));
    if (over && over.dataset.id !== dragId) over.classList.add("drag-over");
  });

  taskListEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const over = e.target.closest(".task-card");
    $$(".task-card").forEach((c) => c.classList.remove("drag-over"));
    if (!over || over.dataset.id === dragId || !dragId) return;
    const fromIdx = S.tasks.findIndex((t) => t.id === dragId);
    const toIdx = S.tasks.findIndex((t) => t.id === over.dataset.id);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = S.tasks.splice(fromIdx, 1);
    S.tasks.splice(toIdx, 0, moved);
    dragId = null;
    save();
    renderTasks();
  });

  function burstAt(el) {
    const { x, y } = centerOf(el);
    burst(x, y, 8);
  }

  /* ----------------------------------------------------------
     10. Breakdown engine
         Primary: LiquidAI/LFM2.5-350M-ONNX, q4, WebGPU, streamed.
         Fallback: deterministic planner - app never dead-ends.
     ---------------------------------------------------------- */
  let generatorPromise = null;

  const MODEL_ID = "LiquidAI/LFM2.5-350M-ONNX";
  // Pinned to the v4 line: its rewritten WebGPU runtime is the only one
  // that loads this model on ORT-web builds shipped since 2025 (v3.8.1
  // throws a native status error at session creation on modern Chrome).
  const TRANSFORMERS_URL =
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/dist/transformers.min.js";

  function gpuAvailable() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  /** Lazily dynamic-import transformers.js + build the pipeline once.
      Resolves to { generate } or throws - caller decides fallback. */
  function ensureGenerator(onProgress) {
    if (generatorPromise) return generatorPromise;

    generatorPromise = (async () => {
      const tf = await import(/* webpackIgnore: true */ TRANSFORMERS_URL);
      const { pipeline, TextStreamer } = tf;

      const files = {}; // track bytes across shards
      const gen = await pipeline("text-generation", MODEL_ID, {
        device: "webgpu",
        dtype: "q4",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file && p.total) {
            files[p.file] = { loaded: p.loaded || 0, total: p.total };
            const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
            const total = Object.values(files).reduce((a, f) => a + f.total, 0);
            onProgress?.(
              `Loading LFM2.5-350M · ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`
            );
          } else if (p.status === "ready") {
            onProgress?.("Warming up GPU kernels…");
          }
        },
      });

      /** v3 returned generated_text as a string; v4 returns chat message
          objects ({ role, content }) or an array of them. Accept both. */
      function extractText(out) {
        const raw = out?.[0]?.generated_text;
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) {
          const last = raw[raw.length - 1];
          return String(last?.content ?? last?.text ?? "");
        }
        if (raw && typeof raw === "object") return String(raw.content ?? "");
        return "";
      }

      async function generate(messages, onToken, maxNew) {
        let acc = "";
        const streamer = new TextStreamer(gen.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (tok) => {
            acc += tok;
            onToken?.(acc);
          },
        });
        const out = await gen(messages, { max_new_tokens: maxNew ?? 240, do_sample: false, streamer });
        return extractText(out) || acc;
      }

      return { generate, label: "LFM2.5-350M · WebGPU · q4" };
    })().catch((err) => {
      generatorPromise = null; // allow retry next click
      throw err;
    });

    return generatorPromise;
  }

  /* ---- strict-ish prompt & tolerant parser ---- */
  /* No minutes in the contract: a 350M model guesses them badly and the
     numbers lent the plans a false precision. Steps are titles only. The
     example is deliberately far from office/school work, and the rule
     against reusing it is explicit - earlier prompts got their example
     steps parroted back verbatim. */
  function buildMessages(title) {
    return [
      {
        role: "system",
        content:
          'You break tasks into steps. Output ONLY JSON, nothing else. Example - Task: "Repot a houseplant" gives {"steps":["Pick a pot with drainage and buy potting mix","Cover the drainage hole and add a base layer of fresh soil","Tease out the roots and centre the plant in its new pot","Fill around the root ball, water lightly, and tidy the spill"]}. Plan the user task the same way: 3 to 6 short concrete steps, each one specific to that task. Never reuse or reword the example steps.',
      },
      { role: "user", content: `Task: "${title}"` },
    ];
  }

  function parseStepsJSON(text) {
    // The model sometimes wraps output in markdown fences even when told
    // not to; the JSON inside is still fine.
    text = text.replace(/```(?:json)?/gi, "");
    const opens = [text.indexOf("{"), text.indexOf("[")].filter((i) => i !== -1);
    const start = Math.min(...opens);
    if (opens.length === 0) throw new Error("no json");
    // Cut at the first position where brackets actually balance (string
    // aware), so junk the model appends after the closing brace never
    // enters the parse. Truncated output has no such point; the raw tail
    // goes to the repair pass, which rebuilds the missing brackets.
    let body = text.slice(start);
    const cut = endOfFirstJSON(body);
    if (cut !== -1) body = body.slice(0, cut);

    let obj;
    try {
      obj = JSON.parse(body);
    } catch {
      try {
        obj = JSON.parse(repairJSON(body));
      } catch {
        // Last resort: salvage the quoted strings out of the first array
        // literal. Survives interleaved junk the repair pass cannot.
        // body, not text - prose like "Plan [v2]:" contains a bracket that
        // would otherwise swallow the scan before the real JSON array.
        const salvaged = salvageStrings(body);
        if (salvaged.length < 2) throw new Error("unrepairable");
        return finalizeSteps(salvaged);
      }
    }
    const arr = Array.isArray(obj) ? obj : obj.steps;
    if (!Array.isArray(arr)) throw new Error("shape");
    return finalizeSteps(arr);
  }

  /** Walk text tracking string state and bracket depth. Returns the index
      just past the end of the first complete top-level value, or -1 if
      the brackets never balance (truncated output). */
  function endOfFirstJSON(text) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  /** A 350M model drifts off the contract in predictable ways: keys
      missing their opening quote (m":30), bare keys, stray commas, or
      output cut off mid-array by the token cap. Repair those - but only
      OUTSIDE string literals, walking with the same scanner endOfFirstJSON
      uses. The old regex pass rewrote `, "b":` inside a step title into a
      broken key and spliced `},{` through the middle of a title, leaving
      the model's plan wearing garbage steps. */
  function repairJSON(body) {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        out += c;
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === ",") {
        // stray comma right before a closing bracket
        let k = i + 1;
        while (k < body.length && /\s/.test(body[k])) k++;
        if (body[k] === "]" || body[k] === "}") { i = k - 1; continue; }
        out += c;
        continue;
      }
      if (c === "{" || c === ",") {
        // unquoted key ({ steps: , , m":30) - quote it; the key-terminating
        // quote the m": case already has is left for the next iteration.
        let k = i + 1;
        while (k < body.length && /\s/.test(body[k])) k++;
        const m = /^[A-Za-z_]\w*/.exec(body.slice(k));
        if (m) {
          let j = k + m[0].length;
          while (j < body.length && /\s/.test(body[j])) j++;
          if (body[j] === ":" || (body[j] === '"' && body[j + 1] === ":")) {
            out += c + body.slice(i + 1, k) + `"${m[0]}"`;
            i = body[j] === ":" ? j - 1 : j;
            continue;
          }
        }
      }
      if (c === "}" && body[i + 1] === "{") { out += "},{"; i++; continue; }
      out += c;
    }
    if ((out.match(/"/g) || []).length % 2 === 1) out += '"'; // cut mid-string
    const openCurly = (out.match(/\{/g) || []).length - (out.match(/\}/g) || []).length;
    const openSquare = (out.match(/\[/g) || []).length - (out.match(/\]/g) || []).length;
    if (openSquare > 0 || openCurly > 0) {
      out += "]".repeat(Math.max(0, openSquare)) + "}".repeat(Math.max(0, openCurly));
    }
    return out;
  }

  /** Pull the quoted strings out of the first array literal, walking with
      a real string scanner. A string immediately followed by a colon is a
      key, not a value. Regex alternatives re-anchor mid-string when a
      lookahead fails, so this is done by hand. */
  function salvageStrings(text) {
    const from = text.indexOf("[");
    if (from === -1) return [];
    const seg = text.slice(from);
    const cut = endOfFirstJSON(seg);
    const scope = cut === -1 ? seg : seg.slice(0, cut);
    const out = [];
    let i = 0;
    while (i < scope.length) {
      if (scope[i] !== '"') { i++; continue; }
      let j = i + 1;
      let val = "";
      let esc = false;
      while (j < scope.length) {
        const c = scope[j];
        if (esc) { val += c; esc = false; j++; continue; }
        if (c === "\\") { esc = true; j++; continue; }
        if (c === '"') break;
        val += c;
        j++;
      }
      if (j >= scope.length) break; // unterminated tail: discard
      let k = j + 1;
      while (k < scope.length && /\s/.test(scope[k])) k++;
      if (scope[k] !== ":") out.push(val);
      i = j + 1;
    }
    return out;
  }

  /** Dedupe, strip bullets, cap the count. Accepts bare strings (the
      current contract) or {t}/{title} objects (older drift). */
  function finalizeSteps(arr) {
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const titleStr = String(
        typeof raw === "string" ? raw : raw?.t ?? raw?.title ?? ""
      )
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s*/, "") // strip list bullets
        .slice(0, 80);
      if (!titleStr || seen.has(titleStr.toLowerCase())) continue;
      seen.add(titleStr.toLowerCase());
      out.push({ title: titleStr });
      if (out.length >= 6) break;
    }
    if (out.length < 2) throw new Error("too few steps");
    return out;
  }

  /** Deterministic offline planner - always works, no network. */
  function fallbackSteps() {
    return [
      { title: "Clarify the goal and gather what you need" },
      { title: "First working pass, start to finish" },
      { title: "Review, fix weak spots, and refine" },
      { title: "Final tidy-up and wrap" },
    ];
  }

  /* ---- modal plumbing ---- */
  const modal = $("#breakdown-modal");
  const subList = $("#breakdown-list");
  const subSource = $("#breakdown-subtitle") || $("#breakdown-source");
  let pendingSteps = null;
  let pendingSource = null;
  let busyBreaking = false;

  function openModal() { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); }
  function closeModal() { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }

  function setSub(text, spinning) {
    subSource.innerHTML =
      (spinning ? '<span class="spin"></span>' : "") + esc(text);
  }

  let currentBreakdownTask = null;

  async function runBreakdown(task) {
    if (busyBreaking) {
      // Escape/X closed the dialog mid-run - the model is still working,
      // so bring the dialog back instead of silently doing nothing.
      openModal();
      return;
    }
    busyBreaking = true;
    currentBreakdownTask = task;

    pendingSteps = null;
    pendingSource = null;
    subList.innerHTML = "";
    $("#breakdown-task-name").textContent = `"${task.title}"`;
    openModal();
    document.activeElement?.blur();

    let full = ""; // survives into the catch so failures can be diagnosed
    try {
      if (!gpuAvailable()) throw new Error("WebGPU unavailable in this browser");
      setSub("Loading LFM2.5-350M (first time downloads ~276 MB)…", true);

      const { generate, label } = await ensureGenerator((msg) => setSub(msg, true));

      // live preview: one growing row while tokens stream in
      const liveRow = document.createElement("li");
      liveRow.className = "breakdown-item live-row";
      liveRow.innerHTML = `<span class="num">…</span><span style="white-space:pre-wrap"></span>`;
      subList.appendChild(liveRow);
      const liveText = liveRow.lastElementChild;

      full = await generate(
        buildMessages(task.title),
        (acc) => { liveText.textContent = acc.slice(-600); },
        260
      );

      // The dialog was closed while the model ran: drop the result rather
      // than repainting a hidden dialog and re-arming Apply.
      if (!modal.classList.contains("open")) { busyBreaking = false; return; }

      liveRow.remove();
      const steps = parseStepsJSON(full);
      pendingSteps = steps;
      pendingSource = label;
      setSub(`${label} · ${steps.length} steps generated`, false);
      renderPending(steps);
    } catch (err) {
      if (!modal.classList.contains("open")) { busyBreaking = false; return; }
      console.info("[chrono] breakdown fell back:", err?.message || err, "raw:", JSON.stringify(full.slice(0, 400)));
      pendingSteps = fallbackSteps();
      pendingSource = "Local planner";
      setSub(
        !gpuAvailable()
          ? "WebGPU not available here, so the built-in local planner was used."
          : `Model couldn't load (${String(err.message || err).slice(0, 80)}), so the built-in local planner was used.`,
        false
      );
      renderPending(pendingSteps);
      Sound.error();
    }

    busyBreaking = false;
  }

  function renderPending(steps) {
    subList.innerHTML = steps
      .map(
        (s, i) => `
        <li class="breakdown-item">
          <span class="num">${i + 1}</span><span>${esc(s.title)}</span>
        </li>`
      )
      .join("");
  }

  function applyPending() {
    closeModal();
    if (!pendingSteps || !currentBreakdownTask) return;
    // The task can be deleted while the model runs - applying to the
    // orphan would mutate nothing but still mint the first-plan XP.
    if (!S.tasks.includes(currentBreakdownTask)) {
      currentBreakdownTask = null;
      pendingSteps = null;
      return;
    }

    // One-time reward: the first plan applied to a task pays +2,
    // re-planning the same task pays attention, not XP.
    const firstPlan = !currentBreakdownTask.subtasks.length && !currentBreakdownTask.source;

    currentBreakdownTask.subtasks = pendingSteps.map((s) => ({
      title: s.title,
      done: false,
    }));
    currentBreakdownTask.source = pendingSource;
    save();
    renderTasks();
    toast(`Plan applied: <strong>${pendingSteps.length} steps</strong> added.`, "success");

    if (firstPlan) awardXP(scaleXP(2), centerOf($("#breakdown-source")));
    currentBreakdownTask = null;
    pendingSteps = null;
  }

  /* ----------------------------------------------------------
     11. Boot / event wiring
     ---------------------------------------------------------- */

  function bindEvents() {
    // timer controls
    $("#btn-start").addEventListener("click", () => {
      toggle();
      renderControls();
    });
    $("#btn-reset").addEventListener("click", reset);

    $$(".mode-btn").forEach((b) =>
      b.addEventListener("click", () => setMode(b.dataset.mode))
    );

    // session length inputs
    [["len-work", "work"], ["len-short", "short"], ["len-long", "long"]].forEach(
      ([id, key]) => {
        const input = $("#" + id);
        input.value = S.settings[key];
        input.addEventListener("change", () => {
          const v = clamp(parseInt(input.value, 10) || S.settings[key], key === "short" ? 1 : 5, 120);
          input.value = v;
          S.settings[key] = v;
          save();
          if (!T.running && T.mode === key) setMode(key);
        });
      }
    );

    // tasks
    $("#btn-add-task").addEventListener("click", () => addTask($("#task-input").value));
    $("#task-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTask(e.target.value);
    });

    // breakdown modal
    $("#breakdown-close").addEventListener("click", closeModal);
    $("#breakdown-done").addEventListener("click", () => closeModal());
    $("#breakdown-apply").addEventListener("click", applyPending);

    // theme
    $("#theme-toggle").addEventListener("click", cycleTheme);

    // fullscreen - focus mode for the whole deck
    $("#fullscreen-btn").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", () => {
      document.documentElement.dataset.fs = document.fullscreenElement ? "1" : "0";
    });

    // rank ladder
    $("#pill-rank").addEventListener("click", openRanks);
    $("#ranks-close").addEventListener("click", closeRanks);
    ranksModal.addEventListener("click", (e) => {
      if (e.target === ranksModal) closeRanks();
    });

    // friends
    $("#pill-friends").addEventListener("click", openFriends);
    $("#friends-close").addEventListener("click", closeFriends);
    friendsModal.addEventListener("click", (e) => {
      if (e.target === friendsModal) closeFriends();
    });
    $("#friends-copy").addEventListener("click", copyMyCode);
    $("#friend-add").addEventListener("click", () => {
      addFriendByCode($("#friend-input").value);
      $("#friend-input").value = "";
    });
    $("#friend-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        addFriendByCode(e.target.value);
        e.target.value = "";
      }
    });
    $("#friends-name").addEventListener("change", (e) => {
      S.profile.name = String(e.target.value || "").trim().slice(0, 24);
      save();
      broadcastProfile();
      renderFriends();
    });
    $("#friends-list").addEventListener("click", (e) => {
      if (!e.target.closest(".unfriend")) return;
      const row = e.target.closest("[data-code]");
      if (row) removeFriend(row.dataset.code);
    });

    // Keyboard shortcuts. Skipped while typing, and skipped when a
    // BUTTON has focus (its own Space/Enter activation must win,
    // otherwise we'd toggle twice).
    document.addEventListener("keydown", (e) => {
      // e.target can be document/window for synthetic and edge events,
      // so every DOM probe below is guarded.
      const targetEl = e.target instanceof Element ? e.target : null;
      const typing =
        /^(input|textarea|select)$/i.test(targetEl?.tagName || "");
      if (e.key === "Escape") { closeModal(); closeRanks(); closeFriends(); return; }
      if (typing || e.repeat) return;

      if (e.code === "Space" && !(targetEl && targetEl.closest("button"))) {
        e.preventDefault();
        toggle();
        renderControls();
      }

      // T = cycle work → short → long → work
      if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const order = ["work", "short", "long"];
        const next = order[(order.indexOf(T.mode) + 1) % order.length];
        setMode(next);
        toast(`Switched to ${MODE_LABEL[next]}`, "info", 1500);
      }

      // F = fullscreen
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        toggleFullscreen();
      }
    });
  }

  let booted = false;

  async function init() {
    try {
      await hydrate();
    } catch (err) {
      console.info("[chrono] hydrate failed, starting fresh:", err?.message || err);
      S = defaultState();
    }
    applyTheme();
    buildStaticUI();

    // Rebuild the timer face from hydrated settings - T was constructed
    // from defaults before storage was decrypted. Then resume a session
    // that was live when the page last closed.
    const live = S.timerLive;
    setMode((live && live.mode) || T.mode);
    if (live) S.timerLive = live; // setMode's persist clobbered the snapshot
    if (live && live.mode && durationFor(live.mode)) {
      T.total = live.total || durationFor(live.mode);
      T.left = clamp(Math.ceil(live.left ?? T.total), 0, T.total);
      if (T.left <= 0) {
        // A zeroed/mangled snapshot must never boot to a dead face whose
        // Start button no-ops (start() bails on left <= 0) - reset it.
        T.left = T.total;
        live.running = false;
      }
      if (live.running && T.left > 0) {
        start();
        toast(`Session resumed with ${Math.floor(T.left / 60)}m ${T.left % 60}s left.`, "info", 2600);
      }
    }

    renderTime(); // paint initial countdown + ring
    bindEvents();
    renderAllStats();
    renderTasks();
    // Paint the friends pill from persisted state now, not on first modal
    // open - otherwise the count reads 0 until a sync succeeds, and never
    // corrects at all when the broker is unreachable.
    renderFriends();
    announce("Contomo ready.");

    if (!gpuAvailable()) {
      setTimeout(() =>
        toast("This browser has no WebGPU, so task breakdown will use the built-in local planner.", "info", 5200), 900);
    }

    // Friends: claim our broker slot shortly after boot, then poll
    // every few minutes so both-online friends find each other.
    setTimeout(() => { syncFriends(); }, 2000);
    setInterval(() => { if (!document.hidden) syncFriends(); }, 5 * 60 * 1000);

    booted = true;
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();

  // Sunday 23:59 can pass while the tab sits open - re-check on wake.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !booted) return;
    checkWeeklyReset();
    if (friendsModal.classList.contains("open")) syncFriends();
  });

  // E2E-only seam: automated tests seed deep-rank states and assert the
  // pure math through the app's own functions. Inert unless the page was
  // loaded with #e2e, and it can only do what the app itself can do.
  if (location.hash === "#e2e") {
    window.ChronoStore = {
      state: () => JSON.parse(JSON.stringify(S)),
      write: (patch) => {
        // Same rules as hydrate: strip structural keys before the assign
        // (a "__proto__" own property would swap S's prototype), and keep
        // xp inside the cap so a test can't mint an out-of-range state.
        const clean = scrubProto(JSON.parse(JSON.stringify(patch)));
        S = Object.assign(S, clean);
        S.xp = clamp(Math.round(Number(S.xp) || 0), 0, XP_CAP);
        save();
      },
      xpForLevel, legacyXpForLevel, migrateXP, levelFromXP, xpForSession,
      taskCompletionXP, scaleXP, rankMult, weekKey, resetTargetXP,
      checkWeeklyReset, rankIndexOf,
    };
  }
})();

