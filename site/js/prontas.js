// Consultas prontas (Início): cartões montados a partir dos manifestos. Só entram os cartões cujas tabelas,
// variáveis e macros existem; os anos saem do manifesto. "Rodar" mostra o resultado na própria página
// (PNAD com o renderizador do Explorar; RAIS com tabela de várias medidas) e "Ver SQL" leva ao editor.
import { el, num, mb, segundos, faixasAnos, paraCSV, baixarTexto, dicaErro } from './util.js';
import { dimensoes, juntarRotulo } from './dimensoes.js';
import { mostrar } from './explorar.js';
import { desenharGrafico } from './grafico.js';

const FAIXAS_IDADE = `CASE WHEN V2009 < 25 THEN '14 a 24 anos' WHEN V2009 < 40 THEN '25 a 39 anos' WHEN V2009 < 60 THEN '40 a 59 anos' ELSE '60 anos ou mais' END`;

const juntar = juntarRotulo;

function extremos(t) {
  const a0 = t.arquivos[0], a1 = t.arquivos[t.arquivos.length - 1];
  const tri = a => (Array.isArray(a.trimestres) && a.trimestres.length ? a.trimestres : [1, 2, 3, 4]);
  return { pri: { ano: a0.ano, tri: tri(a0)[0] }, ult: { ano: a1.ano, tri: tri(a1)[tri(a1).length - 1] } };
}

const rotTri = p => `${p.ano}T${p.tri}`;

