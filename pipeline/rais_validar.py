"""Validação da RAIS do Rio convertida -> pnad-rais-rio/validacao_rais.md

Uso: python -I rais_validar.py

Confere os Parquet finais (saida_rais/) contra gabaritos independentes:
  * linhas e vínculos ativos em 31/12 por ano: resumos auditados do caso indicador-cidades-inteligentes
    (insumos/rais/filtrado/rais_vinc_<ano>_*.resumo.json, campo por_municipio["Rio de Janeiro"]);
  * ativos em 31/12 de 2016 (2.381.304) e 2021 (2.109.414) publicados em Estudos Cariocas;
  * soma de "Qtd Vínculos Ativos" dos estabelecimentos do Rio (arquivo independente do MTE);
  * extratos de estabelecimentos do caso MCMV (rio_330455/ESTB_<ano>_totais.json, 2009–2021);
  * vínculos e estabelecimentos por bairro contra a camada RAIS_open do IPP/Data.Rio (2013–2016).
"""
import csv
import json
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rais_colunas as RC  # noqa: E402
from rais import DESTINO, STATS, nome_arquivo  # noqa: E402
from rais_dic import IGNORADO  # noqa: E402

PROJ = Path("/home/otavio/Documents/vscode/pnad-rais-rio")
GEN = Path("/home/otavio/Documents/vscode/generic-nb-lm-agentic-search/cases")
RES = GEN / "indicador-cidades-inteligentes/insumos/rais/filtrado"
MCMV = GEN / "mcmv-estudo-unificado/bairros_sucesso/fontes/rais"
IPP_V = MCMV / "ipp_datario_rais_2013_2016/ipp_rais_vinculos_bairro_atividade_2013_2016.csv"
IPP_E = MCMV / "ipp_datario_rais_2013_2016/ipp_rais_estabelecimentos_bairro_atividade_2013_2016.csv"
TAB_BAIRRO = MCMV / "tabela_codigos_bairro_rais_rj.csv"
ANOS = list(range(2006, 2026))
ROTULOS_VINC = [*map(str, range(2006, 2024)), "2023_legado", "2024", "2025"]
ESTUDOS_CARIOCAS = {2016: 2381304, 2021: 2109414}

con = duckdb.connect()
con.execute("set memory_limit='3GB'; set threads=4")
(PROJ / "trabalho_rais/_duck_tmp").mkdir(parents=True, exist_ok=True)
con.execute(f"set temp_directory='{PROJ / 'trabalho_rais/_duck_tmp'}'")


def fv(rot):
    return DESTINO["vinculos"] / nome_arquivo("vinculos", str(rot))


def fe(rot):
    return DESTINO["estab"] / nome_arquivo("estab", str(rot))


def q1(sql):
    return con.execute(sql).fetchone()


def br(n):
    return "–" if n is None else f"{n:,}".replace(",", ".")


def pct(x):
    return "–" if x is None else f"{x:.1f}".replace(".", ",")


def gabarito_resumo(ano):
    for nome in (f"rais_vinc_{ano}_RJ.resumo.json", f"rais_vinc_{ano}_MG_ES_RJ.resumo.json"):
        p = RES / nome
        if p.exists():
            d = json.loads(p.read_text())["por_municipio"]["Rio de Janeiro"]
            return d["linhas"], d["ativos_3112"], nome
    return None, None, None


def estab_totais(ano):
    p = MCMV / "rio_330455" / f"ESTB_{ano}_totais.json"
    if p.exists():
        d = json.loads(p.read_text())
        return d["linhas_rio"], d["vinculos_ativos_rio"]
    return None, None


L = []  # linhas do markdown


def tabela(cab, linhas):
    L.append("| " + " | ".join(cab) + " |")
    L.append("|" + "|".join("---" for _ in cab) + "|")
    for ln in linhas:
        L.append("| " + " | ".join(str(x) for x in ln) + " |")
    L.append("")


