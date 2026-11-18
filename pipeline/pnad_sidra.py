"""Valida os Parquet da PNAD do Rio e as macros de site/sql/estimacao_pnad.sql contra o SIDRA (N6 = 3304557).

Uso: python -I repo/pipeline/pnad_sidra.py [saida.md]   (padrão: <raiz>/validacao_pnad.md)

Lê site/dados/manifest_pnad.json, registra as views pnad_trimestral, pnad_visita1, pnad_visita5 e pnad_deflatores,
carrega as macros e compara cada indicador com o valor publicado (API https://apisidra.ibge.gov.br/values/...).
Critério: a estimativa pontual, arredondada como o SIDRA publica, tem de ser igual. O CV é comparado e a diferença
explicada (o IBGE usa pesos replicados, que captam a calibração).
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.request
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import duckdb

PIPE = Path(__file__).resolve().parent
SITE = PIPE.parent / "site"
RAIZ = PIPE.parent.parent
API = "https://apisidra.ibge.gov.br/values"
RIO = "n6/3304557"

INFORMAL = "(VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2))"
TRIMESTRES = [(2012, 1), (2015, 4), (2019, 4), (2020, 1), (2022, 2), (2023, 2), (2024, 4), (2026, 3)]
OBRIGATORIOS = {(2012, 1), (2019, 4), (2023, 2), (2026, 3)}

# nome, tabela SIDRA, variável valor, variável CV, classificação, tipo, args, escala, casas, primeiro período
IND_TRI = [
    ("Força de trabalho (mil pessoas)", 4093, 4088, 4089, "/c2/6794", "total", "(VD4001=1)::INT", 1e-3, 0, 201201),
    ("Ocupados (mil pessoas)", 4093, 4090, 4091, "/c2/6794", "total", "(VD4002=1)::INT", 1e-3, 0, 201201),
    ("Desocupados (mil pessoas)", 4093, 4092, 4093, "/c2/6794", "total", "(VD4002=2)::INT", 1e-3, 0, 201201),
    ("Taxa de desocupação (%)", 4093, 4099, 4103, "/c2/6794", "razao", "(VD4002=2)::INT, (VD4001=1)::INT", 100, 1,
     201201),
    ("Ocupados informais (mil pessoas)", 4093, 4723, 4724, "/c2/6794", "total", f"({INFORMAL} AND VD4002=1)::INT",
     1e-3, 0, 201504),
    ("Taxa de informalidade (%)", 4093, 12466, 12467, "/c2/6794", "razao", f"({INFORMAL})::INT, (VD4002=1)::INT", 100,
     1, 201504),
    ("Rendimento médio nominal habitual de todos os trabalhos (R$)", 6472, 5929, 5937, "", "media",
     "VD4019 | VD4002=1", 1, 0, 201201),
    ("Rendimento médio real habitual de todos os trabalhos (R$ do último trimestre)", 6472, 5933, 5941, "",
     "media_real", "VD4019 | VD4002=1", 1, 0, 201201),
]
ANOS_V1 = [2012, 2019, 2024]
# nome, tabela, var valor, var CV, classificação, tipo, args, escala, casas, anos
IND_ANU = [
    ("Pessoas de 14 anos ou mais (mil)", 7158, 1641, 4087, "/c653/32860", "total", "(V2009>=14)::INT", 1e-3, 0,
     ANOS_V1),
    ("Pessoas de 14 anos ou mais na força de trabalho (mil)", 7158, 1641, 4087, "/c653/47878", "total",
     "(VD4001=1)::INT", 1e-3, 0, ANOS_V1),
    ("Número médio de moradores por domicílio", 6578, 10163, 10164, "", "razao",
     "CASE WHEN V2005=1 THEN V2001 ELSE 0 END, (V2005=1)::INT", 1, 1, [2019, 2024]),
    ("Domicílios (mil)", 6677, 162, 5123, "/c845/47557", "total", "(V2005=1)::INT", 1e-3, 0, [2019, 2024]),
    ("Domicílios com geladeira (%)", 6677, 10250, 10251, "/c845/47552", "razao",
     "(V2005=1 AND S01023 IN (1, 2))::INT, (V2005=1)::INT", 100, 1, [2019, 2024]),
]

_cache: dict[str, list] = {}


def sidra(url: str) -> list:
    if url not in _cache:
        for tentativa in range(5):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    _cache[url] = json.loads(r.read().decode("utf-8"))[1:]
                break
            except Exception as e:  # rede instável: tenta de novo
                if tentativa == 4:
                    raise
                time.sleep(5 * (tentativa + 1))
    return _cache[url]


def arred(x: float, casas: int) -> Decimal:
    return Decimal(repr(x)).quantize(Decimal(1).scaleb(-casas), rounding=ROUND_HALF_UP)


def fmt(x, casas=1):
    if x is None:
        return "–"
    if isinstance(x, str):
        return x
    s = f"{x:,.{casas}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def conectar():
    man = json.loads((SITE / "dados" / "manifest_pnad.json").read_text(encoding="utf-8"))
    con = duckdb.connect()
    con.execute("SET threads=4; SET memory_limit='3GB'")
    for nome, t in man["tabelas"].items():
        arqs = ",".join(f"'{SITE / a['url']}'" for a in t["arquivos"])
        con.execute(f"CREATE VIEW {nome} AS SELECT * FROM read_parquet([{arqs}], union_by_name=true)")
    con.execute((SITE / "sql" / "estimacao_pnad.sql").read_text(encoding="utf-8"))
    con.execute("""CREATE VIEW pnad_trimestral_defl AS
        SELECT t.*, d.Habitual, d.Efetivo FROM pnad_trimestral t
        LEFT JOIN pnad_deflatores d ON t.Ano = d.Ano AND t.Trimestre = d.Trimestre AND t.UF = d.UF""")
    return con, man


def estimar(con, tipo, args, filtro, anual=None):
    """Devolve (estimativa, cv_linear, cv_calibrado|None, n)."""
    if anual:
        t = f"'{anual}', "
        pre = "pnad_anual_"
    else:
        t, pre = "", "pnad_"
    if tipo == "total":
        a = con.execute(f"SELECT estimativa, cv, n_amostra FROM {pre}total({t}{args}, true, {filtro})").fetchone()
        b = con.execute(f"SELECT estimativa, cv FROM {pre}total_cal({t}{args}, true, {filtro})").fetchone()
        assert abs(a[0] - b[0]) < 1e-6 * abs(a[0]), "total e total_cal divergem na estimativa"
        return a[0], a[1], b[1], a[2]
    if tipo == "razao":
        a = con.execute(f"SELECT estimativa, cv, n_amostra FROM {pre}razao({t}{args}, true, {filtro})").fetchone()
        return a[0], a[1], None, a[2]
    y, dom = [s.strip() for s in args.split("|")]
    if tipo == "media":
        a = con.execute(f"SELECT estimativa, cv, n_amostra FROM {pre}media({t}{y}, true, {dom} AND {filtro})").fetchone()
        return a[0], a[1], None, a[2]
    if tipo == "media_real":
        a = con.execute(f"""SELECT estimativa, cv, n_amostra FROM pnad_razao_em('pnad_trimestral_defl', V1028, Ano,
            Trimestre, coalesce({y}*Habitual, 0), CASE WHEN {y} IS NULL THEN 0 ELSE 1 END, true,
            {dom} AND {filtro})""").fetchone()
        return a[0], a[1], None, a[2]
    raise ValueError(tipo)


COMPARA_CV = []  # (tipo, cv_linear %, cv_calibrado % | None, cv SIDRA %)


def linha_validacao(nome, per_txt, ours, sid_v, sid_cv, url, escala, casas):
    est, cv_lin, cv_cal, n = ours
    try:
        COMPARA_CV.append(("total" if cv_cal is not None else "razao", 100 * cv_lin,
                           None if cv_cal is None else 100 * cv_cal, float(sid_cv)))
    except (TypeError, ValueError):
        pass
    if sid_v is None or not sid_v.replace(".", "", 1).replace("-", "", 1).isdigit():
        status = f"SIDRA sem valor ('{sid_v}')"
        ok = None
    else:
        ok = arred(est * escala, casas) == Decimal(sid_v).quantize(Decimal(1).scaleb(-casas))
        status = "bate" if ok else "NÃO BATE"
    cv_txt = fmt(100 * cv_lin, 2) + (f" / {fmt(100 * cv_cal, 2)}" if cv_cal is not None else "")
    return ok, (f"| {nome} | {per_txt} | {fmt(est * escala, casas + 2)} | {sid_v} | {cv_txt} | {sid_cv} | "
                f"[API]({url}) | {status} |")


def main():
    saida = Path(sys.argv[1]) if len(sys.argv) > 1 else RAIZ / "validacao_pnad.md"
    con, man = conectar()
    tri_ok = tri_tot = anu_ok = anu_tot = 0
    nao_batem = []
    linhas_tri, linhas_anu = [], []
    for (ano, tri) in TRIMESTRES:
        per = f"{ano}{tri:02d}"
        filtro = f"Ano={ano} AND Trimestre={tri}"
        for nome, tab, v, vcv, cl, tipo, args, esc, casas, inicio in IND_TRI:
            if int(per) < inicio:
                continue
            url = f"{API}/t/{tab}/{RIO}/v/{v},{vcv}/p/{per}{cl}"
            rows = {r["D2C"]: r["V"] for r in sidra(url)}
            ours = estimar(con, tipo, args, filtro)
            ok, ln = linha_validacao(nome, f"{tri}º tri/{ano}", ours, rows.get(str(v)), rows.get(str(vcv)), url, esc,
                                     casas)
            linhas_tri.append(ln)
            if ok is not None:
                tri_tot += 1
                tri_ok += ok
                if not ok:
                    nao_batem.append(ln)
    for nome, tab, v, vcv, cl, tipo, args, esc, casas, anos in IND_ANU:
        for ano in anos:
            url = f"{API}/t/{tab}/{RIO}/v/{v},{vcv}/p/{ano}{cl}"
            rows = {r["D2C"]: r["V"] for r in sidra(url)}
            ours = estimar(con, tipo, args, f"Ano={ano}", anual="pnad_visita1")
            ok, ln = linha_validacao(nome, f"{ano} (visita 1)", ours, rows.get(str(v)), rows.get(str(vcv)), url, esc,
                                     casas)
            linhas_anu.append(ln)
            if ok is not None:
                anu_tot += 1
                anu_ok += ok
                if not ok:
                    nao_batem.append(ln)

    # equivalência do domínio: o mesmo indicador escrito de dois jeitos dá a mesma variância
    eq = []
    P = "Ano=2026 AND Trimestre=3"
    pares = [
        ("Taxa de desocupação, 3º tri/2026: domínio no denominador × no filtro",
         f"SELECT estimativa, ep FROM pnad_razao((VD4002=2)::INT, (VD4001=1)::INT, true, {P})",
         f"SELECT estimativa, ep FROM pnad_proporcao(VD4002=2, true, VD4001=1 AND {P})"),
        ("Taxa de desocupação de pretos e pardos de 60+ anos, 3º tri/2026 (domínio pequeno)",
         f"SELECT estimativa, ep FROM pnad_razao((VD4002=2 AND V2010 IN (2,4) AND V2009>=60)::INT, "
         f"(VD4001=1 AND V2010 IN (2,4) AND V2009>=60)::INT, true, {P})",
         f"SELECT estimativa, ep FROM pnad_proporcao(VD4002=2, true, VD4001=1 AND V2010 IN (2,4) AND V2009>=60 AND {P})"),
        ("Ocupados indígenas, 3º tri/2026 (total; domínio no y × no filtro)",
         f"SELECT estimativa, ep FROM pnad_total((VD4002=1 AND V2010=5)::INT, true, {P})",
         f"SELECT estimativa, ep FROM pnad_total(1, true, VD4002=1 AND V2010=5 AND {P})"),
        ("Rendimento médio dos ocupados com superior completo, 3º tri/2026 (média × razão)",
         f"SELECT estimativa, ep FROM pnad_media(VD4019, true, VD4002=1 AND VD3004=7 AND {P})",
         f"SELECT estimativa, ep FROM pnad_razao(CASE WHEN VD4002=1 AND VD3004=7 THEN VD4019 END, "
         f"CASE WHEN VD4002=1 AND VD3004=7 AND VD4019 IS NOT NULL THEN 1 ELSE 0 END, true, {P})"),
    ]
    # macro antiga (coordenador, 18/11): UPAs tiradas do filtro; mostra o efeito de excluir UPAs sem o domínio
    con.execute("""CREATE OR REPLACE MACRO razao_antiga(num, den, grupo, filtro) AS TABLE
