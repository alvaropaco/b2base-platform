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
