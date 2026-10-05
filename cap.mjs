/**
 * Pure policy helpers for dsh-image-edge-cap. No DSH imports, so unit tests
 * run under plain `node --test`.
 */

export const DEFAULT_MAX_IMAGE_EDGE = 2000;
export const MIN_IMAGE_EDGE = 16;
export const MAX_IMAGE_EDGE = 16384;
export const MODES = Object.freeze(['off', 'all', 'selected']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A usable edge limit, or undefined. */
export function validEdge(value) {
  return Number.isInteger(value) && value >= MIN_IMAGE_EDGE && value <= MAX_IMAGE_EDGE ? value : undefined;
}

/**
 * The long-edge cap for one request route, or undefined when none applies.
 * A rule is `{ mode: 'off' | 'all' | 'selected', models: string[], maxImageEdge }`:
 * `all` covers every model of the provider, `selected` only the listed model ids.
 */
export function capFor(rules, provider, model) {
  if (!isRecord(rules) || typeof provider !== 'string' || !Object.hasOwn(rules, provider)) return undefined;
  const rule = rules[provider];
  if (!isRecord(rule)) return undefined;
  const edge = validEdge(rule.maxImageEdge ?? DEFAULT_MAX_IMAGE_EDGE);
  if (edge === undefined) return undefined;
  if (rule.mode === 'all') return edge;
  if (rule.mode === 'selected') {
    return typeof model === 'string' && Array.isArray(rule.models) && rule.models.includes(model) ? edge : undefined;
  }
  return undefined;
}

/**
 * Aspect-preserving integer size with an exact long edge. The short edge is
 * rounded the way sharp derives it when resizing by the long edge alone, which
 * is how dsh-attachment-local resizes (and what its cache check compares).
 */
export function longEdgeDimensions(width, height, longEdge) {
  if (longEdge >= Math.max(width, height)) return { width, height };
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
    : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge };
}

/**
 * Shrink a request-image target so neither side exceeds `cap`. Returns the
 * original target object (same identity) when nothing changes, so a disabled
 * or non-binding cap keeps the store's variant id byte-identical.
 * @param ref - the attachment reference (source `width`/`height`).
 * @param target - `{ width, height, maxBytes }` chosen by the adapter.
 */
export function capTarget(ref, target, cap) {
  if (cap === undefined || !isRecord(target)) return target;
  const { width, height } = target;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return target;
  if (Math.max(width, height) <= cap) return target;
  // Derive from the source size so rounding matches the store's resize.
  const sourceW = Number.isInteger(ref?.width) && ref.width > 0 ? ref.width : width;
  const sourceH = Number.isInteger(ref?.height) && ref.height > 0 ? ref.height : height;
  const next = longEdgeDimensions(sourceW, sourceH, cap);
  return {
    ...target,
    width: Math.min(width, next.width),
    height: Math.min(height, next.height),
  };
}