def main():
    L.append("# Validação da RAIS do município do Rio (2006–2025)\n")
    L.append("Gerado por `repo/pipeline/rais_validar.py` sobre os Parquet finais em `saida_rais/` (os mesmos "
             "enviados ao Hugging Face). Fonte dos dados: microdados públicos da RAIS, PDET/MTE. "
             "Recorte: município do estabelecimento = 330455.\n")

    # 1. linhas e ativos por ano
    L.append("## 1. Linhas e vínculos ativos em 31/12, por ano\n")
    L.append("Gabaritos: (a) resumos auditados do caso indicador-cidades-inteligentes "
             "(`insumos/rais/filtrado/*.resumo.json`, Rio separado em `por_municipio`, 2010–2025); "
             "(b) soma de `qtd_vinculos_ativos` dos estabelecimentos do Rio (arquivo ESTB do MTE, independente do "
             "de vínculos); (c) Estudos Cariocas para 2016 e 2021.\n")
    linhas_tab, falhas = [], []
    for rot in ROTULOS_VINC:
        f = fv(rot)
        if not f.exists():
            linhas_tab.append([rot, "falta"] + [""] * 7)
            continue
        n, atv = q1(f"select count(*), count(*) filter (where ind_vinculo_ativo_31_12 = 1) from '{f}'")
        ano = int(rot[:4])
        g_l, g_a, _ = gabarito_resumo(f"{ano}_Legado" if rot.endswith("legado") else ano)
        e_atv = None
        if not rot.endswith("legado") and fe(ano).exists():
            e_atv = q1(f"select sum(qtd_vinculos_ativos) from '{fe(ano)}'")[0]
        ec = ESTUDOS_CARIOCAS.get(ano) if not rot.endswith("legado") else None
        ok = all(x is None or x == y for x, y in [(g_l, n), (g_a, atv), (ec, atv)])
        if not ok:
            falhas.append(rot)
        dif_e = "–" if e_atv is None else ("0" if e_atv == atv else f"{atv - e_atv:+,}".replace(",", ".")
                                           + f" ({100 * (atv - e_atv) / e_atv:+.1f}%)".replace(".", ","))
        linhas_tab.append([rot, br(n), br(g_l), br(atv), br(g_a), br(ec), "ok" if ok else "**DIFERE**",
                           br(e_atv), dif_e])
    tabela(["Ano", "Linhas", "Linhas (resumo)", "Ativos 31/12", "Ativos (resumo)", "Estudos Cariocas",
            "Confere (resumo e EC)", "Ativos (soma ESTB)", "Ativos − soma ESTB"], linhas_tab)
    L.append(f"Anos com diferença contra o resumo ou Estudos Cariocas: {', '.join(falhas) if falhas else 'nenhum'}.\n")
    L.append("A soma de `qtd_vinculos_ativos` do arquivo de estabelecimentos é igual aos ativos do arquivo de "
             "vínculos em todos os anos de 2006 a 2022. De 2023 em diante (eSocial) os dois arquivos do MTE "
             "divergem em cerca de 1% no Rio; os vínculos batem com o resumo auditado, então a divergência é da "
             "fonte (os dois arquivos eSocial não fecham entre si), não da conversão.\n")

    # 2. estabelecimentos contra os totais
    L.append("## 2. Estabelecimentos contra os extratos do caso MCMV (2009–2021)\n")
    L.append("Gabarito: `bairros_sucesso/fontes/rais/rio_330455/ESTB_<ano>_totais.json` (linhas do Rio e soma de "
             "vínculos ativos, conferidos pelo caso MCMV com a TABELA 1 da RAIS e a Tabela 744 do IPP).\n")
    rows = []
    for a in ANOS:
        f = fe(a)
        if not f.exists():
            rows.append([a, "falta"] + [""] * 6)
            continue
        n, atv, cep = q1(f"select count(*), sum(qtd_vinculos_ativos), count(bairro_ipp_cep) from '{f}'")
        atv_cep = q1(f"select sum(qtd_vinculos_ativos) filter (where bairro_ipp_cep is not null) from '{f}'")[0]
        g_n, g_a = estab_totais(a)
        ok = (g_n is None or g_n == n) and (g_a is None or g_a == atv)
        rows.append([a, br(n), br(g_n), br(atv), br(g_a), "ok" if ok else "**DIFERE**",
                     pct(100 * cep / n) if cep else "–", pct(100 * (atv_cep or 0) / atv) if cep else "–"])
    tabela(["Ano", "Estabelecimentos", "Gabarito", "Vínculos ativos (soma)", "Gabarito", "Confere",
            "% estab. com bairro pelo CEP", "% vínculos com bairro pelo CEP"], rows)

    # 3. bairros contra o IPP
    L.append("## 3. Vínculos e estabelecimentos por bairro contra o IPP/Data.Rio (2013–2016)\n")
    L.append("Gabarito: camada RAIS_open do IPP no Data.Rio (vínculos e estabelecimentos por bairro e atividade), "
             "somada por bairro. O código `bairros_rj` vira bairro IPP pela `tabela_codigos_bairro_rais_rj.csv` "
             "(sub-bairros somados como faz o IPP; sem correspondência = \"Outros\", código 999). Vínculos = "
             "`ind_vinculo_ativo_31_12 = 1` no arquivo de vínculos; estabelecimentos = `ind_rais_negativa = 0` no "
             "arquivo de estabelecimentos.\n")
    con.execute(f"""create or replace table tb as select try_cast(codigo_rais as INTEGER) as cod,
                coalesce(try_cast(codbairro_ipp as INTEGER), 999) as ipp from read_csv('{TAB_BAIRRO}', all_varchar=true)""")
    con.execute("update tb set cod = -1 where cod is null")
    rows = []
    for a in (2013, 2014, 2015, 2016):
        ipp_v = dict(con.execute(f"""select cast(Cod_Bairro as INTEGER), sum(coalesce(Vinc_{a},0)) from
                     read_csv('{IPP_V}') group by 1""").fetchall())
        ipp_e = dict(con.execute(f"""select cast(Cod_Bairro as INTEGER), sum(coalesce(Est_{a},0)) from
                     read_csv('{IPP_E}') group by 1""").fetchall())
        meu_v = dict(con.execute(f"""select coalesce(tb.ipp, 999), count(*) from '{fv(a)}' v left join tb on tb.cod = v.bairros_rj
                     where ind_vinculo_ativo_31_12 = 1 group by 1""").fetchall())
        meu_e = dict(con.execute(f"""select coalesce(tb.ipp, 999), count(*) from '{fe(a)}' e left join tb on tb.cod = e.bairros_rj
                     where ind_rais_negativa = 0 group by 1""").fetchall())
        ks = set(ipp_v) | set(meu_v)
        dv = {k: meu_v.get(k, 0) - ipp_v.get(k, 0) for k in ks}
        ke = set(ipp_e) | set(meu_e)
        de = {k: meu_e.get(k, 0) - ipp_e.get(k, 0) for k in ke}
        rows.append([a, len(ks), br(int(sum(ipp_v.values()))), br(sum(meu_v.values())),
                     sum(1 for v in dv.values() if v), br(int(sum(abs(v) for v in dv.values()))),
                     sum(1 for v in de.values() if v), br(int(sum(abs(v) for v in de.values())))])
        grandes = sorted(((abs(v), k, v) for k, v in dv.items() if v), reverse=True)[:3]
        if grandes:
            L.append(f"- {a}: maiores diferenças de vínculos (código IPP: meu − IPP): "
                     + "; ".join(f"{k}: {v:+d}" for _, k, v in grandes))
    L.append("")
    tabela(["Ano", "Bairros (grupos)", "Vínculos IPP", "Vínculos aqui", "Bairros com dif. (vínc.)",
            "Soma |dif| vínc.", "Bairros com dif. (estab.)", "Soma |dif| estab."], rows)
    L.append("O caso MCMV, que contou os vínculos pela soma de `qtd_vinculos_ativos` do arquivo de "
             "estabelecimentos, achou uma diferença de 97 vínculos em 2013 (Centro × Anchieta). Contando pelo arquivo "
             "de vínculos, a diferença some: o IPP montou a tabela a partir dos vínculos.\n")

    # 4. eSocial x Legado 2023
    L.append("## 4. RAIS 2023: eSocial (série principal) × Legado, só o Rio\n")
    if fv("2023").exists() and fv("2023_legado").exists():
        sql = lambda f: q1(f"""select count(*), count(*) filter (where ind_vinculo_ativo_31_12 = 1),
              sum(vl_rem_media_nom) filter (where ind_vinculo_ativo_31_12 = 1),
              count(*) filter (where ind_vinculo_ativo_31_12 = 1 and natureza_juridica between 1000 and 1999),
              count(*) filter (where ind_vinculo_ativo_31_12 = 1 and tipo_vinculo in (10,15,20,25,60,65,70,75)),
              count(*) filter (where ind_vinculo_ativo_31_12 = 1 and tipo_vinculo in (30,31,35))
              from '{f}'""")
        e, g = sql(fv("2023")), sql(fv("2023_legado"))
        nomes = ["Linhas (vínculos no ano)", "Ativos em 31/12", "Massa de remuneração média nominal dos ativos (R$)",
                 "Ativos na administração pública (natureza 1xxx)", "Ativos CLT (tipo 10–25, 60–75)",
                 "Ativos estatutários (tipo 30, 31, 35)"]
        rows = []
        for nm, x, y in zip(nomes, e, g):
            x, y = float(x or 0), float(y or 0)
            rows.append([nm, br(round(x)), br(round(y)), br(round(x - y)), pct(100 * (x - y) / y) + "%" if y else "–"])
        tabela(["Medida", "eSocial", "Legado", "eSocial − Legado", "Diferença"], rows)

    # 5. preenchimento real
    L.append("## 5. Preenchimento real por ano (vínculos)\n")
    L.append("% das linhas com valor não nulo **e** fora dos códigos de ignorado. Bairro: código da aba BAIRRO_RJ, "
             "sem 0 (fora do estado), 9999 (outros municípios), -1, 9997 e 999997. CBO: sem -1, 0 e 999999. "
             "Raça: sem -1 e 9 (não identificado). Município de trabalho: sem -1, 0 e 999999. Entre parênteses, % "
             "que veio como \"{ñ class}\" e virou NULL.\n")
    rows = []
    stats = {json.loads(p.read_text())["rotulo"]: json.loads(p.read_text()) for p in STATS.glob("vinculos_*.json")}
    for rot in ROTULOS_VINC:
        f = fv(rot)
        if not f.exists():
            continue
        partes = []
        for c in ("bairros_rj", "cbo_2002_ocupacao", "raca_cor", "municipio_trab"):
            ign = ", ".join(map(str, IGNORADO[c]))
            partes.append(f"100.0 * count(*) filter (where {c} is not null and {c} not in ({ign})) / count(*)")
        r = q1(f"select {', '.join(partes)} from '{f}'")
        st = stats.get(rot, {}).get("colunas", {})
        n = stats.get(rot, {}).get("linhas_rio") or 1
        cel = []
        for c, v in zip(("bairros_rj", "cbo_2002_ocupacao", "raca_cor", "municipio_trab"), r):
            nc = st.get(c, {}).get("nao_class", 0)
            cel.append(pct(v) + (f" ({pct(100 * nc / n)})" if nc else ""))
        rows.append([rot, *cel])
    tabela(["Ano", "Bairro (bairros_rj)", "CBO 2002", "Raça/cor", "Município de trabalho"], rows)

    # 6. remunerações mês a mês
    L.append("## 6. Remunerações mês a mês (vl_rem_janeiro_sc … vl_rem_novembro_sc)\n")
    rows, primeiro = [], None
    for rot in map(str, ANOS):
        f = fv(rot)
        if not f.exists():
            continue
        tem = {r[0] for r in con.execute(f"select column_name from (describe select * from '{f}')").fetchall()}
        if "vl_rem_janeiro_sc" not in tem:
            rows.append([rot, "não existe", ""])
            continue
        nn, pos = q1(f"select count(vl_rem_janeiro_sc), count(*) filter (where vl_rem_janeiro_sc > 0) from '{f}'")
        primeiro = primeiro or rot
        rows.append([rot, br(nn), br(pos)])
    L.append(f"**Primeiro ano com as remunerações mês a mês: {primeiro}.**\n")
    tabela(["Ano", "Não nulos em janeiro", "Janeiro > 0"], rows)

    # 7. faixas no eSocial
    L.append("## 7. Códigos das faixas: leiaute antigo × eSocial\n")
    L.append("Mínimo e máximo da variável contínua dentro de cada código de faixa, para mostrar onde a codificação "
             "mudou (o eSocial não tem leiaute publicado com as faixas).\n")
    for rot in ("2022", "2023", "2025"):
        f = fv(rot)
        if not f.exists():
            continue
        for faixa, var in (("faixa_rem_media_sm", "vl_rem_media_sm"), ("faixa_hora_contrat", "qtd_hora_contr"),
                           ("faixa_tempo_emprego", "tempo_emprego"), ("faixa_etaria", "idade")):
            r = con.execute(f"select {faixa}, count(*), min({var}), max({var}) from '{f}' group by 1 order by 1").fetchall()
            L.append(f"- {rot} `{faixa}` (código: n, mín–máx de `{var}`): "
                     + "; ".join(f"{k}: {br(n)}, {a}–{b}" for k, n, a, b in r))
    for rot in ("2023", "2024", "2025"):
        if fv(rot).exists():
            a, b, c = q1(f"""select count(*) filter (where causa_afastamento_1 = 999),
                         count(*) filter (where causa_afastamento_1 = 999 and qtd_dias_afastamento > 0),
                         count(*) filter (where causa_afastamento_1 <> 999 and qtd_dias_afastamento = 0) from '{fv(rot)}'""")
            L.append(f"- {rot} `causa_afastamento_1 = 999`: {br(a)} linhas; com dias de afastamento > 0: {br(b)}; "
                     f"outro código com 0 dia: {br(c)}.")
    L.append("")
    L.append("Outras mudanças de codificação encontradas (estão no dicionário, por coluna):\n")
    rows = []
    for rot in ROTULOS_VINC:
        r = q1(f"""select min(faixa_rem_media_sm), max(faixa_rem_media_sm) filter (where faixa_rem_media_sm < 98),
               count(*) filter (where faixa_rem_dez_sm = 0), max(faixa_hora_contrat) filter (where faixa_hora_contrat < 99),
               count(*) filter (where faixa_tempo_emprego = 0), count(*) filter (where vl_rem_media_sm > 150),
               count(*) filter (where mes_desligamento is null), count(*) filter (where causa_afastamento_1 = 99),
               count(*) filter (where tipo_admissao_trabalhador = 1) from '{fv(rot)}'""")
        rows.append([rot, f"{r[0]}–{r[1]}", br(r[2]), r[3], br(r[4]), br(r[5]), br(r[6]), br(r[7]), br(r[8])])
    tabela(["Ano", "faixa_rem_media_sm (códigos)", "faixa_rem_dez_sm = 0", "faixa_hora_contrat máx.",
            "faixa_tempo_emprego = 0", "vl_rem_media_sm > 150", "mes_desligamento nulo", "causa_afastamento_1 = 99",
            "tipo_admissao = 1"], rows)
    L.append("Conferência da CNAE: % de linhas em que `cnae_2_0_classe` = 5 primeiros dígitos da subclasse.\n")
    rows = []
    for a in ANOS:
        cel = [a]
        for f in (fv(a), fe(a)):
            if f.exists():
                v = q1(f"""select 100.0 * count(*) filter (where cnae_2_0_classe = cnae_2_0_subclasse // 100)
                       / count(*) filter (where cnae_2_0_subclasse > 0) from '{f}'""")[0]
                cel.append(pct(v))
            else:
                cel.append("–")
        rows.append(cel)
    tabela(["Ano", "Vínculos", "Estabelecimentos"], rows)

    # 8. tamanhos
    L.append("## 8. Linhas e tamanho dos arquivos\n")
    rows, tl, tb = [], 0, 0
    for base in ("vinculos", "estab"):
        for f in sorted(DESTINO[base].glob("*.parquet")):
            n = q1(f"select count(*) from '{f}'")[0]
            rg = q1(f"select count(distinct row_group_id) from parquet_metadata('{f}')")[0]
            mb = f.stat().st_size / 1e6
            tl += n; tb += f.stat().st_size
            rows.append([f.name, br(n), rg, f"{mb:.1f}".replace(".", ",")])
    tabela(["Arquivo", "Linhas", "Blocos (row groups)", "MB"], rows)
    L.append(f"**Total: {br(tl)} linhas, {tb / 1e6:,.0f} MB.**\n".replace(",", "."))

    # 9. leitura conjunta
    L.append("## 9. Leitura conjunta de todos os anos (union_by_name)\n")
    for base in ("vinculos", "estab"):
        arqs = sorted(str(f) for f in DESTINO[base].glob("*.parquet") if "legado" not in f.name)
        lista = ", ".join(f"'{a}'" for a in arqs)
        try:
            r = con.execute(f"""select count(*), count(distinct ano), min(ano), max(ano)
                            from read_parquet([{lista}], union_by_name=true)""").fetchone()
            esq = con.execute(f"describe select * from read_parquet([{lista}], union_by_name=true)").fetchall()
            L.append(f"- {base}: {len(arqs)} arquivos, {br(r[0])} linhas, anos {r[2]}–{r[3]}, {len(esq)} colunas, "
                     "sem erro de tipo.")
        except Exception as e:  # noqa: BLE001
            L.append(f"- {base}: **ERRO** {e}")
    if fv("2023_legado").exists():
        arqs = sorted(str(f) for f in DESTINO["vinculos"].glob("*.parquet"))
        lista = ", ".join(f"'{a}'" for a in arqs)
        r = con.execute(f"select count(*) from read_parquet([{lista}], union_by_name=true)").fetchone()
        L.append(f"- vínculos com o Legado junto: {br(r[0])} linhas, sem erro de tipo.")
    L.append("")
    (PROJ / "validacao_rais.md").write_text("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
