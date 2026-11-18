-- Estimação com erro-padrão por linearização de Taylor (Estrato/UPA), PNAD Contínua do município do Rio.
-- Portável para DuckDB 1.4 (motor do DuckDB-WASM 1.32) e DuckDB 2.0. Testado nos dois (pipeline/pnad.py e
-- validacao_pnad.md). Requer as views pnad_trimestral, pnad_visita1 e pnad_visita5 (uma por tabela do
-- manifest_pnad.json).
--
-- Método
--   * Estimativa: totais ponderados pelo peso calibrado (V1028 no trimestral, V1032 nas visitas anuais).
--   * Variância: linearização. Para cada UPA, z = soma de w*(y - R*x)/X (razão) ou soma de w*y (total), só com
--     as pessoas do domínio; as UPAs sem ninguém do domínio entram com z = 0. Em cada estrato h com n_h UPAs:
--     var = soma_h n_h/(n_h - 1) * soma_i (z_hi - média_h)^2. Estratos com uma UPA só contribuem com zero.
--   * O filtro define o domínio, não o desenho: o universo de UPAs e estratos é o de todos os registros dos
--     períodos que o filtro alcança (ex.: filtro "VD4002=1 AND Ano=2026" usa todas as UPAs de 2026, com z = 0
--     nas que não têm ocupados). Escrever o domínio no filtro ou como indicador no num/den dá a mesma variância.
--   * O IBGE calcula o CV com pesos replicados, que captam a calibração (pós-estratificação por posest e por
--     sexo e idade). A linearização simples ignora a calibração: para razões (taxas, médias, proporções) o CV
--     fica próximo do publicado; para totais de grupos grandes fica maior. Para totais, prefira
--     pnad_total_cal / pnad_anual_total_cal, que tratam a calibração por posest. Ver validacao_pnad.md.
--
-- Saída de todas as macros: período (Ano, Trimestre | Ano), grupo, estimativa, ep, cv, ic95_inf, ic95_sup,
-- n_amostra (registros da amostra no domínio: den <> 0 na razão, y <> 0 no total).
-- num, den e y são numéricos (use (cond)::INT para indicadores); valor nulo conta como 0.
-- "grupo" aceita qualquer expressão: uma coluna (V2007), uma expressão (V2009 >= 60) ou um struct
-- ({'sexo': V2007, 'cor': V2010}). Use true para não agrupar. "filtro" é um predicado; use true para nenhum.
--
-- Trimestral (pnad_trimestral, peso V1028, por Ano e Trimestre):
--   pnad_razao(num, den, grupo, filtro)   razão soma(w*num)/soma(w*den)
--   pnad_total(y, grupo, filtro)          total soma(w*y), variância sem a calibração
--   pnad_total_cal(y, grupo, filtro)      mesmo total, variância com a calibração por posest (recomendado)
--   pnad_media(y, grupo, filtro)          média de y entre os registros do filtro com y não nulo
--   pnad_proporcao(cond, grupo, filtro)   proporção (0 a 1) do filtro em que cond é verdadeira
-- Anuais (tabela = 'pnad_visita1' ou 'pnad_visita5', peso V1032, por Ano):
--   pnad_anual_razao(tabela, num, den, grupo, filtro), pnad_anual_total(tabela, y, grupo, filtro),
--   pnad_anual_total_cal(tabela, y, grupo, filtro), pnad_anual_media(tabela, y, grupo, filtro),
--   pnad_anual_proporcao(tabela, cond, grupo, filtro)
-- Núcleos genéricos (qualquer tabela, peso e período): pnad_razao_em(tabela, peso, per1, per2, num, den, grupo, filtro),
--   pnad_total_em(...) e pnad_total_cal_em(tabela, peso, per1, per2, y, grupo, filtro).
--
-- Exemplos
--   taxa de desocupação por sexo, 2026T3:
--     SELECT * FROM pnad_razao((VD4002=2)::INT, (VD4001=1)::INT, V2007, Ano=2026 AND Trimestre=3);
--   ocupados (pessoas) por trimestre de 2019:
--     SELECT * FROM pnad_total_cal((VD4002=1)::INT, true, Ano=2019);
--   rendimento médio habitual de todos os trabalhos dos ocupados com rendimento, por cor:
--     SELECT * FROM pnad_media(VD4019, V2010, VD4002=1 AND Ano=2023);
--   taxa de informalidade (a partir de 2015T4):
--     SELECT * FROM pnad_proporcao(VD4009 IN (2,4,10) OR (VD4009 IN (8,9) AND V4019=2), true, VD4002=1);
--   proporção com ensino superior completo entre 25+ anos, visita 1 de 2024:
--     SELECT * FROM pnad_anual_proporcao('pnad_visita1', VD3004=7, true, V2009>=25 AND Ano=2024);

