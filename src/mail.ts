// Envío de correos. Sin SMTP configurado, el correo se muestra en la consola del servidor.
import nodemailer from 'nodemailer';
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
const transport = SMTP_HOST
  ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined })
  : null;
export const mailConfigured = !!transport;
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!transport) return console.log(`\n--- CORREO (SMTP sin configurar) ---\nPara: ${to}\nAsunto: ${subject}\n${text}\n------------------------------------\n`);
  try { await transport.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text }); }
  catch (e) { console.error('No se pudo enviar el correo:', (e as Error).message); }
}