export function cartoesProntos(cat, motor) {
  const T = cat.tabelas;
  const macros = new Set((motor.macrosEstimacao || []).map(m => m.nome));
  const out = [];

  // ------------------------------------------------------------------ PNAD
  const pt = T.pnad_trimestral;
  const vp = cat.dic.pnad_trimestral || {};
  const temPNAD = (...vs) => pt && pt.arquivos.length && vs.every(v => vp[v]);
  if (temPNAD('V2007', 'VD4001', 'VD4002') && macros.has('pnad_razao')) {
    const { pri, ult } = extremos(pt);
    const mesmo = pri.ano === ult.ano && pri.tri === ult.tri;
    const filtro = mesmo ? `Ano = ${ult.ano} AND Trimestre = ${ult.tri}`
      : `Ano IN (${pri.ano}, ${ult.ano}) AND ((Ano = ${pri.ano} AND Trimestre = ${pri.tri}) OR (Ano = ${ult.ano} AND Trimestre = ${ult.tri}))`;
    out.push({
      id: 'pnad_desocupacao_sexo', base: 'PNAD', tipo: 'pnad', titulo: 'Taxa de desocupação por sexo',
      desc: `${rotTri(pri)}${mesmo ? '' : ` e ${rotTri(ult)}`}: desocupados sobre a força de trabalho, com IC 95% e CV.`,
      plano: { linha: { variavel: 'V2007' }, rotuloMedida: 'taxa de desocupação por sexo', ehProporcao: true },
      sql: `-- Taxa de desocupação por sexo, ${rotTri(pri)}${mesmo ? '' : ` e ${rotTri(ult)}`}. Macro pnad_razao (sql/estimacao_pnad.sql).
SELECT e.Ano, e.Trimestre, e.grupo AS linha, r.rotulo AS linha_rotulo,
       e.estimativa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, V2007, ${filtro}) e
LEFT JOIN dic_categorias r ON r.tabela = 'pnad_trimestral' AND r.variavel = 'V2007' AND r.codigo_num = e.grupo
ORDER BY 1, 2, 3`,
    });
    out.push({
      id: 'pnad_serie_desocupacao', base: 'PNAD', tipo: 'pnad', titulo: 'Série da taxa de desocupação',
      desc: `Todos os trimestres, ${rotTri(pri)} a ${rotTri(ult)}, com IC 95%.`,
      plano: { rotuloMedida: 'taxa de desocupação', ehProporcao: true },
      sql: `-- Taxa de desocupação do município do Rio, ${rotTri(pri)} a ${rotTri(ult)}. Macro pnad_razao (sql/estimacao_pnad.sql).
SELECT e.Ano, e.Trimestre, e.estimativa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, true, true) e
ORDER BY 1, 2`,
    });
    if (vp.V2010 && vp.VD4016 && macros.has('pnad_media')) {
      out.push({
        id: 'pnad_rendimento_cor', base: 'PNAD', tipo: 'pnad', titulo: 'Rendimento habitual médio por cor ou raça',
        desc: `Trabalho principal dos ocupados (VD4016), R$ correntes, ${rotTri(ult)}.`,
        plano: { linha: { variavel: 'V2010' }, rotuloMedida: 'rendimento mensal habitual médio do trabalho principal (R$)', ehProporcao: false },
        sql: `-- Rendimento mensal habitual médio do trabalho principal (VD4016) dos ocupados, por cor ou raça, ${rotTri(ult)}.
-- Macro pnad_media (sql/estimacao_pnad.sql): média entre quem tem VD4016 preenchido. Valores em R$ correntes.
SELECT e.Ano, e.Trimestre, e.grupo AS linha, r.rotulo AS linha_rotulo,
       e.estimativa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_media(VD4016, V2010, Ano = ${ult.ano} AND Trimestre = ${ult.tri} AND VD4002 = 1) e
LEFT JOIN dic_categorias r ON r.tabela = 'pnad_trimestral' AND r.variavel = 'V2010' AND r.codigo_num = e.grupo
ORDER BY 1, 2, 3`,
      });
    }
    if (vp.V2009) {
      out.push({
        id: 'pnad_desocupacao_idade', base: 'PNAD', tipo: 'pnad', titulo: 'Taxa de desocupação por faixa de idade',
        desc: `Quatro faixas de idade, ${rotTri(ult)}.`,
        plano: { linha: { variavel: 'V2009' }, rotuloMedida: 'taxa de desocupação por faixa de idade', ehProporcao: true },
        sql: `-- Taxa de desocupação por faixa de idade (V2009), ${rotTri(ult)}. Macro pnad_razao (sql/estimacao_pnad.sql).
SELECT e.Ano, e.Trimestre, e.grupo AS linha,
       e.estimativa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT,
       ${FAIXAS_IDADE},
       Ano = ${ult.ano} AND Trimestre = ${ult.tri} AND V2009 >= 14) e
ORDER BY 1, 2, 3`,
      });
    }
    if (vp.VD4009 && vp.V4019 && macros.has('pnad_proporcao') && (ult.ano > 2015 || (ult.ano === 2015 && ult.tri === 4))) {
      out.push({
        id: 'pnad_informalidade_sexo', base: 'PNAD', tipo: 'pnad', titulo: 'Taxa de informalidade por sexo',
        desc: `Ocupados informais sobre o total de ocupados, ${rotTri(ult)}.`,
        plano: { linha: { variavel: 'V2007' }, rotuloMedida: 'taxa de informalidade por sexo', ehProporcao: true },
        sql: `-- Taxa de informalidade por sexo, ${rotTri(ult)}. Macro pnad_proporcao (sql/estimacao_pnad.sql).
-- Informais: sem carteira (VD4009 2 e 4), trabalhador familiar auxiliar (10), e empregador ou conta-própria
-- sem CNPJ (VD4009 8 e 9 com V4019 = 2). V4019 existe desde 2015T4.
SELECT e.Ano, e.Trimestre, e.grupo AS linha, r.rotulo AS linha_rotulo,
       e.estimativa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_proporcao(VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2), V2007,
       Ano = ${ult.ano} AND Trimestre = ${ult.tri} AND VD4002 = 1) e
LEFT JOIN dic_categorias r ON r.tabela = 'pnad_trimestral' AND r.variavel = 'V2007' AND r.codigo_num = e.grupo
ORDER BY 1, 2, 3`,
      });
    }
  }

  // ------------------------------------------------------------------ RAIS Vínculos
  const rv = T.rais_vinculos;
  const vr = cat.dic.rais_vinculos || {};
  if (rv && rv.arquivos.length && rv.anos.length) {
    const y = rv.anos[rv.anos.length - 1];
    const ativo = rv.ativo || 'ind_vinculo_ativo_31_12';
    const fonte = rv.macroPeriodo ? `${rv.macroPeriodo}(${y}, ${y})` : 'rais_vinculos';
    const ondeAno = rv.macroPeriodo ? '' : ` AND ano = ${y}`;
    const dims = dimensoes(cat, 'rais_vinculos');
    const dim = id => dims.find(d => d.id === id);
    const remMedia = `avg(vl_rem_media_nom) FILTER (WHERE vl_rem_media_nom > 0)`;
    const remMediana = `median(vl_rem_media_nom) FILTER (WHERE vl_rem_media_nom > 0)`;
    const notaRem = 'remuneração média mensal nominal no ano (vl_rem_media_nom), sem os valores zerados';
    const dSec = dim('cnae_2_0_subclasse@secao') || dim('cnae_2_0_classe@secao');
    if (dSec && vr.vl_rem_media_nom) {
      out.push({
        id: 'rais_setor_cnae', base: 'RAIS', tipo: 'rais', titulo: 'Vínculos e remuneração por setor',
        desc: `Vínculos ativos em 31/12/${y} e remuneração média, por seção da CNAE.`,
        medidas: [{ col: 'vinculos', rotulo: 'Vínculos ativos em 31/12', dec: 0 }, { col: 'rem_media', rotulo: 'Remuneração média (R$)', dec: 2 }],
        principal: 'vinculos', linha: dSec,
        sql: `-- Vínculos ativos em 31/12/${y} e ${notaRem}, por seção da CNAE.
-- A seção sai da subclasse pelas faixas de divisão da CNAE 2.0 (dados/dic/cnae.json).
WITH agg AS (
  SELECT ano, ${dSec.expr} AS linha, count(*) AS vinculos, ${remMedia} AS rem_media
  FROM ${fonte}
  WHERE ${ativo} = 1${ondeAno}
  GROUP BY ALL
)
SELECT agg.ano, agg.linha, rl.rotulo AS linha_rotulo, agg.vinculos, agg.rem_media
FROM agg
${juntar('rl', dSec, 'agg.linha')}
ORDER BY agg.vinculos DESC`,
      });
    }
    const dRaca = dim('raca_cor');
    if (dRaca && vr.cbo_2002_ocupacao && vr.vl_rem_media_nom) {
      const cbo = cat.classificacoes.cbo;
      const fam = cbo && cbo.niveis && cbo.niveis.familia ? (cbo.niveis.familia['2124'] || '') : '';
      out.push({
        id: 'rais_programadores_raca', base: 'RAIS', tipo: 'rais', titulo: 'Programadores por cor ou raça',
        desc: `CBO família 2124${fam ? ` (${fam.toLowerCase()})` : ''}, vínculos ativos em 31/12/${y}: média e mediana da remuneração.`,
        medidas: [{ col: 'vinculos', rotulo: 'Vínculos ativos', dec: 0 }, { col: 'rem_media', rotulo: 'Remuneração média (R$)', dec: 2 }, { col: 'rem_mediana', rotulo: 'Remuneração mediana (R$)', dec: 2 }],
        principal: 'vinculos', linha: dRaca,
        sql: `-- Vínculos ativos em 31/12/${y} na família 2124 da CBO 2002${fam ? ` (${fam})` : ''}, por cor ou raça.
-- A família são os 4 primeiros dígitos da ocupação: cbo_2002_ocupacao // 100. Remuneração: ${notaRem}.
WITH agg AS (
  SELECT ano, raca_cor AS linha, count(*) AS vinculos, ${remMedia} AS rem_media, ${remMediana} AS rem_mediana
  FROM ${fonte}
  WHERE ${ativo} = 1 AND cbo_2002_ocupacao // 100 = 2124${ondeAno}
  GROUP BY ALL
)
SELECT agg.ano, agg.linha, rl.rotulo AS linha_rotulo, agg.vinculos, agg.rem_media, agg.rem_mediana
FROM agg
${juntar('rl', dRaca, 'agg.linha')}
ORDER BY agg.vinculos DESC`,
      });
    }
    const dEsc = dim('escolaridade_apos_2005'), dSexo = dim('sexo');
    if (dEsc && dSexo && vr.vl_rem_media_nom) {
      out.push({
        id: 'rais_rem_sexo_escolaridade', base: 'RAIS', tipo: 'rais', titulo: 'Remuneração por sexo e escolaridade',
        desc: `Vínculos ativos em 31/12/${y}: média e mediana da remuneração nominal.`,
        medidas: [{ col: 'vinculos', rotulo: 'Vínculos ativos', dec: 0 }, { col: 'rem_media', rotulo: 'Remuneração média (R$)', dec: 2 }, { col: 'rem_mediana', rotulo: 'Remuneração mediana (R$)', dec: 2 }],
        principal: 'rem_mediana', linha: dEsc, coluna: dSexo,
        sql: `-- Remuneração por escolaridade e sexo, vínculos ativos em 31/12/${y}. Remuneração: ${notaRem}.
WITH agg AS (
  SELECT ano, escolaridade_apos_2005 AS linha, sexo AS coluna, count(*) AS vinculos,
         ${remMedia} AS rem_media, ${remMediana} AS rem_mediana
  FROM ${fonte}
  WHERE ${ativo} = 1${ondeAno}
  GROUP BY ALL
)
SELECT agg.ano, agg.linha, rl.rotulo AS linha_rotulo, agg.coluna, rc.rotulo AS coluna_rotulo,
       agg.vinculos, agg.rem_media, agg.rem_mediana
FROM agg
${juntar('rl', dEsc, 'agg.linha')}
${juntar('rc', dSexo, 'agg.coluna')}
ORDER BY agg.linha, agg.coluna`,
      });
    }
    const a0 = rv.anos[0];
    out.push({
      id: 'rais_serie_vinculos', base: 'RAIS', tipo: 'rais', titulo: 'Série de vínculos ativos em 31/12',
      desc: `Anos publicados: ${faixasAnos(rv.anos)}. Abre todos os arquivos de vínculos (a primeira vez demora mais).`,
      medidas: [{ col: 'vinculos', rotulo: 'Vínculos ativos em 31/12', dec: 0 }],
      principal: 'vinculos',
      sql: `-- Vínculos ativos em 31/12 por ano, ${faixasAnos(rv.anos)} (todos os anos publicados).
SELECT ano, count(*) AS vinculos
FROM ${rv.macroPeriodo ? `${rv.macroPeriodo}(${a0}, ${y})` : 'rais_vinculos'}
WHERE ${ativo} = 1
GROUP BY ano
ORDER BY ano`,
    });
  }

  // ------------------------------------------------------------------ RAIS Estabelecimentos
  const re = T.rais_estab;
  if (re && re.arquivos.length && re.anos.length) {
    const y = re.anos[re.anos.length - 1];
    const dTam = dimensoes(cat, 'rais_estab').find(d => d.id === 'tamanho_estabelecimento');
    const ve = cat.dic.rais_estab || {};
    if (dTam && ve.qtd_vinculos_ativos) {
      out.push({
        id: 'rais_estab_tamanho', base: 'RAIS', tipo: 'rais', titulo: 'Estabelecimentos por tamanho',
        desc: `Estabelecimentos e vínculos ativos em 31/12/${y}, por faixa de empregados.`,
        medidas: [{ col: 'estabelecimentos', rotulo: 'Estabelecimentos', dec: 0 }, { col: 'vinculos', rotulo: 'Vínculos ativos em 31/12', dec: 0 }],
        principal: 'estabelecimentos', linha: dTam,
        sql: `-- Estabelecimentos e vínculos ativos em 31/12/${y} por tamanho (empregados ativos em 31/12).
-- A faixa "zero" inclui os estabelecimentos sem empregados no fim do ano (por exemplo, RAIS negativa).
WITH agg AS (
  SELECT ano, tamanho_estabelecimento AS linha, count(*) AS estabelecimentos, sum(qtd_vinculos_ativos) AS vinculos
  FROM ${re.macroPeriodo ? `${re.macroPeriodo}(${y}, ${y})` : 'rais_estab'}
  ${re.macroPeriodo ? '' : `WHERE ano = ${y}\n  `}GROUP BY ALL
)
SELECT agg.ano, agg.linha, rl.rotulo AS linha_rotulo, agg.estabelecimentos, agg.vinculos
FROM agg
${juntar('rl', dTam, 'agg.linha')}
ORDER BY agg.linha`,
      });
    }
  }
  return out;
}

