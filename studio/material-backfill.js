'use strict';

/**
 * studio/material-backfill.js — AUTO-CURA dos materiais de imagem presos em
 * 'pending' (2026-10-16): uploads anteriores ao deploy da visão nunca foram
 * relidos (o upload antigo nem chamava a extração) e nenhum job os varria.
 * Roda no boot (com atraso para não competir com a subida) e de tempo em
 * tempo; a varredura em si é serializada, premium-only e com teto por
 * rodada (material-service.extractPendingImageMaterials).
 */

const BOOT_DELAY_MS = 15_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;

function registerMaterialBackfill(prisma, { logger = console, bootDelayMs = BOOT_DELAY_MS, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  let running = false;
  async function sweep(trigger) {
    if (running) return;
    running = true;
    try {
      const { createMaterialService } = require('./material-service');
      const out = await createMaterialService(prisma).extractPendingImageMaterials({});
      // Boot sempre loga (visibilidade do feature); periódico só quando há
      // trabalho — log vazio a cada 15 min é ruído.
      if (out.checked > 0 || trigger === 'boot') {
        logger.info(`[materials:backfill] ${trigger}: checked=${out.checked} extracted=${out.extracted} failed=${out.failed}${out.skipped ? ` skipped=${out.skipped}` : ''}`);
      }
    } catch (err) {
      logger.error(`[materials:backfill] ${trigger} falhou (segue):`, err.stack || String(err));
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

module.exports = { registerMaterialBackfill };
