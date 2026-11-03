// Content taxonomy, severity scale and rating presets.
//
// Every tagged segment has a category and a severity from 1 (mild) to 3
// (strong). A rating preset is a map of category -> the highest severity that
// is allowed to play. Anything above the threshold is filtered with the
// category's action (skip, mute or blur).

export const CATEGORIES = [
  { id: 'nudity', label: 'Nudity', defaultAction: 'skip' },
  { id: 'sex', label: 'Sexual content', defaultAction: 'skip' },
  { id: 'violence', label: 'Violence', defaultAction: 'skip' },
  { id: 'gore', label: 'Gore', defaultAction: 'skip' },
  { id: 'language', label: 'Language', defaultAction: 'mute' },
  { id: 'drugs', label: 'Drugs & alcohol', defaultAction: 'skip' },
  { id: 'frightening', label: 'Frightening / intense', defaultAction: 'skip' },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export const SEVERITIES = { 1: 'mild', 2: 'moderate', 3: 'strong' };

// 'blur' hides the picture (the video goes dark). A real blur filter over a
// full-size video costs a multi-pass GPU effect on every frame and makes
// playback stutter, so the name is kept for compatibility but not the effect.
export const ACTIONS = ['skip', 'mute', 'blur'];
export const ACTION_LABELS = { skip: 'skip', mute: 'mute', blur: 'hide picture' };

const t = (nudity, sex, violence, gore, language, drugs, frightening) => ({
  nudity, sex, violence, gore, language, drugs, frightening,
});

// Thresholds are the maximum severity that still plays.
//                                 nud sex vio gore lang drug fright
export const PRESETS = {
  unfiltered: { label: 'Unfiltered', thresholds: t(3, 3, 3, 3, 3, 3, 3) },
  R: { label: 'R', thresholds: t(2, 2, 3, 2, 3, 3, 3) },
  'PG-13': { label: 'PG-13', thresholds: t(0, 1, 2, 1, 2, 2, 3) },
  PG: { label: 'PG', thresholds: t(0, 0, 1, 0, 1, 1, 2) },
  G: { label: 'G', thresholds: t(0, 0, 0, 0, 0, 0, 1) },
};

export const PRESET_ORDER = ['unfiltered', 'R', 'PG-13', 'PG', 'G', 'custom'];

export function defaultActions() {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultAction]));
}

export function defaultProfile() {
  return {
    preset: 'PG-13',
    thresholds: { ...PRESETS['PG-13'].thresholds },
    actions: defaultActions(),
    // Machine-detected segments (subtitle analysis, scanner) are shown on the
    // timeline but only acted on when enabled and confident enough.
    ai: { enabled: true, minConfidence: 0.6 },
    // How profanity is muted: the whole subtitle line, or an estimated window
    // around the word itself.
    languageMode: 'line',
    hideCaptionsWhileMuted: true,
  };
}

const clampSeverity = (n) => Math.max(0, Math.min(3, Math.round(Number(n) || 0)));

/** Fill in defaults and resolve the preset into concrete thresholds. */
export function resolveProfile(profile = {}) {
  const base = defaultProfile();
  const preset = profile.preset && (PRESETS[profile.preset] || profile.preset === 'custom')
    ? profile.preset
    : base.preset;
  const source = preset === 'custom'
    ? { ...base.thresholds, ...(profile.thresholds || {}) }
    : PRESETS[preset].thresholds;
  const thresholds = {};
  for (const id of CATEGORY_IDS) thresholds[id] = clampSeverity(source[id] ?? 3);

  const actions = defaultActions();
  for (const [id, action] of Object.entries(profile.actions || {})) {
    if (CATEGORY_IDS.includes(id) && ACTIONS.includes(action)) actions[id] = action;
  }
  const ai = { ...base.ai, ...(profile.ai || {}) };
  ai.minConfidence = Math.max(0, Math.min(1, Number(ai.minConfidence) || 0));
  return {
    preset,
    thresholds,
    actions,
    ai,
    languageMode: profile.languageMode === 'word' ? 'word' : 'line',
    hideCaptionsWhileMuted: profile.hideCaptionsWhileMuted !== false,
  };
}

/** True when a segment is above what the profile allows. */
export function exceeds(segment, resolved) {
  const max = resolved.thresholds[segment.category];
  if (max === undefined) return false;
  return segment.severity > max;
}

/** Human summary like "PG-13" or "Custom (no nudity, mild language)". */
export function describeProfile(profile) {
  const r = resolveProfile(profile);
  if (r.preset !== 'custom') return PRESETS[r.preset].label;
  const parts = CATEGORIES.filter((c) => r.thresholds[c.id] < 3).map((c) =>
    r.thresholds[c.id] === 0 ? `no ${c.label.toLowerCase()}` : `≤${SEVERITIES[r.thresholds[c.id]]} ${c.label.toLowerCase()}`,
  );
  return parts.length ? `Custom (${parts.join(', ')})` : 'Custom (unfiltered)';
}
