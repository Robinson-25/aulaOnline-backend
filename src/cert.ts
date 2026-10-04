import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import type { Response } from 'express';
import { q, type Row } from './db.ts';
import type { User } from './auth.ts';

export const SITE = process.env.SITE_NAME || 'Aula Pro Online';
export const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (prefix: string, n = 10): string => `${prefix}-${Array.from(crypto.randomBytes(n), (b) => ABC[b % ABC.length]).join('')}`;

export async function courseProgress(userId: number, courseId: number): Promise<{ total: number; done: number; percent: number }> {
  const total = (await q.get('SELECT COUNT(*) n FROM lessons WHERE course_id=?', courseId)).n;
  const done = (await q.get("SELECT COUNT(*) n FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=? AND l.course_id=? AND p.status='completada'", userId, courseId)).n;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

// Emite el certificado solo si todas las lecciones (incluidos los cuestionarios aprobados) están completas.
export async function ensureCertificate(user: User, courseId: number): Promise<Row | null> {
  const course = (await q.get('SELECT has_certificate FROM courses WHERE id=?', courseId));
  const existing = (await q.get('SELECT * FROM certificates WHERE user_id=? AND course_id=?', user.id, courseId));
  if (existing || !course?.has_certificate) return existing || null;
  const p = (await courseProgress(user.id, courseId));
  if (!p.total || p.done < p.total) return null;
  let code: string;
  do code = randomCode('APO'); while ((await q.get('SELECT 1 FROM certificates WHERE code=?', code)));
  (await q.run('INSERT INTO certificates (code,user_id,course_id,student_name) VALUES (?,?,?,?)', code, user.id, courseId, user.name));
  return (await q.get('SELECT * FROM certificates WHERE code=?', code)) ?? null;
}

export const fmtDate = (s: string): string => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' });

export async function certificatePdf(cert: Row, res: Response): Promise<void> {
  const course = (await q.get('SELECT title, instructor, duration_hours FROM courses WHERE id=?', cert.course_id));
  const url = `${PUBLIC_URL}/verificar/${cert.code}`;
  const qr = await QRCode.toBuffer(url, { margin: 1, width: 300, color: { dark: '#00275B' } });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificado-${cert.code}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width, H = doc.page.height, navy = '#00275B', red = '#E0212F';
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  doc.rect(0, 0, W, 18).fill(navy).rect(0, H - 18, W, 18).fill(red);
  doc.lineWidth(1.5).strokeColor(navy).rect(28, 40, W - 56, H - 80).stroke();
  doc.lineWidth(0.5).strokeColor('#B9C6DA').rect(36, 48, W - 72, H - 96).stroke();
  const center = (text: string, y: number, size: number, font: string, color: string, opts: object = {}) => doc.font(font).fontSize(size).fillColor(color).text(text, 80, y, { width: W - 160, align: 'center', ...opts });
  center(SITE.toUpperCase(), 78, 14, 'Helvetica-Bold', red, { characterSpacing: 3 });
  center('Certificado de finalización', 108, 34, 'Helvetica-Bold', navy);
  center('Se otorga el presente certificado a', 170, 13, 'Helvetica', '#475569');
  center(cert.student_name, 196, 30, 'Helvetica-Bold', '#0F172A');
  doc.moveTo(W / 2 - 170, 238).lineTo(W / 2 + 170, 238).lineWidth(1).strokeColor(red).stroke();
  center('por haber completado satisfactoriamente el curso', 252, 13, 'Helvetica', '#475569');
  center(course.title, 278, 22, 'Helvetica-Bold', navy);
  const extra = [course.duration_hours ? `Duración: ${course.duration_hours} horas` : null, course.instructor ? `Instructor: ${course.instructor}` : null].filter(Boolean).join('   ·   ');
  if (extra) center(extra, 318, 11, 'Helvetica', '#475569');
  if (cert.revoked) center('CERTIFICADO ANULADO', 345, 16, 'Helvetica-Bold', red);
  doc.image(qr, W - 190, H - 200, { width: 110 });
  doc.font('Helvetica').fontSize(8).fillColor('#475569').text('Escanea para verificar', W - 200, H - 84, { width: 130, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text('Fecha de emisión', 80, H - 150);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0F172A').text(fmtDate(cert.issued_at), 80, H - 134);
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text('Código de verificación', 80, H - 108);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0F172A').text(cert.code, 80, H - 92);
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(url, 80, H - 72);
  doc.end();
}