WITH base AS (SELECT Ano, Trimestre, Estrato, UPA, grupo AS g, V1028*(num) AS wy, V1028*(den) AS wx
  FROM pnad_trimestral WHERE filtro),
est AS (SELECT Ano, Trimestre, g, sum(wy)/sum(wx) AS r, sum(wx) AS x FROM base GROUP BY Ano, Trimestre, g),
upas AS (SELECT DISTINCT Ano, Trimestre, Estrato, UPA FROM pnad_trimestral WHERE filtro),
grade AS (SELECT u.Ano, u.Trimestre, u.Estrato, u.UPA, e.g, e.r, e.x FROM upas u JOIN est e
  ON u.Ano=e.Ano AND u.Trimestre=e.Trimestre),
z AS (SELECT gr.Ano, gr.Trimestre, gr.g, gr.Estrato, gr.UPA, coalesce(sum(b.wy - gr.r*b.wx), 0)/any_value(gr.x) AS z
  FROM grade gr LEFT JOIN base b ON b.Ano=gr.Ano AND b.Trimestre=gr.Trimestre AND b.Estrato=gr.Estrato
  AND b.UPA=gr.UPA AND b.g IS NOT DISTINCT FROM gr.g GROUP BY gr.Ano, gr.Trimestre, gr.g, gr.Estrato, gr.UPA),
