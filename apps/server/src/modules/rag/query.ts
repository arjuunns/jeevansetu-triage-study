/**
 * Helpers that turn a terse triage record into a retrieval query that matches
 * guideline prose: common ED abbreviations are expanded and abnormal vital
 * signs are named in words.
 *
 * The abbreviation list is general emergency-department shorthand, written
 * independently of any evaluation data.
 */

const ABBREVIATIONS: Record<string, string> = {
  abd: 'abdominal',
  abdo: 'abdominal',
  abn: 'abnormal',
  afib: 'atrial fibrillation',
  ams: 'altered mental status',
  bil: 'bilateral',
  bp: 'blood pressure',
  brbpr: 'bright red blood per rectum',
  'c/o': 'complains of',
  chf: 'congestive heart failure',
  copd: 'chronic obstructive pulmonary disease',
  cp: 'chest pain',
  cva: 'stroke',
  dib: 'difficulty breathing',
  dka: 'diabetic ketoacidosis',
  doe: 'dyspnea on exertion',
  dvt: 'deep vein thrombosis',
  elev: 'elevated',
  etoh: 'alcohol intoxication',
  eval: 'evaluation',
  fx: 'fracture',
  gi: 'gastrointestinal',
  gib: 'gastrointestinal bleeding',
  gsw: 'gunshot wound',
  ha: 'headache',
  'h/a': 'headache',
  hi: 'homicidal ideation',
  htn: 'hypertension',
  hx: 'history',
  ich: 'intracranial hemorrhage',
  l: 'left',
  lac: 'laceration',
  lle: 'left lower extremity',
  llq: 'left lower quadrant',
  loc: 'loss of consciousness',
  lt: 'left',
  lue: 'left upper extremity',
  luq: 'left upper quadrant',
  mva: 'motor vehicle accident',
  mvc: 'motor vehicle collision',
  'n/v': 'nausea and vomiting',
  'n/v/d': 'nausea, vomiting and diarrhea',
  od: 'overdose',
  pe: 'pulmonary embolism',
  pna: 'pneumonia',
  pt: 'patient',
  r: 'right',
  'r/o': 'rule out',
  rle: 'right lower extremity',
  rlq: 'right lower quadrant',
  rt: 'right',
  rue: 'right upper extremity',
  ruq: 'right upper quadrant',
  's/p': 'status post',
  sah: 'subarachnoid hemorrhage',
  sdh: 'subdural hematoma',
  si: 'suicidal ideation',
  sob: 'shortness of breath',
  sx: 'symptoms',
  sz: 'seizure',
  tia: 'transient ischemic attack',
  uri: 'upper respiratory infection',
  uti: 'urinary tract infection',
  'w/': 'with',
  'w/u': 'workup',
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Longest keys first so "n/v/d" wins over "n/v".
const ABBREVIATION_PATTERN = new RegExp(
  `(?<![a-z0-9/])(${Object.keys(ABBREVIATIONS)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?![a-z0-9/])`,
  'gi',
);

export function expandClinicalAbbreviations(text: string): string {
  return text.replace(ABBREVIATION_PATTERN, (m) => ABBREVIATIONS[m.toLowerCase()] ?? m);
}

/** ESI danger-zone heart-rate and respiratory-rate limits by age (years). */
function dangerZone(age: number): { hr: number; rr: number } {
  if (age < 0.25) return { hr: 180, rr: 50 };
  if (age < 3) return { hr: 160, rr: 40 };
  if (age <= 8) return { hr: 140, rr: 30 };
  return { hr: 100, rr: 20 };
}

/** Abnormal vital signs named in words, e.g. ["tachycardia (heart rate 128)"]. */
export function describeAbnormalVitals(vitals: Record<string, number | boolean | undefined>, age: number): string[] {
  const num = (k: string) => (typeof vitals[k] === 'number' ? (vitals[k] as number) : undefined);
  const zone = dangerZone(age);
  const hr = num('heartRate');
  const rr = num('respiratoryRate');
  const spo2 = num('oxygenSaturation');
  const sbp = num('systolicBp');
  const temp = num('temperatureC');
  const pain = num('painScore');
  const out: string[] = [];
  if (hr !== undefined && hr > zone.hr) out.push(`tachycardia (heart rate ${hr})`);
  if (hr !== undefined && hr < 50) out.push(`bradycardia (heart rate ${hr})`);
  if (rr !== undefined && rr > zone.rr) out.push(`tachypnea (respiratory rate ${rr})`);
  if (spo2 !== undefined && spo2 < 92) out.push(`hypoxia (SpO2 ${spo2}%)`);
  if (sbp !== undefined && sbp < 90) out.push(`hypotension (systolic ${sbp})`);
  if (temp !== undefined && temp >= 38) out.push(`fever (${temp} C)`);
  if (temp !== undefined && temp <= 35) out.push(`hypothermia (${temp} C)`);
  if (pain !== undefined && pain >= 7) out.push(`severe pain (${pain}/10)`);
  if (vitals.isUnconscious === true) out.push('unresponsive');
  return out;
}
