// Segment validation shared by the extension (local tags) and the server.

import { ACTIONS, CATEGORY_IDS } from './ratings.js';

export const MAX_SEGMENT_SECONDS = 60 * 60;
export const MAX_NOTE_LENGTH = 280;
export const SOURCES = ['community', 'local', 'subtitles', 'scanner'];

/**
 * Normalise an untrusted segment. Returns { ok: true, segment } or
 * { ok: false, error }.
 */
export function validateSegment(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'segment must be an object' };
  const start = Number(input.start);
  const end = Number(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: 'start and end must be numbers (seconds)' };
  if (start < 0) return { ok: false, error: 'start must be >= 0' };
  if (end <= start) return { ok: false, error: 'end must be after start' };
  if (end - start > MAX_SEGMENT_SECONDS) return { ok: false, error: 'segment longer than one hour' };
  if (!CATEGORY_IDS.includes(input.category)) return { ok: false, error: `category must be one of ${CATEGORY_IDS.join(', ')}` };
  const severity = Number(input.severity);
  if (![1, 2, 3].includes(severity)) return { ok: false, error: 'severity must be 1, 2 or 3' };
  if (input.action != null && !ACTIONS.includes(input.action)) return { ok: false, error: `action must be one of ${ACTIONS.join(', ')}` };
  const note = input.note == null ? '' : String(input.note).slice(0, MAX_NOTE_LENGTH);
  let confidence = input.confidence == null ? 1 : Number(input.confidence);
  if (!Number.isFinite(confidence)) confidence = 1;
  confidence = Math.max(0, Math.min(1, confidence));
  const source = SOURCES.includes(input.source) ? input.source : 'community';
  return {
    ok: true,
    segment: {
      ...(input.id != null ? { id: String(input.id) } : {}),
      start: round3(start),
      end: round3(end),
      category: input.category,
      severity,
      action: input.action ?? null,
      note,
      source,
      confidence: round3(confidence),
    },
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
