'use strict';

/**
 * studio/media-route.js — handler do GET /media/:name (PÚBLICO, montado no
 * server-prod ANTES do guard de /api): imagens GERADAS pelo Studio (banner de
 * e-mail por IA). O cliente de e-mail do LEAD busca a imagem sem sessão; o
 * nome é o hash SHA-256 do conteúdo (32 hex + extensão, não-adivinhável) e a
 * leitura é restrita à pasta generated/ do storage. Extraído do server-prod
 * para ser exercitado por teste HTTP real (mesmo código de produção).
 */
module.exports = function mediaRoute(req, res) {
  try {
    const storage = require('./storage');
    const buffer = storage.readGenerated(req.params.name);
    const ext = String(req.params.name).split('.').pop().toLowerCase();
    res.setHeader('Content-Type', ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (_e) {
    res.status(404).end();
  }
};
