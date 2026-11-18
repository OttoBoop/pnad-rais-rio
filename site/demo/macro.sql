-- Razão ponderada com erro-padrão por linearização de Taylor (Estrato/UPA).
-- periodo: filtra o universo (Ano/Trimestre). O domínio entra como indicador em num e den,
-- e assim as UPAs sem ninguém do domínio entram com z=0.
CREATE OR REPLACE MACRO pnad_razao(num, den, grupo, periodo) AS TABLE
WITH base AS (
  SELECT Ano, Trimestre, Estrato, UPA, grupo AS g, V1028*(num) AS wy, V1028*(den) AS wx, (den)::INT AS nx
  FROM pnad_trimestral WHERE periodo
),
est AS (SELECT Ano, Trimestre, g, sum(wy)/sum(wx) AS r, sum(wx) AS x, sum(nx) AS n
        FROM base GROUP BY Ano, Trimestre, g HAVING sum(nx) > 0),
upas AS (SELECT DISTINCT Ano, Trimestre, Estrato, UPA FROM pnad_trimestral WHERE periodo),
grade AS (SELECT u.Ano, u.Trimestre, u.Estrato, u.UPA, e.g, e.r, e.x FROM upas u JOIN est e ON u.Ano=e.Ano AND u.Trimestre=e.Trimestre),
z AS (
  SELECT gr.Ano, gr.Trimestre, gr.g, gr.Estrato, gr.UPA, coalesce(sum(b.wy - gr.r*b.wx), 0)/any_value(gr.x) AS z
  FROM grade gr LEFT JOIN base b ON b.Ano=gr.Ano AND b.Trimestre=gr.Trimestre AND b.Estrato=gr.Estrato AND b.UPA=gr.UPA AND b.g IS NOT DISTINCT FROM gr.g
  GROUP BY gr.Ano, gr.Trimestre, gr.g, gr.Estrato, gr.UPA
),
estr AS (SELECT Ano, Trimestre, g, Estrato, count(*) AS nh, sum(z) AS sz, sum(z*z) AS szz FROM z GROUP BY Ano, Trimestre, g, Estrato),
v AS (SELECT Ano, Trimestre, g, sum(CASE WHEN nh>1 THEN nh/(nh-1)*(szz - sz*sz/nh) ELSE 0 END) AS var FROM estr GROUP BY Ano, Trimestre, g)
SELECT e.Ano AS ano, e.Trimestre AS tri, e.g AS grupo, e.r AS estimativa, sqrt(v.var) AS ep,
       e.r - 1.96*sqrt(v.var) AS ic95_inf, e.r + 1.96*sqrt(v.var) AS ic95_sup, sqrt(v.var)/abs(e.r) AS cv, e.n AS n_amostra
FROM est e JOIN v ON e.Ano=v.Ano AND e.Trimestre=v.Trimestre AND e.g IS NOT DISTINCT FROM v.g
ORDER BY 1, 2, 3;
