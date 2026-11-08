/**
 * Curated summary of the ESI v4 triage algorithm, paraphrased from the
 * Emergency Severity Index Implementation Handbook, Version 4 (Gilboy, Tanabe,
 * Travers, Rosenau; AHRQ, 2012).
 *
 * Used two ways: split on `## ` headings into retrievable chunks for RAG, and
 * included whole in the prompt for the "ESI guide" condition. Keep it factual
 * and in sync with the handbook; it is part of the method.
 */
export const ESI_GUIDE_SOURCE = 'ESI algorithm summary (curated from the ESI v4 Implementation Handbook)';

export const ESI_ALGORITHM_GUIDE = `## ESI overview
The Emergency Severity Index (ESI) is a five-level emergency department triage algorithm. ESI 1 is the most urgent and ESI 5 the least. The nurse works through four decision points in order (A, B, C, D) and stops at the first one that assigns a level. ESI 1 and 2 are decided by acuity; ESI 3, 4 and 5 are decided by the number of different resources the patient is expected to need.

## Decision point A: immediate life-saving intervention (ESI 1)
Assign ESI 1 if the patient requires an immediate life-saving intervention, or is unresponsive (responds only to pain, or not at all), intubated, apneic or pulseless.
Life-saving interventions: bag-valve-mask ventilation, intubation, surgical airway, emergency CPAP or BiPAP; defibrillation, emergency cardioversion, external pacing; needle chest decompression, pericardiocentesis, open thoracotomy, intraosseous access; significant IV fluid resuscitation, blood transfusion, control of major bleeding; naloxone, dextrose (D50), dopamine, atropine, adenosine.
Not life-saving on their own: diagnostic tests, ECG, laboratory tests, imaging, oxygen by nasal cannula or non-rebreather mask, nebulised medications, IV access for routine medication, cardiac monitoring.
Typical ESI 1 presentations: cardiac or respiratory arrest; severe respiratory distress; SpO2 below 90%; critically injured trauma patient who is unresponsive; overdose with respiratory rate below 6; severe bradycardia or tachycardia with signs of hypoperfusion; hypotension with signs of hypoperfusion; anaphylaxis; hypoglycaemia with altered mental status.

## Decision point B: high-risk, confused or in severe pain (ESI 2)
Assign ESI 2 if any of the following apply.
High-risk situation: a condition that could easily deteriorate or needs time-sensitive treatment, recognisable from the chief complaint, a brief history and the patient's appearance. The guiding question is whether the nurse would give the last open bed to this patient. Examples: chest pain suspicious for acute coronary syndrome in a stable patient; signs of stroke not meeting ESI 1; suspected ectopic pregnancy in a haemodynamically stable patient; suicidal or homicidal ideation; immunocompromised patient with fever; possible sepsis.
New-onset confusion, lethargy or disorientation.
Severe pain or distress: pain rated 7 or more on a 0 to 10 scale, confirmed by the nurse's assessment, or severe psychological distress.

## Decision point C: number of resources (ESI 3, 4 or 5)
If the patient is not ESI 1 or 2, estimate how many different types of resources the provider will need to reach a disposition. None: ESI 5. One: ESI 4. Two or more: go to decision point D (ESI 3 unless D applies).
Count each type of resource once, however many tests of that type are ordered.
Resources: laboratory tests (blood, urine); ECG; plain radiographs; CT, MRI, ultrasound, angiography; IV fluids; IV, IM or nebulised medications; specialty consultation; simple procedure (counts as one, e.g. laceration repair, urinary catheter); complex procedure (counts as two, e.g. procedural sedation).
Not resources: history and physical examination (including pelvic examination); point-of-care testing; saline lock; oral medications; tetanus immunisation; prescription refills; phone call to the primary care provider; simple wound care (dressings, recheck); crutches, splints, slings.

## Decision point D: danger-zone vital signs
For a patient expected to need two or more resources, check the vital signs. If any is in the danger zone, consider up-triage to ESI 2; otherwise assign ESI 3.
Danger zone by age: under 3 months, heart rate above 180 or respiratory rate above 50; 3 months to 3 years, heart rate above 160 or respiratory rate above 40; 3 to 8 years, heart rate above 140 or respiratory rate above 30; over 8 years, heart rate above 100 or respiratory rate above 20. Any age: SpO2 below 92%.
Paediatric fever: age 1 to 28 days with temperature of 38.0 C or higher, assign at least ESI 2; 1 to 3 months with 38.0 C or higher, consider ESI 2; 3 months to 3 years with 39.0 C or higher and incomplete immunisations or no obvious source, consider ESI 3.`;

/**
 * The guide as single-topic retrieval chunks: one per paragraph, prefixed with
 * its section title. Short lead-in lines are merged into the next paragraph.
 * (Whole sections mix too many topics to rank well against a patient query.)
 */
export function esiGuideChunks(): { title: string; content: string }[] {
  const chunks: { title: string; content: string }[] = [];
  for (const section of ESI_ALGORITHM_GUIDE.split(/^## /m).filter((s) => s.trim())) {
    const [heading = '', ...lines] = section.split('\n');
    const title = heading.trim();
    let carry = '';
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      const text = carry ? `${carry} ${line}` : line;
      if (text.length < 100) {
        carry = text;
        continue;
      }
      chunks.push({ title, content: `${title}. ${text}` });
      carry = '';
    }
    if (carry) chunks.push({ title, content: `${title}. ${carry}` });
  }
  return chunks;
}
