// Editor SQL: exemplos à vista em cartões (agrupados por base, montados a partir dos manifestos), textarea com
// Ctrl+Enter, limite de linhas exibidas, CSV e link da consulta.
import { el, num, mb, segundos, celula, paraCSV, baixarTexto, faixasAnos, dicaErro } from './util.js';
import { dimensoes, juntarRotulo } from './dimensoes.js';

function extremosTri(t) {
  const tri = a => (Array.isArray(a.trimestres) && a.trimestres.length ? a.trimestres : [1, 2, 3, 4]);
  const a0 = t.arquivos[0], a1 = t.arquivos[t.arquivos.length - 1];
  return { pri: { ano: a0.ano, tri: tri(a0)[0] }, ult: { ano: a1.ano, tri: tri(a1)[tri(a1).length - 1] } };
}

export const GRUPOS = [
  { id: 'pnad_trimestral', rotulo: 'PNAD trimestral' },
  { id: 'pnad_anual', rotulo: 'PNAD anual (visitas 1 e 5)' },
  { id: 'rais_vinculos', rotulo: 'RAIS Vínculos' },
  { id: 'rais_estab', rotulo: 'RAIS Estabelecimentos' },
  { id: 'catalogo', rotulo: 'Catálogo e dicionário' },
];

// Exemplos montados a partir do catálogo: só entram os que usam tabelas, variáveis e macros publicados,
// com os anos que existem nos manifestos.
export function exemplos(cat, motor) {
  const ex = [];
  const T = cat.tabelas;
  const macros = new Set((motor.macrosEstimacao || []).map(m => m.nome));
  const add = (grupo, id, titulo, desc, sql) => ex.push({ grupo, id, titulo, desc, sql });

  // ---------------------------------------------------------------- PNAD trimestral
  const pt = T.pnad_trimestral, vp = cat.dic.pnad_trimestral || {};
  if (pt && pt.arquivos.length && macros.has('pnad_razao') && vp.VD4001 && vp.VD4002) {
    const { pri, ult } = extremosTri(pt);
    const f = `Ano = ${ult.ano} AND Trimestre = ${ult.tri}`;
    const ut = `${ult.ano}T${ult.tri}`;
    const dims = dimensoes(cat, 'pnad_trimestral');
    add('pnad_trimestral', 'pt_desocupacao_sexo', `Taxa de desocupação por sexo, ${ut}`, 'Desocupados sobre a força de trabalho, com erro-padrão, IC 95% e CV.',
`-- pnad_razao(numerador, denominador, grupo, filtro), de sql/estimacao_pnad.sql
SELECT e.Ano, e.Trimestre, c.rotulo AS sexo, e.estimativa AS taxa, e.ep, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, V2007, ${f}) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2007' AND c.codigo_num = e.grupo
ORDER BY e.grupo;`);
    add('pnad_trimestral', 'pt_serie_desocupacao', 'Série da taxa de desocupação', `Todos os trimestres, ${pri.ano}T${pri.tri} a ${ut}.`,
`SELECT Ano, Trimestre, estimativa AS taxa_desocupacao, ep, ic95_inf, ic95_sup, cv, n_amostra
FROM pnad_razao((VD4002 = 2)::INT, (VD4001 = 1)::INT, true, true)
ORDER BY Ano, Trimestre;`);
    if (vp.VD4010 && macros.has('pnad_total_cal')) {
      add('pnad_trimestral', 'pt_ocupados_atividade', `Ocupados por grupamento de atividade, ${ut}`, 'Pessoas ocupadas (total ponderado) em cada grupamento de atividade (VD4010), com IC 95%.',
`-- pnad_total_cal(y, grupo, filtro): total ponderado; a variância trata a calibração por posest.
SELECT c.rotulo AS grupamento_de_atividade, e.estimativa AS ocupados, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_total_cal(1, VD4010, ${f} AND VD4002 = 1 AND VD4010 IS NOT NULL) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'VD4010' AND c.codigo_num = e.grupo
ORDER BY e.estimativa DESC;`);
    }
    const dGG = dims.find(d => d.id === 'V4010@grande_grupo');
    if (dGG && dGG.rot && macros.has('pnad_total_cal')) {
      add('pnad_trimestral', 'pt_ocupados_cod', `Ocupados por grande grupo de ocupação (COD), ${ut}`, 'Ocupação do trabalho principal (V4010) agregada no 1º dígito da COD.',
`-- O grande grupo da COD é o primeiro dígito do código de 4 dígitos de V4010 (dados/dic/cod_pnad.json).
SELECT c.rotulo AS grande_grupo, e.estimativa AS ocupados, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_total_cal(1, ${dGG.expr}, ${f} AND VD4002 = 1 AND V4010 IS NOT NULL) e
${juntarRotulo('c', dGG, 'e.grupo')}
ORDER BY e.estimativa DESC;`);
    }
    if (vp.VD4016 && vp.V2010 && macros.has('pnad_media')) {
      add('pnad_trimestral', 'pt_rendimento_cor', `Rendimento habitual médio por cor ou raça, ${ut}`, 'VD4016 (trabalho principal) dos ocupados, em R$ correntes.',
`-- pnad_media(y, grupo, filtro): média de y entre os registros do filtro com y preenchido.
SELECT c.rotulo AS cor_raca, e.estimativa AS rendimento_medio, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_media(VD4016, V2010, ${f} AND VD4002 = 1) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2010' AND c.codigo_num = e.grupo
ORDER BY e.grupo;`);
    }
    if (vp.VD4009 && vp.V4019 && macros.has('pnad_proporcao') && (ult.ano > 2015 || (ult.ano === 2015 && ult.tri === 4))) {
      add('pnad_trimestral', 'pt_informalidade', `Taxa de informalidade por sexo, ${ut}`, 'Ocupados sem carteira, sem CNPJ ou auxiliares familiares, sobre o total de ocupados.',
`-- Informais: sem carteira (VD4009 2 e 4), trabalhador familiar auxiliar (10), e empregador ou conta-própria
-- sem CNPJ (VD4009 8 e 9 com V4019 = 2). V4019 existe desde 2015T4. Definição em sql/estimacao_pnad.sql.
SELECT c.rotulo AS sexo, e.estimativa AS taxa_informalidade, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_proporcao(VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2), V2007, ${f} AND VD4002 = 1) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_trimestral' AND c.variavel = 'V2007' AND c.codigo_num = e.grupo
ORDER BY e.grupo;`);
    }
    add('pnad_trimestral', 'pt_amostra', `População estimada e tamanho da amostra, ${ult.ano}`, 'Soma dos pesos, pessoas e UPAs na amostra, por trimestre (sem macro).',
`SELECT Ano, Trimestre, round(sum(V1028)) AS populacao_estimada, count(*) AS pessoas_na_amostra,
       count(DISTINCT UPA) AS upas
FROM pnad_trimestral
WHERE Ano = ${ult.ano}
GROUP BY ALL ORDER BY ALL;`);
  }

  // ---------------------------------------------------------------- PNAD anual (visitas)
  const v1 = T.pnad_visita1, v5 = T.pnad_visita5;
  const d1 = cat.dic.pnad_visita1 || {}, d5 = cat.dic.pnad_visita5 || {};
  const ultimo = t => t.anos[t.anos.length - 1];
  if (macros.has('pnad_anual_media') && v1 && v1.anos.length && d1.VD5008 && d1.V2010) {
    const y = ultimo(v1);
    add('pnad_anual', 'pa_renda_pc_cor', `Rendimento domiciliar per capita médio por cor ou raça, ${y}`, '1ª visita: VD5008 (habitual de todos os trabalhos e efetivo de outras fontes), R$ correntes.',
`-- Macros anuais: o primeiro argumento é a tabela da visita; peso V1032. VD5008 em R$ correntes do ano.
SELECT c.rotulo AS cor_raca, e.estimativa AS rendimento_pc_medio, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_anual_media('pnad_visita1', VD5008, V2010, Ano = ${y}) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_visita1' AND c.variavel = 'V2010' AND c.codigo_num = e.grupo
ORDER BY e.grupo;`);
  }
  if (macros.has('pnad_anual_proporcao') && v1 && v1.anos.length && d1.VD5009) {
    add('pnad_anual', 'pa_ate_meio_sm', 'Pessoas com rendimento domiciliar per capita até ½ salário mínimo', `1ª visita, ${faixasAnos(v1.anos)}: faixas 1 e 2 de VD5009, por ano.`,
`-- VD5009 = 1 (até ¼ salário mínimo) ou 2 (mais de ¼ até ½), entre as pessoas com a faixa preenchida.
SELECT Ano, estimativa AS proporcao, ep, ic95_inf, ic95_sup, cv, n_amostra
FROM pnad_anual_proporcao('pnad_visita1', VD5009 IN (1, 2), true, VD5009 IS NOT NULL)
ORDER BY Ano;`);
  }
  if (macros.has('pnad_anual_proporcao') && v1 && d1.S01001 && v1.anos.some(a => a >= 2016)) {
    add('pnad_anual', 'pa_apartamento', 'Pessoas que moram em apartamento', `1ª visita, ${faixasAnos(v1.anos.filter(a => a >= 2016))}: tipo do domicílio (S01001 = Apartamento), por ano.`,
`-- S01001 (tipo do domicílio) existe desde 2016. Proporção de pessoas, não de domicílios.
SELECT Ano, estimativa AS proporcao_em_apartamento, ic95_inf, ic95_sup, cv, n_amostra
FROM pnad_anual_proporcao('pnad_visita1', S01001 = 2, true, Ano >= 2016 AND S01001 IS NOT NULL)
ORDER BY Ano;`);
  }
  const tvA = d1.V5002A ? ['pnad_visita1', v1] : (d5.V5002A ? ['pnad_visita5', v5] : null);
  if (macros.has('pnad_anual_proporcao') && tvA && tvA[1] && tvA[1].anos.length) {
    add('pnad_anual', 'pa_bolsa_familia', 'Recebeu Bolsa Família ou Auxílio Brasil no mês de referência', `${tvA[0] === 'pnad_visita1' ? '1ª' : '5ª'} visita: V5002A = Sim, entre as pessoas que responderam ao quesito, por ano.`,
`-- V5002A: "recebeu rendimentos de Programa Auxílio Brasil (antigo Bolsa Família)?" (rótulo do dicionário do IBGE).
SELECT Ano, estimativa AS proporcao, ic95_inf, ic95_sup, cv, n_amostra
FROM pnad_anual_proporcao('${tvA[0]}', V5002A = 1, true, V5002A IS NOT NULL)
ORDER BY Ano;`);
  }
  if (macros.has('pnad_anual_proporcao') && v5 && v5.anos.length && d5.VD3004 && d5.V2010) {
    const y = ultimo(v5);
    add('pnad_anual', 'pa_superior_cor', `Superior completo entre 25 anos ou mais, por cor ou raça, ${y}`, '5ª visita: VD3004 = Superior completo.',
`SELECT c.rotulo AS cor_raca, e.estimativa AS proporcao_superior_completo, e.ic95_inf, e.ic95_sup, e.cv, e.n_amostra
FROM pnad_anual_proporcao('pnad_visita5', VD3004 = 7, V2010, Ano = ${y} AND V2009 >= 25 AND VD3004 IS NOT NULL) e
LEFT JOIN dic_categorias c ON c.tabela = 'pnad_visita5' AND c.variavel = 'V2010' AND c.codigo_num = e.grupo
ORDER BY e.grupo;`);
  }

  // ---------------------------------------------------------------- RAIS Vínculos
  const rv = T.rais_vinculos, vr = cat.dic.rais_vinculos || {};
  if (rv && rv.anos.length) {
    const y = ultimo(rv), a0 = rv.anos[0];
    const ativo = rv.ativo || 'ind_vinculo_ativo_31_12';
    const de = (x0, x1) => (rv.macroPeriodo ? `${rv.macroPeriodo}(${x0}, ${x1})` : 'rais_vinculos');
    const dims = dimensoes(cat, 'rais_vinculos');
    const dim = id => dims.find(d => d.id === id);
    const remMedia = 'avg(vl_rem_media_nom) FILTER (WHERE vl_rem_media_nom > 0)';
    const dSec = dim('cnae_2_0_subclasse@secao') || dim('cnae_2_0_classe@secao');
    if (dSec && vr.vl_rem_media_nom) {
      add('rais_vinculos', 'rv_setor', `Vínculos e remuneração por setor, ${y}`, 'Vínculos ativos em 31/12 e remuneração média nominal, por seção da CNAE.',
`-- A seção sai da subclasse pelas faixas de divisão da CNAE 2.0 (dados/dic/cnae.json). Remuneração sem zeros.
WITH v AS (
  SELECT ${dSec.expr} AS secao, count(*) AS vinculos, ${remMedia} AS rem_media
  FROM ${de(y, y)}
  WHERE ${ativo} = 1
  GROUP BY 1
)
SELECT v.secao, s.rotulo AS setor, v.vinculos, round(v.rem_media, 2) AS remuneracao_media
FROM v ${juntarRotulo('s', dSec, 'v.secao')}
ORDER BY v.vinculos DESC;`);
    }
    const dFam = dim('cbo_2002_ocupacao@familia');
    if (dFam && dFam.rot) {
      add('rais_vinculos', 'rv_ocupacoes', `As 20 ocupações (famílias da CBO) com mais vínculos, ${y}`, 'Vínculos ativos em 31/12, por família da CBO 2002 (4 dígitos).',
`-- A família da CBO são os 4 primeiros dígitos da ocupação: cbo_2002_ocupacao // 100 (dados/dic/cbo.json).
WITH v AS (
  SELECT ${dFam.expr} AS familia, count(*) AS vinculos, ${remMedia} AS rem_media
  FROM ${de(y, y)}
  WHERE ${ativo} = 1 AND cbo_2002_ocupacao > 0
  GROUP BY 1
)
SELECT v.familia, f.rotulo AS ocupacao, v.vinculos, round(v.rem_media, 2) AS remuneracao_media
FROM v ${juntarRotulo('f', dFam, 'v.familia')}
ORDER BY v.vinculos DESC
LIMIT 20;`);
    }
    if (vr.raca_cor && vr.cbo_2002_ocupacao) {
      add('rais_vinculos', 'rv_programadores', `Programadores (CBO família 2124) por cor ou raça, ${y}`, 'Vínculos ativos em 31/12, média e mediana da remuneração.',
`SELECT c.rotulo AS raca_cor, count(*) AS vinculos,
       round(avg(v.vl_rem_media_nom) FILTER (WHERE v.vl_rem_media_nom > 0), 2) AS remuneracao_media,
       round(median(v.vl_rem_media_nom) FILTER (WHERE v.vl_rem_media_nom > 0), 2) AS remuneracao_mediana
FROM ${de(y, y)} v
LEFT JOIN dic_categorias c ON c.tabela = 'rais_vinculos' AND c.variavel = 'raca_cor' AND c.codigo_num = v.raca_cor
WHERE v.${ativo} = 1 AND v.cbo_2002_ocupacao // 100 = 2124
GROUP BY ALL ORDER BY vinculos DESC;`);
    }
    if (dSec && vr.sexo) {
      add('rais_vinculos', 'rv_mulheres_setor', `Participação das mulheres por setor, ${y}`, 'Proporção de vínculos ativos de mulheres (sexo = 2, FEMININO) em cada seção da CNAE.',
`WITH v AS (
  SELECT ${dSec.expr} AS secao, count(*) AS vinculos, count(*) FILTER (WHERE sexo = 2) AS mulheres
  FROM ${de(y, y)}
  WHERE ${ativo} = 1
  GROUP BY 1
)
SELECT s.rotulo AS setor, v.vinculos, v.mulheres, round(v.mulheres / v.vinculos, 4) AS proporcao_mulheres
FROM v ${juntarRotulo('s', dSec, 'v.secao')}
ORDER BY proporcao_mulheres DESC;`);
    }
    const yb = [...rv.anos].reverse().find(a => a <= 2021);
    if (yb && vr.bairros_rj) {
      add('rais_vinculos', 'rv_bairro', `Os 20 bairros com mais vínculos, ${yb}`, 'Bairro do estabelecimento (bairros_rj), informado nos vínculos só até 2021.',
`-- O bairro dos vínculos só vem até 2021 (de 2022 em diante vem como ignorado). Códigos e nomes: dados/dic/bairros_rj.json.
SELECT v.bairros_rj, CASE WHEN v.bairros_rj IS NULL THEN '(não informado: vazio ou {ñ class} na fonte)' ELSE b.rotulo END AS bairro,
       count(*) AS vinculos_ativos
FROM ${de(yb, yb)} v
LEFT JOIN dic_categorias b ON b.tabela = 'rais_vinculos' AND b.variavel = 'bairros_rj' AND b.codigo_num = v.bairros_rj
WHERE v.${ativo} = 1
GROUP BY ALL ORDER BY vinculos_ativos DESC
LIMIT 20;`);
    }
    if (vr.escolaridade_apos_2005 && vr.sexo) {
      add('rais_vinculos', 'rv_rem_sexo_escolaridade', `Remuneração por sexo e escolaridade, ${y}`, 'Vínculos ativos em 31/12: média e mediana da remuneração nominal.',
`SELECT e.rotulo AS escolaridade, s.rotulo AS sexo, count(*) AS vinculos,
       round(avg(v.vl_rem_media_nom) FILTER (WHERE v.vl_rem_media_nom > 0), 2) AS remuneracao_media,
       round(median(v.vl_rem_media_nom) FILTER (WHERE v.vl_rem_media_nom > 0), 2) AS remuneracao_mediana
FROM ${de(y, y)} v
LEFT JOIN dic_categorias e ON e.tabela = 'rais_vinculos' AND e.variavel = 'escolaridade_apos_2005' AND e.codigo_num = v.escolaridade_apos_2005
LEFT JOIN dic_categorias s ON s.tabela = 'rais_vinculos' AND s.variavel = 'sexo' AND s.codigo_num = v.sexo
WHERE v.${ativo} = 1
GROUP BY v.escolaridade_apos_2005, v.sexo, e.rotulo, s.rotulo
ORDER BY v.escolaridade_apos_2005, v.sexo;`);
    }
    if (T.rais_vinculos_2023_legado && T.rais_vinculos_2023_legado.arquivos.length && rv.anos.includes(2023)) {
      add('rais_vinculos', 'rv_esocial_legado', '2023: arquivo eSocial contra o arquivo Legado', 'A série principal usa o eSocial; o Legado do mesmo ano fica em rais_vinculos_2023_legado.',
`-- Quebra de série de 2023: mesmas contas nos dois arquivos do ano. Remuneração média dos ativos, sem zeros.
SELECT 'eSocial (série principal)' AS arquivo, count(*) AS vinculos, count(*) FILTER (WHERE ${ativo} = 1) AS ativos_31_12,
       round(avg(vl_rem_media_nom) FILTER (WHERE ${ativo} = 1 AND vl_rem_media_nom > 0), 2) AS remuneracao_media_ativos
FROM ${de(2023, 2023)}
UNION ALL
SELECT 'Legado', count(*), count(*) FILTER (WHERE ${ativo} = 1),
       round(avg(vl_rem_media_nom) FILTER (WHERE ${ativo} = 1 AND vl_rem_media_nom > 0), 2)
FROM rais_vinculos_2023_legado;`);
    }
    add('rais_vinculos', 'rv_serie', 'Série de vínculos ativos em 31/12', `Anos publicados: ${faixasAnos(rv.anos)}. Abre todos os arquivos de vínculos.`,
`SELECT ano, count(*) AS vinculos_ativos
FROM ${de(a0, y)}
WHERE ${ativo} = 1
GROUP BY ano ORDER BY ano;`);
  }

  // ---------------------------------------------------------------- RAIS Estabelecimentos
  const re = T.rais_estab, ve = cat.dic.rais_estab || {};
  if (re && re.anos.length) {
    const y = ultimo(re), a0 = re.anos[0];
    const de = (x0, x1) => (re.macroPeriodo ? `${re.macroPeriodo}(${x0}, ${x1})` : 'rais_estab');
    const dims = dimensoes(cat, 'rais_estab');
    const dim = id => dims.find(d => d.id === id);
    if (ve.tamanho_estabelecimento && ve.qtd_vinculos_ativos) {
      add('rais_estab', 're_porte', `Estabelecimentos por porte, ${y}`, 'Faixa de empregados ativos em 31/12 (tamanho_estabelecimento) e vínculos.',
`SELECT t.rotulo AS porte, count(*) AS estabelecimentos, sum(e.qtd_vinculos_ativos) AS vinculos_ativos
FROM ${de(y, y)} e
LEFT JOIN dic_categorias t ON t.tabela = 'rais_estab' AND t.variavel = 'tamanho_estabelecimento' AND t.codigo_num = e.tamanho_estabelecimento
GROUP BY e.tamanho_estabelecimento, t.rotulo
ORDER BY e.tamanho_estabelecimento;`);
    }
    const dSec = dim('cnae_2_0_subclasse@secao') || dim('cnae_2_0_classe@secao');
    if (dSec && ve.qtd_vinculos_ativos) {
      add('rais_estab', 're_setor', `Estabelecimentos com empregados por setor, ${y}`, 'Estabelecimentos com pelo menos um vínculo ativo em 31/12, por seção da CNAE.',
`WITH e AS (
  SELECT ${dSec.expr} AS secao, count(*) AS estabelecimentos, sum(qtd_vinculos_ativos) AS vinculos_ativos
  FROM ${de(y, y)}
  WHERE qtd_vinculos_ativos > 0
  GROUP BY 1
)
SELECT s.rotulo AS setor, e.estabelecimentos, e.vinculos_ativos
FROM e ${juntarRotulo('s', dSec, 'e.secao')}
ORDER BY e.estabelecimentos DESC;`);
    }
    const dBai = dim('bairro_ipp_cep');
    if (dBai && dBai.rot && re.anos.some(a => a >= 2014)) {
      add('rais_estab', 're_bairro', `Os 20 bairros com mais estabelecimentos com empregados, ${y}`, 'Bairro IPP pelo CEP do estabelecimento (bairro_ipp_cep, desde 2014).',
`-- bairro_ipp_cep: bairro da malha IPP 2023, a partir do CEP do estabelecimento (dados/dic/bairros_rj.json, "ipp").
SELECT e.bairro_ipp_cep, b.rotulo AS bairro, count(*) AS estabelecimentos, sum(e.qtd_vinculos_ativos) AS vinculos_ativos
FROM ${de(y, y)} e
${juntarRotulo('b', dBai, 'e.bairro_ipp_cep')}
WHERE e.qtd_vinculos_ativos > 0 AND e.bairro_ipp_cep IS NOT NULL
GROUP BY ALL ORDER BY estabelecimentos DESC
LIMIT 20;`);
    }
    if (ve.qtd_vinculos_ativos) {
      add('rais_estab', 're_serie', 'Série de estabelecimentos com empregados', `${faixasAnos(re.anos)}: estabelecimentos com vínculo ativo em 31/12 e total de vínculos.`,
`SELECT ano, count(*) FILTER (WHERE qtd_vinculos_ativos > 0) AS estabelecimentos_com_empregados,
       sum(qtd_vinculos_ativos) AS vinculos_ativos
FROM ${de(a0, y)}
GROUP BY ano ORDER BY ano;`);
    }
  }

  // ---------------------------------------------------------------- Catálogo e dicionário
  add('catalogo', 'ct_catalogo', 'Tabelas, views e macros disponíveis', 'A lista que o site monta a partir dos manifestos.', 'SELECT * FROM catalogo;');
  add('catalogo', 'ct_rendimento', 'Variáveis que falam em rendimento', 'Busca na descrição das variáveis de todas as tabelas.',
`SELECT tabela, variavel, descricao, tipo, anos
FROM dic_variaveis
WHERE descricao ILIKE '%rendimento%'
ORDER BY tabela, variavel;`);
  add('catalogo', 'ct_rotulos', 'Rótulos de uma variável', 'Códigos e rótulos de VD4009 (posição na ocupação), em dic_categorias.',
`SELECT tabela, variavel, codigo, rotulo
FROM dic_categorias
WHERE variavel = 'VD4009'
ORDER BY tabela, codigo_num;`);
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
  const primeiro = lista.find(e => e.grupo !== 'catalogo') || lista[0];
  area.value = lerHash() || sessionStorage.getItem('sql-texto') || primeiro.sql;
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
  btn.addEventListener('click', () => executar());
  btnCSV.addEventListener('click', () => ultimo && baixarTexto('consulta.csv', paraCSV(ultimo.colunas, ultimo.linhas)));
  btnCSVBR.addEventListener('click', () => ultimo && baixarTexto('consulta_excel.csv', paraCSV(ultimo.colunas, ultimo.linhas, 'br')));
  btnLink.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${location.search}#sql?q=${encodeURIComponent(area.value)}`;
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); btnLink.textContent = 'Link copiado'; } catch { btnLink.textContent = 'Link na barra de endereço'; }
    setTimeout(() => { btnLink.textContent = 'Link desta consulta'; }, 2500);
  });

  async function executar(idExemplo = null) {
    const sql = area.value.trim();
    if (!sql) return;
    btn.disabled = true;
    saida.innerHTML = '';
    saida.append(el('p', { class: 'mudo', role: 'status' }, 'Executando…'));
    try {
      const r = await motor.consultar(sql, { origem: idExemplo ? `exemplo ${idExemplo}` : 'sql' });
      ultimo = r;
      btnCSV.disabled = btnCSVBR.disabled = false;
      mostrar(r, Number(selLim.value), idExemplo);
    } catch (e) {
      ultimo = null;
      btnCSV.disabled = btnCSVBR.disabled = true;
      saida.innerHTML = '';
      const s = e.stats;
      saida.append(el('pre', { class: 'erro', id: 'sql-erro' }, String(e.message || e) + dicaErro(e.message || e)));
      if (s) saida.append(el('p', { class: 'mudo' }, `${segundos(s.ms)} · ${mb(s.dados.bytes)} baixados em ${s.dados.req} requisições`));
      window.__ultimoSQL = { erro: String(e.message || e), exemplo: idExemplo };
    } finally {
      btn.disabled = false;
    }
  }

  function mostrar(r, limite, idExemplo) {
    saida.innerHTML = '';
    const s = r.stats;
    window.__ultimoSQL = { colunas: r.colunas, linhas: r.linhas, stats: { ms: s.ms, dados: s.dados }, exemplo: idExemplo, sql: area.value.trim() };
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

  // Exemplos à vista: abas por base e cartões com "Rodar" e "Carregar no editor".
  const grupos = GRUPOS.filter(g => lista.some(e => e.grupo === g.id));
  const abas = el('div', { class: 'abas', role: 'tablist', 'aria-label': 'Exemplos por base' });
  const grade = el('div', { class: 'prontas exemplos', id: 'sql-exemplos' });
  let grupoAtual = grupos[0] && grupos[0].id;
  function desenharGrupo() {
    for (const b of abas.children) { const on = b.dataset.grupo === grupoAtual; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', String(on)); }
    grade.innerHTML = '';
    const g = GRUPOS.find(x => x.id === grupoAtual);
    for (const e of lista.filter(x => x.grupo === grupoAtual)) {
      const rodar = el('button', { type: 'button', 'data-exemplo-rodar': e.id }, 'Rodar');
      const carregar = el('button', { type: 'button', class: 'secundario', 'data-exemplo-carregar': e.id }, 'Carregar no editor');
      rodar.addEventListener('click', () => { area.value = e.sql; salvar(); executar(e.id); saida.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      carregar.addEventListener('click', () => { area.value = e.sql; salvar(); area.scrollIntoView({ behavior: 'smooth', block: 'center' }); area.focus(); });
      grade.append(el('article', { class: 'cartao-pronto', id: `exemplo-${e.id}` },
        el('span', { class: 'base' }, g ? g.rotulo : e.grupo), el('h3', {}, e.titulo), el('p', { class: 'mudo' }, e.desc),
        el('div', { class: 'acoes' }, rodar, carregar)));
    }
  }
  for (const g of grupos) {
    const b = el('button', { type: 'button', class: 'aba', role: 'tab', 'data-grupo': g.id }, `${g.rotulo} (${lista.filter(e => e.grupo === g.id).length})`);
    b.addEventListener('click', () => { grupoAtual = g.id; desenharGrupo(); });
    abas.append(b);
  }
  desenharGrupo();

  raiz.append(
    el('h2', { class: 'titulo-exemplos' }, 'Exemplos'),
    abas, grade,
    el('h2', {}, 'Editor'),
    el('div', { class: 'sql-barra' }, selLim),
    area,
    el('div', { class: 'acoes' }, btn, btnCSV, btnCSVBR, btnLink),
    objetos, saida);
  return { definir(sql) { area.value = sql; salvar(); }, executar, exemplos: lista };
}
