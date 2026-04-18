/**
 * Design tokens read from CSS custom properties at module load time.
 * CSS (:root) is the single source of truth — changing a variable there
 * automatically flows through to canvas drawing code that imports from here.
 */
const _s = getComputedStyle(document.documentElement);
const _get = (v: string) => _s.getPropertyValue(v).trim();

export const PITCH_COLOR  = _get("--pitch-color");   // #00ff88
export const VOLUME_COLOR = _get("--volume-color");  // #ff6b35
export const MISS_COLOR   = _get("--miss-color");    // #ff4444
export const BG_DEEP      = _get("--bg-deep");       // #0b0b0b
