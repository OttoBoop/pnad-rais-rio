// Lê os manifestos e os dicionários. O site não conhece nenhum arquivo fora dos manifestos.

const MANIFESTOS = ['pnad', 'rais'];

// Pasta dos manifestos: dados/ por padrão. Para testes, "?dados=sub" lê dados/sub/manifest_*.json (só subpastas de dados/).
function pastaDados() {
  const p = new URLSearchParams(location.search).get('dados');
  if (p && /^[A-Za-z0-9_\-/]+$/.test(p) && !p.includes('..') && !p.startsWith('/')) return `dados/${p.replace(/\/+$/, '')}/`;
  return 'dados/';
}

export const BASE_SITE = new URL('.', location.href);

export function absoluta(url) {
  return new URL(url, BASE_SITE).href;
}

function hostDe(url) {
  try { return new URL(url).host; } catch { return ''; }
}

async function lerJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Rótulos de categoria: aceita {"1": "Homem"}, [{codigo, rotulo}] e {"1": {"rotulo": ...}}.
function normalizarCategorias(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (Array.isArray(c)) {
    for (const x of c) {
      if (x && typeof x === 'object') {
        const cod = x.codigo ?? x.cod ?? x.valor ?? x.code;
        const rot = x.rotulo ?? x.descricao ?? x.nome ?? x.titulo ?? x.label;
        if (cod !== undefined) out[String(cod)] = String(rot ?? '');
      }
    }
  } else {
    for (const [k, v] of Object.entries(c)) {
      out[k] = typeof v === 'object' && v !== null ? String(v.rotulo ?? v.descricao ?? v.nome ?? v.titulo ?? JSON.stringify(v)) : String(v);
    }
  }
  return Object.keys(out).length ? out : null;
}

// Dicionário de classificação. Dois formatos do pipeline:
//  PNAD: {"categorias": {folha: rótulo}, "niveis": {nível: {código: rótulo}}, "hierarquia": {folha: {nível: código}}}
//  RAIS: {"niveis": {...}, "ocupacao": {código: {titulo, familia, ...}}} ou {"secao": {...}, ..., "subclasse": {código: {descricao, classe, ...}}}
// Vira {niveis: {nível: {código: rótulo}}, hierarquia: [{nível: código}], ordem: [níveis na ordem do arquivo]}.
// No formato PNAD, a folha se chama "codigo".
const METADADOS = new Set(['titulo', 'fonte', 'url', 'url_leiaute', 'url_ipp', 'uso', 'nota', 'gerado_em', 'baixado_em', 'arquivo_ibge',
  'variaveis', 'descricao', 'subclasses_so_no_leiaute', 'tabela']);

function rotuloDe(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  return String(v.rotulo ?? v.titulo ?? v.descricao ?? v.nome ?? '');
}

function ehMapaDeCodigos(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const vs = Object.values(m);
  return vs.length > 0 && vs.every(v => typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && rotuloDe(v)));
}

