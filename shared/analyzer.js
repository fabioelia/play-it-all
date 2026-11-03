// Scan-ahead analyzer: turns a subtitle track into content segments before
// the scene plays.
//
// Two signals, both cheap enough to run in a content script on a full
// episode in a few milliseconds:
//  1. Profanity in dialogue → precise "language" segments (muted).
//  2. Sound descriptions in SDH captions and suggestive dialogue → scene
//     hints, clustered over time into low/medium confidence segments for
//     sex, violence, gore, drugs and frightening content.
//
// Output segments carry source:"subtitles" and a confidence, so the engine
// can treat them as suggestions until the viewer opts in or a human confirms.

import { DIALOGUE_HINTS, PROFANE_PHRASES, PROFANITY, SOUND_HINTS } from './lexicon.js';

// [moaning] or (gunshots). All-caps lines are not treated as sounds: shouted
// dialogue is often written in capitals too.
const SOUND_RE = /\[([^\]]+)\]|\(([^)]+)\)/g;

/** Split a cue into sound descriptions and spoken dialogue. */
export function splitCue(text) {
  const sounds = [];
  const dialogue = String(text).replace(SOUND_RE, (all, a, b) => {
    sounds.push((a || b).toLowerCase());
    return ' ';
  });
  return {
    sounds,
    // Drop speaker labels ("JON:") and music notes.
    dialogue: dialogue.replace(/^\s*-?\s*[A-Z][A-Z .'-]{1,30}:\s*/gm, ' ').replace(/[♪♫]/g, ' '),
  };
}

/** Find profane words in a line. Returns [{ word, severity, index }]. */
export function findProfanity(dialogue) {
  const hits = [];
  const wordRe = /[A-Za-z][A-Za-z'*#@\-]*/g;
  let m;
  while ((m = wordRe.exec(dialogue))) {
    const token = m[0].toLowerCase().replace(/'/g, '').replace(/-+$/, '');
    for (const entry of PROFANITY) {
      if (entry.re.test(token)) {
        hits.push({ word: m[0], severity: entry.severity, index: m.index });
        break;
      }
    }
  }
  for (const entry of PROFANE_PHRASES) {
    const pm = entry.re.exec(dialogue);
    if (!pm) continue;
    const inside = (h) => h.index >= pm.index && h.index < pm.index + pm[0].length;
    if (hits.some((h) => inside(h) && h.severity >= entry.severity)) continue;
    // The phrase outranks the weaker words it contains ("god damn" > "damn").
    for (let i = hits.length - 1; i >= 0; i--) if (inside(hits[i])) hits.splice(i, 1);
    hits.push({ word: pm[0], severity: entry.severity, index: pm.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * @param {Array<{start:number,end:number,text:string}>} cues
 * @param {object} [opts]
 * @param {'line'|'word'} [opts.languageMode='line']
 * @param {number} [opts.wordPad=0.6]       seconds around an estimated word time
 * @param {number} [opts.sceneGap=20]       hints of a category closer than this join one scene
 * @param {number} [opts.scenePad=2]        seconds added around a hinted scene
 * @returns {Array} segments
 */
export function analyzeCues(cues, opts = {}) {
  const languageMode = opts.languageMode === 'word' ? 'word' : 'line';
  const wordPad = opts.wordPad ?? 0.6;
  const sceneGap = opts.sceneGap ?? 20;
  const scenePad = opts.scenePad ?? 2;

  const language = [];
  const hints = [];

  for (const cue of cues) {
    const { sounds, dialogue } = splitCue(cue.text);

    for (const hit of findProfanity(dialogue)) {
      let start = cue.start;
      let end = cue.end;
      if (languageMode === 'word') {
        // Estimate when the word is spoken from its position in the line.
        const len = Math.max(1, dialogue.trim().length);
        const offset = Math.max(0, dialogue.indexOf(hit.word) - (dialogue.length - dialogue.trimStart().length));
        const at = cue.start + (cue.end - cue.start) * Math.min(1, offset / len);
        start = Math.max(cue.start, at - wordPad);
        end = Math.min(cue.end, at + wordPad + 0.3);
      }
      language.push({
        id: `sub:language:${start.toFixed(2)}:${hit.index}`,
        start, end,
        category: 'language',
        severity: hit.severity,
        action: 'mute',
        source: 'subtitles',
        // Profanity in a transcript is near-certain; keep a little doubt for
        // homographs ("hell", "ass" the animal).
        confidence: hit.severity === 1 ? 0.8 : 0.95,
        note: `"${mask(hit.word)}"`,
      });
    }

    for (const sound of sounds) {
      for (const h of SOUND_HINTS) {
        if (h.re.test(sound)) hints.push({ ...pick(h), start: cue.start, end: cue.end, evidence: `[${sound}]` });
      }
    }
    for (const h of DIALOGUE_HINTS) {
      if (h.re.test(dialogue)) hints.push({ ...pick(h), start: cue.start, end: cue.end, evidence: 'dialogue' });
    }
  }

  return [...mergeLanguage(language), ...clusterHints(hints, { sceneGap, scenePad })].sort((a, b) => a.start - b.start);
}

const pick = ({ category, severity, confidence }) => ({ category, severity, confidence });

function mask(word) {
  return word.length <= 2 ? word : word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

// Several profanities in one cue produce one mute segment.
function mergeLanguage(segs) {
  segs.sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      last.severity = Math.max(last.severity, s.severity);
      last.note = `${last.note}, ${s.note}`;
    } else out.push({ ...s });
  }
  return out;
}

/**
 * Hints for the same category that fall within `sceneGap` seconds are one
 * scene. Independent hints compound: confidence = 1 - Π(1 - cᵢ).
 */
export function clusterHints(hints, { sceneGap = 20, scenePad = 2 } = {}) {
  const byCat = new Map();
  for (const h of hints) {
    if (!byCat.has(h.category)) byCat.set(h.category, []);
    byCat.get(h.category).push(h);
  }
  const out = [];
  for (const [category, list] of byCat) {
    list.sort((a, b) => a.start - b.start);
    let scene = null;
    const flush = () => {
      if (!scene) return;
      const confidence = 1 - scene.misses;
      // A lone weak hint (one "[kissing]") rarely means a strong scene;
      // severity is the max seen, confidence carries the doubt.
      out.push({
        id: `sub:${category}:${scene.start.toFixed(1)}`,
        start: Math.max(0, scene.start - scenePad),
        end: scene.end + scenePad,
        category,
        severity: scene.severity,
        source: 'subtitles',
        confidence: Math.round(confidence * 100) / 100,
        note: `${scene.count} cue${scene.count > 1 ? 's' : ''}: ${[...scene.evidence].slice(0, 4).join(' ')}`,
      });
      scene = null;
    };
    for (const h of list) {
      if (scene && h.start <= scene.end + sceneGap) {
        scene.end = Math.max(scene.end, h.end);
        scene.severity = Math.max(scene.severity, h.severity);
        scene.misses *= 1 - h.confidence;
        scene.count++;
        scene.evidence.add(h.evidence);
      } else {
        flush();
        scene = { start: h.start, end: h.end, severity: h.severity, misses: 1 - h.confidence, count: 1, evidence: new Set([h.evidence]) };
      }
    }
    flush();
  }
  return out;
}
