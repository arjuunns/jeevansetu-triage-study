import PDFDocument from 'pdfkit';

import type { ReferralPayload } from '@jeevansetu/types';

/**
 * Phase 11 — PDF referral generator. Renders the doctor-approved referral
 * snapshot into a clinician-readable A4 document and resolves to a Buffer.
 * Pure rendering — no I/O beyond the in-memory stream.
 */
export function renderReferralPdf(payload: ReferralPayload, qrPngBuffer?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).fillColor('#0f766e').text('JeevanSetu', { continued: true });
    doc.fillColor('#111').fontSize(12).text('  — Clinical Referral', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#555').text(`Referral ID: ${payload.referralId}`);
    doc.text(`Generated: ${new Date(payload.generatedAt).toLocaleString()}`);
    if (qrPngBuffer) {
      try {
        doc.image(qrPngBuffer, doc.page.width - 130, 45, { width: 80 });
      } catch {
        /* QR optional */
      }
    }
    divider(doc);

    section(doc, 'Patient');
    kv(doc, 'Name', payload.patient.name);
    kv(doc, 'Age / Gender', `${payload.patient.age} / ${payload.patient.gender}`);
    kv(doc, 'Blood Group', payload.patient.bloodGroup);
    if (payload.patient.phone) kv(doc, 'Phone', payload.patient.phone);

    section(doc, 'Clinical Summary');
    kv(doc, 'Chief complaint', payload.clinical.chiefComplaint ?? '—');
    kv(doc, 'Primary symptom', payload.clinical.primarySymptom);
    if (payload.clinical.secondarySymptoms.length)
      kv(doc, 'Secondary symptoms', payload.clinical.secondarySymptoms.join(', '));
    kv(doc, 'Severity', payload.clinical.severity, payload.clinical.severity === 'CRITICAL' ? '#b91c1c' : '#111');

    section(doc, 'Vitals');
    const vitals = Object.entries(payload.clinical.vitals)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${v}`)
      .join('    ');
    doc.fontSize(10).fillColor('#111').text(vitals || 'No vitals recorded.');

    section(doc, 'AI Reasoning (doctor-approved)');
    doc.fontSize(10).fillColor('#111').text(payload.clinical.aiReasoning, { align: 'left' });
    if (payload.clinical.possibleConditions.length) {
      doc.moveDown(0.3);
      doc.fontSize(10).text(`Possible conditions: ${payload.clinical.possibleConditions.join(', ')}`);
    }
    if (payload.clinical.riskFactors.length) {
      doc.fontSize(10).text(`Risk factors: ${payload.clinical.riskFactors.join(', ')}`);
    }

    section(doc, 'Doctor Approval');
    kv(doc, 'Reviewed by', payload.approval.doctorName);
    kv(doc, 'Action', payload.approval.action);
    if (payload.approval.justification) kv(doc, 'Justification', payload.approval.justification);
    kv(doc, 'Approved at', new Date(payload.approval.approvedAt).toLocaleString());

    section(doc, 'Recommended Destination');
    kv(doc, 'Hospital', payload.destination.hospitalName);
    kv(doc, 'Department', payload.destination.department);
    if (payload.destination.address) kv(doc, 'Address', payload.destination.address);
    if (payload.destination.distanceKm !== undefined)
      kv(doc, 'Distance', `${payload.destination.distanceKm} km`);

    if (payload.citations.length) {
      section(doc, 'Guideline Evidence');
      payload.citations.forEach((c, i) => {
        doc.fontSize(9).fillColor('#0f766e').text(`[${i + 1}] (${c.source}) ${c.title}`);
        doc.fontSize(9).fillColor('#444').text(c.snippet, { indent: 12 });
        doc.moveDown(0.2);
      });
    }

    doc.moveDown(1);
    doc
      .fontSize(8)
      .fillColor('#888')
      .text(
        'This referral was assisted by AI and approved by a licensed clinician. JeevanSetu does not make autonomous medical decisions.',
        { align: 'center' },
      );

    doc.end();
  });
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.6);
  doc.fontSize(12).fillColor('#0f766e').text(title);
  doc.moveDown(0.2);
}

function kv(doc: PDFKit.PDFDocument, key: string, value: string, valueColor = '#111'): void {
  doc.fontSize(10).fillColor('#555').text(`${key}: `, { continued: true });
  doc.fillColor(valueColor).text(value);
}

function divider(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.4);
  doc
    .strokeColor('#e5e7eb')
    .lineWidth(1)
    .moveTo(50, doc.y)
    .lineTo(doc.page.width - 50, doc.y)
    .stroke();
}
