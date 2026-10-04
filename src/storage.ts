// Dónde se guardan los archivos subidos (portadas, materiales, videos, comprobantes).
// - Con CLOUDINARY_* en .env: en Cloudinary (no se pierden al desplegar).
// - Sin esas claves: en la carpeta local data/uploads (útil para desarrollo).
import { v2 as cloudinary } from 'cloudinary';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.ts';

const E = process.env;
export const cloud = !!(E.CLOUDINARY_CLOUD_NAME && E.CLOUDINARY_API_KEY && E.CLOUDINARY_API_SECRET);
// Carpeta dentro de Cloudinary: separa estos archivos de los de otros proyectos de la misma cuenta.
const FOLDER = (E.CLOUDINARY_FOLDER || 'aulaonline').replace(/[^\w-]/g, '');
/** Tamaño máximo de video en MB (el plan gratuito de Cloudinary admite 100 MB por video). */
export const VIDEO_MAX_MB = cloud ? Number(E.CLOUDINARY_VIDEO_MAX_MB || 100) : 2048;

if (cloud) {
  cloudinary.config({ cloud_name: E.CLOUDINARY_CLOUD_NAME, api_key: E.CLOUDINARY_API_KEY, api_secret: E.CLOUDINARY_API_SECRET, secure: true, upload_prefix: E.CLOUDINARY_UPLOAD_PREFIX || undefined });
  try {
    await cloudinary.api.ping();
    console.log(`  ✔ Archivos en Cloudinary (cuenta: ${E.CLOUDINARY_CLOUD_NAME}  ·  carpeta: ${FOLDER})\n`);
  } catch (e) {
    const msg = (e as { error?: { message?: string }; message?: string })?.error?.message || (e as Error)?.message || 'error desconocido';
    console.error(`  ✖ No se pudo conectar a Cloudinary (${msg}).\n    Revisa CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en backend/.env\n`);
    process.exit(1);
  }
} else {
  console.log('  • Archivos en la carpeta local data/uploads (configura CLOUDINARY_* en .env para guardarlos en la nube)\n');
}

export type Kind = 'images' | 'files' | 'videos' | 'vouchers';
const PRIVATE: Kind[] = ['videos', 'vouchers']; // solo accesibles con enlace firmado

/**
 * Guarda un archivo que multer dejó en disco.
 * Devuelve `ref` (lo que se guarda en la base de datos) y `url` (dirección pública, solo para imágenes y materiales).
 */
export async function store(localPath: string, kind: Kind): Promise<{ ref: string; url: string | null }> {
  const file = path.basename(localPath);
  if (!cloud) return PRIVATE.includes(kind) ? { ref: `${kind}/${file}`, url: null } : { ref: `/uploads/${kind}/${file}`, url: `/uploads/${kind}/${file}` };
  const ext = path.extname(file).slice(1).toLowerCase();
  const resource_type = kind === 'videos' ? 'video' : kind === 'files' ? 'raw' : ext === 'pdf' ? 'raw' : 'image';
  const isPrivate = PRIVATE.includes(kind);
  try {
    const r = await cloudinary.uploader.upload(localPath, {
      folder: `${FOLDER}/${kind}`, resource_type, type: isPrivate ? 'authenticated' : 'upload',
      // en archivos "raw" el identificador debe incluir la extensión
      public_id: resource_type === 'raw' ? file : path.parse(file).name, overwrite: false,
    });
    if (!isPrivate) return { ref: r.secure_url, url: r.secure_url };
    return { ref: `cld:${resource_type}:${r.public_id}${resource_type === 'raw' ? '' : `.${r.format}`}`, url: null };
  } finally {
    fs.unlink(localPath, () => {}); // el archivo temporal ya no hace falta
  }
}

const parse = (ref: string) => {
  const m = /^cld:(image|video|raw):(.+)$/.exec(ref);
  if (!m) return null;
  const raw = m[1] === 'raw', dot = m[2].lastIndexOf('.');
  return { resource_type: m[1], public_id: raw ? m[2] : m[2].slice(0, dot), format: raw ? undefined : m[2].slice(dot + 1) };
};
/** ¿Es una referencia válida a un archivo privado de este proyecto en Cloudinary? */
export const isCloudRef = (ref: unknown): boolean => typeof ref === 'string' && new RegExp(`^cld:(image|video|raw):${FOLDER}/(videos|vouchers)/[\\w.-]+$`).test(ref);

/** Enlace firmado para ver un archivo privado de Cloudinary (o null si la referencia es local). */
export function cloudUrl(ref: string): string | null {
  const p = parse(ref);
  return p ? cloudinary.url(p.public_id, { resource_type: p.resource_type, type: 'authenticated', sign_url: true, secure: true, format: p.format }) : null;
}

/** Borra un archivo privado (video o comprobante), esté en Cloudinary o en disco. */
export function removeMedia(ref: string | null | undefined): void {
  if (!ref) return;
  const p = parse(ref);
  if (p) { if (cloud) cloudinary.uploader.destroy(p.public_id, { resource_type: p.resource_type, type: 'authenticated', invalidate: true }).catch(() => {}); }
  else if (/^(videos|vouchers)\/[\w.-]+$/.test(ref)) fs.unlink(path.join(UPLOAD_DIR, ref), () => {});
}
