import { PrismaClient, VisitStatus, ReviewAction, ReferralStatus, EmergencyAlertStatus } from '@prisma/client';

/**
 * JeevanSetu — full demo seed.
 * Wipes operational tables and rebuilds a realistic night-shift dataset:
 * hospitals, patients, vitals, AI triage assessments (with reasoning,
 * citations and safety flags), hospital routing, referrals spread over the
 * past 14 days, doctor reviews (queue + history), emergency alerts, agent
 * pipeline runs and audit logs.
 */
const prisma = new PrismaClient();

const randomRange = (min: number, max: number) => Math.random() * (max - min) + min;
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomElement = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

// ─── Clinical scenario library ────────────────────────────────────────────────

interface Scenario {
  chiefComplaint: string;
  vitals: Record<string, unknown>;
  symptoms: { name: string; severity: 'MILD' | 'MODERATE' | 'SEVERE'; isPrimary?: boolean }[];
  aiSeverity: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
  esi: number;
  department: string;
  conditions: string[];
  tests: string[];
  riskFactors: string[];
  redFlags: string[];
  safetyCritical?: boolean;
  reasoning: string;
  citations: { source: string; title: string; snippet: string; score: number }[];
}

const scenarios: Scenario[] = [
  // ── CRITICAL ──
  {
    chiefComplaint: 'Crushing chest pain radiating to left arm with diaphoresis for 40 minutes',
    vitals: { oxygenSaturation: 89, heartRate: 118, systolicBp: 92, diastolicBp: 58, respiratoryRate: 26, temperatureC: 36.9 },
    symptoms: [
      { name: 'Crushing chest pain radiating to left arm', severity: 'SEVERE', isPrimary: true },
      { name: 'Shortness of breath', severity: 'SEVERE' },
      { name: 'Cold sweats', severity: 'MODERATE' },
    ],
    aiSeverity: 'CRITICAL', esi: 1, department: 'Cardiology',
    conditions: ['Acute ST-Elevation Myocardial Infarction (STEMI)', 'Unstable Angina', 'Aortic Dissection'],
    tests: ['12-lead ECG within 10 minutes', 'High-sensitivity Troponin I (0h/1h)', 'Portable Chest X-Ray', 'Bedside ECHO'],
    riskFactors: ['Hypertension history', 'Male >45', 'Active chest pain with autonomic features'],
    redFlags: ['SpO2 < 90%', 'Systolic BP < 100 mmHg'],
    safetyCritical: true,
    reasoning:
      'Presenting complaint of crushing chest pain with radiation to the left arm plus diaphoresis is a classic ACS presentation. Hypotension (92/58) and SpO2 89% indicate possible cardiogenic compromise. Per WHO ACS pathway and ESI criteria, this is an ESI-1 / CRITICAL presentation. Deterministic safety layer forced CRITICAL due to hypotension and hypoxia. Immediate cath-lab activation recommended; do not delay for troponin.',
    citations: [
      { source: 'WHO', title: 'WHO Package of Essential Noncommunicable Disease Interventions — Acute Coronary Syndromes', snippet: 'Patients presenting with chest pain suggestive of acute coronary occlusion require immediate ECG (within 10 minutes) and reperfusion strategy. Hypotension with pulmonary congestion indicates cardiogenic shock — activate primary PCI.', score: 0.94 },
      { source: 'ESI', title: 'Emergency Severity Index v4 Implementation Handbook', snippet: 'ESI-1 requires immediate life-saving intervention. Unstable vital signs (SBP < 90, SpO2 < 90) mandate level 1 assignment regardless of resources anticipated.', score: 0.91 },
      { source: 'ICMR', title: 'ICMR Public Health Foundation STEMI India Guidelines', snippet: 'Door-to-balloon time target of 90 minutes; thrombolysis within 30 minutes if PCI unavailable at first facility.', score: 0.87 },
    ],
  },
  {
    chiefComplaint: 'Sudden right-sided weakness and slurred speech, onset 70 minutes ago',
    vitals: { oxygenSaturation: 96, heartRate: 88, systolicBp: 178, diastolicBp: 102, respiratoryRate: 18, temperatureC: 36.8 },
    symptoms: [
      { name: 'Right-sided facial droop and arm weakness', severity: 'SEVERE', isPrimary: true },
      { name: 'Slurred speech', severity: 'SEVERE' },
    ],
    aiSeverity: 'CRITICAL', esi: 1, department: 'Neurology',
    conditions: ['Acute Ischemic Stroke (L/MCA)', 'Transient Ischemic Attack', 'Intracerebral Hemorrhage'],
    tests: ['STAT non-contrast CT head', 'CT Angiography head/neck', 'Random blood glucose', 'Coagulation profile'],
    riskFactors: ['Severe hypertension on arrival', 'Last-known-well within thrombolysis window'],
    redFlags: ['FAST positive', 'BP 178/102'],
    safetyCritical: true,
    reasoning:
      'FAST-positive presentation with last-known-well 70 minutes places the patient squarely inside the IV thrombolysis window (<4.5h). NIHSS assessment and STAT CT required before decision. Elevated BP is expected post-stroke; per guidelines do not lower below 220/120 unless thrombolysis planned. ESI-1 due to time-critical intervention requirement.',
    citations: [
      { source: 'WHO', title: 'WHO Global Action Plan on Epilepsy & Other Neurological Disorders — Stroke Pathway', snippet: 'Suspected acute stroke patients must undergo imaging within 20 minutes of arrival; door-to-needle target 60 minutes.', score: 0.93 },
      { source: 'MTS', title: 'Manchester Triage System — Neurological Presentation Discriminators', snippet: 'Acute neurological deficit with onset <6 hours is assigned RED priority (immediate).', score: 0.89 },
      { source: 'AIIMS', title: 'AIIMS Comprehensive Stroke Center Protocol', snippet: 'IV alteplase 0.9 mg/kg (max 90 mg) indicated within 4.5 hours of last-known-well after hemorrhage exclusion.', score: 0.85 },
    ],
  },
  {
    chiefComplaint: 'Found unconscious at home after fall from staircase, scalp bleeding',
    vitals: { oxygenSaturation: 91, heartRate: 128, systolicBp: 84, diastolicBp: 48, respiratoryRate: 28, temperatureC: 36.4, glasgowComaScale: 7, isUnconscious: true },
    symptoms: [
      { name: 'Loss of consciousness', severity: 'SEVERE', isPrimary: true },
      { name: 'Scalp laceration with active bleeding', severity: 'SEVERE' },
      { name: 'Vomiting', severity: 'MODERATE' },
    ],
    aiSeverity: 'CRITICAL', esi: 1, department: 'Trauma',
    conditions: ['Severe Traumatic Brain Injury', 'Hemorrhagic Shock', 'Cervical Spine Injury'],
    tests: ['STAT CT trauma series (head/c-spine/chest/pelvis)', 'Type & Crossmatch 4 units', 'Arterial Blood Gas', 'FAST ultrasound'],
    riskFactors: ['GCS 7 — airway protection compromised', 'Class III hemorrhagic shock'],
    redFlags: ['GCS ≤ 8', 'Unconscious', 'Systolic BP < 90 mmHg'],
    safetyCritical: true,
    reasoning:
      'GCS 7 meets the intubation threshold (GCS ≤ 8) and concurrent shock suggests internal hemorrhage. ATLS primary survey takes precedence; massive transfusion protocol should be activated. Deterministic layer escalated severity to CRITICAL on unconsciousness rule R-UNCONSCIOUS-01.',
    citations: [
      { source: 'WHO', title: 'WHO Road Safety — Prehospital Trauma Care Systems', snippet: 'Hypotensive head-injured patients have doubled mortality; maintain SBP ≥ 110 and SpO2 ≥ 94%.', score: 0.92 },
      { source: 'ESI', title: 'Emergency Severity Index v4 Implementation Handbook', snippet: 'Requirement for immediate airway intervention assigns ESI-1.', score: 0.9 },
      { source: 'ICMR', title: 'ICMR Trauma Care Facility Guidelines India', snippet: 'GCS ≤ 8 with hemodynamic instability requires transfer to Level-1 trauma facility with 24h neurosurgical cover.', score: 0.88 },
    ],
  },
  {
    chiefComplaint: 'Breathlessness at rest with high-grade fever for 3 days',
    vitals: { oxygenSaturation: 87, heartRate: 122, systolicBp: 105, diastolicBp: 68, respiratoryRate: 32, temperatureC: 39.8 },
    symptoms: [
      { name: 'Breathlessness at rest', severity: 'SEVERE', isPrimary: true },
      { name: 'Productive cough with rust-colored sputum', severity: 'SEVERE' },
      { name: 'High fever', severity: 'MODERATE' },
    ],
    aiSeverity: 'CRITICAL', esi: 1, department: 'Pulmonology',
    conditions: ['Community-Acquired Pneumonia (severe)', 'Sepsis with Hypoxemia', 'ARDS'],
    tests: ['Chest X-Ray PA/AP', 'CBC with differential', 'Blood cultures x2', 'Lactate', 'Sputum Gram stain'],
    riskFactors: ['SpO2 87% on room air', 'Respiratory rate 32', 'Fever 39.8°C'],
    redFlags: ['SpO2 < 90%', 'Respiratory rate > 30'],
    safetyCritical: true,
    reasoning:
      'Hypoxia (SpO2 87%) with tachypnea 32 and high fever satisfies CURB-65 severe criteria and the deterministic hypoxia override. Sepsis screen (lactate, cultures) must run in parallel with supplemental oxygen. ESI-1 given imminent respiratory failure risk.',
    citations: [
      { source: 'WHO', title: 'WHO Clinical Management of Severe Acute Respiratory Infection', snippet: 'SpO2 < 90% warrants immediate oxygen therapy; consider NIV/HFNC if failing, escalate to ICU for invasive ventilation.', score: 0.93 },
      { source: 'ICMR', title: 'ICMR Treatment Guidelines for Community-Acquired Pneumonia', snippet: 'Severe CAP: empiric beta-lactam + macrolide within 4 hours of diagnosis after cultures.', score: 0.88 },
      { source: 'ESI', title: 'Emergency Severity Index v4 Implementation Handbook', snippet: 'Unstable vital signs define ESI-1; hypoxia on room air qualifies.', score: 0.86 },
    ],
  },
  // ── HIGH ──
  {
    chiefComplaint: 'Severe right lower abdominal pain with bilious vomiting for 12 hours',
    vitals: { oxygenSaturation: 98, heartRate: 104, systolicBp: 124, diastolicBp: 78, respiratoryRate: 22, temperatureC: 38.4 },
    symptoms: [
      { name: 'Right lower quadrant tenderness with rebound', severity: 'SEVERE', isPrimary: true },
      { name: 'Nausea and vomiting', severity: 'MODERATE' },
      { name: 'Anorexia', severity: 'MILD' },
    ],
    aiSeverity: 'HIGH', esi: 2, department: 'General Surgery',
    conditions: ['Acute Appendicitis', 'Mesenteric Adenitis', 'Ectopic Pregnancy (if female)'],
    tests: ['CBC', 'Ultrasound abdomen', 'Urinalysis', 'Beta-hCG if applicable'],
    riskFactors: ['Peritoneal signs on exam', 'Low-grade fever'],
    redFlags: [],
    reasoning:
      'McBurney-point tenderness with rebound and fever raises Alvarado score to 7 — surgical consult within one hour indicated. No hemodynamic instability, so ESI-2 (high-risk resource-intensive, one-hour physician contact).',
    citations: [
      { source: 'MTS', title: 'Manchester Triage System — Abdominal Pain Chart', snippet: 'Severe pain with rebound tenderness maps to ORANGE (very urgent) — clinician within 10–60 minutes.', score: 0.9 },
      { source: 'WHO', title: 'WHO Surgical Safety & Acute Abdomen Protocols', snippet: 'Suspected appendicitis with peritonism requires surgical review within 60 minutes and serial examination.', score: 0.84 },
    ],
  },
  {
    chiefComplaint: 'Two episodes of generalized seizure, still drowsy',
    vitals: { oxygenSaturation: 95, heartRate: 108, systolicBp: 148, diastolicBp: 90, respiratoryRate: 20, temperatureC: 37.6 },
    symptoms: [
      { name: 'Generalized tonic-clonic seizures', severity: 'SEVERE', isPrimary: true },
      { name: 'Post-ictal drowsiness', severity: 'MODERATE' },
      { name: 'Tongue biting', severity: 'MILD' },
    ],
    aiSeverity: 'HIGH', esi: 2, department: 'Neurology',
    conditions: ['New-onset Seizure Disorder', 'Central Nervous System Infection', 'Metabolic Derangement'],
    tests: ['Random blood glucose', 'Serum electrolytes', 'CT head non-contrast', 'EEG consult'],
    riskFactors: ['Multiple seizures without full recovery between', 'Unknown seizure history'],
    redFlags: [],
    reasoning:
      'More than one seizure in 24h without return to baseline defines impending status epilepticus risk. Glucose and electrolytes must precede imaging where feasible. ESI-2 given active post-ictal state requiring continuous observation.',
    citations: [
      { source: 'WHO', title: 'WHO Epilepsy — Technical Criteria for Diagnosis & Management', snippet: 'Benzodiazepine for seizures lasting >5 min; investigate second seizure within same illness episode urgently.', score: 0.9 },
      { source: 'ICMR', title: 'ICMR Standards for Emergency Neurological Care', snippet: 'Post-ictal patients require 1:1 nursing observation until GCS returns to pre-morbid level.', score: 0.82 },
    ],
  },
  {
    chiefComplaint: 'Deep laceration to forearm from glass, bleeding not controlled by pressure',
    vitals: { oxygenSaturation: 99, heartRate: 112, systolicBp: 118, diastolicBp: 72, respiratoryRate: 20, temperatureC: 36.7 },
    symptoms: [
      { name: 'Active venous bleeding from forearm wound', severity: 'SEVERE', isPrimary: true },
      { name: 'Numbness distal to injury', severity: 'MODERATE' },
    ],
    aiSeverity: 'HIGH', esi: 2, department: 'Emergency',
    conditions: ['Vascular Injury', 'Peripheral Nerve Injury', 'Tendon Laceration'],
    tests: ['CBC & Group & Save', 'Hand/wrist X-ray (glass foreign body)', 'Arterial Doppler if pulses weak'],
    riskFactors: ['Ongoing hemorrhage', 'Possible tendon/nerve involvement'],
    redFlags: [],
    reasoning:
      'Distal neurovascular deficit with uncontrolled bleeding elevates this above simple laceration. Requires urgent surgical exploration — ESI-2, two-resource class with time-sensitive intervention.',
    citations: [
      { source: 'MTS', title: 'Manchester Triage System — Wounds Chart', snippet: 'Heavy haemorrhage controlled only by pressure → ORANGE; explore within one hour.', score: 0.88 },
      { source: 'ESI', title: 'Emergency Severity Index v4 Implementation Handbook', snippet: 'High-risk mechanism with neurovascular compromise → ESI-2.', score: 0.83 },
    ],
  },
  // ── MODERATE ──
  {
    chiefComplaint: 'Persistent loose stools and vomiting since two days',
    vitals: { oxygenSaturation: 98, heartRate: 96, systolicBp: 108, diastolicBp: 66, respiratoryRate: 18, temperatureC: 37.8 },
    symptoms: [
      { name: 'Watery diarrhea 8–10 episodes/day', severity: 'MODERATE', isPrimary: true },
      { name: 'Reduced urine output', severity: 'MODERATE' },
      { name: 'Abdominal cramps', severity: 'MILD' },
    ],
    aiSeverity: 'MODERATE', esi: 3, department: 'General Medicine',
    conditions: ['Acute Gastroenteritis', 'Food-borne Illness', 'Early Hypovolemia'],
    tests: ['Serum electrolytes & creatinine', 'Stool routine/microscopy', 'CBC'],
    riskFactors: ['Orthostatic symptoms', 'Reduced oral intake'],
    redFlags: [],
    reasoning:
      'Moderate dehydration signs without shock or severe electrolyte symptoms. Oral rehydration plus antiemetics with reassessment; labs to exclude renal impairment. ESI-3 (two or more resources, stable).',
    citations: [
      { source: 'WHO', title: 'WHO The Treatment of Diarrhoea — A Manual for Physicians', snippet: 'Plan B ORS 75 ml/kg over 4 hours for some dehydration; reassess and switch plans based on response.', score: 0.91 },
      { source: 'ICMR', title: 'ICMR Acute Diarrheal Diseases Management', snippet: 'Zinc supplementation and continued feeding reduce duration; antibiotics reserved for dysentery/cholera.', score: 0.8 },
    ],
  },
  {
    chiefComplaint: 'Ankle twisted playing football — cannot bear weight, marked swelling',
    vitals: { oxygenSaturation: 99, heartRate: 84, systolicBp: 126, diastolicBp: 80, respiratoryRate: 16, temperatureC: 36.8 },
    symptoms: [
      { name: 'Lateral ankle pain and swelling', severity: 'MODERATE', isPrimary: true },
      { name: 'Inability to bear weight', severity: 'MODERATE' },
    ],
    aiSeverity: 'MODERATE', esi: 3, department: 'Orthopedics',
    conditions: ['Ankle Fracture (Ottawa positive)', 'Grade II-III Ligament Tear'],
    tests: ['Ankle X-ray series (Ottawa rules met)'],
    riskFactors: ['Ottawa ankle criteria positive'],
    redFlags: [],
    reasoning:
      'Inability to bear weight four steps triggers Ottawa radiographic criteria. Stable vitals, isolated limb injury — ESI-3 with splinting and analgesia while awaiting imaging.',
    citations: [
      { source: 'MTS', title: 'Manchester Triage System — Limb Problems', snippet: 'Deformity or inability to weight-bear without neurovascular deficit → YELLOW (urgent, ≤1h).', score: 0.87 },
      { source: 'OTHER', title: 'Ottawa Ankle Rules — Validation Cohort (JAMA)', snippet: 'X-ray indicated only with bone tenderness at malleoli or base of 5th metatarsal/navicular, or inability to bear weight.', score: 0.85 },
    ],
  },
  // ── LOW ──
  {
    chiefComplaint: 'Dry cough and sore throat for 3 days, no fever',
    vitals: { oxygenSaturation: 99, heartRate: 78, systolicBp: 122, diastolicBp: 78, respiratoryRate: 14, temperatureC: 36.6 },
    symptoms: [
      { name: 'Dry cough', severity: 'MILD', isPrimary: true },
      { name: 'Sore throat', severity: 'MILD' },
    ],
    aiSeverity: 'LOW', esi: 5, department: 'General Medicine',
    conditions: ['Upper Respiratory Tract Infection', 'Allergic Pharyngitis'],
    tests: [],
    riskFactors: [],
    redFlags: [],
    reasoning:
      'Afebrile, normal vitals, no respiratory distress and symptom duration under one week — viral URTI most likely. Single-resource visit; symptomatic therapy and safety-netting advice suffice. ESI-5.',
    citations: [
      { source: 'ESI', title: 'Emergency Severity Index v4 Implementation Handbook', snippet: 'No resources anticipated and stable vital signs → ESI-5.', score: 0.9 },
      { source: 'WHO', title: 'WHO Primary Care Management of Respiratory Illness', snippet: 'Antibiotics not indicated for uncomplicated viral pharyngitis; advise hydration, analgesia, return precautions.', score: 0.79 },
    ],
  },
  {
    chiefComplaint: 'Medication refill for hypertension, running out tomorrow',
    vitals: { oxygenSaturation: 98, heartRate: 74, systolicBp: 132, diastolicBp: 84, respiratoryRate: 14, temperatureC: 36.7 },
    symptoms: [{ name: 'Chronic hypertension follow-up', severity: 'MILD', isPrimary: true }],
    aiSeverity: 'LOW', esi: 5, department: 'General Medicine',
    conditions: ['Essential Hypertension — controlled'],
    tests: [],
    riskFactors: [],
    redFlags: [],
    reasoning: 'Routine prescription refill with controlled home readings. ESI-5; route to outpatient pharmacy service where available.',
    citations: [{ source: 'ICMR', title: 'ICMR Hypertension Task Force — Follow-up Norms', snippet: 'Controlled hypertensives may receive up to 90-day refills via primary care without ER workup.', score: 0.81 }],
  },
];