function normalizarClassificacao(obj) {
  const r = { niveis: {}, hierarquia: [], titulo: null, ordem: [] };
  if (!obj || typeof obj !== 'object') return r;
  r.titulo = obj.titulo || null;
  const brutos = {};
  if (obj.variaveis && !Array.isArray(obj.variaveis) && typeof obj.variaveis === 'object') {
    for (const [nome, v] of Object.entries(obj.variaveis)) if (v && ehMapaDeCodigos(v.categorias)) brutos[nome] = v.categorias;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (METADADOS.has(k) || k === 'hierarquia') continue;
    if (k === 'niveis' && v && typeof v === 'object') {
      for (const [n, m] of Object.entries(v)) if (ehMapaDeCodigos(m)) brutos[n] = m;
    } else if (k === 'categorias' && ehMapaDeCodigos(v)) {
      brutos.codigo = v;
    } else if (ehMapaDeCodigos(v)) {
      brutos[k] = v;
    }
  }
  if (!Object.keys(brutos).length && ehMapaDeCodigos(obj.codigos || obj)) brutos.codigo = obj.codigos || obj;
  const nomes = new Set(Object.keys(brutos));
  for (const [n, m] of Object.entries(brutos)) {
    r.ordem.push(n);
    r.niveis[n] = {};
    for (const [c, v] of Object.entries(m)) {
      r.niveis[n][c] = rotuloDe(v);
      // Entradas com os códigos dos níveis acima viram a hierarquia (CBO: ocupacao -> familia...; CNAE: subclasse -> classe...).
      if (v && typeof v === 'object') {
        const h = { [n]: c };
        for (const [kk, vv] of Object.entries(v)) if (nomes.has(kk) && (typeof vv === 'string' || typeof vv === 'number')) h[kk] = String(vv);
        if (Object.keys(h).length > 1) r.hierarquia.push(h);
      }
    }
  }
  if (obj.hierarquia && typeof obj.hierarquia === 'object') {
    for (const h of Object.values(obj.hierarquia)) {
      if (h && typeof h === 'object') r.hierarquia.push(Object.fromEntries(Object.entries(h).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([a, b]) => [a, String(b)])));
    }
  }
  return r;
}

// Referência de uma variável a uma classificação: "dados/dic/cnae.json" ou "dados/dic/cnae.json (classe_95)".
function refClassificacao(v) {
  const cand = [v.categorias, v.classificacao, v.tabela].find(x => typeof x === 'string' && /\.json/i.test(x));
  if (!cand) return null;
  const m = cand.match(/^\s*(\S+?\.json)\s*(?:\(([^)]+)\))?/i);
  return m ? { url: m[1], sub: m[2] ? m[2].trim() : null } : null;
}