estr AS (SELECT Ano, Trimestre, g, Estrato, count(*) AS nh, sum(z) AS sz, sum(z*z) AS szz FROM z
  GROUP BY Ano, Trimestre, g, Estrato),
v AS (SELECT Ano, Trimestre, g, sum(CASE WHEN nh>1 THEN nh/(nh-1)*(szz - sz*sz/nh) ELSE 0 END) AS var FROM estr
  GROUP BY Ano, Trimestre, g)
SELECT e.r AS estimativa, sqrt(v.var) AS ep FROM est e JOIN v ON e.Ano=v.Ano AND e.Trimestre=v.Trimestre
  AND e.g IS NOT DISTINCT FROM v.g""")
    for nome, q1, q2 in pares:
        a, b = con.execute(q1).fetchone(), con.execute(q2).fetchone()
        eq.append(f"| {nome} | {fmt(a[0], 4)} | {fmt(a[1], 5)} | {fmt(b[1], 5)} | "
                  f"{'igual' if abs(a[1] - b[1]) <= 1e-9 * max(abs(a[1]), 1e-12) and abs(a[0] - b[0]) < 1e-9 * abs(a[0]) else 'DIFERENTE'} |")
    antiga = con.execute(f"SELECT estimativa, ep FROM razao_antiga((VD4002=2)::INT, 1, true, VD4001=1 AND V2010 IN (2,4) "
                         f"AND V2009>=60 AND {P})").fetchone()
    nova = con.execute(f"SELECT estimativa, ep FROM pnad_proporcao(VD4002=2, true, VD4001=1 AND V2010 IN (2,4) "
                       f"AND V2009>=60 AND {P})").fetchone()
    n_upas = con.execute(f"SELECT count(DISTINCT UPA), count(DISTINCT UPA) FILTER (WHERE VD4001=1 AND V2010 IN (2,4) "
                         f"AND V2009>=60) FROM pnad_trimestral WHERE {P}").fetchone()

    # supressões do município no SIDRA, e como ficam as nossas estimativas nesses trimestres
    url_sup = f"{API}/t/4093/{RIO}/v/4090/p/all/c2/6794"
    sup = [r["D3C"] for r in sidra(url_sup) if not r["V"].replace(".", "", 1).isdigit()]
    sup_linhas = []
    for p in sup:
        ano, tri = int(p[:4]), int(p[4:])
        n_pes, = con.execute(f"SELECT count(*) FROM pnad_trimestral WHERE Ano={ano} AND Trimestre={tri}").fetchone()
        tx = con.execute(f"SELECT estimativa, cv FROM pnad_razao((VD4002=2)::INT, (VD4001=1)::INT, true, "
                         f"Ano={ano} AND Trimestre={tri})").fetchone()
        oc = con.execute(f"SELECT estimativa, cv FROM pnad_total_cal((VD4002=1)::INT, true, "
                         f"Ano={ano} AND Trimestre={tri})").fetchone()
        sup_linhas.append(f"| {tri}º tri/{ano} | {fmt(n_pes, 0)} | {fmt(100 * tx[0], 1)} | {fmt(100 * tx[1], 1)} | "
                          f"{fmt(oc[0] / 1e3, 0)} | {fmt(100 * oc[1], 1)} |")
    n_2019, = con.execute("SELECT count(*) FROM pnad_trimestral WHERE Ano=2019 AND Trimestre=4").fetchone()

    # resumo das diferenças de CV
    raz = [(c[1] - c[3]) for c in COMPARA_CV if c[0] == "razao"]
    tot_lin = [c[1] / c[3] for c in COMPARA_CV if c[0] == "total" and c[3] > 0]
    tot_cal = [(c[2] - c[3]) for c in COMPARA_CV if c[0] == "total"]
    tot_cal_rel = [c[2] / c[3] for c in COMPARA_CV if c[0] == "total" and c[3] > 0]
    media = lambda xs: sum(xs) / len(xs)
    resumo_cv = [
        f"- Razões, médias e proporções ({len(raz)} comparações): CV nosso menos CV do SIDRA entre "
        f"{fmt(min(raz), 2)} e {fmt(max(raz), 2)} ponto percentual (média {fmt(media(raz), 2)}; média do valor "
        f"absoluto {fmt(media([abs(x) for x in raz]), 2)}).",
        f"- Totais com `pnad_total_cal` ({len(tot_cal)} comparações): diferença entre {fmt(min(tot_cal), 2)} e "
        f"{fmt(max(tot_cal), 2)} ponto percentual (média do valor absoluto {fmt(media([abs(x) for x in tot_cal]), 2)}); "
        f"nosso CV fica entre {fmt(min(tot_cal_rel), 2)} e {fmt(max(tot_cal_rel), 2)} vez o publicado.",
        f"- Totais com `pnad_total` (linearização simples): o CV fica entre {fmt(min(tot_lin), 1)} e "
        f"{fmt(max(tot_lin), 1)} vezes o publicado (média {fmt(media(tot_lin), 1)}).",
    ]

    # arquivos
    arq_linhas, total_b = [], 0
    for nome, t in man["tabelas"].items():
        for a in t["arquivos"]:
            total_b += a["bytes"]
            arq_linhas.append(f"| `{a['url']}` | {fmt(a['linhas'], 0)} | {fmt(a['bytes'] / 1e6, 2)} |")

    hoje = dt.date.today().strftime("%d/%m/%Y")
    md = [
        "# Validação da PNAD Contínua do município do Rio contra o SIDRA",
        "",
        f"Gerado por `repo/pipeline/pnad_sidra.py` em {hoje}, a partir dos Parquet de `repo/site/dados/pnad/` e das "
        "macros de `repo/site/sql/estimacao_pnad.sql` (DuckDB). Os valores do SIDRA saem da API, para o município do "
        "Rio (N6 = 3304557); cada linha traz o link exato da consulta.",
        "",
        "**Critério.** A estimativa pontual, arredondada como o SIDRA publica (mil pessoas sem casa decimal; taxas "
        "com uma casa; reais sem casa), tem de ser igual ao valor publicado. O CV é comparado com o publicado.",
        "",
        "**Coluna \"CV nosso\".** Nos totais, o primeiro número é a linearização simples (`pnad_total`) e o segundo, "
        "a linearização com a calibração por posest (`pnad_total_cal`). Nas razões, médias e proporções, há um número "
        "só (`pnad_razao`, `pnad_media`, `pnad_proporcao`).",
        "",
        "## Resumo",
        "",
        f"- Trimestral: **{tri_ok} de {tri_tot}** estimativas pontuais batem com o SIDRA "
        f"({len(TRIMESTRES)} trimestres, entre eles os obrigatórios 1º tri/2012, 4º tri/2019, 2º tri/2023 e "
        "3º tri/2026).",
        f"- Anual (visita 1): **{anu_ok} de {anu_tot}** batem.",
        f"- Não batem: {len(nao_batem)}." + ("" if not nao_batem else " Detalhe abaixo."),
        "",
        "**Quanto o CV difere** (CV em %, comparação de cada linha das tabelas abaixo):",
        "",
        *resumo_cv,
        "",
        "**Integridade dos arquivos.** Em todos os 59 trimestres, a soma de V1028 no Rio é igual à projeção V1029 do "
        "posest 331 (a capital); em todos os anos das visitas, a soma de V1032 é igual a V1030. A contagem de linhas "
        "de cada Parquet é igual à de linhas do Rio no arquivo do IBGE, e todas têm V1023 = 1 (capital) e a largura "
        "do layout (`repo/pipeline/pnad_registro.json`). Os tipos de cada coluna são os mesmos em todos os anos, e "
        "`read_parquet([...], union_by_name=true)` lê cada tabela inteira sem erro (`pnad.py validar`).",
        "",
        "## Trimestral",
        "",
        "| Indicador | Trimestre | Nosso valor | SIDRA | CV nosso (%) | CV SIDRA (%) | Link | Status |",
        "|---|---|---|---|---|---|---|---|",
        *linhas_tri,
        "",
        "Informalidade: ocupados como empregado do setor privado sem carteira (VD4009=2), trabalhador doméstico sem "
        "carteira (4), trabalhador familiar auxiliar (10), e empregador ou conta própria sem CNPJ (VD4009 8 ou 9 e "
        "V4019=2). A série começa no 4º tri/2015, quando o quesito do CNPJ (V4019) entrou no questionário.",
        "",
        "Rendimento real: VD4019 vezes o deflator `Habitual` de `deflatores.zip` (UF 33, mesmo Ano e Trimestre), "
        "que leva os valores a preços do último trimestre do arquivo de deflatores do IBGE. A consulta usa o núcleo "
        "`pnad_razao_em` sobre uma view que junta microdado e deflator.",
        "",
        "## Anual (visita 1)",
        "",
        "| Indicador | Ano | Nosso valor | SIDRA | CV nosso (%) | CV SIDRA (%) | Link | Status |",
        "|---|---|---|---|---|---|---|---|",
        *linhas_anu,
        "",
        "- As tabelas anuais de rendimento por fonte (outras fontes, domiciliar per capita: 7437, 7531 e outras) só "
        "existem até o nível de UF no SIDRA; não há valor publicado para o município. Por isso a validação anual usa "
        "as tabelas que descem até o município e saem da visita 1: 7158 (Características adicionais do mercado de "
        "trabalho, 2012–2019 e 2022–2025), 6578 e 6677 (Características do domicílio, 2016–2019 e 2022–2025).",
        "- **Visita 5**: nenhuma tabela do SIDRA por município sai da 5ª visita. A tabela 6578, que em 2020–2021 "
        "usaria a 5ª visita, não traz valor para o Rio nesses anos. A visita 5 foi conferida pela integridade: em "
        "todo ano, a soma de V1032 é igual à projeção V1030, e as contagens batem com o arquivo do IBGE "
        "(`repo/pipeline/pnad_registro.json`).",
        "",
        "## O domínio não mexe no desenho",
        "",
        "Nas macros, o filtro escolhe quem entra na estimativa (o domínio). O desenho é sempre o de todas as UPAs e "
        "estratos dos períodos que o filtro alcança, e as UPAs sem ninguém do domínio entram com z = 0. Por isso, o "
        "mesmo indicador escrito de dois jeitos dá o mesmo erro-padrão:",
        "",
        "| Indicador | Estimativa | EP (jeito 1) | EP (jeito 2) | Resultado |",
        "|---|---|---|---|---|",
        *eq,
        "",
        f"Na versão inicial de `pnad_razao`, as UPAs vinham do próprio filtro. No domínio pequeno acima (pretos e "
        f"pardos de 60 anos ou mais na força de trabalho), só {n_upas[1]} das {n_upas[0]} UPAs do trimestre têm "
        f"alguém do domínio. O EP era {fmt(antiga[1], 5)} na versão antiga e é {fmt(nova[1], 5)} na atual, com as "
        "UPAs sem o domínio entrando com z = 0.",
        "",
        "## Supressões do IBGE",
        "",
        f"O SIDRA não publica o município do Rio (valor \"...\") em {len(sup)} trimestres: "
        f"{', '.join(f'{p[5]}º tri/{p[:4]}' for p in sup)} ([API]({url_sup})). São os trimestres da pandemia, com "
        f"entrevista por telefone e amostra menor: no Rio, de {fmt(n_2019, 0)} pessoas no 4º tri/2019 para o mínimo "
        "mostrado abaixo. Os microdados desses trimestres estão nos arquivos, e as macros estimam normalmente; o "
        "site deve avisar que o IBGE não publica esses trimestres para o município. Nossas estimativas neles:",
        "",
        "| Trimestre | Pessoas na amostra | Taxa de desocupação (%) | CV (%) | Ocupados (mil) | CV calibrado (%) |",
        "|---|---|---|---|---|---|",
        *sup_linhas,
        "",
        "## Por que o CV difere",
        "",
        "- O IBGE calcula o CV com os 200 pesos replicados (bootstrap), que refazem a calibração em cada réplica. A "
        "calibração fixa o total da população em cada posest (no Rio, posest 331 = a capital inteira: a soma de V1028 "
        "é exatamente V1029 em todos os trimestres) e por sexo e idade na UF.",
        "- A linearização simples ignora a calibração. Nos totais de grupos grandes (força de trabalho, ocupados, "
        "pessoas de 14 anos ou mais), o CV sai de 1,6 a 5 vezes o publicado, porque boa parte da variância de um "
        "total vem da variância do tamanho da população, que a calibração zera (o total da população tem CV 0 em "
        "`pnad_total_cal`).",
        "- `pnad_total_cal` trata a calibração por posest como pós-estratificação: o total é N × R, com R = soma(w·y) / "
        "soma(w) no posest, e o resíduo y − R de todas as pessoas entra na variância. O CV dos totais cai para perto "
        "do publicado. A calibração por sexo e idade, feita na UF, não é reproduzida, e por isso sobra diferença.",
        "- Nas razões, médias e proporções, numerador e denominador variam juntos, e a calibração quase não pesa. O "
        "CV da linearização simples fica perto do publicado, para mais ou para menos, porque o bootstrap e a "
        "linearização são estimadores diferentes do mesmo erro.",
        "",
        "## Arquivos gerados (Parquet ZSTD 19, sem pesos replicados)",
        "",
        "| Arquivo (relativo a `repo/site/`) | Linhas | MB |",
        "|---|---|---|",
        *arq_linhas,
        "",
        f"**Total: {fmt(total_b / 1e6, 2)} MB** em {len(arq_linhas)} arquivos.",
        "",
    ]
    if nao_batem:
        md[md.index("## Trimestral"):md.index("## Trimestral")] = ["## O que não bate", "", "| Indicador | Período | "
                                                                  "Nosso valor | SIDRA | CV nosso (%) | CV SIDRA (%) | "
                                                                  "Link | Status |", "|---|---|---|---|---|---|---|---|",
                                                                  *nao_batem, ""]
    saida.write_text("\n".join(md), encoding="utf-8")
    print(f"trimestral {tri_ok}/{tri_tot}, anual {anu_ok}/{anu_tot}; não batem {len(nao_batem)}; -> {saida}")
    for ln in nao_batem:
        print("  ", ln)


if __name__ == "__main__":
    main()
