// Flood color for the lyrics screen: one saturated dark color per song, taken
// from its cover, clamped so white text always reads on it. Pure functions;
// the canvas sampling itself lives in the game.

const FALLBACK = ["#5a0a14", "#0b3d2e", "#1a2a6c", "#4a1a6b", "#6b3a00", "#0a4a5a"];
export const DEFAULT_FLOOD = "#12304a";

/** Contrast ratio the flood must give to white text at TEXT_ALPHA. */
export const MIN_CONTRAST = 4.5;
const TEXT_ALPHA = 0.78;

export function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast of white at `alpha` over the opaque color `bg`. */
export function whiteContrast(bg, alpha = 1) {
  const mixed = bg.map((v) => 255 * alpha + v * (1 - alpha));
  return (luminance(mixed) + 0.05) / (luminance(bg) + 0.05);
}

/**
 * The flood for a cover color: saturation at least 45 %, lightness 20-30 %,
 * then darkened further until 78 %-white text reaches MIN_CONTRAST.
 * @returns {string} #rrggbb
 */
export function floodFromRgb(r, g, b) {
  const hsl = rgbToHsl(r, g, b);
  const s = Math.min(0.85, Math.max(0.45, hsl.s));
  let l = Math.min(0.3, Math.max(0.2, hsl.l));
  let rgb = hslToRgb(hsl.h, s, l);
  while (whiteContrast(rgb, TEXT_ALPHA) < MIN_CONTRAST && l > 0.08) {
    l -= 0.01;
    rgb = hslToRgb(hsl.h, s, l);
  }
  return toHex(rgb);
}

/** Bar color: the flood mixed ~55 % toward black. */
export function deepOf(hex) {
  const rgb = fromHex(hex);
  if (!rgb) return "#0b1a28";
  return toHex(rgb.map((v) => v * 0.45));
}

/** A stable palette color for a track whose cover cannot be sampled. */
export function fallbackFlood(id) {
  let h = 0;
  for (const ch of String(id ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/**
 * Dominant color of RGBA pixel data, weighting saturated mid-tones so gray
 * borders and white backgrounds do not win. Returns [r, g, b] or null.
 */
export function dominantRgb(data) {
  let wr = 0, wg = 0, wb = 0, wsum = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const { s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const w = (s * s + 0.02) * Math.max(0.02, 1 - Math.abs(l - 0.5) * 1.4);
    wr += data[i] * w; wg += data[i + 1] * w; wb += data[i + 2] * w; wsum += w;
  }
  if (wsum === 0) return null;
  return [wr / wsum, wg / wsum, wb / wsum];
}
