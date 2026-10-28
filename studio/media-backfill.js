'use strict';

/**
 * studio/media-backfill.js — AUTO-CURA dos banners de e-mail presos em src de
 * PÁGINA (2026-10-28): emailDocs gravados antes do resolvedor genérico (ou
 * cuja resolução falhou no envio) guardam src apontando para PÁGINA externa
 * (ex.: álbum de imagens) — cliente de e-mail não renderiza página, e o chat
 * acaba exibindo/avisando sobre o host de origem. O sweep resolve a imagem
 * direta, baixa os bytes para o NOSSO storage e PERSISTE o emailDoc curado;
 * com MEDIA_PUBLISH_* configurado o src vira a URL pública do bucket
 * (Cloudflare R2) — o e-mail nunca depende do host de origem.
 *
 * Roda no boot (com atraso) e de tempo em tempo; varredura serializada, com
 * teto por rodada (linhas vistas e curas por sweep — o que sobrar fica para
 * o próximo). Falha de resolução (host bloqueou e sem relay) é logada com
 * causa e o sweep seguinte tenta de novo.
 */

const BOOT_DELAY_MS = 20_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;
const MAX_ROWS_PER_SWEEP = 50;
const MAX_HEALS_PER_SWEEP = 10;

function registerMediaBackfill(prisma, { logger = console, bootDelayMs = BOOT_DELAY_MS, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  let running = false;
  async function sweep(trigger) {
    if (running) return null;
    running = true;
    try {
      const { ensureImageSourcesResolved, isPageUrl } = require('./resolve-image-link');
      const storage = require('./storage');
      const rows = await prisma.studioContent.findMany({
        where: { channel: 'email' },
        orderBy: { updatedAt: 'desc' },
        take: MAX_ROWS_PER_SWEEP,
      });
      let checked = 0;
      let healed = 0;
      for (const row of rows) {
        const blocks = row.emailDoc && Array.isArray(row.emailDoc.blocks) ? row.emailDoc.blocks : [];
        if (!blocks.some((b) => b && b.type === 'image' && typeof b.src === 'string' && isPageUrl(b.src))) continue;
        checked += 1;
        if (healed >= MAX_HEALS_PER_SWEEP) break; // próximo sweep continua
        const before = JSON.stringify(row.emailDoc);
        try {
          await ensureImageSourcesResolved(row.emailDoc, {
            readGenerated: storage.readGenerated,
            readBuffer: storage.readBuffer,
            publishMedia: (n, d) => require('./media-publisher').publishMedia(n, d),
            persist: async (doc) => {
              await prisma.studioContent.update({ where: { id: row.id }, data: { emailDoc: doc } });
            },
          });
          if (JSON.stringify(row.emailDoc) !== before) healed += 1;
        } catch (err) {
          logger.warn(`[media:backfill] ${trigger}: ${String(row.id).slice(0, 8)} não curou agora (${err.code || err.message}) — o próximo sweep tenta de novo.`);
        }
      }
      if (checked > 0 || trigger === 'boot') {
        logger.info(`[media:backfill] ${trigger}: verificados=${checked} curados=${healed}`);
      }
      return { checked, healed };
    } catch (err) {
      logger.error(`[media:backfill] ${trigger} falhou (segue):`, err.stack || String(err));
      return { error: err.message, checked: 0, healed: 0 };
    } finally {
      running = false;
    }
  }
  const boot = setTimeout(() => sweep('boot'), bootDelayMs);
  const timer = setInterval(() => sweep('periodic'), intervalMs);
  if (typeof boot.unref === 'function') boot.unref();
  if (typeof timer.unref === 'function') timer.unref();
  return { sweep };
}

module.exports = { registerMediaBackfill };
