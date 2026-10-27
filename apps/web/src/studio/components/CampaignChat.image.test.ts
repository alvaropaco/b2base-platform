/**
 * CampaignChat.image.test.ts — IMAGEM GERADA NO CHAT (2026-10-26): a prévia
 * da imagem é decision de render FUNÇÃO PURA (padrão capture/recovery —
 * vitest, sem DOM, sem dependência nova — constituição VI).
 *   - a URL de exibição vem do resultado ESTRUTURADO da ferramenta
 *     (imagePath relativo > imageUrl absoluto > images[]), nunca do texto
 *     escrito pela IA;
 *   - cards de falha NUNCA têm URL (nada de falso sucesso) e o retry é
 *     mensagem EXPLÍCITA do usuário;
 *   - cards antigos do histórico (link cru no detail) continuam renderizando.
 */
import { describe, expect, it } from 'vitest';
import { imageCardUrls, imageDownloadName, imageGenRetryMessage, stripLegacyImageLink, type ChatCard } from './CampaignChat';

describe('imageCardUrls — fonte estruturada da prévia', () => {
  it('card novo: imagePath relativo vence (mesma origem, sobrevive a troca de APP_URL)', () => {
    const card: ChatCard = {
      type: 'image_generated',
      label: 'Imagem gerada',
      imagePath: '/media/abc123def456abc123def456abc12345.png',
      imageUrl: 'https://www.b2base.net/media/abc123def456abc123def456abc12345.png',
    };
    expect(imageCardUrls(card)).toEqual(['/media/abc123def456abc123def456abc12345.png']);
  });

  it('card ANTIGO do histórico (só imageUrl absoluto) continua exibindo', () => {
    const card: ChatCard = {
      type: 'image_generated',
      label: 'Imagem gerada',
      imageUrl: 'https://b2base.net/media/0123456789abcdef0123456789abcdef.png',
    };
    expect(imageCardUrls(card)).toEqual(['https://b2base.net/media/0123456789abcdef0123456789abcdef.png']);
  });

  it('múltiplas imagens (images[]) saem na ordem — string e objeto {url}', () => {
    const card: ChatCard = {
      type: 'image_generated',
      label: 'Imagens geradas',
      images: ['/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', { url: 'https://cdn.b2base.net/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' }],
    };
    expect(imageCardUrls(card)).toEqual([
      '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      'https://cdn.b2base.net/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    ]);
  });

  it('falha de geração (retryable, sem URL) → lista VAZIA — nada de falso sucesso', () => {
    const card: ChatCard = {
      type: 'image_generated',
      label: 'Não consegui gerar a imagem agora',
      retryable: true,
      prompt: 'banner de pizza',
    };
    expect(imageCardUrls(card)).toEqual([]);
  });

  it('card de ambiente sem motor (sem retryable) → lista vazia também', () => {
    const card: ChatCard = {
      type: 'image_generated',
      label: 'Geração de imagem não configurada neste ambiente',
    };
    expect(imageCardUrls(card)).toEqual([]);
  });

  it('outros tipos de card NUNCA viram imagem (mesmo com imageUrl sujo no payload)', () => {
    expect(imageCardUrls({ type: 'balance', label: 'x', imageUrl: 'https://evil.example/x.png' })).toEqual([]);
  });
});

describe('imageGenRetryMessage — retry EXPLÍCITO do dono', () => {
  it('falha com prompt → mensagem nova citando o pedido original', () => {
    const card: ChatCard = { type: 'image_generated', label: 'Não consegui gerar a imagem agora', retryable: true, prompt: 'banner de dobradeira azul' };
    expect(imageGenRetryMessage(card)).toBe('Tente gerar a imagem de novo: "banner de dobradeira azul"');
  });

  it('falha sem prompt → mensagem genérica de retry', () => {
    const card: ChatCard = { type: 'image_generated', label: 'x', retryable: true };
    expect(imageGenRetryMessage(card)).toBe('Tente gerar a imagem de novo.');
  });

  it('sucesso e card sem retryable → NUNCA oferecem retry', () => {
    expect(imageGenRetryMessage({ type: 'image_generated', label: 'Imagem gerada', imagePath: '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' })).toBeNull();
    expect(imageGenRetryMessage({ type: 'image_generated', label: 'Geração de imagem não configurada neste ambiente' })).toBeNull();
  });
});

describe('stripLegacyImageLink — histórico antigo sem ruído', () => {
  it('remove a linha do link cru e preserva o resto do detail', () => {
    const detail = 'Prompt: "banner de pizza"\n⚠ nota de formato\nLink público da imagem: https://b2base.net/media/0123456789abcdef0123456789abcdef.png\nMe peça para inserir no e-mail.';
    expect(stripLegacyImageLink(detail)).toBe('Prompt: "banner de pizza"\n⚠ nota de formato\nMe peça para inserir no e-mail.');
  });

  it('detail sem link volta intacto; vazio não quebra', () => {
    expect(stripLegacyImageLink('Prompt: "x"')).toBe('Prompt: "x"');
    expect(stripLegacyImageLink('')).toBe('');
  });
});

describe('imageDownloadName — nome seguro para o download', () => {
  it('deriva o nome da URL (com e sem query)', () => {
    expect(imageDownloadName('/media/0123456789abcdef0123456789abcdef.png')).toBe('0123456789abcdef0123456789abcdef.png');
    expect(imageDownloadName('https://b2base.net/media/0123456789abcdef0123456789abcdef.png?r=2')).toBe('0123456789abcdef0123456789abcdef.png');
    expect(imageDownloadName('https://b2base.net/media/0123456789abcdef0123456789abcdef.jpg')).toBe('0123456789abcdef0123456789abcdef.jpg');
  });

  it('URL sem nome reconhecível → fallback imagem.png (nunca vazio)', () => {
    expect(imageDownloadName('https://b2base.net/')).toBe('imagem.png');
    expect(imageDownloadName('')).toBe('imagem.png');
  });
});

// ── 2026-10-26: BOTÃO com link no card de revisão (pedido do dono) ──────────
import { contentReviewButton } from './CampaignChat';

describe('contentReviewButton — [label](url) do bloco button vira botão clicável', () => {
  it('linha do botão do e-mail → {label, url} (mesmo destino do disparo)', () => {
    expect(contentReviewButton('[Falar com a Arthur Company](https://wa.me/5512996399943)')).toEqual({
      label: 'Falar com a Arthur Company',
      url: 'https://wa.me/5512996399943',
    });
  });

  it('URL com path/query e label curto', () => {
    expect(contentReviewButton('[Ver mais](https://exemplo.com/a?b=1)')).toEqual({
      label: 'Ver mais',
      url: 'https://exemplo.com/a?b=1',
    });
  });

  it('markdown incompleto, texto comum ou linha vazia → null (texto puro)', () => {
    expect(contentReviewButton('[sem url]')).toBeNull();
    expect(contentReviewButton('[label](nao-e-url)')).toBeNull();
    expect(contentReviewButton('Olá {{firstName}}, tudo bem?')).toBeNull();
    expect(contentReviewButton('')).toBeNull();
  });
});

// Render REAL do componente (sem DOM): o botão sai como <a> clicável.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentReviewDetail } from './CampaignChat';

describe('ContentReviewDetail — render do card de revisão', () => {
  const DETAIL = [
    '**Assunto:** {{companyName}}: máquinas industriais',
    'Olá {{firstName}}, tudo bem?',
    '[Falar com a Arthur Company](https://wa.me/5512996399943)',
  ].join('\n');
  const render = (text: string) => renderToStaticMarkup(createElement(ContentReviewDetail, { text }));

  it('linha de botão vira <a href> clicável com o rótulo (mesmo destino do e-mail)', () => {
    const html = render(DETAIL);
    expect(html).toContain('<a href="https://wa.me/5512996399943"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Falar com a Arthur Company</a>');
  });

  it('negrito resolvido (sem asterisco cru) e linhas comuns como texto', () => {
    const html = render(DETAIL);
    expect(html).toContain('<strong class="text-foreground">Assunto:</strong>');
    expect(html).not.toContain('**');
    expect(html).toContain('Olá {{firstName}}, tudo bem?');
  });

  it('texto vazio não quebra', () => {
    expect(render('')).toContain('<div class="mt-0.5 space-y-1">');
  });
});

// ── 2026-10-27: CTA REAL no card da imagem (separado do zoom) ───────────────
import { imageCta } from './CampaignChat';

describe('imageCta — botão de verdade no card, distinto do zoom', () => {
  const base: ChatCard = { type: 'image_generated', label: 'Imagem gerada' };

  it('card com ctaUrl/ctaLabel → {label, url} (mesmo destino do e-mail)', () => {
    expect(imageCta({ ...base, ctaUrl: 'https://wa.me/5512996399943', ctaLabel: 'Falar com a Arthur Company' })).toEqual({
      label: 'Falar com a Arthur Company',
      url: 'https://wa.me/5512996399943',
    });
  });

  it('sem ctaLabel → rótulo padrão do WhatsApp', () => {
    expect(imageCta({ ...base, ctaUrl: 'https://wa.me/5512996399943' })?.label).toBe('Falar com a gente no WhatsApp');
  });

  it('URL ausente, insegura ou card de OUTRO tipo → null (nada de botão falso)', () => {
    expect(imageCta(base)).toBeNull();
    expect(imageCta({ ...base, ctaUrl: 'javascript:alert(1)' })).toBeNull();
    expect(imageCta({ ...base, ctaUrl: '' })).toBeNull();
    expect(imageCta({ type: 'content_review', label: 'x', ctaUrl: 'https://wa.me/1' })).toBeNull();
  });
});
