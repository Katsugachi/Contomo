/* ============================================================
   Contomo - rank badges
   Six hand-authored SVG medals. Flat fills only: every shape
   is a solid color; shading comes from separate facet shapes,
   never from gradients. Self-contained fixed colors so badges
   look identical in both themes.
   ============================================================ */

(function () {
  "use strict";

  /** N-point star path helper (gold sunburst). */
  function starPath(cx, cy, outerR, innerR, points) {
    const coords = [];
    for (let k = 0; k < points * 2; k++) {
      const r = k % 2 === 0 ? outerR : innerR;
      const angle = -Math.PI / 2 + (k * Math.PI) / points;
      const x = (cx + r * Math.cos(angle)).toFixed(2);
      const y = (cy + r * Math.sin(angle)).toFixed(2);
      coords.push(`${x} ${y}`);
    }
    return "M" + coords.join(" L") + " Z";
  }

  const BADGES = {
    /* ---------- BRONZE · Levels 1-7 ----------
       Hexagon with rising chevrons - the first step up. */
    bronze() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Bronze rank">
  <path d="M24 5 L40 14 V34 L24 43 L8 34 V14 Z"
        fill="#A2703B" stroke="#7A5327" stroke-width="2" stroke-linejoin="round"/>
  <path d="M15 27 L24 19 L33 27" fill="none" stroke="#F2E3D5"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 33 L24 25 L33 33" fill="none" stroke="#C79B66"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
    },

    /* ---------- SILVER · Levels 8-14 ----------
       Shield with three stacked bars - steady accumulation. */
    silver() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Silver rank">
  <path d="M24 4 L40 10 V25 C40 34 33 40.5 24 44 C15 40.5 8 34 8 25 V10 Z"
        fill="#8E9BA6" stroke="#5F6B74" stroke-width="2" stroke-linejoin="round"/>
  <rect x="14" y="17" width="20" height="3.6" rx="1.8" fill="#F4F7F9"/>
  <rect x="17" y="23.5" width="14" height="3.6" rx="1.8" fill="#D3DBE1"/>
  <rect x="20" y="30" width="8" height="3.6" rx="1.8" fill="#ACB9C2"/>
</svg>`;
    },

    /* ---------- GOLD · Levels 15-24 ----------
       Sunburst: an 8-point star around a warm core. */
    gold() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Gold rank">
  <path d="${starPath(24, 24, 20, 9, 8)}"
        fill="#CFA22E" stroke="#946F15" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="7.5" fill="#946F15"/>
  <circle cx="24" cy="24" r="4" fill="#FFF3CE"/>
</svg>`;
    },

    /* ---------- DIAMOND · Levels 25-39 ----------
       Brilliant-cut gem; facets are separate flat shapes. */
    diamond() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Diamond rank">
  <path d="M24 5 L39 18 L24 43 L9 18 Z"
        fill="#3FA8D0" stroke="#1F6E8C" stroke-width="2" stroke-linejoin="round"/>
  <path d="M9 18 H39" stroke="#1F6E8C" stroke-width="2" stroke-linecap="round"/>
  <path d="M24 5 L17.5 18 L24 43 Z" fill="#66C2E0"/>
  <path d="M24 5 L30.5 18 L24 43 Z" fill="#2E86AB"/>
  <path d="M9 18 L17.5 18 M39 18 L30.5 18" stroke="#7FCFE8" stroke-width="2" stroke-linecap="round"/>
  <path d="M20 21.5 h8" stroke="#BEEAF6" stroke-width="2" stroke-linecap="round"/>
</svg>`;
    },

    /* ---------- MYTHIC · Levels 40-59 ----------
       Purple flame with an inner core. */
    mythic() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Mythic rank">
  <path d="M24 4 C24.5 12 15 15.5 15 25 C15 31.5 18.5 36 24 38.5 C29.5 36 33 31.5 33 25 C33 19.5 29.5 16.5 28 12.5 C28 17 26 19.5 24 20.5 C26 16.5 25.5 10 24 4 Z"
        fill="#8250C4" stroke="#573493" stroke-width="2" stroke-linejoin="round"/>
  <path d="M24 22.5 C26.5 25.5 28.5 27 28.5 30 C28.5 33.2 26.6 35.2 24 36.2 C21.4 35.2 19.5 33.2 19.5 30 C19.5 27 21.5 25.5 24 22.5 Z"
        fill="#E6DAFB"/>
</svg>`;
    },

    /* ---------- MASTER · Levels 60-100 ----------
       Compass star inside a ring - mastery as orientation. */
    master() {
      return `
<svg viewBox="0 0 48 48" role="img" aria-label="Master rank">
  <circle cx="24" cy="24" r="19.5" fill="#B23040" stroke="#7E1F2B" stroke-width="2.5"/>
  <circle cx="24" cy="24" r="13.5" fill="none" stroke="#D96A77" stroke-width="1.5"/>
  <path d="M24 10.5 L27.3 20.7 L37.5 24 L27.3 27.3 L24 37.5 L20.7 27.3 L10.5 24 L20.7 20.7 Z"
        fill="#F8EDEE" stroke="#7E1F2B" stroke-width="1.4" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="2.4" fill="#7E1F2B"/>
</svg>`;
    },
  };

  const RANKS = [
    { key: "bronze", name: "Bronze", minLevel: 1, maxLevel: 7 },
    { key: "silver", name: "Silver", minLevel: 8, maxLevel: 14 },
    { key: "gold", name: "Gold", minLevel: 15, maxLevel: 24 },
    { key: "diamond", name: "Diamond", minLevel: 25, maxLevel: 39 },
    { key: "mythic", name: "Mythic", minLevel: 40, maxLevel: 59 },
    { key: "master", name: "Master", minLevel: 60, maxLevel: Infinity },
  ];

  function rankForLevel(level) {
    if (RANKS[0] && level < RANKS[0].minLevel) level = RANKS[0].minLevel;
    let current = RANKS[0];
    for (const rank of RANKS) {
      if (level >= rank.minLevel && level <= rank.maxLevel) { current = rank; break; }
    }
    return current;
  }

  function badgeSVG(rankKey) {
    const factory = BADGES[rankKey];
    return factory ? factory() : "";
  }

  window.ChronoBadges = { RANKS, rankForLevel, badgeSVG, BADGES };
})();