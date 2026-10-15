'use strict';

/**
 * studio/leads-pdf.js — planilha de leads em PDF, SEM dependência nova.
 *
 * Escreve PDF 1.4 na mão (objetos + xref): fontes base Helvetica e
 * Helvetica-Bold com WinAnsiEncoding (acentos do PT-BR cobertos; o que está
 * fora vira '?'), A4 paisagem, cabeçalho de colunas repetido a cada página,
 * zebra nas linhas e paginação no rodapé. Determinístico: mesmo input →
 * mesmo buffer (o storage do Studio dedupa por SHA-256).
 */

const PAGE = { width: 841.89, height: 595.28 }; // A4 paisagem (pt)
const MARGIN = 40;
const TITLE_SIZE = 15;
const SUBTITLE_SIZE = 8.5;
const HEADER_ROW_H = 20;
const ROW_H = 16;
const CELL_SIZE = 8;
const CELL_PAD = 4;
// Largura média do glifo Helvetica ≈ 0.52em (suficiente para truncar célula).
const CHAR_W = CELL_SIZE * 0.52;

// Primário da identidade do Cockpit (#160211) + cinzas do tema claro.
const INK = '0.086 0.008 0.067';
const MUTED = '0.42 0.447 0.502';
const ZEBRA = '0.945 0.949 0.961';
const HAIRLINE = '0.898 0.906 0.922';

// glifos cp1252 fora do latin1 → byte WinAnsi equivalente; resto vira '?'.
const WIN_ANSI_MAP = {
  '€': '\u0080', '‚': '\u0082', 'ƒ': '\u0083', '„': '\u0084', '…': '\u0085',
  '†': '\u0086', '‡': '\u0087', 'ˆ': '\u0088', '‰': '\u0089', 'Š': '\u008a',
  '‹': '\u008b', 'Œ': '\u008c', 'Ž': '\u008e', '‘': '\u0091', '’': '\u0092',
  '“': '\u0093', '”': '\u0094', '•': '\u0095', '–': '\u0096', '—': '\u0097',
  '˜': '\u0098', '™': '\u0099', 'š': '\u009a', '›': '\u009b', 'œ': '\u009c',
  'ž': '\u009e', 'Ÿ': '\u009f',
};

function toWinAnsi(value) {
  return String(value == null ? '' : value)
    .replace(/[€‚ƒ„…†‡ˆ‰Š‹ŒŽ''""•–—˜™š›œžŸ]/g, (ch) => WIN_ANSI_MAP[ch] || '?')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\u0000-\u00ff]/g, '?')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

function pdfEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Trunca no limite da coluna (aproximação por largura média do glifo). */
function fitCell(text, colWidth) {
  const maxChars = Math.max(3, Math.floor((colWidth - CELL_PAD * 2) / CHAR_W));
  const s = toWinAnsi(text);
  if (s.length <= maxChars) return s;
  // Reticência JÁ em WinAnsi (0x85) — U+2026 cru viraria 0x26 ('&') no
  // Buffer latin1 e apareceria como "&" no PDF.
  return `${s.slice(0, Math.max(1, maxChars - 1))}\u0085`;
}

/**
 * Larguras proporcionais ao maior texto de cada coluna (limitado), com piso —
 * e REENCAIXE quando os pisos somam mais que a mesa (10+ colunas): reduz as
 * colunas com folga proporcionalmente até caber na página.
 */
function computeWidths(labels, rows, tableWidth) {
  const MIN = 34;
  const natural = labels.map((label, i) => {
    let len = toWinAnsi(label).length;
    for (const row of rows) len = Math.max(len, String(row[i] == null ? '' : row[i]).length);
    return Math.min(44, Math.max(8, len));
  });
  const total = natural.reduce((a, b) => a + b, 0) || 1;
  let widths = natural.map((n) => Math.max(MIN, Math.round((n / total) * tableWidth)));
  let sum = widths.reduce((a, b) => a + b, 0);
  if (sum > tableWidth) {
    const reducible = widths.reduce((acc, w) => acc + (w - MIN), 0);
    if (reducible > 0) {
      const excess = sum - tableWidth;
      widths = widths.map((w) => w - Math.min(w - MIN, Math.round((excess * (w - MIN)) / reducible)));
    } else {
      widths = widths.map((w) => Math.max(24, Math.floor((w * tableWidth) / sum)));
    }
    sum = widths.reduce((a, b) => a + b, 0);
  }
  // Ajuste fino do arredondamento: a diferença sobra/salta na coluna mais
  // larga (sempre com folga ≥ MIN).
  const widest = widths.indexOf(Math.max(...widths));
  widths[widest] += tableWidth - sum;
  return widths;
}

function textOp({ x, y, font, size, color, text }) {
  return `BT ${color} rg /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET\n`;
}

function rectOp({ x, y, w, h, color }) {
  return `${color} rg ${x} ${y} ${w} ${h} re f\n`;
}