CREATE OR REPLACE MACRO pnad_razao_em(tabela, peso, per1, per2, num, den, grupo, filtro) AS TABLE
WITH base AS (
  SELECT per1 AS p1, per2 AS p2, Estrato AS h, UPA AS u, grupo AS g,
         (peso)*coalesce((num), 0) AS wy, (peso)*coalesce((den), 0) AS wx,
         CASE WHEN (den) <> 0 THEN 1 ELSE 0 END AS nx
  FROM query_table(tabela) WHERE filtro
),
est AS (
  SELECT p1, p2, g, sum(wy)/sum(wx) AS r, sum(wx) AS x, sum(nx) AS n
  FROM base GROUP BY p1, p2, g
),
periodos AS (SELECT DISTINCT p1, p2 FROM base),
upas AS (
  SELECT DISTINCT pr.p1, pr.p2, Estrato AS h, UPA AS u
  FROM query_table(tabela) JOIN periodos pr ON per1 = pr.p1 AND per2 = pr.p2
),
grade AS (
  SELECT d.p1, d.p2, d.h, d.u, e.g, e.r, e.x
  FROM upas d JOIN est e ON d.p1 = e.p1 AND d.p2 = e.p2
),
z AS (
  SELECT gr.p1, gr.p2, gr.g, gr.h, gr.u, coalesce(sum(b.wy - gr.r*b.wx), 0)/any_value(gr.x) AS z
  FROM grade gr LEFT JOIN base b
    ON b.p1 = gr.p1 AND b.p2 = gr.p2 AND b.h = gr.h AND b.u = gr.u AND b.g IS NOT DISTINCT FROM gr.g
  GROUP BY gr.p1, gr.p2, gr.g, gr.h, gr.u
),
estr AS (
  SELECT p1, p2, g, h, count(*) AS nh, sum(z) AS sz, sum(z*z) AS szz
  FROM z GROUP BY p1, p2, g, h
),
v AS (
  SELECT p1, p2, g, sum(CASE WHEN nh > 1 THEN nh/(nh - 1)*(szz - sz*sz/nh) ELSE 0 END) AS var
  FROM estr GROUP BY p1, p2, g
)
SELECT e.p1, e.p2, e.g, e.r AS estimativa, sqrt(greatest(v.var, 0)) AS ep,
       sqrt(greatest(v.var, 0))/e.r AS cv,
       e.r - 1.959964*sqrt(greatest(v.var, 0)) AS ic95_inf, e.r + 1.959964*sqrt(greatest(v.var, 0)) AS ic95_sup,
       e.n AS n_amostra
FROM est e JOIN v ON e.p1 = v.p1 AND e.p2 = v.p2 AND e.g IS NOT DISTINCT FROM v.g;

CREATE OR REPLACE MACRO pnad_total_em(tabela, peso, per1, per2, y, grupo, filtro) AS TABLE
WITH base AS (
  SELECT per1 AS p1, per2 AS p2, Estrato AS h, UPA AS u, grupo AS g,
         (peso)*(y) AS wy, CASE WHEN (y) <> 0 THEN 1 ELSE 0 END AS ny
  FROM query_table(tabela) WHERE filtro
),
est AS (SELECT p1, p2, g, sum(wy) AS t, sum(ny) AS n FROM base GROUP BY p1, p2, g),
periodos AS (SELECT DISTINCT p1, p2 FROM base),
upas AS (
  SELECT DISTINCT pr.p1, pr.p2, Estrato AS h, UPA AS u
  FROM query_table(tabela) JOIN periodos pr ON per1 = pr.p1 AND per2 = pr.p2
),
grade AS (
  SELECT d.p1, d.p2, d.h, d.u, e.g
  FROM upas d JOIN est e ON d.p1 = e.p1 AND d.p2 = e.p2
),
z AS (
  SELECT gr.p1, gr.p2, gr.g, gr.h, gr.u, coalesce(sum(b.wy), 0) AS z
  FROM grade gr LEFT JOIN base b
    ON b.p1 = gr.p1 AND b.p2 = gr.p2 AND b.h = gr.h AND b.u = gr.u AND b.g IS NOT DISTINCT FROM gr.g
  GROUP BY gr.p1, gr.p2, gr.g, gr.h, gr.u
),
estr AS (
  SELECT p1, p2, g, h, count(*) AS nh, sum(z) AS sz, sum(z*z) AS szz
  FROM z GROUP BY p1, p2, g, h
),
v AS (
  SELECT p1, p2, g, sum(CASE WHEN nh > 1 THEN nh/(nh - 1)*(szz - sz*sz/nh) ELSE 0 END) AS var
  FROM estr GROUP BY p1, p2, g
)
SELECT e.p1, e.p2, e.g, e.t AS estimativa, sqrt(greatest(v.var, 0)) AS ep,
       sqrt(greatest(v.var, 0))/e.t AS cv,
       e.t - 1.959964*sqrt(greatest(v.var, 0)) AS ic95_inf, e.t + 1.959964*sqrt(greatest(v.var, 0)) AS ic95_sup,
       e.n AS n_amostra
