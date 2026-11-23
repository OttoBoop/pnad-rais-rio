// Utilitários sem dependência: formatação pt-BR, escape, CSV e download.

const fmtCache = new Map();
function fmt(dec) {
  if (!fmtCache.has(dec)) {
    fmtCache.set(dec, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  }
  return fmtCache.get(dec);
}

export function num(x, dec = 0) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '—';
  return fmt(dec).format(Number(x));
}

export function pct(x, dec = 1) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return fmt(dec).format(Number(x) * 100) + '%';
}

export function mb(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return fmt(0).format(bytes / 1024) + ' KB';
  return fmt(bytes < 100 * 1024 * 1024 ? 2 : 0).format(bytes / 1024 / 1024) + ' MB';
}

export function segundos(ms) {
  return fmt(ms < 10000 ? 2 : 1).format(ms / 1000) + ' s';
}

// Erro típico de arquivo trocado no servidor durante a sessão (o DuckDB guarda os metadados em cache).
export function dicaErro(msg) {
  return /don't know what type|magic bytes|Corrupt|Could not read|out of range|HTTP 416|truncated/i.test(String(msg || ''))
    ? ' Se os arquivos foram atualizados durante a sua sessão, recarregue a página e rode de novo.' : '';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Anos como faixas compactas: [2012..2019, 2022..2025] -> "2012–2019, 2022–2025".
export function faixasAnos(anos) {
  const a = [...new Set((anos || []).map(Number))].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return '—';
  const out = [];
  let ini = a[0], ant = a[0];
  for (const x of a.slice(1).concat([NaN])) {
    if (x === ant + 1) { ant = x; continue; }
    out.push(ini === ant ? String(ini) : `${ini}–${ant}`);
    ini = ant = x;
  }
  return out.join(', ');
}

// Identificador SQL: sem aspas quando é simples, com aspas duplas caso contrário.
export function ident(nome) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(nome) ? nome : '"' + String(nome).replace(/"/g, '""') + '"';
}

// Literal SQL: número quando o texto é numérico, string com aspas simples caso contrário.
export function literal(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return "'" + s.replace(/'/g, "''") + "'";
}

export function strSQL(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// CSV RFC 4180. modo 'br' = ponto e vírgula, vírgula decimal e BOM (abre direto no Excel em português).
export function paraCSV(colunas, linhas, modo = 'padrao') {
  const sep = modo === 'br' ? ';' : ',';
  const cel = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '';
      const s = String(v);
      return modo === 'br' ? s.replace('.', ',') : s;
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'object') v = JSON.stringify(v);
    const s = String(v);
    return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const corpo = [colunas.map(cel).join(sep), ...linhas.map(l => colunas.map(c => cel(l[c])).join(sep))].join('\r\n');
  return (modo === 'br' ? '﻿' : '') + corpo + '\r\n';
}

export function baixarTexto(nome, texto, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return e;
}

// Valor de uma célula para exibição: números com separador pt-BR, objetos como JSON.
export function celula(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? num(v, 0) : String(v);
    return num(v, Math.abs(v) < 1 ? 4 : 2);
  }
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x);
  return String(v);
}
