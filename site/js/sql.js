// Editor SQL: textarea, Ctrl+Enter, exemplos prontos, limite de linhas exibidas, CSV e link da consulta.
import { el, num, mb, segundos, celula, paraCSV, baixarTexto } from './util.js';

function ultimoPeriodo(t) {
  const a = t.arquivos[t.arquivos.length - 1];
  if (!a) return null;
  const tris = Array.isArray(a.trimestres) && a.trimestres.length ? a.trimestres : null;
  return { ano: a.ano, tri: tris ? tris[tris.length - 1] : null };
}

// Exemplos montados a partir do catálogo: só entram os que usam tabelas publicadas.
export function exemplos(cat, motor) {
  const ex = [];
  const T = cat.tabelas;
  const temMacro = n => (motor.macrosEstimacao || []).some(m => m.nome === n);
  ex.push({ titulo: 'Catálogo: tabelas, views e macros disponíveis', sql: 'SELECT * FROM catalogo;' });
  if (T.pnad_trimestral && temMacro('pnad_razao')) {
    const u = ultimoPeriodo(T.pnad_trimestral);
    const filtroUlt = `Ano = ${u.ano}${u.tri ? ` AND Trimestre = ${u.tri}` : ''}`;
    ex.push({ titulo: `PNAD: taxa de desocupação por sexo, ${u.ano}${u.tri ? 'T' + u.tri : ''}, com erro-padrão e IC 95%`, sql:
`-- pnad_razao(numerador, denominador, grupo, filtro), de sql/estimacao_pnad.sql
SELECT r.Ano, r.Trimestre, r.grupo AS V2007, c.rotulo AS sexo,
       r.estimativa, r.ep, r.ic95_inf, r.ic95_sup, r.cv, r.n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, V2007, ${filtroUlt}) r
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2007' AND c.codigo_num = r.grupo
ORDER BY 1, 2, 3;` });
    ex.push({ titulo: 'PNAD: série da taxa de desocupação, todos os trimestres', sql:
`SELECT Ano, Trimestre, estimativa AS taxa_desocupacao, ep, ic95_inf, ic95_sup, cv, n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, true, true)
ORDER BY Ano, Trimestre;` });
    if (temMacro('pnad_total_cal')) ex.push({ titulo: `PNAD: ocupados e desocupados (pessoas), ${u.ano}, com a calibração no erro-padrão`, sql:
`-- pnad_total_cal(y, grupo, filtro): total ponderado; variância com a calibração por posest.
SELECT Ano, Trimestre, grupo AS VD4002, estimativa AS pessoas, ep, cv, n_amostra
FROM pnad_total_cal(1, VD4002, Ano = ${u.ano} AND VD4002 IS NOT NULL)
ORDER BY 1, 2, 3;` });
    if (temMacro('pnad_media')) ex.push({ titulo: `PNAD: rendimento habitual médio do trabalho principal (VD4016) por cor ou raça, ${u.ano}`, sql:
`-- pnad_media(y, grupo, filtro): média de y entre os registros do filtro com y preenchido.
SELECT r.Ano, r.Trimestre, r.grupo AS V2010, c.rotulo AS cor_raca, r.estimativa AS media_vd4016, r.ep, r.cv, r.n_amostra
FROM pnad_media(VD4016, V2010, Ano = ${u.ano} AND VD4002 = 1) r
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2010' AND c.codigo_num = r.grupo
ORDER BY 1, 2, 3;` });
    if (temMacro('pnad_proporcao') && (u.ano > 2015 || (u.ano === 2015 && u.tri === 4))) ex.push({ titulo: `PNAD: taxa de informalidade dos ocupados, ${u.ano}${u.tri ? 'T' + u.tri : ''} (definição em sql/estimacao_pnad.sql)`, sql:
`-- pnad_proporcao(condição, grupo, filtro). Informais: sem carteira (VD4009 2 e 4), trabalhador familiar
-- auxiliar (10), e empregador ou conta-própria sem CNPJ (VD4009 8 e 9 com V4019 = 2). V4019 existe desde 2015T4.
SELECT r.Ano, r.Trimestre, r.grupo AS V2007, c.rotulo AS sexo, r.estimativa AS taxa_informalidade, r.ep, r.cv, r.n_amostra
FROM pnad_proporcao(VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2), V2007, ${filtroUlt} AND VD4002 = 1) r
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2007' AND c.codigo_num = r.grupo
ORDER BY 1, 2, 3;` });
    ex.push({ titulo: `PNAD: população estimada (soma dos pesos) e pessoas na amostra, ${u.ano}`, sql:
`SELECT Ano, Trimestre, round(sum(V1028)) AS populacao, count(*) AS pessoas_na_amostra,
       count(DISTINCT UPA) AS upas
FROM pnad_trimestral
WHERE Ano = ${u.ano}
GROUP BY ALL ORDER BY ALL;` });
  }
  for (const v of ['pnad_visita1', 'pnad_visita5']) {
    if (!T[v] || !temMacro('pnad_anual_proporcao')) continue;
    const y = T[v].anos[T[v].anos.length - 1];
    ex.push({ titulo: `PNAD anual (${T[v].titulo || v}): proporção com superior completo entre 25 anos ou mais, ${y}`, sql:
`-- Macros anuais: o primeiro argumento é o nome da tabela; peso V1032.
SELECT * FROM pnad_anual_proporcao('${v}', VD3004 = 7, true, V2009 >= 25 AND Ano = ${y});` });
  }
  const rv = T.rais_vinculos;
  if (rv) {
    const y = rv.anos[rv.anos.length - 1];
    const fonte = rv.macroPeriodo ? `${rv.macroPeriodo}(${y}, ${y})` : 'rais_vinculos';
    ex.push({ titulo: `RAIS: programadores (CBO família 2124) por raça/cor, ${y}, com remuneração média`, sql:
`-- CBO 2002 tem 6 dígitos; a família (4 dígitos) é cbo_2002_ocupacao // 100.
-- ${rv.macroPeriodo ? `${rv.macroPeriodo}(a0, a1) só abre os arquivos dos anos pedidos.` : ''}
SELECT v.raca_cor, c.rotulo AS raca_cor_rotulo, count(*) AS vinculos_ativos,
       avg(v.vl_rem_media_nom) FILTER (WHERE v.vl_rem_media_nom > 0) AS rem_media_nominal
FROM ${fonte} v
LEFT JOIN dic_categorias c ON c.tabela = 'rais_vinculos' AND c.variavel = 'raca_cor' AND c.codigo_num = v.raca_cor
WHERE v.${rv.ativo || 'ind_vinculo_ativo_31_12'} = 1 AND v.cbo_2002_ocupacao // 100 = 2124
GROUP BY ALL ORDER BY vinculos_ativos DESC;` });
    ex.push({ titulo: 'RAIS: série de vínculos ativos em 31/12 por subsetor do IBGE (todos os anos)', sql:
`-- Abre todos os arquivos de vínculos (a primeira vez demora mais).
SELECT v.ano, v.ibge_subsetor, c.rotulo AS subsetor, count(*) AS vinculos_ativos
FROM rais_vinculos v
LEFT JOIN dic_categorias c ON c.tabela = 'rais_vinculos' AND c.variavel = 'ibge_subsetor' AND c.codigo_num = v.ibge_subsetor
WHERE v.${rv.ativo || 'ind_vinculo_ativo_31_12'} = 1
GROUP BY ALL ORDER BY 1, 2;` });
    ex.push({ titulo: `RAIS: mediana da remuneração média por sexo e escolaridade, ${y}`, sql:
`SELECT sexo, escolaridade_apos_2005, count(*) AS vinculos_ativos,
       median(vl_rem_media_nom) FILTER (WHERE vl_rem_media_nom > 0) AS mediana_rem_nominal
FROM ${fonte}
WHERE ${rv.ativo || 'ind_vinculo_ativo_31_12'} = 1
GROUP BY ALL ORDER BY 1, 2;` });
    if (T.rais_vinculos_2023_legado && rv.anos.includes(2023)) {
      ex.push({ titulo: 'RAIS 2023: série principal (eSocial) contra o arquivo Legado', sql:
`SELECT 'eSocial (série principal)' AS arquivo, count(*) AS registros, count(*) FILTER (WHERE ${rv.ativo || 'ind_vinculo_ativo_31_12'} = 1) AS ativos_31_12
FROM ${rv.macroPeriodo ? `${rv.macroPeriodo}(2023, 2023)` : 'rais_vinculos WHERE ano = 2023'}
UNION ALL
SELECT 'Legado', count(*), count(*) FILTER (WHERE ${rv.ativo || 'ind_vinculo_ativo_31_12'} = 1)
FROM rais_vinculos_2023_legado;` });
    }
  }
  const re = T.rais_estab;
  if (re) {
    const y = re.anos[re.anos.length - 1];
    const fonte = re.macroPeriodo ? `${re.macroPeriodo}(${y}, ${y})` : 'rais_estab';
    ex.push({ titulo: `RAIS Estabelecimentos: estabelecimentos e vínculos ativos por tamanho, ${y}`, sql:
`SELECT e.tamanho_estabelecimento, c.rotulo AS tamanho, count(*) AS estabelecimentos, sum(e.qtd_vinculos_ativos) AS vinculos_ativos
FROM ${fonte} e
LEFT JOIN dic_categorias c ON c.tabela = 'rais_estab' AND c.variavel = 'tamanho_estabelecimento' AND c.codigo_num = e.tamanho_estabelecimento
GROUP BY ALL ORDER BY 1;` });
  }
  ex.push({ titulo: 'Dicionário: variáveis cuja descrição fala em rendimento', sql:
`SELECT tabela, variavel, descricao, tipo, anos
FROM dic_variaveis
WHERE descricao ILIKE '%rendimento%'
ORDER BY tabela, variavel;` });
  return ex;
}