async function main(): Promise<void> {
  console.log('🌱 JeevanSetu demo seed — rebuilding realistic dataset...');

  // ── 0. Wipe operational tables (child-first) ──
  console.log('Clearing existing data...');
  await prisma.referralDocument.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.hospitalRouting.deleteMany();
  await prisma.emergencyAlert.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.doctorReview.deleteMany();
  await prisma.aIReasoning.deleteMany();
  await prisma.guidelineCitationRecord.deleteMany();
  await prisma.triageDecision.deleteMany();
  await prisma.triageAssessment.deleteMany();
  await prisma.symptom.deleteMany();
  await prisma.vitalSigns.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.specialist.deleteMany();
  await prisma.hospitalResource.deleteMany();
  await prisma.department.deleteMany();
  await prisma.hospitalCapacity.deleteMany();
  await prisma.hospital.deleteMany();
  await prisma.user.deleteMany();

  // ── 1. Users ──
  console.log('Provisioning staff...');
  const staffSpecs = [
    { clerkUserId: 'dev_nurse', email: 'nurse@jeevansetu.health', role: 'NURSE' as const, firstName: 'Asha', lastName: 'Kaur' },
    { clerkUserId: 'dev_doctor', email: 'doctor@jeevansetu.health', role: 'DOCTOR' as const, firstName: 'Ravi', lastName: 'Menon' },
    { clerkUserId: 'dev_doctor2', email: 'doctor2@jeevansetu.health', role: 'DOCTOR' as const, firstName: 'Priya', lastName: 'Raghavan' },
    { clerkUserId: 'dev_admin', email: 'admin@jeevansetu.health', role: 'HOSPITAL_ADMIN' as const, firstName: 'Meera', lastName: 'Shetty' },
    { clerkUserId: 'dev_cmo', email: 'cmo@jeevansetu.health', role: 'CMO' as const, firstName: 'Sanjay', lastName: 'Deshpande' },
    { clerkUserId: 'dev_super', email: 'super@jeevansetu.health', role: 'SUPER_ADMIN' as const, firstName: 'Root', lastName: 'Admin' },
  ];
  const users: Record<string, { id: string }> = {};
  for (const u of staffSpecs) {
    users[u.clerkUserId] = await prisma.user.create({ data: u });
  }
  const nurse = users.dev_nurse;
  const doctors = [users.dev_doctor, users.dev_doctor2];

  // ── 2. Hospitals ──
  console.log('Provisioning 25 hospitals...');
  const cities = ['Chandigarh', 'Mohali', 'Panchkula'];
  const states: Record<string, string> = { Chandigarh: 'Chandigarh', Mohali: 'Punjab', Panchkula: 'Haryana' };
  const tiers = ['BASIC', 'INTERMEDIATE', 'ADVANCED', 'COMPREHENSIVE'] as const;
  const specialtiesPool = ['Emergency', 'Cardiology', 'Neurology', 'Orthopedics', 'Pediatrics', 'General Medicine', 'Trauma', 'Pulmonology'];
  const resourcesPool = ['CT Scanner', 'Cath Lab', 'MRI', 'Dialysis', 'X-Ray', 'Ultrasound', 'ICU Ventilator'];
  const brandPool = ['Fortis', 'Max', 'Apollo', 'Civil', 'General', 'Medicity', 'Care'];

  const hospitals: { id: string; name: string; lat: number; lng: number }[] = [];
  for (let i = 1; i <= 25; i++) {
    const cityName = randomElement(cities);
    const tier = randomElement(tiers);
    // Bias capacity so occupancy spans ~30–97%.
    const icuTotal = randomInt(5, 50);
    const genTotal = randomInt(50, 400);
    const ventTotal = randomInt(2, 35);
    const ambTotal = randomInt(2, 15);
    const lat = randomRange(30.68, 30.77);
    const lng = randomRange(76.69, 76.85);
    const name = `Sector ${randomInt(1, 70)} ${randomElement(brandPool)} Hospital`;
    const h = await prisma.hospital.create({
      data: {
        name,
        address: `Sector ${randomInt(1, 70)}, ${cityName}`,
        city: cityName,
        state: states[cityName],
        latitude: lat,
        longitude: lng,
        phone: `+919815${randomInt(100000, 999999)}`,
        email: `contact@hosp${i}.jeevansetu.health`,
        emergencyLevel: tier,
        isTraumaCenter: tier === 'COMPREHENSIVE' || (tier === 'ADVANCED' && Math.random() > 0.4),
        capacity: {
          create: {
            icuBedsTotal: icuTotal,
            icuBedsAvailable: Math.round(icuTotal * randomRange(0.02, 0.7)),
            generalBedsTotal: genTotal,
            generalBedsAvailable: Math.round(genTotal * randomRange(0.03, 0.7)),
            ventilatorsTotal: ventTotal,
            ventilatorsAvailable: randomInt(0, ventTotal),
            ambulancesTotal: ambTotal,
            ambulancesAvailable: randomInt(1, ambTotal),
          },
        },
        departments: { create: specialtiesPool.filter(() => Math.random() > 0.3).map((n) => ({ name: n })) },
        specialists: {
          create: [
            { name: `Dr. Amit Sharma`, specialty: 'General Medicine', isOnDuty: true },
            { name: `Dr. Sarah Verma`, specialty: 'Emergency', isOnDuty: Math.random() > 0.3 },
            { name: `Dr. Nikhil Bose`, specialty: 'Cardiology', isOnDuty: Math.random() > 0.5 },
          ],
        },
        resources: { create: resourcesPool.filter(() => Math.random() > 0.4).map((n) => ({ name: n, category: 'Equipment' })) },
      },
    });
    hospitals.push({ id: h.id, name: h.name, lat, lng });
  }

  // ── 3. Patients, visits, triage pipeline ──
  console.log('Provisioning patients with triage, routing, referrals and reviews...');
  const firstNames = ['Arjun', 'Vikram', 'Priya', 'Anjali', 'Rahul', 'Aditya', 'Neha', 'Kabir', 'Rohan', 'Sneha', 'Deepak', 'Aarav', 'Simran', 'Ishaan', 'Meera', 'Riya', 'Karan', 'Pooja', 'Sunita', 'Rajesh'];
  const lastNames = ['Sharma', 'Verma', 'Mehta', 'Gupta', 'Singh', 'Patel', 'Reddy', 'Nair', 'Kumar', 'Joshi', 'Chawla', 'Soni', 'Gill', 'Kapoor', 'Das', 'Roy', 'Sen', 'Rao', 'Bose', 'Deshmukh'];
  const genders = ['MALE', 'FEMALE', 'OTHER'] as const;
  const bloodGroups = ['A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE'] as const;
  const models = ['gemini-2.0-flash', 'llama3.1:8b'];

  let queueCount = 0;
  let historyCount = 0;

  for (let i = 1; i <= 70; i++) {
    const scenario = scenarios[i % scenarios.length];
    const age = scenario.esi === 1 && Math.random() > 0.5 ? randomInt(55, 84) : randomInt(8, 80);
    // Arrival spread across the last ~10 hours so the queue looks live.
    const arrivedAt = minutesAgo(randomInt(4, 600));
    const model = randomElement(models);

    const patient = await prisma.patient.create({
      data: {
        name: `${randomElement(firstNames)} ${randomElement(lastNames)}`,
        age,
        gender: randomElement(genders),
        bloodGroup: randomElement(bloodGroups),
        phone: `+919988${randomInt(100000, 999999)}`,
        allergies: Math.random() > 0.75 ? [randomElement(['Penicillin', 'Sulfa drugs', 'Dust', 'Peanuts'])] : [],
        existingDiseases: Math.random() > 0.6 ? [randomElement(['Hypertension', 'Type 2 Diabetes', 'Asthma', 'Hypothyroidism'])] : [],
        medications: Math.random() > 0.6 ? [randomElement(['Amlodipine', 'Metformin', 'Salbutamol inhaler', 'Levothyroxine'])] : [],
        registeredById: nurse.id,
        createdAt: arrivedAt,
      },
    });

    // Decide lifecycle: ~55% pending in review queue, 45% already reviewed.
    const reviewed = i % 100 < 45;
    const action: ReviewAction = reviewed ? randomElement(['APPROVE', 'APPROVE', 'APPROVE', 'MODIFY', 'OVERRIDE', 'REJECT']) : 'APPROVE';
    const finalSeverity =
      !reviewed || action === 'APPROVE'
        ? scenario.aiSeverity
        : action === 'REJECT'
          ? null
          : action === 'OVERRIDE'
            ? randomElement(['CRITICAL', 'HIGH', 'MODERATE'] as const)
            : scenario.aiSeverity === 'CRITICAL'
              ? 'HIGH'
              : 'CRITICAL';

    const selected = randomElement(hospitals.slice(0, 12));
    const ranked = [...hospitals].sort(() => Math.random() - 0.5).slice(0, 4)
      .map((h, idx) => ({
        hospitalId: h.id,
        name: h.name,
        distanceKm: Number(randomRange(1.2, 22).toFixed(1)),
        availableBeds: randomInt(0, 40),
        score: Number((0.95 - idx * randomRange(0.08, 0.15)).toFixed(3)),
        reasoning:
          idx === 0
            ? `${h.name} has ${scenario.department} coverage with ventilator capacity and shortest weighted distance (${Number(randomRange(1.2, 6).toFixed(1))} km) for a ${scenario.aiSeverity.toLowerCase()} case.`
            : `Candidate fallback — adequate beds but longer route or missing ${scenario.department} specialization.`,
      }));

    const visitStatus: VisitStatus = !reviewed
      ? randomElement(['TRIAGED', 'UNDER_REVIEW'] as const)
      : action === 'REJECT'
        ? 'CANCELLED'
        : Math.random() > 0.5 ? 'REFERRED' : 'APPROVED';

    const needsReferral = reviewed && action !== 'REJECT';
    const referralAt = daysAgo(randomInt(0, 13));

    const visit = await prisma.visit.create({
      data: {
        patientId: patient.id,
        status: visitStatus,
        chiefComplaint: scenario.chiefComplaint,
        arrivalAt: arrivedAt,
        createdAt: arrivedAt,
        vitals: { create: { ...scenario.vitals, recordedAt: arrivedAt, createdAt: arrivedAt } },
        symptoms: {
          create: scenario.symptoms.map((s) => ({
            name: s.name,
            severity: s.severity,
            isPrimary: s.isPrimary ?? false,
            duration: randomElement(['30 minutes', '2 hours', '1 day', '2 days', '3 days']),
          })),
        },
      },
    });

    // Agent executions feed avg triage latency + pipeline modal.
    const triageLatency = randomInt(850, 2400);
    await prisma.agentExecution.createMany({
      data: [
        { visitId: visit.id, agentType: 'PATIENT_INTAKE', status: 'SUCCEEDED', latencyMs: randomInt(200, 700), tokensUsed: randomInt(300, 900), input: { source: 'MANUAL_INTAKE_FORM' }, output: { patientId: patient.id }, supervisorVerdict: { approved: true, issues: [], notes: 'Schema validated.' }, createdAt: arrivedAt },
        { visitId: visit.id, agentType: 'TRIAGE', status: 'SUCCEEDED', latencyMs: triageLatency, tokensUsed: randomInt(900, 2100), input: { visitId: visit.id }, output: { severity: scenario.aiSeverity, esi: scenario.esi }, supervisorVerdict: { approved: true, issues: [], notes: 'Grounded in retrieved guidance.' }, createdAt: arrivedAt },
        ...(needsReferral
          ? [{
              visitId: visit.id, agentType: 'ROUTING' as const, status: 'SUCCEEDED' as const, latencyMs: randomInt(150, 500), tokensUsed: randomInt(100, 400),
              input: { requiredDepartment: scenario.department },
              output: { selectedHospitalId: selected.id },
              supervisorVerdict: { approved: true, issues: [] as string[], notes: 'Capacity verified against live snapshot.' },
              createdAt: arrivedAt,
            }]
          : []),
      ],
    });

    const confidenceBase = scenario.aiSeverity === 'CRITICAL' ? 0.9 : scenario.aiSeverity === 'HIGH' ? 0.84 : 0.8;
    const assessment = await prisma.triageAssessment.create({
      data: {
        visitId: visit.id,
        safetyIsCritical: !!scenario.safetyCritical,
        safetyForcedSeverity: scenario.safetyCritical ? 'CRITICAL' : null,
        safetyTriggeredRules: scenario.redFlags.map((f, idx) => ({ ruleId: `R-${idx + 1}`, label: f, rationale: `Deterministic threshold breached: ${f}` })),
        aiSeverity: scenario.aiSeverity,
        esiLevel: scenario.esi,
        aiConfidence: Number(randomRange(confidenceBase, Math.min(confidenceBase + 0.09, 0.985)).toFixed(3)),
        recommendedDepartment: scenario.department,
        possibleConditions: scenario.conditions,
        recommendedTests: scenario.tests,
        riskFactors: scenario.riskFactors,
        redFlags: scenario.redFlags,
        finalSeverity: finalSeverity,
        reasoning: {
          create: {
            model,
            promptTokens: randomInt(1100, 1900),
            completionTokens: randomInt(380, 900),
            reasoningText: scenario.reasoning,
            rawOutput: { severity: scenario.aiSeverity, esi: scenario.esi, department: scenario.department, conditions: scenario.conditions },
          },
        },
        citations: {
          create: scenario.citations.map((c) => ({
            chunkId: `${c.source.toLowerCase()}-chunk-${randomInt(10, 99)}`,
            source: c.source,
            title: c.title,
            snippet: c.snippet,
            page: randomInt(3, 140),
            score: c.score,
          })),
        },
        createdAt: arrivedAt,
      },
    });

    await prisma.hospitalRouting.create({
      data: {
        visitId: visit.id,
        selectedHospitalId: needsReferral ? selected.id : null,
        rankedCandidates: ranked,
        weightsUsed: { distance: 0.35, capacity: 0.25, specialization: 0.3, equipment: 0.1 },
        requiredDepartment: scenario.department,
        createdAt: arrivedAt,
      },
    });

    if (!reviewed) {
      queueCount++;
      if (scenario.safetyCritical && Math.random() > 0.4) {
        await prisma.emergencyAlert.create({
          data: {
            visitId: visit.id,
            status: Math.random() > 0.35 ? 'ACTIVE' : 'ACKNOWLEDGED',
            severity: 'CRITICAL',
            title: `EMERGENCY: ${patient.name} — ${scenario.redFlags[0] ?? 'critical vitals'}`,
            message: `Safety layer flagged ${scenario.redFlags.join(', ') || 'critical deterioration'} for ${patient.name} (${age}/${patient.gender}). Immediate specialist review required.`,
            triggeredRules: scenario.redFlags,
            createdAt: minutesAgo(randomInt(2, 45)),
          },
        });
      }
    } else if (action !== 'REJECT') {
      historyCount++;
      const reviewedBy = randomElement(doctors);
      const justifications = [
        'Clinical picture at bedside differs slightly from chart narrative — adjusted severity after direct examination.',
        'ECG changes warrant escalation despite initially stable vitals.',
        'Patient responded well to initial management; downgraded for ward-level care.',
        'Confirmed AI recommendation after independent assessment; documentation complete.',
      ];
      await prisma.doctorReview.create({
        data: {
          assessmentId: assessment.id,
          doctorId: reviewedBy.id,
          action,
          justification: action === 'APPROVE' ? randomElement(justifications.slice(3)) : randomElement(justifications),
          overrideSeverity: action === 'MODIFY' || action === 'OVERRIDE' ? finalSeverity : null,
          reviewedAt: new Date(arrivedAt.getTime() + randomInt(10, 180) * 60_000),
          createdAt: arrivedAt,
        },
      });

      if (needsReferral) {
        await prisma.referral.create({
          data: {
            visitId: visit.id,
            hospitalId: selected.id,
            status: randomElement(['GENERATED', 'SENT', 'SENT', 'ACCEPTED', 'COMPLETED'] as ReferralStatus[]),
            referralCode: `REF-${new Date().getFullYear()}-${String(1000 + i)}`,
            payload: {
              patient: { name: patient.name, age, gender: patient.gender, bloodGroup: patient.bloodGroup },
              severity: finalSeverity,
              department: scenario.department,
              chiefComplaint: scenario.chiefComplaint,
              vitals: scenario.vitals,
            },
            documents: {
              create: [
                { format: 'PDF', url: `referrals/${visit.id}/referral.pdf`, checksum: `sha256-${Math.random().toString(36).slice(2, 12)}`, sizeBytes: randomInt(80_000, 400_000), createdAt: referralAt },
                { format: 'FHIR_JSON', url: `referrals/${visit.id}/bundle.fhir.json`, checksum: `sha256-${Math.random().toString(36).slice(2, 12)}`, sizeBytes: randomInt(4_000, 30_000), createdAt: referralAt },
                { format: 'QR_CODE', url: `referrals/${visit.id}/qr.png`, checksum: `sha256-${Math.random().toString(36).slice(2, 12)}`, sizeBytes: randomInt(2_000, 12_000), createdAt: referralAt },
              ],
            },
            createdAt: referralAt,
          },
        });
      }

      if (Math.random() > 0.55) {
        await prisma.notification.create({
          data: {
            userId: reviewedBy.id,
            type: 'DOCTOR_REVIEW_REQUIRED',
            channel: 'IN_APP',
            status: 'READ',
            title: `Review completed — ${patient.name}`,
            body: `${action} recorded for ${patient.name}; final severity ${finalSeverity ?? 'rejected'}.`,
            readAt: minutesAgo(randomInt(5, 300)),
            sentAt: minutesAgo(randomInt(10, 320)),
            createdAt: minutesAgo(randomInt(10, 330)),
          },
        });
      }
    }

    // Audit trail entries for the ledger.
    await prisma.auditLog.createMany({
      data: [
        { action: 'PATIENT_CREATED', entityType: 'Patient', entityId: patient.id, userId: nurse.id, newState: { name: patient.name, age }, ipAddress: '10.0.0.24', metadata: { channel: 'intake-form' }, createdAt: arrivedAt },
        { action: 'AI_TRIAGE_EXECUTED', entityType: 'Visit', entityId: visit.id, userId: null, newState: { severity: scenario.aiSeverity, confidence: assessment.aiConfidence, model }, ipAddress: 'internal', metadata: { engineVersion: 'triage-graph-v1' }, createdAt: arrivedAt },
        ...(reviewed ? [{ action: action === 'APPROVE' ? 'DOCTOR_APPROVED' : action === 'REJECT' ? 'DOCTOR_REJECTED' : 'DOCTOR_OVERRIDDEN', entityType: 'TriageAssessment', entityId: assessment.id, userId: randomElement(doctors).id, newState: { action, finalSeverity }, ipAddress: '10.0.0.31', metadata: {}, createdAt: new Date(arrivedAt.getTime() + 90 * 60_000) }] : []),
      ] as any,
    });
  }

  console.log(`✅ Seeded 70 visits — ${queueCount} pending in review queue, ${historyCount} processed.`);
  console.log('   Hospitals: 25 · Alerts: active criticals present · Referrals spread over 14 days');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