/**
 * buildLeadsPdf({ title, subtitle, columns:[{label}], rows:[[str]] }) → Buffer.
 * Uma página por lote de linhas; cabeçalho da tabela repete em todas.
 */
function buildLeadsPdf({ title, subtitle, columns, rows = [] }) {
  const labels = (columns || []).map((c) => toWinAnsi(c.label || ''));
  if (labels.length === 0) labels.push(toWinAnsi('Lead'));
  const tableWidth = PAGE.width - MARGIN * 2;
  const widths = computeWidths(labels, rows, tableWidth);

  const titleText = fitCell(title || 'Leads', tableWidth).replace(/[\u0085]$/, '');
  const subtitleText = fitCell(subtitle || '', tableWidth).replace(/[\u0085]$/, '');
  const titleY = PAGE.height - MARGIN - TITLE_SIZE;
  const subtitleY = titleY - 15;
  const tableTop = subtitleY - 10;

  // Posições x de cada coluna.
  const colX = [];
  let cursor = MARGIN;
  for (const w of widths) {
    colX.push(cursor);
    cursor += w;
  }

  const headerBaseline = tableTop - HEADER_ROW_H + (HEADER_ROW_H - CELL_SIZE) / 2 + 1;
  const firstRowTop = tableTop - HEADER_ROW_H;
  const usableHeight = firstRowTop - (MARGIN + 18); // rodapé abaixo
  const rowsPerPage = Math.max(1, Math.floor(usableHeight / ROW_H));

  const pages = [];
  for (let start = 0; start < Math.max(rows.length, 1); start += rowsPerPage) {
    const slice = rows.slice(start, start + rowsPerPage);
    let ops = '';
    // Título e subtítulo.
    ops += textOp({ x: MARGIN, y: titleY, font: 'F2', size: TITLE_SIZE, color: INK, text: titleText });
    if (subtitleText) ops += textOp({ x: MARGIN, y: subtitleY, font: 'F1', size: SUBTITLE_SIZE, color: MUTED, text: subtitleText });
    // Cabeçalho da tabela (fundo primário, texto branco).
    ops += rectOp({ x: MARGIN, y: tableTop - HEADER_ROW_H, w: tableWidth, h: HEADER_ROW_H, color: INK });
    labels.forEach((label, i) => {
      ops += textOp({ x: colX[i] + CELL_PAD, y: headerBaseline, font: 'F2', size: CELL_SIZE, color: '1 1 1', text: fitCell(label, widths[i]) });
    });
    // Linhas com zebra e fio inferior.
    slice.forEach((row, r) => {
      const rowTop = firstRowTop - (r + 1) * ROW_H;
      if (r % 2 === 1) ops += rectOp({ x: MARGIN, y: rowTop, w: tableWidth, h: ROW_H, color: ZEBRA });
      ops += rectOp({ x: MARGIN, y: rowTop, w: tableWidth, h: 0.5, color: HAIRLINE });
      labels.forEach((_label, c) => {
        const cell = row[c] == null ? '' : row[c];
        ops += textOp({ x: colX[c] + CELL_PAD, y: rowTop + (ROW_H - CELL_SIZE) / 2 + 1, font: 'F1', size: CELL_SIZE, color: INK, text: fitCell(cell, widths[c]) });
      });
    });
    pages.push(ops);
  }

  // Paginação no rodapé (depois de saber o total de páginas).
  const total = pages.length;
  pages.forEach((ops, i) => {
    const label = total > 1 ? `Página ${i + 1} de ${total}` : 'Página 1';
    const x = PAGE.width - MARGIN - Math.ceil(label.length * 8 * 0.5);
    pages[i] = ops + textOp({ x, y: MARGIN - 2, font: 'F1', size: 8, color: MUTED, text: label });
  });

  // ── Montagem dos objetos com xref de offsets reais ────────────────────────
  const objects = [];
  const pageObjIds = pages.map((_p, i) => 5 + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  );
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  pages.forEach((ops, i) => {
    const contentId = pageObjIds[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    const stream = Buffer.from(ops, 'latin1');
    objects.push({ stream });
  });

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  objects.forEach((body, idx) => {
    offsets.push(chunks.reduce((sum, c) => sum + c.length, 0));
    chunks.push(Buffer.from(`${idx + 1} 0 obj\n`, 'latin1'));
    if (body && body.stream) {
      chunks.push(
        Buffer.from(`<< /Length ${body.stream.length} >>\nstream\n`, 'latin1'),
        body.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1')
      );
    } else {
      chunks.push(Buffer.from(`${body}\nendobj\n`, 'latin1'));
    }
  });
  const xrefOffset = chunks.reduce((sum, c) => sum + c.length, 0);
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  chunks.push(
    Buffer.from(xref, 'latin1'),
    Buffer.from(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1')
  );
  return Buffer.concat(chunks);
}

module.exports = { buildLeadsPdf };