function lerHash() {
  const m = location.hash.match(/^#sql\?q=(.*)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

export function montarSQL(raiz, ctx) {
  const { cat, motor } = ctx;
  raiz.innerHTML = '';
  const lista = exemplos(cat, motor);
  const area = el('textarea', { id: 'sql-texto', class: 'mono editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', rows: 12, 'aria-label': 'Consulta SQL' });
  area.value = lerHash() || sessionStorage.getItem('sql-texto') || lista[1]?.sql || lista[0].sql;
  const selEx = el('select', { id: 'sql-exemplos', 'aria-label': 'Exemplos' }, el('option', { value: '' }, 'Exemplos prontos…'), lista.map((e, i) => el('option', { value: i }, e.titulo)));
  selEx.addEventListener('change', () => { if (selEx.value !== '') { area.value = lista[Number(selEx.value)].sql; salvar(); } selEx.value = ''; });
  const selLim = el('select', { id: 'sql-limite', 'aria-label': 'Linhas exibidas' }, [100, 1000, 10000].map(n => el('option', { value: n, selected: n === 1000 }, `mostrar até ${num(n)} linhas`)));
  const btn = el('button', { type: 'button', id: 'sql-executar' }, 'Executar (Ctrl+Enter)');
  const btnCSV = el('button', { type: 'button', class: 'secundario', id: 'sql-csv', disabled: true }, 'CSV');
  const btnCSVBR = el('button', { type: 'button', class: 'secundario', disabled: true }, 'CSV (Excel pt-BR)');
  const btnLink = el('button', { type: 'button', class: 'secundario', id: 'sql-link' }, 'Link desta consulta');
  const saida = el('div', { id: 'sql-saida', class: 'sql-saida' });
  const objetos = el('details', { class: 'painel objetos' }, el('summary', {}, 'Tabelas, views e macros'),
    el('p', { class: 'nota' }, 'As views são criadas na primeira consulta que as menciona. Os macros _periodo(ano_inicial, ano_final) só abrem os arquivos dos anos pedidos; a view sem sufixo abre todos.'),
    el('ul', { class: 'lista-objetos' },
      Object.values(cat.tabelas).filter(t => t.arquivos.length).flatMap(t => [
        el('li', {}, el('code', {}, t.chave), ` · ${t.titulo || ''} (${t.arquivos.length} arquivo${t.arquivos.length > 1 ? 's' : ''})`),
        t.macroPeriodo ? el('li', {}, el('code', {}, `${t.macroPeriodo}(a0, a1)`)) : null,
      ]),
      (motor.macrosEstimacao || []).map(m => el('li', {}, el('code', {}, `${m.nome}(${m.parametros.join(', ')})`), ' · sql/estimacao_pnad.sql')),
      el('li', {}, el('code', {}, 'dic_variaveis'), ', ', el('code', {}, 'dic_categorias'), ', ', el('code', {}, 'catalogo'))));
  let ultimo = null;
  function salvar() { try { sessionStorage.setItem('sql-texto', area.value); } catch { /* sem armazenamento */ } }
  area.addEventListener('input', salvar);
  area.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); executar(); }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const p = area.selectionStart; area.setRangeText('  ', p, area.selectionEnd, 'end'); }
  });
  btn.addEventListener('click', executar);
  btnCSV.addEventListener('click', () => ultimo && baixarTexto('consulta.csv', paraCSV(ultimo.colunas, ultimo.linhas)));
  btnCSVBR.addEventListener('click', () => ultimo && baixarTexto('consulta_excel.csv', paraCSV(ultimo.colunas, ultimo.linhas, 'br')));
  btnLink.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${location.search}#sql?q=${encodeURIComponent(area.value)}`;
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); btnLink.textContent = 'Link copiado'; } catch { btnLink.textContent = 'Link na barra de endereço'; }
    setTimeout(() => { btnLink.textContent = 'Link desta consulta'; }, 2500);
  });

  async function executar() {
    const sql = area.value.trim();
    if (!sql) return;
    btn.disabled = true;
    saida.innerHTML = '';
    saida.append(el('p', { class: 'mudo', role: 'status' }, 'Executando…'));
    try {
      const r = await motor.consultar(sql, { origem: 'sql' });
      ultimo = r;
      btnCSV.disabled = btnCSVBR.disabled = false;
      mostrar(r, Number(selLim.value));
    } catch (e) {
      ultimo = null;
      btnCSV.disabled = btnCSVBR.disabled = true;
      saida.innerHTML = '';
      const s = e.stats;
      saida.append(el('pre', { class: 'erro', id: 'sql-erro' }, String(e.message || e)));
      if (s) saida.append(el('p', { class: 'mudo' }, `${segundos(s.ms)} · ${mb(s.dados.bytes)} baixados em ${s.dados.req} requisições`));
    } finally {
      btn.disabled = false;
    }
  }

  function mostrar(r, limite) {
    saida.innerHTML = '';
    const s = r.stats;
    window.__ultimoSQL = { colunas: r.colunas, linhas: r.linhas, stats: { ms: s.ms, dados: s.dados } };
    saida.append(el('p', { class: 'mudo', id: 'sql-stats' }, `${num(r.linhas.length)} linhas${r.linhas.length > limite ? ` (mostrando ${num(limite)}; o CSV tem todas)` : ''} · ${segundos(s.ms)} · ${mb(s.dados.bytes)} baixados em ${s.dados.req} requisições${s.criados.length ? ` · abriu ${s.criados.join(', ')}` : ''}`));
    if (!r.colunas.length) return;
    const tab = el('table', { class: 'dados', id: 'sql-tabela' },
      el('thead', {}, el('tr', {}, r.colunas.map((c, i) => el('th', { title: r.tipos[i] }, c)))),
      el('tbody', {}, r.linhas.slice(0, limite).map(l => el('tr', {}, r.colunas.map(c => {
        const v = l[c];
        return el('td', { class: typeof v === 'number' ? 'num' : null }, celula(v));
      })))));
    saida.append(el('div', { class: 'rolagem' }, tab));
  }

  raiz.append(
    el('div', { class: 'sql-barra' }, selEx, selLim),
    area,
    el('div', { class: 'acoes' }, btn, btnCSV, btnCSVBR, btnLink),
    objetos, saida);
  return { definir(sql) { area.value = sql; salvar(); }, executar };
}