// Nível da classificação que corresponde aos valores da variável no Parquet.
function nivelFolha(cl, variavel, sub) {
  if (sub && cl.niveis[sub]) return sub;
  if (cl.niveis.codigo) return 'codigo';
  const v = variavel.toLowerCase();
  const porNome = Object.keys(cl.niveis).filter(n => v.includes(n.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return porNome || cl.ordem[0] || null;
}

export function nomeClassificacao(url) {
  return String(url).split('/').pop().replace(/\.json$/i, '');
}

export async function carregarCatalogo() {
  const pasta = pastaDados();
  const cat = { pasta, manifestos: [], tabelas: {}, dic: {}, classificacoes: {}, hostsDados: new Set([location.host]) };
  await Promise.all(MANIFESTOS.map(async nome => {
    const url = `${pasta}manifest_${nome}.json`;
    const reg = { nome, url, ok: false };
    cat.manifestos.push(reg);
    try {
      const m = await lerJSON(url);
      reg.ok = true;
      reg.gerado_em = m.gerado_em;
      for (const [chave, t] of Object.entries(m.tabelas || {})) {
        const arquivos = (t.arquivos || []).map(a => {
          const abs = absoluta(a.url);
          cat.hostsDados.add(hostDe(abs));
          return { ...a, ano: a.ano === undefined || a.ano === null ? null : Number(a.ano), urlManifesto: a.url, url: abs, host: hostDe(abs) };
        }).sort((x, y) => (x.ano ?? 0) - (y.ano ?? 0));
        const periodo = Array.isArray(t.periodo) ? t.periodo : (t.periodo ? [t.periodo] : []);
        cat.tabelas[chave] = {
          ...t, chave, manifesto: nome, arquivos, periodo,
          colAno: periodo[0] || null,
          colTrimestre: periodo.find(p => /^trimestre$/i.test(p)) || null,
          amostral: Boolean(t.peso),
          anos: arquivos.map(a => a.ano).filter(a => a !== null),
          linhas: arquivos.reduce((s, a) => s + (Number(a.linhas) || 0), 0),
          bytes: arquivos.reduce((s, a) => s + (Number(a.bytes) || 0), 0),
        };
      }
      reg.classificacoes = m.dicionarios || m.classificacoes || null;
    } catch (e) {
      reg.erro = String(e.message || e);
    }
  }));
  cat.manifestos.sort((a, b) => MANIFESTOS.indexOf(a.nome) - MANIFESTOS.indexOf(b.nome));
  // Ordem estável: PNAD antes da RAIS, e dentro de cada manifesto a ordem em que as tabelas aparecem.
  const ordenadas = {};
  for (const m of MANIFESTOS) for (const [k, t] of Object.entries(cat.tabelas)) if (t.manifesto === m) ordenadas[k] = t;
  cat.tabelas = ordenadas;

  // Dicionários das tabelas. Uma variável pode apontar para uma classificação ("classificacao": "dados/dic/cod_pnad.json").
  const refs = new Map(); // url da classificação -> nome
  const pedidos = [];
  for (const t of Object.values(cat.tabelas)) {
    if (!t.dicionario) continue;
    pedidos.push(lerJSON(absoluta(t.dicionario)).then(d => {
      const vars = {};
      for (const [nome, v] of Object.entries(d.variaveis || {})) {
        const ref = refClassificacao(v);
        let categorias = v.categorias && typeof v.categorias === 'object' ? normalizarCategorias(v.categorias) : null;
        // Categorias que mudam entre períodos: a lista junta todas (o dicionário mostra cada período).
        if (Array.isArray(v.categorias_por_periodo)) {
          for (const per of v.categorias_por_periodo) categorias = { ...(normalizarCategorias(per && per.categorias) || {}), ...(categorias || {}) };
        }
        vars[nome] = { ...v, categorias, classificacao: ref ? nomeClassificacao(ref.url) : null, subClassificacao: ref ? ref.sub : null };
        if (ref) refs.set(ref.url, nomeClassificacao(ref.url));
      }
      cat.dic[t.chave] = vars;
      t.notaDicionario = d.nota || null;
    }).catch(e => { cat.dic[t.chave] = {}; t.erroDicionario = String(e.message || e); }));
  }
  await Promise.all(pedidos);
  // Classificações declaradas nos manifestos ("dicionarios" ou "classificacoes") e as referenciadas pelas variáveis.
  for (const reg of cat.manifestos) {
    const c = reg.classificacoes;
    if (!c) continue;
    const lista = Array.isArray(c) ? c.map(u => [nomeClassificacao(u), u])
      : Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v : (v && (v.url || v.arquivo))]);
    for (const [nome, url] of lista) if (url) refs.set(url, nome);
  }
  await Promise.all([...refs].map(([url, nome]) => lerJSON(absoluta(url))
    .then(d => { cat.classificacoes[nome] = { url, ...normalizarClassificacao(d) }; })
    .catch(e => { cat.classificacoes[nome] = { url, niveis: {}, hierarquia: [], ordem: [], erro: String(e.message || e) }; })));
  for (const vars of Object.values(cat.dic)) {
    for (const [nome, v] of Object.entries(vars)) {
      const cl = v.classificacao && cat.classificacoes[v.classificacao];
      v.nivelClassificacao = cl ? nivelFolha(cl, nome, v.subClassificacao) : null;
    }
  }
  return cat;
}

// Variáveis com categorias (para linhas, colunas e filtros) e numéricas (para médias e somas).
export function variaveisCategoricas(cat, chave) {
  const vars = cat.dic[chave] || {};
  return Object.entries(vars).filter(([, v]) => v.categorias || v.classificacao).map(([nome, v]) => ({ nome, ...v }));
}

export function variaveisNumericas(cat, chave) {
  const vars = cat.dic[chave] || {};
  return Object.entries(vars).filter(([, v]) => !v.categorias && /INT|DOUBLE|DECIMAL|FLOAT|NUMERIC|REAL/i.test(v.tipo || ''))
    .map(([nome, v]) => ({ nome, ...v }));
}