FROM est e JOIN v ON e.p1 = v.p1 AND e.p2 = v.p2 AND e.g IS NOT DISTINCT FROM v.g;

-- Total com a calibração por posest (pós-estratificação): o peso calibrado soma a projeção da população em
-- cada posest (no Rio, posest 331 = a capital inteira), então o total é N_ps * R_ps, com R_ps = soma(w*y)/soma(w)
-- no posest. A estimativa é a mesma de pnad_total_em; a variância usa o resíduo y - R_ps de todas as pessoas do
-- período (z da UPA = soma(w*y no domínio) - R_ps * soma(w de todas as pessoas da UPA)). Isso reproduz a maior
-- parte do efeito da calibração e deixa o CV dos totais perto do publicado pelo IBGE (validacao_pnad.md).
CREATE OR REPLACE MACRO pnad_total_cal_em(tabela, peso, per1, per2, y, grupo, filtro) AS TABLE
WITH base AS (
  SELECT per1 AS p1, per2 AS p2, Estrato AS h, UPA AS u, posest AS ps, grupo AS g,
         (peso)*(y) AS wy, CASE WHEN (y) <> 0 THEN 1 ELSE 0 END AS ny
  FROM query_table(tabela) WHERE filtro
),
periodos AS (SELECT DISTINCT p1, p2 FROM base),
pop AS (
  SELECT pr.p1, pr.p2, Estrato AS h, UPA AS u, posest AS ps, sum(peso) AS wu
  FROM query_table(tabela) JOIN periodos pr ON per1 = pr.p1 AND per2 = pr.p2
  GROUP BY pr.p1, pr.p2, Estrato, UPA, posest
),
npop AS (SELECT p1, p2, ps, sum(wu) AS n_ps FROM pop GROUP BY p1, p2, ps),
dom AS (
  SELECT p1, p2, h, u, ps, g, sum(wy) AS a, sum(ny) AS n
  FROM base GROUP BY p1, p2, h, u, ps, g
),
est_ps AS (
  SELECT d.p1, d.p2, d.g, d.ps, sum(d.a) AS t, sum(d.a)/any_value(np.n_ps) AS r
  FROM dom d JOIN npop np ON d.p1 = np.p1 AND d.p2 = np.p2 AND d.ps = np.ps
  GROUP BY d.p1, d.p2, d.g, d.ps
),
est AS (SELECT p1, p2, g, sum(t) AS t FROM est_ps GROUP BY p1, p2, g),
nam AS (SELECT p1, p2, g, sum(n) AS n FROM dom GROUP BY p1, p2, g),
grupos AS (SELECT DISTINCT p1, p2, g FROM est),
grade AS (
  SELECT pp.p1, pp.p2, pp.h, pp.u, pp.ps, pp.wu, gs.g
  FROM pop pp JOIN grupos gs ON pp.p1 = gs.p1 AND pp.p2 = gs.p2
),
z AS (
  SELECT gr.p1, gr.p2, gr.g, gr.h, gr.u,
         sum(coalesce(d.a, 0) - coalesce(e.r, 0)*gr.wu) AS z
  FROM grade gr
  LEFT JOIN dom d ON d.p1 = gr.p1 AND d.p2 = gr.p2 AND d.h = gr.h AND d.u = gr.u AND d.ps = gr.ps
                 AND d.g IS NOT DISTINCT FROM gr.g
  LEFT JOIN est_ps e ON e.p1 = gr.p1 AND e.p2 = gr.p2 AND e.ps = gr.ps AND e.g IS NOT DISTINCT FROM gr.g
  GROUP BY gr.p1, gr.p2, gr.g, gr.h, gr.u
),
estr AS (
  SELECT p1, p2, g, h, count(*) AS nh, sum(z) AS sz, sum(z*z) AS szz
  FROM z GROUP BY p1, p2, g, h
),
v AS (
  SELECT p1, p2, g, sum(CASE WHEN nh > 1 THEN nh/(nh - 1)*(szz - sz*sz/nh) ELSE 0 END) AS var
  FROM estr GROUP BY p1, p2, g
)
SELECT e.p1, e.p2, e.g, e.t AS estimativa, sqrt(greatest(v.var, 0)) AS ep,
       sqrt(greatest(v.var, 0))/e.t AS cv,
       e.t - 1.959964*sqrt(greatest(v.var, 0)) AS ic95_inf, e.t + 1.959964*sqrt(greatest(v.var, 0)) AS ic95_sup,
       nm.n AS n_amostra