function rotulo(x, campo) {
  const v = x[campo];
  if (v === null || v === undefined) return '(vazio)';
  const r = x[campo + '_rotulo'];
  return r || String(v);
}

function mostrarRAIS(saida, c, r, ctx) {
  saida.innerHTML = '';
  const s = r.stats;
  saida.append(el('p', { class: 'mudo', id: 'pronta-stats' }, `${num(r.linhas.length)} linhas · ${segundos(s.ms)} · ${mb(s.dados.bytes)} baixados em ${s.dados.req} requisições${s.criados.length ? ` · abriu ${s.criados.join(', ')}` : ''}`));
  saida.append(el('div', { class: 'acoes' },
    el('button', { type: 'button', class: 'secundario', onclick: () => baixarTexto(`${c.id}.csv`, paraCSV(r.colunas, r.linhas)) }, 'CSV'),
    el('button', { type: 'button', class: 'secundario', onclick: () => baixarTexto(`${c.id}_excel.csv`, paraCSV(r.colunas, r.linhas, 'br')) }, 'CSV (Excel pt-BR)'),
    el('button', { type: 'button', class: 'secundario', onclick: () => ctx.abrirNoEditor(c.sql) }, 'Ver SQL')));
  const graf = el('div', { class: 'grafico', id: 'pronta-grafico' });
  saida.append(graf);
  const pr = c.medidas.find(m => m.col === c.principal) || c.medidas[0];
  const linhas = r.linhas.map(x => ({
    _periodo: String(x.ano), _linha: c.linha ? rotulo(x, 'linha') : null, _coluna: c.coluna ? rotulo(x, 'coluna') : null,
    valor: x[pr.col], registros: x.vinculos ?? x.estabelecimentos ?? null,
  }));
  const tab = el('table', { class: 'dados', id: 'pronta-tabela' },
    el('thead', {}, el('tr', {}, ['Ano', ...(c.linha ? ['Categoria'] : []), ...(c.coluna ? [c.coluna.variavel === 'sexo' ? 'Sexo' : 'Coluna'] : []), ...c.medidas.map(m => m.rotulo)].map(h => el('th', {}, h)))),
    el('tbody', {}, r.linhas.map(x => el('tr', {},
      el('td', {}, String(x.ano)), c.linha ? el('td', {}, rotulo(x, 'linha')) : null, c.coluna ? el('td', {}, rotulo(x, 'coluna')) : null,
      c.medidas.map(m => el('td', { class: 'num' }, num(x[m.col], m.dec)))))));
  saida.append(el('div', { class: 'rolagem' }, tab));
  saida.append(el('p', { class: 'nota' }, `RAIS: registro administrativo, sem peso e sem erro amostral.${c.medidas.some(m => /rem/.test(m.col)) ? ' Remunerações em reais nominais de cada ano.' : ''}`));
  desenharGrafico(graf, linhas, { amostral: false, medida: pr.col === 'vinculos' || pr.col === 'estabelecimentos' ? 'contagem' : 'valor', rotuloMedida: pr.rotulo, ehMonetario: /rem/.test(pr.col) })
    .catch(e => { graf.innerHTML = ''; graf.append(el('p', { class: 'nota' }, 'Gráfico indisponível: ' + (e.message || e))); });
}

