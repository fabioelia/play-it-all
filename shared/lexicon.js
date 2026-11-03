// Word lists for the subtitle analyzer. Tokens are lower-cased words with
// apostrophes stripped ("fuckin'" → "fuckin"). Each entry is matched against a
// whole token, so "class" never matches "ass" and "hello" never matches "hell".
//
// severity: 1 mild, 2 moderate, 3 strong — mirrors the rating scale.

export const PROFANITY = [
  // strong
  { re: /^(mother)?f+u+c+k+\w*$/, severity: 3 },
  { re: /^f+[*\-#@]+k\w*$/, severity: 3 }, // censored "f**k"
  { re: /^\w*fuck\w*$/, severity: 3 }, // clusterfuck, unfuckingbelievable
  { re: /^c+u+n+t+s?$/, severity: 3 },
  { re: /^cocksuck\w*$/, severity: 3 },
  { re: /^n+i+g+g+(a|er|ers|as|az)$/, severity: 3 },
  { re: /^fag(s|got|gots)?$/, severity: 3 },
  { re: /^retards?$/, severity: 3 },
  // moderate
  { re: /^\w*shit\w*$/, severity: 2 },
  { re: /^bitch\w*$/, severity: 2 },
  { re: /^bastards?$/, severity: 2 },
  { re: /^ass(hole|holes|wipe|hat)s?$/, severity: 2 },
  { re: /^(dumb|jack|smart|bad|hard|kick|lard|fat)ass(es)?$/, severity: 2 },
  { re: /^dick(s|head|heads)?$/, severity: 2 },
  { re: /^cocks?$/, severity: 2 },
  { re: /^puss(y|ies)$/, severity: 2 },
  { re: /^whor(e|es|ing)$/, severity: 2 },
  { re: /^sluts?$/, severity: 2 },
  { re: /^pricks?$/, severity: 2 },
  { re: /^twats?$/, severity: 2 },
  { re: /^wank(er|ers|ing)?$/, severity: 2 },
  { re: /^tits?$/, severity: 2 },
  { re: /^goddamn(ed|it)?$/, severity: 2 },
  { re: /^piss(ed|ing)?$/, severity: 2 },
  { re: /^bollocks$/, severity: 2 },
  // mild
  { re: /^damn(ed|it)?$/, severity: 1 },
  { re: /^hell$/, severity: 1 },
  { re: /^ass(es)?$/, severity: 1 },
  { re: /^crap(py)?$/, severity: 1 },
  { re: /^bloody$/, severity: 1 },
  { re: /^bugger(ed)?$/, severity: 1 },
  { re: /^arse$/, severity: 1 },
];

// Two-word phrases that are profanity only together.
export const PROFANE_PHRASES = [
  { re: /\bgod\s+damn(ed|it)?\b/i, severity: 2 },
  { re: /\bjesus\s+(fucking\s+)?christ\b/i, severity: 1 },
  { re: /\bson of a bitch\b/i, severity: 2 },
];

// Hints from sound descriptions in SDH captions ("[moaning]", "(gunshots)").
// These describe what is happening on screen, which is the cheapest signal we
// get for non-verbal content when frames are DRM-protected.
// confidence is the chance a single hint marks real content of that severity.
export const SOUND_HINTS = [
  { re: /\b(moan(s|ing)?|orgasm\w*|climax(es|ing)?|sex(ual)? (noises|sounds)|bed (creak|squeak)\w*|thrust(s|ing)?)\b/, category: 'sex', severity: 3, confidence: 0.45 },
  { re: /\b(pant(s|ing)? (heavily|rhythmically)|breath(es|ing)? heavily|gasp(s|ing)? (in )?pleasure|kiss(es|ing)? passionately|making out|lovemaking)\b/, category: 'sex', severity: 2, confidence: 0.35 },
  { re: /\b(kiss(es|ing)?)\b/, category: 'sex', severity: 1, confidence: 0.3 },
  { re: /\b(gun ?(shot|fire)s?|gunfire|shots? fired|rifle fires|machine gun\w*|explosions?|explodes|bomb)\b/, category: 'violence', severity: 2, confidence: 0.55 },
  { re: /\b(stab(s|bing|bed)?|slash(es|ing)?|punch(es|ing)?|blows? land|kicks?|beating|fighting|struggl(es|ing)|sword(s)? (clash|clang)\w*|blade (slices|cuts)|strangl\w+|chok(es|ing))\b/, category: 'violence', severity: 2, confidence: 0.45 },
  { re: /\b(screams?|screaming|shrieks?|shrieking|cries out in pain|wails?|wailing|groans? in pain)\b/, category: 'violence', severity: 1, confidence: 0.3 },
  { re: /\b(squelch\w*|flesh (tears|tearing|rips)|bones? (crack|crunch|snap)\w*|blood (spurts|gushes|splatters|sprays)|gurgl(es|ing)|disembowel\w*|decapitat\w*)\b/, category: 'gore', severity: 3, confidence: 0.55 },
  { re: /\b(snort(s|ing)?|sniff(s|ing)? (deeply|sharply)|inhales? (deeply|sharply)|exhales smoke|lighter (clicks|flicks)|bong bubbl\w*|pills rattle)\b/, category: 'drugs', severity: 1, confidence: 0.3 },
  { re: /\b(ominous|eerie|sinister|creepy) (music|tone|whispers?)\b|\b(growl(s|ing)|snarl(s|ing))\b/, category: 'frightening', severity: 1, confidence: 0.3 },
];

// Dialogue that suggests (not proves) on-screen content.
export const DIALOGUE_HINTS = [
  { re: /\b(take (off )?your clothes|get undressed|you'?re naked|naked|nude)\b/i, category: 'nudity', severity: 2, confidence: 0.3 },
  { re: /\b(rape[ds]?|raping)\b/i, category: 'sex', severity: 3, confidence: 0.4 },
  { re: /\b(have sex|having sex|sleep with (me|you|her|him))\b/i, category: 'sex', severity: 2, confidence: 0.25 },
];
