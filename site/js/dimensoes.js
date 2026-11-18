// Dimensões (linhas, colunas, filtros) e variáveis numéricas de cada base, a partir dos dicionários.
import { ident } from './util.js';

const DESENHO_PNAD = /^(V10\d\d|posest|posest_sxi|UPA|Estrato|UF|Capital|RM_RIDE|Ano|Trimestre)$/i;

// Largura do código com zeros à esquerda (na hierarquia ou nas chaves do nível).
function largura(cl, nivel) {
  let w = 0;
  for (const h of cl.hierarquia || []) { const c = h[nivel]; if (c && /^\d+$/.test(c)) w = Math.max(w, c.length); }
  if (!w) {
    const ks = Object.keys(cl.niveis[nivel] || {});
    if (ks.length && ks.every(k => /^\d+$/.test(k))) w = Math.max(...ks.map(k => k.length));
  }
  return w;
}

// Níveis acima da folha (o nível que corresponde aos valores do Parquet). Nível numérico: divisão inteira,
// conferida na hierarquia (o código do nível é prefixo do código da folha). Nível com letras (seção da CNAE):
// faixas de um nível numérico, montadas a partir da hierarquia.
export function niveisDerivados(cl, folha) {
  const W = largura(cl, folha);
  if (!W || !folha) return [];
  const entradas = (cl.hierarquia || []).filter(h => h[folha] !== undefined);
  if (!entradas.length) return [];
  const niveis = [...new Set(entradas.flatMap(h => Object.keys(h)))].filter(n => n !== folha);
  const out = [], numericos = [];
  for (const n of niveis) {
    const vals = entradas.map(h => h[n]).filter(x => x !== undefined && x !== null && x !== '');
    if (!vals.length || !vals.every(x => /^\d+$/.test(x))) continue;
    const w = largura(cl, n);
    if (!w || w >= W) continue;
    if (!entradas.slice(0, 2000).every(h => h[n] === undefined || String(h[folha]).padStart(W, '0').startsWith(h[n].padStart(w, '0')))) continue;
    const div = 10 ** (W - w);
    numericos.push({ nivel: n, w, div });
    out.push({ nivel: n, numerico: true, largura: w, expr: x => `(${x} // ${div})` });
  }
  for (const n of niveis) {
    if (out.some(o => o.nivel === n)) continue;
    // O nível numérico mais agregado que determina este nível: menos faixas e mais códigos cobertos.
    for (const p of [...numericos].sort((a, b) => a.w - b.w)) {
      const m = new Map();
      let ok = true;
      for (const h of entradas) {
        if (h[n] === undefined || h[p.nivel] === undefined) continue;
        const pc = Number(h[p.nivel]);
        if (m.has(pc) && m.get(pc) !== h[n]) { ok = false; break; }
        m.set(pc, h[n]);
      }
      if (!ok || !m.size) continue;
      const ordem = [...m.keys()].sort((a, b) => a - b);
      const faixas = [];
      for (const c of ordem) {
        const ult = faixas[faixas.length - 1];
        if (ult && ult.v === m.get(c)) ult.b = c; else faixas.push({ a: c, b: c, v: m.get(c) });
      }
      const esc = v => String(v).replace(/'/g, "''");
      const expr = x => `CASE ${faixas.map(f => f.a === f.b ? `WHEN ${x} // ${p.div} = ${f.a} THEN '${esc(f.v)}'` : `WHEN ${x} // ${p.div} BETWEEN ${f.a} AND ${f.b} THEN '${esc(f.v)}'`).join(' ')} END`;
      out.push({ nivel: n, numerico: false, expr });
      break;
    }
  }
  // Do mais agregado para o mais detalhado.
  return out.sort((a, b) => (a.numerico ? a.largura : 0) - (b.numerico ? b.largura : 0));
}

function nomeNivel(n) {
  return n.replace(/_/g, ' ');
}

// Faixas de idade (convenção do site, ajustável no SQL).
const FAIXA_IDADE = x => `CASE WHEN ${x} IS NULL THEN NULL WHEN ${x} < 14 THEN '00 a 13' WHEN ${x} < 18 THEN '14 a 17' WHEN ${x} < 25 THEN '18 a 24' WHEN ${x} < 30 THEN '25 a 29' WHEN ${x} < 40 THEN '30 a 39' WHEN ${x} < 50 THEN '40 a 49' WHEN ${x} < 60 THEN '50 a 59' ELSE '60 ou mais' END`;

export function dimensoes(cat, chave) {
  const t = cat.tabelas[chave];
  const vars = cat.dic[chave] || {};
  const dims = [];
  for (const [nome, v] of Object.entries(vars)) {
    if (nome === t.colAno || nome === t.colTrimestre) continue;
    const desc = v.descricao || '';
    if (v.categorias) {
      dims.push({ id: nome, variavel: nome, rotulo: `${nome} · ${desc}`, expr: ident(nome), rot: { tabela: chave, variavel: nome, numerico: true }, categorias: v.categorias, anos: v.anos, nulo: v.nulo });
    } else if (v.classificacao) {
      const cl = cat.classificacoes[v.classificacao];
      const titulo = (cl && cl.titulo) || v.classificacao;
      const folha = v.nivelClassificacao;
      const mapa = cl && folha ? cl.niveis[folha] : null;
      const numerico = mapa ? Object.keys(mapa).every(k => /^-?\d+$/.test(k)) : true;
      dims.push({ id: nome, variavel: nome, rotulo: `${nome} · ${desc} (${titulo}${folha && folha !== 'codigo' ? `, ${nomeNivel(folha)}` : ''})`, expr: ident(nome), rot: mapa ? { tabela: v.classificacao, variavel: folha, numerico } : null, categorias: mapa, anos: v.anos, nulo: v.nulo });
      if (cl && folha) {
        for (const nd of niveisDerivados(cl, folha)) {
          dims.push({ id: `${nome}@${nd.nivel}`, variavel: nome, rotulo: `${nome} · ${desc} (${titulo}, ${nomeNivel(nd.nivel)})`, expr: nd.expr(ident(nome)), rot: cl.niveis[nd.nivel] ? { tabela: v.classificacao, variavel: nd.nivel, numerico: nd.numerico } : null, categorias: cl.niveis[nd.nivel] || null, anos: v.anos, nulo: v.nulo });
        }
      }
    }
  }
  if (t.amostral && vars.V2009) {
    dims.push({ id: 'V2009@faixa', variavel: 'V2009', rotulo: 'V2009 · Idade em faixas (faixas do site)', expr: FAIXA_IDADE('V2009'), rot: null, categorias: null, texto: true });
  }
  return dims.sort((a, b) => a.id.localeCompare(b.id, 'pt-BR', { numeric: true }));
}

export function numericas(cat, chave) {
  const t = cat.tabelas[chave];
  const vars = cat.dic[chave] || {};
  return Object.entries(vars).filter(([nome, v]) => {
    if (v.categorias || v.classificacao) return false;
    if (!/INT|DOUBLE|DECIMAL|FLOAT|NUMERIC|REAL/i.test(v.tipo || '')) return false;
    if (t.amostral) return !DESENHO_PNAD.test(nome);
    return /^(vl_|tempo_emprego|idade$|qtd_)/.test(nome);
  }).map(([nome, v]) => ({ nome, descricao: v.descricao || '', tipo: v.tipo }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
}