export function montarProntas(grade, saida, ctx) {
  const { cat, motor } = ctx;
  const lista = cartoesProntos(cat, motor);
  grade.innerHTML = '';
  if (!lista.length) {
    grade.append(el('p', { class: 'mudo' }, 'Nenhuma consulta pronta disponível: os manifestos ainda não trazem as tabelas necessárias.'));
    return lista;
  }
  for (const c of lista) {
    const rodar = el('button', { type: 'button', 'data-pronta': c.id, class: 'rodar-pronta' }, 'Rodar');
    const ver = el('button', { type: 'button', class: 'secundario', 'data-ver-sql': c.id }, 'Ver SQL');
    ver.addEventListener('click', () => ctx.abrirNoEditor(c.sql));
    rodar.addEventListener('click', async () => {
      for (const b of grade.querySelectorAll('button.rodar-pronta')) b.disabled = true;
      saida.innerHTML = '';
      const cab = el('div', { class: 'res-cabeca' }, el('span', { class: 'base' }, c.base), el('h3', { id: 'pronta-titulo' }, c.titulo), el('p', { class: 'mudo' }, c.desc));
      const corpo = el('div', {}, el('p', { class: 'mudo', role: 'status' }, 'Rodando…'));
      saida.append(cab, corpo);
      saida.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.__ultimaPronta = null;
      try {
        const r = await motor.consultar(c.sql, { origem: `consulta pronta: ${c.titulo}` });
        if (c.tipo === 'pnad') {
          const plano = { tabela: cat.tabelas.pnad_trimestral, medida: c.id, linha: null, coluna: null, amostral: true, periodo: { b: { ano: 0 } }, soRotulo: true, semTitulo: true, sql: c.sql, ...c.plano };
          mostrar(corpo, plano, r, ctx);
        } else {
          mostrarRAIS(corpo, c, r, ctx);
        }
        window.__ultimaPronta = { id: c.id, sql: c.sql, colunas: r.colunas, linhas: r.linhas, stats: { ms: r.stats.ms, dados: r.stats.dados } };
      } catch (e) {
        corpo.innerHTML = '';
        corpo.append(el('p', { class: 'erro', id: 'pronta-erro' }, String(e.message || e) + dicaErro(e.message || e)));
        window.__ultimaPronta = { id: c.id, erro: String(e.message || e) };
      } finally {
        for (const b of grade.querySelectorAll('button.rodar-pronta')) b.disabled = false;
      }
    });
    grade.append(el('article', { class: 'cartao-pronto', id: `pronta-${c.id}` },
      el('span', { class: 'base' }, c.base), el('h3', {}, c.titulo), el('p', { class: 'mudo' }, c.desc),
      el('div', { class: 'acoes' }, rodar, ver)));
  }
  return lista;
}
