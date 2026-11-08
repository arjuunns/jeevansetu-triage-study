import { ingestGuideline } from '../src/modules/rag/rag.service.js';

/**
 * Seed script — ingests sample medical guideline texts into the RAG pipeline
 * (Pinecone + PostgreSQL). Run with:
 *
 *   npx tsx --env-file=.env prisma/seed-guidelines.ts
 */

const SAMPLE_GUIDELINES = [
  {
    title: 'WHO Emergency Triage Assessment and Treatment (ETAT)',
    source: 'WHO' as const,
    version: '2.0',
    description: 'WHO guidelines for emergency triage assessment and treatment in developing countries.',
    text: `
Emergency Triage Assessment and Treatment (ETAT) Guidelines

CHAPTER 1: TRIAGE PRINCIPLES
Emergency triage is the process of rapidly screening sick children soon after their arrival in hospital
to identify those with emergency signs requiring immediate emergency treatment, those with
priority signs who should be given priority in the queue, and those who are non-urgent cases.

EMERGENCY SIGNS (IMMEDIATE TREATMENT REQUIRED):
- Obstructed breathing or central cyanosis
- Severe respiratory distress (very fast breathing with chest indrawing)
- Shock: cold extremities with capillary refill time > 3 seconds and weak, fast pulse
- Coma or convulsions (currently convulsing)
- Severe dehydration (lethargy, sunken eyes, very slow skin pinch)

PRIORITY SIGNS (SEEN NEXT):
- Tiny baby: any sick child under 2 months
- Temperature: very high fever (> 38.5°C)
- Trauma or surgical condition
- Pallor (severe anaemia)
- Poisoning
- Pain (severe)
- Respiratory distress
- Restless, continuously irritable, or lethargic
- Referral (urgent)
- Malnutrition (visible severe wasting)
- Oedema (both feet)
- Burns (major)

CHAPTER 2: AIRWAY AND BREATHING
Assess airway patency immediately. If the child is not breathing or has gasping respirations:
- Open airway using head-tilt chin-lift manoeuvre
- Look for foreign body obstruction
- Provide bag-mask ventilation if spontaneous breathing does not resume
- Give oxygen if SpO2 < 90%

For respiratory distress:
- Position upright or semi-upright
- Give supplemental oxygen to maintain SpO2 > 94%
- Consider nebulized salbutamol for wheeze
- Consider antibiotics if pneumonia suspected

CHAPTER 3: CIRCULATION
Signs of shock include: cold extremities, capillary refill > 3 seconds, weak rapid pulse,
and altered consciousness.

Management of shock:
- Establish IV access immediately
- Give 20 mL/kg normal saline bolus over 15 minutes
- Reassess after each bolus
- If shock persists after 40 mL/kg, consider blood transfusion or inotropes
- Monitor urine output
- Check blood glucose and treat hypoglycaemia

CHAPTER 4: NEUROLOGICAL EMERGENCIES
Glasgow Coma Scale assessment:
- GCS 3-8: Severe brain injury, protect airway, consider intubation
- GCS 9-12: Moderate brain injury, close monitoring required
- GCS 13-15: Mild brain injury, observation

Convulsions:
- Protect from injury, do not restrain
- Give diazepam rectally 0.5 mg/kg or IV 0.3 mg/kg
- Check blood glucose
- If convulsion continues after 10 minutes, repeat diazepam
- Consider phenytoin if status epilepticus

CHAPTER 5: SEVERE MALARIA
Clinical features: high fever, altered consciousness, prostration, respiratory distress,
repeated convulsions, jaundice, dark urine, severe anaemia.

Treatment:
- IV artesunate 2.4 mg/kg at 0, 12, and 24 hours, then daily
- Maintain airway, check blood glucose every 4 hours
- Blood transfusion if Hb < 5 g/dL with respiratory distress
- Monitor for fluid overload
    `,
  },
  {
    title: 'Emergency Severity Index (ESI) Triage Algorithm v4',
    source: 'ESI' as const,
    version: '4.0',
    description: 'ESI five-level emergency department triage algorithm.',
    text: `
Emergency Severity Index (ESI) Version 4 Implementation Handbook

ESI LEVEL 1 - IMMEDIATE (RESUSCITATION)
Requires immediate life-saving intervention.
Examples:
- Cardiac arrest or respiratory arrest
- Major trauma with active hemorrhage
- Unconscious patient (GCS < 9)
- Severe anaphylaxis with airway compromise
- Active seizure (status epilepticus)
- Intubated patient
- Pulseless extremity

Assessment: Is this patient dying? Does the patient require immediate intervention?

ESI LEVEL 2 - EMERGENT
High-risk situation, confused/lethargic/disoriented, or severe pain/distress.
Examples:
- Chest pain suggestive of ACS (age > 35)
- Stroke signs within window (FAST positive)
- Suicidal ideation with plan
- Severe asthma exacerbation (cannot speak in full sentences)
- Abdominal pain with hemodynamic instability
- High-risk OB: vaginal bleeding, possible ectopic
- Immunocompromised with fever > 38°C
- Pain scale 7-10 with acute onset

Assessment: Should this patient wait? Consider:
- Is this a high-risk situation?
- Is the patient confused, lethargic, or disoriented?
- Is the patient in severe pain or distress?

ESI LEVEL 3 - URGENT
Requires two or more resources but vital signs are in normal parameters.
Expected resources: labs, ECG, X-rays, IV fluids, medications, specialist consultation.
Examples:
- Abdominal pain, mild to moderate
- Laceration requiring sutures
- Asthma without respiratory distress (can speak full sentences)
- Urinary tract infection with flank pain
- Dehydration requiring IV fluids

ESI LEVEL 4 - LESS URGENT
Requires one resource.
Examples:
- Simple laceration (wound care only)
- Prescription refill with mild symptoms
- Urinalysis for UTI symptoms
- Simple X-ray for possible fracture

ESI LEVEL 5 - NON-URGENT
Requires no resources.
Examples:
- Medication refill
- Chronic complaint, no change
- Simple wound check

VITAL SIGN CONSIDERATIONS:
Danger zone vital signs that may warrant uptriage to ESI Level 2:
- Heart rate > 100 or < 50
- Respiratory rate > 20
- SpO2 < 92%
- Temperature > 38.5°C or < 35°C in adults
- Blood pressure: systolic < 90 or > 200

PEDIATRIC MODIFICATIONS:
Fever in infants:
- < 28 days with temp > 38°C → ESI Level 2
- 28-90 days with temp > 38°C → ESI Level 2 or 3 based on appearance
- Use pediatric vital sign ranges for age
    `,
  },
  {
    title: 'ICMR Guidelines for Management of Acute Chest Pain',
    source: 'ICMR' as const,
    version: '2023',
    description: 'Indian Council of Medical Research guidelines for acute chest pain management in emergency settings.',
    text: `
ICMR Clinical Practice Guidelines: Management of Acute Chest Pain in Emergency Settings

1. INITIAL ASSESSMENT (FIRST 10 MINUTES)
All patients presenting with acute chest pain should receive:
- 12-lead ECG within 10 minutes of arrival
- Continuous cardiac monitoring
- IV access
- Oxygen only if SpO2 < 90%
- Brief focused history (onset, character, radiation, associated symptoms)
- Aspirin 325 mg chewable (unless contraindicated)

2. HIGH-RISK FEATURES (REQUIRES IMMEDIATE CARDIOLOGY CONSULTATION)
- ST elevation in 2 or more contiguous leads → activate catheterization lab
- New left bundle branch block with chest pain
- Hemodynamic instability (SBP < 90 mmHg)
- Pulmonary edema
- Heart rate < 40 or > 150 with symptoms
- Syncope with chest pain

3. DIFFERENTIAL DIAGNOSIS OF ACUTE CHEST PAIN
Life-threatening causes (must exclude):
a) Acute Coronary Syndrome (ACS): crushing/pressure chest pain, radiation to left arm/jaw, 
   diaphoresis, nausea. Risk factors: age > 45M/55F, diabetes, hypertension, smoking, 
   family history, dyslipidemia.

b) Aortic Dissection: sudden "tearing" chest pain radiating to back, blood pressure
   differential between arms > 20 mmHg, widened mediastinum on CXR.
   Management: IV beta-blocker (target HR < 60), urgent CT angiography, surgical consultation.

c) Pulmonary Embolism: pleuritic chest pain, dyspnea, tachycardia, hypoxia.
   Risk factors: recent surgery, immobilization, malignancy, prior DVT/PE.
   Diagnosis: D-dimer (if low probability), CT pulmonary angiography.
   Treatment: anticoagulation with heparin, consider thrombolysis if massive PE.

d) Tension Pneumothorax: acute chest pain, respiratory distress, absent breath sounds
   on one side, tracheal deviation. Treatment: immediate needle decompression (2nd
   intercostal space, midclavicular line), followed by chest tube.

e) Cardiac Tamponade: Beck's triad (hypotension, muffled heart sounds, JVD).
   Diagnosis: bedside echocardiography. Treatment: pericardiocentesis.

4. TROPONIN-BASED RISK STRATIFICATION
- High-sensitivity troponin at 0 and 3 hours (or 0/1 hour with validated algorithm)
- Troponin > 99th percentile with rise/fall pattern → ACS likely
- Use HEART score for risk stratification:
  H - History (0-2 points)
  E - ECG (0-2 points)  
  A - Age (0-2 points)
  R - Risk factors (0-2 points)
  T - Troponin (0-2 points)
  Score 0-3: low risk, consider discharge with follow-up
  Score 4-6: moderate risk, admit for observation
  Score 7-10: high risk, aggressive treatment and cardiology consultation

5. SPECIAL POPULATIONS
Diabetic patients: may present with atypical symptoms (dyspnea, fatigue, nausea
without significant pain). Maintain high index of suspicion.

Elderly (> 75 years): atypical presentations common. Lower threshold for admission.

Women: may present with jaw pain, back pain, nausea, or fatigue rather than
classic chest pain. ECG changes may be subtle.
    `,
  },
  {
    title: 'Manchester Triage System (MTS) Clinical Guidelines',
    source: 'MTS' as const,
    version: '3.0',
    description: 'Manchester Triage System flowchart-based emergency triage guidelines.',
    text: `
Manchester Triage System (MTS) Version 3 - Clinical Decision Framework

OVERVIEW
The Manchester Triage System uses presentational flow charts to assign patients to one of
five clinical priority levels. Each flow chart consists of discriminators (key clinical features)
arranged in order of priority.

PRIORITY LEVELS:
- RED (Immediate, 0 minutes): Life-threatening condition
- ORANGE (Very Urgent, 10 minutes): Potentially life-threatening or time-critical
- YELLOW (Urgent, 60 minutes): Serious but not immediately life-threatening
- GREEN (Standard, 120 minutes): Routine emergency care
- BLUE (Non-Urgent, 240 minutes): Could be managed elsewhere

GENERAL DISCRIMINATORS (apply across all presentations):
RED discriminators:
- Airway compromise
- Inadequate breathing
- Exsanguinating hemorrhage
- Shock (clinical signs)
- Currently fitting
- Unresponsive child/adult

ORANGE discriminators:
- Severe pain (pain score 8-10)
- Uncontrollable major hemorrhage
- Altered conscious level (GCS < 14)
- Very hot adult (> 41°C)
- Very hot child (> 38.5°C with risk factors)
- Acute neurological deficit

YELLOW discriminators:
- Moderate pain (pain score 5-7)
- Warmth (fever 37.5-38.5°C)
- Hot adult (38.5-41°C)
- Persistent vomiting
- Acute mental health problem

GREEN discriminators:
- Mild pain (pain score 1-4)
- Warm (37-37.5°C)
- Recent mild symptoms
- Recent problem (< 7 days)

SPECIFIC FLOW CHARTS:

CHEST PAIN FLOW CHART:
1. Airway compromise → RED
2. Inadequate breathing → RED
3. Shock → RED
4. Severe pain (8-10) → ORANGE
5. Cardiac pain (crushing, radiating, with diaphoresis) → ORANGE
6. Pleuritic pain → ORANGE if with breathlessness
7. Moderate pain (5-7) → YELLOW
8. Recent chest pain → YELLOW
9. Mild pain → GREEN

BREATHING DIFFICULTY FLOW CHART:
1. Airway compromise → RED
2. Inadequate breathing → RED
3. Stridor → ORANGE
4. Severe respiratory distress → ORANGE
5. SpO2 < 95% on air → ORANGE
6. Moderate respiratory distress → YELLOW
7. Wheeze → YELLOW if no distress
8. Mild respiratory symptoms → GREEN

ABDOMINAL PAIN FLOW CHART:
1. Shock → RED
2. Severe pain → ORANGE
3. Haematemesis/melaena → ORANGE
4. Signs of peritonitis → ORANGE
5. Moderate pain → YELLOW
6. Vomiting → YELLOW
7. Mild pain → GREEN

TRAUMA FLOW CHART:
1. Airway compromise → RED
2. Exsanguinating hemorrhage → RED
3. Shock → RED
4. Unresponsive → RED
5. Severe pain → ORANGE
6. Significant mechanism of injury → ORANGE
7. Deformity → ORANGE
8. Moderate pain → YELLOW
9. Swelling → YELLOW
10. Recent injury, mild pain → GREEN
    `,
  },
];

async function main() {
  console.log('🚀 Seeding medical guidelines into RAG pipeline...\n');

  for (const g of SAMPLE_GUIDELINES) {
    console.log(`📄 Ingesting: ${g.title}...`);
    try {
      const result = await ingestGuideline({
        title: g.title,
        source: g.source,
        version: g.version,
        description: g.description,
        text: g.text,
        context: { userId: null },
      });
      console.log(`   ✅ Done — ${result.chunkCount} chunks indexed (guidelineId: ${result.guidelineId})\n`);
    } catch (err) {
      console.error(`   ❌ Failed:`, err);
    }
  }

  console.log('🏁 Guideline seeding complete!');
  process.exit(0);
}

main();