FROM est e
JOIN v ON e.p1 = v.p1 AND e.p2 = v.p2 AND e.g IS NOT DISTINCT FROM v.g
JOIN nam nm ON e.p1 = nm.p1 AND e.p2 = nm.p2 AND e.g IS NOT DISTINCT FROM nm.g;

-- Trimestral ---------------------------------------------------------------------------------------------
CREATE OR REPLACE MACRO pnad_total_cal(y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, p2 AS Trimestre, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_total_cal_em('pnad_trimestral', V1028, Ano, Trimestre, y, grupo, filtro)
ORDER BY 1, 2, 3;

CREATE OR REPLACE MACRO pnad_razao(num, den, grupo, filtro) AS TABLE
SELECT p1 AS Ano, p2 AS Trimestre, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em('pnad_trimestral', V1028, Ano, Trimestre, num, den, grupo, filtro)
ORDER BY 1, 2, 3;

CREATE OR REPLACE MACRO pnad_total(y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, p2 AS Trimestre, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_total_em('pnad_trimestral', V1028, Ano, Trimestre, y, grupo, filtro)
ORDER BY 1, 2, 3;

CREATE OR REPLACE MACRO pnad_media(y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, p2 AS Trimestre, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em('pnad_trimestral', V1028, Ano, Trimestre, coalesce(y, 0), CASE WHEN (y) IS NULL THEN 0 ELSE 1 END,
                   grupo, filtro)
ORDER BY 1, 2, 3;

CREATE OR REPLACE MACRO pnad_proporcao(cond, grupo, filtro) AS TABLE
SELECT p1 AS Ano, p2 AS Trimestre, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em('pnad_trimestral', V1028, Ano, Trimestre, CASE WHEN coalesce(cond, false) THEN 1 ELSE 0 END, 1,
                   grupo, filtro)
ORDER BY 1, 2, 3;

-- Anuais (visita 1 e visita 5) -----------------------------------------------------------------------------
CREATE OR REPLACE MACRO pnad_anual_razao(tabela, num, den, grupo, filtro) AS TABLE
SELECT p1 AS Ano, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em(tabela, V1032, Ano, 0, num, den, grupo, filtro)
ORDER BY 1, 2;

CREATE OR REPLACE MACRO pnad_anual_total(tabela, y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_total_em(tabela, V1032, Ano, 0, y, grupo, filtro)
ORDER BY 1, 2;

CREATE OR REPLACE MACRO pnad_anual_total_cal(tabela, y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_total_cal_em(tabela, V1032, Ano, 0, y, grupo, filtro)
ORDER BY 1, 2;

CREATE OR REPLACE MACRO pnad_anual_media(tabela, y, grupo, filtro) AS TABLE
SELECT p1 AS Ano, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em(tabela, V1032, Ano, 0, coalesce(y, 0), CASE WHEN (y) IS NULL THEN 0 ELSE 1 END, grupo, filtro)
ORDER BY 1, 2;

CREATE OR REPLACE MACRO pnad_anual_proporcao(tabela, cond, grupo, filtro) AS TABLE
SELECT p1 AS Ano, g AS grupo, estimativa, ep, cv, ic95_inf, ic95_sup, n_amostra
FROM pnad_razao_em(tabela, V1032, Ano, 0, CASE WHEN coalesce(cond, false) THEN 1 ELSE 0 END, 1, grupo, filtro)
ORDER BY 1, 2;
