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
// The same analysis runs on what CleanCut hears when there are no captions
// (shared/listening.js): those cues carry measured word times, so a profanity
// is muted exactly where it is said.
//
// Output segments carry source:"subtitles" (or "listening") and a confidence, so the engine
// can treat them as suggestions until the viewer opts in or a human confirms.

import { DIALOGUE_HINTS, PROFANE_PHRASES, PROFANITY, SOUND_HINTS } from './lexicon.js';

// [moaning] or (gunshots). All-caps lines are not treated as sounds: shouted
// dialogue is often written in capitals too.
const SOUND_RE = /\[([^\]]+)\]|\(([^)]+)\)/g;

// Bleeped words, as captions print them. YouTube's automatic captions write
// every profanity as "[ __ ]"; broadcasters and uploaders use "[bleep]",
// "(censored)", "[expletive]" or a run of symbols. These must not be read as
// sound descriptions (which would drop them): each becomes the censored token
// "f**k", which the strong censored-word rule matches.
const BLEEP_RE = /\[\s*_{2,}\s*\]|[[(]\s*(?:bleep(?:ed|s|ing)?|beep(?:ed|s)?|censored|expletive(?:\s+deleted)?)\s*!?\s*[\])]|\*\s*bleep\s*\*/gi;
const SYMBOL_RUN_RE = /(^|[\s"'(])[*#@$%&!]{3,}(?=$|[\s"'.,!?;:)])/g;
export function unbleep(text) {
  return String(text).replace(BLEEP_RE, ' f**k ').replace(SYMBOL_RUN_RE, '$1f**k');
}

/** Split a cue into sound descriptions and spoken dialogue. */
export function splitCue(text) {
  const sounds = [];
  const dialogue = unbleep(text).replace(SOUND_RE, (all, a, b) => {
    sounds.push((a || b).toLowerCase());
    return ' ';
  });
  return {
    sounds,
    // Drop speaker labels ("JON:") and music notes.
    dialogue: dialogue.replace(/^\s*-?\s*[A-Z][A-Z .'-]{1,30}:\s*/gm, ' ').replace(/[♪♫]/g, ' '),
  };
}

/**
 * A cue made of timed words (speech recognition): sound descriptions are the
 * bracketed words, the dialogue is the others joined by spaces, and `spans`
 * maps each dialogue word's characters back to its time.
 */
export function splitWords(words) {
  const sounds = [];
  const spans = [];
  let dialogue = '';
  for (const w of words) {
    const text = String(w.text || '').trim();
    if (!text) continue;
    const said = unbleep(text).trim();
    const sound = said === text && /^[[(]([^\])]+)[\])][.,!?]*$/.exec(text); // "[gunshot]", but not a bleep
    if (sound) {
      sounds.push(sound[1].toLowerCase());
      continue;
    }
    if (dialogue) dialogue += ' ';
    spans.push({ from: dialogue.length, to: dialogue.length + said.length, start: w.start, end: w.end });
    dialogue += said;
  }
  return { sounds, dialogue, spans };
}

/** When the characters [from, to) of a word-cue's dialogue were spoken. */
function spanTime(spans, from, to) {
  const hit = spans.filter((s) => s.to > from && s.from < to);
  return hit.length ? { start: hit[0].start, end: hit[hit.length - 1].end } : null;
}

/** Find profane words in a line. Returns [{ word, severity, index }]. */
export function findProfanity(dialogue) {
  const hits = [];
  const wordRe = /[A-Za-z][A-Za-z'*#@\-]*/g;
  let m;
  while ((m = wordRe.exec(dialogue))) {
    const raw = m[0].toLowerCase().replace(/'/g, '');
    // "f--" is a censored word; "was--" is an interrupted line.
    const token = /^[a-z]-{2,}[a-z]*$/.test(raw) ? raw : raw.replace(/-+$/, '');
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

// Profanity in a transcript is near-certain; keep a little doubt for
// homographs ("hell", "ass" the animal).
const SUBTITLE_CONFIDENCE = (severity) => (severity === 1 ? 0.8 : 0.95);
const MIN_SPOKEN = 0.35; // seconds: the shortest a measured profanity is taken to last

/**
 * @param {Array<{start:number,end:number,text:string,words?:Array<{text:string,start:number,end:number}>}>} cues
 *   cues with `words` (speech recognition) are muted at the measured word times
 * @param {object} [opts]
 * @param {'line'|'word'} [opts.languageMode='line']  for cues without word times
 * @param {number} [opts.wordPad=0.6]       seconds around an estimated word time
 * @param {number} [opts.timedPad=0.1]      seconds around a measured word time
 * @param {number} [opts.sceneGap=20]       hints of a category closer than this join one scene
 * @param {number} [opts.scenePad=2]        seconds added around a hinted scene
 * @param {string} [opts.source='subtitles']  source label of the segments (and their id prefix)
 * @param {(severity:number)=>number} [opts.languageConfidence]  confidence of a profanity
 * @param {number} [opts.hintScale=1]       factor on scene-hint confidences
 * @returns {Array} segments
 */
export function analyzeCues(cues, opts = {}) {
  const languageMode = opts.languageMode === 'word' ? 'word' : 'line';
  const wordPad = opts.wordPad ?? 0.6;
  const timedPad = opts.timedPad ?? 0.1;
  const sceneGap = opts.sceneGap ?? 20;
  const scenePad = opts.scenePad ?? 2;
  const source = opts.source || 'subtitles';
  const prefix = source === 'subtitles' ? 'sub' : source;
  const languageConfidence = opts.languageConfidence || SUBTITLE_CONFIDENCE;
  const hintScale = opts.hintScale ?? 1;

  const language = [];
  const hints = [];

  for (const cue of cues) {
    const { sounds, dialogue, spans } = Array.isArray(cue.words) ? splitWords(cue.words) : splitCue(cue.text);

    for (const hit of findProfanity(dialogue)) {
      let start = cue.start;
      let end = cue.end;
      const said = spans && spanTime(spans, hit.index, hit.index + hit.word.length);
      if (said) {
        // A recogniser sometimes gives a word next to no duration (the last
        // word before a pause): mute at least as long as a short swear lasts.
        start = Math.max(0, said.start - timedPad);
        end = Math.max(said.end, said.start + MIN_SPOKEN) + timedPad;
      } else if (languageMode === 'word') {
        // Estimate when the word is spoken from its position in the line.
        const len = Math.max(1, dialogue.trim().length);
        const offset = Math.max(0, dialogue.indexOf(hit.word) - (dialogue.length - dialogue.trimStart().length));
        const at = cue.start + (cue.end - cue.start) * Math.min(1, offset / len);
        start = Math.max(cue.start, at - wordPad);
        end = Math.min(cue.end, at + wordPad + 0.3);
      }
      language.push({
        id: `${prefix}:language:${start.toFixed(2)}:${hit.index}`,
        start, end,
        category: 'language',
        severity: hit.severity,
        action: 'mute',
        source,
        confidence: languageConfidence(hit.severity),
        note: `"${mask(hit.word)}"`,
      });
    }

    const pick = ({ category, severity, confidence }) => ({ category, severity, confidence: Math.round(confidence * hintScale * 100) / 100 });
    for (const sound of sounds) {
      for (const h of SOUND_HINTS) {
        if (h.re.test(sound)) hints.push({ ...pick(h), start: cue.start, end: cue.end, evidence: `[${sound}]` });
      }
    }
    for (const h of DIALOGUE_HINTS) {
      if (h.re.test(dialogue)) hints.push({ ...pick(h), start: cue.start, end: cue.end, evidence: 'dialogue' });
    }
  }

  return [...mergeLanguage(language), ...clusterHints(hints, { sceneGap, scenePad, source, prefix })].sort((a, b) => a.start - b.start);
}

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
export function clusterHints(hints, { sceneGap = 20, scenePad = 2, source = 'subtitles', prefix = 'sub' } = {}) {
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
        id: `${prefix}:${category}:${scene.start.toFixed(1)}`,
        start: Math.max(0, scene.start - scenePad),
        end: scene.end + scenePad,
        category,
        severity: scene.severity,
        source,
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
