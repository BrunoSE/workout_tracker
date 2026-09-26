// Shared exercise-name canonicalization: several routines spell the same
// movement differently ("Calf raise" vs "Calf raises"). Seeds match on the
// canonical key, while the UI keeps displaying each routine's own spelling.
// Standalone module (no imports) so storage.js can use it too.

function normalize(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// canonical -> extra spellings (all compared after normalize())
const ALIAS_GROUPS = {
  'dumbbell walking lounge': ['dumbbell walking lounges', 'db walking lunges (on shoulders)'],
  'dumbbell lateral raise': ['dumbbell lateral raises', 'dumbbell lat raise'],
  'calf raise': ['calf raises'],
  'reverse lat pulldown': ['reverse grip lat pulldown'],
  'single leg extension': ['single leg ext'],
  'dead hang': ['dead hang (max)'],
  'overhead press': ['overhead press (standing)'],
  'dumbbell incline press': ['inclined dumbbell press'],
  'lying leg curl': ['leg curl'],
};

const VARIANT_TO_CANONICAL = new Map();
for (const [canonical, variants] of Object.entries(ALIAS_GROUPS)) {
  VARIANT_TO_CANONICAL.set(canonical, canonical);
  for (const v of variants) VARIANT_TO_CANONICAL.set(v, canonical);
}

export function canonicalExerciseName(name) {
  const n = normalize(name);
  return VARIANT_TO_CANONICAL.get(n) || n;
}
