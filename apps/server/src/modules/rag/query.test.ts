import { describe, expect, it } from 'vitest';

import { describeAbnormalVitals, expandClinicalAbbreviations } from './query.js';

describe('expandClinicalAbbreviations', () => {
  it.each([
    ['Abd pain, N/V', 'abdominal pain, nausea and vomiting'],
    ['s/p Fall', 'status post Fall'],
    ['N/V/D', 'nausea, vomiting and diarrhea'],
    ['ETOH, SI', 'alcohol intoxication, suicidal ideation'],
    ['R Foot pain', 'right Foot pain'],
  ])('"%s" -> "%s"', (input, expected) => {
    expect(expandClinicalAbbreviations(input)).toBe(expected);
  });

  it('leaves abbreviations inside longer words alone', () => {
    expect(expandClinicalAbbreviations('Hallucinations, chest pressure')).toBe('Hallucinations, chest pressure');
  });
});

describe('describeAbnormalVitals', () => {
  it('names adult danger-zone vitals', () => {
    expect(describeAbnormalVitals({ heartRate: 128, respiratoryRate: 24, oxygenSaturation: 89 }, 60)).toEqual([
      'tachycardia (heart rate 128)',
      'tachypnea (respiratory rate 24)',
      'hypoxia (SpO2 89%)',
    ]);
  });

  it('uses age-specific limits for children', () => {
    expect(describeAbnormalVitals({ heartRate: 130 }, 5)).toEqual([]);
    expect(describeAbnormalVitals({ heartRate: 150 }, 5)).toEqual(['tachycardia (heart rate 150)']);
  });

  it('returns nothing for normal vitals', () => {
    expect(describeAbnormalVitals({ heartRate: 80, systolicBp: 130, temperatureC: 36.8, painScore: 3 }, 40)).toEqual([]);
  });
});
