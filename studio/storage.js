'use strict';

/**
 * studio/storage.js — armazenamento local dos materiais do Studio (T004).
 *
 * Binários de material (PDF/DOCX/PPTX/imagem/vídeo) vivem em volume local
 * configurável (`STUDIO_STORAGE_DIR`, default `./.data/studio`); metadados e
 * extração ficam no Postgres (StudioMaterial). Caminhos sanitizados: nenhum
 * input de usuário compõe o path diretamente (IDs cuid gerados pelo serviço).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(process.cwd(), '.data', 'studio');

function storageDir() {
  const configured = process.env.STUDIO_STORAGE_DIR;
  // Sanitização: nunca aceitar path absoluto/traversal via env em runtime.
  const dir = configured && !path.isAbsolute(configured)
    ? path.join(process.cwd(), configured)
    : configured || DEFAULT_DIR;
  return dir;
}

function ensureDir() {
  const dir = storageDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Salva o buffer com nome determinístico (hash do conteúdo) + extensão. */
function saveBuffer(buffer, ext) {
  const dir = ensureDir();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const fileName = `${hash}.${safeExt}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return { fileName, filePath, relativePath: fileName };
}

function readBuffer(relativePath) {
  // relativePath é sempre o fileName retornado por saveBuffer (sem separators).
  const safe = path.basename(String(relativePath));
  return fs.readFileSync(path.join(storageDir(), safe));
}

/** O arquivo existe no storage? (resolução de anexo na liberação — D6) */
function fileExists(relativePath) {
  const safe = path.basename(String(relativePath));
  return fs.existsSync(path.join(storageDir(), safe));
}

function removeFile(relativePath) {
  const safe = path.basename(String(relativePath));
  const full = path.join(storageDir(), safe);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

/** Extensão segura derivada do mime/nome original (whitelist do FR-023). */
function extFromMime(mimeType, originalName) {
  const byName = String(originalName || '').split('.').pop();
  const candidate = (byName || '').toLowerCase();
  const allowed = ['pdf', 'docx', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'csv', 'txt'];
  if (allowed.includes(candidate)) return candidate;
  const map = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'text/plain': 'txt',
    'text/csv': 'csv',
  };
  return map[mimeType] || 'bin';
}

module.exports = { storageDir, ensureDir, saveBuffer, readBuffer, fileExists, removeFile, extFromMime };
