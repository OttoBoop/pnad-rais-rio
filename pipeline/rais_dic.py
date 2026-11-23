"""Dicionários da RAIS para o site: rais_vinculos.json, rais_estab.json, cbo.json, cnae.json, bairros_rj.json.

Uso: python -I rais_dic.py   (depois de `rais.py final` em todos os anos)

Fontes (cópias locais em pnad-rais-rio/fontes_rais/{layouts,fontes_dic}/):
  * leiautes oficiais da RAIS (PDET/MTE), ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/Layouts/
      vínculos: RAIS_vinculos_layout.xls (2006–2014), RAIS_vinculos_layout2015/2016/2017.xls,
                RAIS_vinculos_layout2018e2019.xls, RAIS_vinculos_layout2020.xls (o mais completo);
      estabelecimentos: 12RAIS_estabelecimento_layout.2002a2013.xls, RAIS_estabelecimento_layout2014a2017.xls,
                RAIS_estabelecimento_layout2018e2019.xls;
  * De-Para Microdados (MTE, RAIS 2024): nomes antigos -> eSocial;
  * CBO 2002 (MTE): https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/cbo/servicos/downloads/
      cbo2002-{grande-grupo,subgrupo-principal,subgrupo,familia,ocupacao}.csv;
  * CNAE 2.x (IBGE/CONCLA): https://servicodados.ibge.gov.br/api/v2/cnae/subclasses (versão 2.3, com a
      hierarquia classe > grupo > divisão > seção); subclasses e classes CNAE 95 que não estão lá vêm das
      abas "subclasse 2.0" e "classe 1.0 ou 95" do leiaute da RAIS;
  * Tabela de Natureza Jurídica 2021 (IBGE/CONCLA):
      https://concla.ibge.gov.br/images/concla/documentacao/CONCLA-TNJ2021-EstruturaDetalhada.pdf
      (códigos antigos que saíram da tabela ficam com o rótulo abreviado do leiaute da RAIS);
  * eSocial S-1.3, Tabela 01 - Categorias de Trabalhadores:
      https://www.gov.br/esocial/pt-br/documentacao-tecnica/leiautes-esocial-v-s-1-3-nt-07-2026-rev-24-09-2026/tabelas.html
  * bairros: aba BAIRRO_RJ do leiaute + tabela_codigos_bairro_rais_rj.csv (caso MCMV, casamento com a
      malha de bairros IPP 2023) + ipp_limite_bairros_2023-12-06_wgs84.geojson (Data.Rio/IPP).
"""
import html
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

import duckdb
import xlrd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rais_colunas as RC  # noqa: E402
from rais import DESTINO, STATS, nome_arquivo  # noqa: E402

PROJ = Path("/home/otavio/Documents/vscode/pnad-rais-rio")
LAY = PROJ / "fontes_rais/layouts"
FD = PROJ / "fontes_rais/fontes_dic"
G = Path("/home/otavio/Documents/vscode/generic-nb-lm-agentic-search/cases/mcmv-estudo-unificado")
LAY_MCMV = G / "bairros_sucesso/fontes/rais/layouts"
TAB_BAIRRO = G / "bairros_sucesso/fontes/rais/tabela_codigos_bairro_rais_rj.csv"
GEO_IPP = G / "quebra_faixas/fontes/enderecos/ipp_limite_bairros_2023-12-06_wgs84.geojson"
SAIDA = PROJ / "repo/site/dados/dic"
HOJE = date.today().isoformat()

VINC_LAYOUTS = [  # do mais antigo ao mais novo; o mais novo prevalece no rótulo
    (LAY / "RAIS_vinculos_layout.xls", "2006–2014"),
    (LAY_MCMV / "RAIS_vinculos_layout2015.xls", "2015"),
    (LAY / "RAIS_vinculos_layout2016.xls", "2016"),
    (LAY / "RAIS_vinculos_layout2017.xls", "2017"),
    (LAY_MCMV / "RAIS_vinculos_layout2018e2019.xls", "2018–2019"),
    (LAY / "RAIS_vinculos_layout2020.xls", "2020"),
]
ESTAB_LAYOUTS = [
    (LAY_MCMV / "12RAIS_estabelecimento_layout.2002a2013.xls", "2002–2013"),
    (LAY_MCMV / "RAIS_estabelecimento_layout2014a2017.xls", "2014–2017"),
    (LAY_MCMV / "RAIS_estabelecimento_layout2018e2019.xls", "2018–2019"),
]
URL_FTP_LAYOUT = "ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/Layouts/"

# nome do leiaute (normalizado por RC.chave) -> nome canônico, quando não bate direto
LAYOUT_VINC = {
    "bairro_rj": "bairros_rj", "caus_afast_1": "causa_afastamento_1", "caus_afast_2": "causa_afastamento_2",
    "caus_afast_3": "causa_afastamento_3", "causa_desli_ou_motivo_de_desligamento": "motivo_desligamento",
    "cbo_ocupacao_2002": "cbo_2002_ocupacao", "cbo_2002": "cbo_2002_ocupacao", "clas_cnae_20": "cnae_2_0_classe",
    "clas_cnae_95": "cnae_95_classe", "emp_em_31_12": "ind_vinculo_ativo_31_12",
    "faixa_remun_dezem_sm": "faixa_rem_dez_sm", "faixa_remun_media_sm": "faixa_rem_media_sm",
    "faixa_tempo_de_emprego": "faixa_tempo_emprego",
    "gr_instrucao_ou_escolaridade_apos_2005": "escolaridade_apos_2005", "horas_contr": "qtd_hora_contr",
    "ind_de_cei_vinc": "ind_cei_vinculado", "ind_simples": "ind_estabelecimento_participante_simples",
    "mun_trab": "municipio_trab", "nacionalidad": "nacionalidade", "nat_juridica": "natureza_juridica",
    "port_defic": "ind_portador_defic", "qt_dias_afas": "qtd_dias_afastamento",
    "rem_dez_r": "vl_rem_dezembro_nom", "rem_dezembro": "vl_rem_dezembro_sm", "rem_med_r": "vl_rem_media_nom",
    "rem_media": "vl_rem_media_sm", "sb_clas_20": "cnae_2_0_subclasse", "tamestab": "tamanho_estabelecimento",
    "temp_empr": "tempo_emprego", "tipo_adm": "tipo_admissao_trabalhador", "tipo_estbl": "tipo_estabelecimento",
    "tp_defic": "tipo_deficiencia", "tp_vinculo": "tipo_vinculo", "ind_trab_parcial": "ind_trabalho_parcial",
    "ind_trab_intermitente": "ind_trabalho_intermitente",
}
LAYOUT_VINC = {**RC.VINC_ALIASES, **LAYOUT_VINC}
LAYOUT_ESTAB = dict(RC.ESTAB_ALIASES, cep_estb="cep_estab", bairro_rj="bairros_rj")

# Descrições das colunas que não estão nos leiautes antigos (eSocial e derivadas).
DESC_EXTRA = {
    "ind_vinculo_abandonado": "Indicador de vínculo abandonado (só no arquivo eSocial, 2023+)",
    "categoria_trabalhador": "Categoria do trabalhador no eSocial (Tabela 01 do eSocial; só 2023+)",
    "tipo_estabelecimento_nome": "Tipo de estabelecimento (nome por extenso, mesma informação do código)",
    "bairro_ipp_cep": ("Bairro IPP (malha de bairros 2023 da Prefeitura) atribuído pelo CEP do estabelecimento; "
                       "derivado pelo pipeline com a tabela CEP -> bairro dos pontos de endereço do IPP. "
                       "Vazio quando não há CEP (antes de 2014) ou o CEP não está na tabela."),
    "uf": "Unidade da Federação do estabelecimento",
    "ano": "Ano-base da RAIS (coluna acrescentada pelo pipeline)",
}

# Códigos que significam "ignorado" ou "não informado" (o dado existe, mas não diz nada).
IGNORADO_GERAL = [-1]
IGNORADO = {
    "bairros_rj": [-1, 0, 9997, 9999, 999997],
    "raca_cor": [-1, 9, 99],
    "cbo_2002_ocupacao": [-1, 0, 999999],
    "municipio_trab": [-1, 0, 999999],
    "faixa_etaria": [-1, 99], "faixa_rem_media_sm": [-1, 99], "faixa_rem_dez_sm": [-1, 99],
    "faixa_hora_contrat": [-1, 99], "faixa_tempo_emprego": [-1, 99],
    "natureza_juridica": [-1, 9999],
    "cnae_2_0_subclasse": [-1], "cnae_2_0_classe": [-1], "cnae_95_classe": [-1, 99999],
}


# ------------------------------------------------------------------ leiautes
def num(v):
    """Valor da coluna 'Valor na Fonte' -> texto do inteiro, ou None se não é código."""
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else None
    s = str(v).strip()
    return str(int(s)) if re.fullmatch(r"-?\d+", s) else None


def ler_layout(path: Path, mapa: dict, base: str):
    """Aba principal do leiaute: {canônico: {"descricao", "categorias"}}."""
    wb = xlrd.open_workbook(str(path))
    sh = wb.sheet_by_index(0)
    ini = next(i for i in range(sh.nrows) if str(sh.cell_value(i, 0)).strip().lower() == "nome")
    out, atual, vistos = {}, None, set()
    canon = set(RC.CANONICAS[base])
    for i in range(ini + 1, sh.nrows):
        linha = [sh.cell_value(i, j) for j in range(sh.ncols)]
        nome = str(linha[0]).strip()
        if nome:
            k = RC.chave(nome)
            k = mapa.get(k, k)
            if k in vistos and k in RC.SEGUNDA_OCORRENCIA:
                k = RC.SEGUNDA_OCORRENCIA[k]
            vistos.add(k)
            atual = k if k in canon else None
            if atual:
                out[atual] = {"descricao": str(linha[1]).strip(), "categorias": {}}
        if atual is None or len(linha) < 5:
            continue
        rot, val = str(linha[3]).strip(), linha[4]
        longo = str(linha[5]).strip() if len(linha) > 5 else ""
        cod = num(val)
        if (cod is not None and rot and "<" not in rot and "ver planilha" not in rot
                and not re.fullmatch(r"[\d.,]+", rot)):
            if longo:
                rot = re.sub(r"^\d+\s*-\s*", "", longo)
            out[atual]["categorias"][cod] = rot
    return out, wb


def ler_faixas(wb):
    """Aba FAIXAS: blocos com título 'FAIXA ...' em pares de colunas (código, rótulo)."""
    sh = wb.sheet_by_name("FAIXAS")
    titulos = {"faixa etaria": "faixa_etaria", "faixa remuneracao media de dezembro": "faixa_rem_dez_sm",
               "faixa hora contratual": "faixa_hora_contrat", "faixa remuneracao media do ano": "faixa_rem_media_sm",
               "faixa tempo emprego": "faixa_tempo_emprego"}
    out = {}
    for c0 in range(0, sh.ncols - 1):
        atual = None
        for i in range(sh.nrows):
            a, b = sh.cell_value(i, c0), sh.cell_value(i, c0 + 1)
            t = RC.chave(str(a)).replace("_", " ")
            if t in titulos:
                atual = titulos[t]
                out.setdefault(atual, {})
                continue
            cod = num(a)
            if atual and cod is not None and str(b).strip():
                out[atual][cod] = str(b).strip()
            elif atual and str(a).strip() == "" and str(b).strip() == "":
                pass
    return out


def ler_lista(wb, aba):
    """Abas 'código:rótulo' (ocupação, município, subclasse, classe 95)."""
    sh = wb.sheet_by_name(aba)
    out = {}
    for i in range(1, sh.nrows):
        s = str(sh.cell_value(i, 0)).strip()
        if ":" in s:
            c, r = s.split(":", 1)
            if re.fullmatch(r"-?\d+", c.strip()):
                out[c.strip()] = r.strip()
    return out


def ler_mes(wb):
    sh = wb.sheet_by_name("mes adm ou desl")
    out = {}
    for i in range(sh.nrows):
        cod = num(sh.cell_value(i, 0))
        if cod is not None and str(sh.cell_value(i, 1)).strip():
            out[cod] = str(sh.cell_value(i, 1)).strip()
    return out


def ler_bairro_rj(wb):
    sh = wb.sheet_by_name("BAIRRO_RJ")
    out = {}
    for i in range(2, sh.nrows):
        cod = num(sh.cell_value(i, 2))
        if cod is not None:
            out[cod] = str(sh.cell_value(i, 1)).strip()
    return out


def layouts(base):
    lista = VINC_LAYOUTS if base == "vinculos" else ESTAB_LAYOUTS
    mapa = LAYOUT_VINC if base == "vinculos" else LAYOUT_ESTAB
    final, wb_ult = {}, None
    for path, periodo in lista:
        lay, wb = ler_layout(path, mapa, base)
        for c, d in lay.items():
            f = final.setdefault(c, {"descricao": d["descricao"], "categorias": {}})
            f["descricao"] = d["descricao"] or f["descricao"]
            f["categorias"].update(d["categorias"])
        wb_ult = wb
    return final, wb_ult


# ------------------------------------------------------------------ tabelas externas
def ler_csv_mte(nome):
    linhas = (FD / nome).read_bytes().decode("latin-1").splitlines()
    out = {}
    for ln in linhas[1:]:
        if ";" in ln:
            c, t = ln.split(";", 1)
            out[c.strip()] = t.strip()
    return out


def natureza_juridica():
    txt = subprocess.run(["pdftotext", "-layout", str(FD / "concla_tnj2021.pdf"), "-"], capture_output=True,
                         text=True, check=True).stdout
    out = {}
    for m in re.finditer(r"^\s+(\d{3})-(\d) - (.+?)\s*$", txt, flags=re.M):
        out[str(int(m.group(1) + m.group(2)))] = m.group(3)
    if len(out) != 92:
        raise RuntimeError(f"natureza jurídica: {len(out)} códigos lidos, esperado 92")
    return out


def esocial_tabela01():
    t = (FD / "esocial_s13_tabelas.html").read_text(encoding="utf-8", errors="replace")
    i = t.find("Tabela 01 - Categorias de Trabalhadores", t.find("Tabela 01 - Categorias de Trabalhadores") + 10)
    j = t.find("Tabela 02 - Financiamento", i)
    s = html.unescape(re.sub(r"<[^>]+>", "|", t[i:j]))
    s = re.sub(r"\s*\|[\s|]*", "|", s)
    out = {}
    for m in re.finditer(r"\|(\d{3})\|([^|]+)\|(\d{2}/\d{2}/\d{4})\|", s):
        out[str(int(m.group(1)))] = m.group(2).strip()
    if len(out) < 30:
        raise RuntimeError(f"Tabela 01 do eSocial: só {len(out)} códigos")
    return out


def cbo_json():
    gg = ler_csv_mte("cbo2002-grande-grupo.csv")
    sgp = ler_csv_mte("cbo2002-subgrupo-principal.csv")
    sg = ler_csv_mte("cbo2002-subgrupo.csv")
    fam = ler_csv_mte("cbo2002-familia.csv")
    ocu = ler_csv_mte("cbo2002-ocupacao.csv")
    ocupacao = {}
    for c, t in sorted(ocu.items()):
        c6 = c.zfill(6)
        ocupacao[c6] = {"titulo": t, "familia": c6[:4], "subgrupo": c6[:3], "subgrupo_principal": c6[:2],
                        "grande_grupo": c6[:1]}
    return {
        "titulo": "CBO 2002 - Classificação Brasileira de Ocupações",
        "fonte": "Ministério do Trabalho e Emprego (MTE), arquivos CSV da estrutura da CBO 2002",
        "url": "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/cbo/servicos/downloads/downloads",
        "baixado_em": HOJE,
        "uso": ("No Parquet da RAIS, cbo_2002_ocupacao é inteiro (sem zeros à esquerda). Para cruzar com esta "
                "tabela use lpad(CAST(cbo_2002_ocupacao AS VARCHAR), 6, '0'); a família são os 4 primeiros "
                "dígitos, o subgrupo os 3, o subgrupo principal os 2 e o grande grupo o primeiro. "
                "-1 = ignorado (vira '0000-1' no lpad)."),
        "niveis": {"grande_grupo": gg, "subgrupo_principal": sgp, "subgrupo": sg, "familia": fam},
        "ocupacao": ocupacao,
    }


def cnae_json(wb_vinc):
    api = json.loads((FD / "ibge_cnae_subclasses.json").read_text())
    sub, cla, gru, div, sec = {}, {}, {}, {}, {}
    for s in api:
        c = s["classe"]; g = c["grupo"]; d = g["divisao"]; e = d["secao"]
        sub[s["id"]] = {"descricao": s["descricao"], "classe": c["id"], "grupo": g["id"], "divisao": d["id"],
                        "secao": e["id"], "fonte": "IBGE/CONCLA CNAE 2.3"}
        cla[c["id"]] = c["descricao"]; gru[g["id"]] = g["descricao"]; div[d["id"]] = d["descricao"]
        sec[e["id"]] = e["descricao"]
    div2sec = {d: s["secao"] for s in sub.values() for d in [s["divisao"]]}
    lay_sub = ler_lista(wb_vinc, "subclasse 2.0")
    faltam = 0
    for c, t in lay_sub.items():
        c7 = c.zfill(7)
        if c7 not in sub:
            faltam += 1
            sub[c7] = {"descricao": t, "classe": c7[:5], "grupo": c7[:3], "divisao": c7[:2],
                       "secao": div2sec.get(c7[:2]), "fonte": "leiaute RAIS (aba 'subclasse 2.0'), fora da CNAE 2.3"}
    return {
        "titulo": "CNAE 2.0 (subclasse a seção) e CNAE 95 (classe)",
        "fonte": ("IBGE/CONCLA, API de classificações (CNAE 2.3, que mantém a estrutura da 2.0); subclasses que "
                  "saíram da CNAE 2.3 e a CNAE 95 vêm dos leiautes oficiais da RAIS (MTE)"),
        "url": "https://servicodados.ibge.gov.br/api/v2/cnae/subclasses",
        "url_leiaute": URL_FTP_LAYOUT,
        "baixado_em": HOJE,
        "uso": ("No Parquet, cnae_2_0_subclasse e cnae_2_0_classe são inteiros. Para cruzar: "
                "lpad(CAST(cnae_2_0_subclasse AS VARCHAR), 7, '0') e lpad(CAST(cnae_2_0_classe AS VARCHAR), 5, '0'); "
                "a divisão são os 2 primeiros dígitos e o grupo os 3. cnae_95_classe: lpad(..., 5, '0')."),
        "subclasses_so_no_leiaute": faltam,
        "secao": sec, "divisao": div, "grupo": gru, "classe": cla, "subclasse": sub,
        "classe_95": {**{c.zfill(5): t for c, t in ler_lista(wb_vinc, "classe 1.0 ou 95").items()},
                      "00999": ("Sem classe CNAE 95 correspondente (código fora da lista do leiaute; aparece em "
                                "classes CNAE 2.0 sem equivalente, como 81303)")},
    }


def bairros_json(wb_vinc):
    import csv
    lay = ler_bairro_rj(wb_vinc)
    tab = {r["codigo_rais"]: r for r in csv.DictReader(TAB_BAIRRO.open(encoding="utf-8"))}
    g = json.loads(GEO_IPP.read_text())
    ipp = {}
    for f in g["features"]:
        p = f["properties"]
        ipp[str(int(p["codbairro"]))] = {"codbairro": p["codbairro"], "nome": p["nome"], "codigos_rais": []}
    rais = {}
    for cod, nome in lay.items():
        k = f"{int(cod):04d}" if int(cod) >= 0 else "-001"
        t = tab.get(k, {})
        cb = t.get("codbairro_ipp") or None
        rais[cod] = {"codigo_rais": k, "nome": nome, "sigla": t.get("sigla_rais"),
                     "bairro_ipp": t.get("bairro_ipp") or None,
                     "codbairro_ipp": int(cb) if cb else None, "casamento": t.get("casamento")}
        if cb:
            ipp[str(int(cb))]["codigos_rais"].append(int(cod))
    rais["9997"] = {"codigo_rais": "9997", "nome": "Ignorado (código usado em 2022, fora do leiaute)",
                    "bairro_ipp": None, "codbairro_ipp": None, "casamento": None}
    rais["999997"] = {"codigo_rais": "999997", "nome": "Ignorado (código do arquivo eSocial, 2023+, fora do leiaute)",
                      "bairro_ipp": None, "codbairro_ipp": None, "casamento": None}
    return {
        "titulo": "Bairros do Rio: código RAIS (Bairros RJ) e bairros IPP 2023",
        "fonte": ("Leiaute oficial da RAIS (aba BAIRRO_RJ, MTE); casamento código RAIS -> bairro IPP feito no caso "
                  "MCMV (bairros_sucesso), que reproduz a tabela RAIS do IPP no Data.Rio em 2014–2016; malha de "
                  "bairros IPP 2023 (Data.Rio)."),
        "url_leiaute": URL_FTP_LAYOUT,
        "url_ipp": "https://www.data.rio/ (Limite de Bairros, IPP)",
        "uso": ("rais: chave = valor de bairros_rj no Parquet (vínculos até 2021; estabelecimentos até 2021). "
                "ipp: chave = valor de bairro_ipp_cep (estabelecimentos, pelo CEP, 2014+). Sub-bairros da lista RAIS "
                "são somados ao bairro IPP como faz o IPP; códigos sem correspondência ficam sem bairro IPP. "
                "12 bairros IPP criados depois da lista do MTE (ex.: Jacarezinho, Lapa, Vila Kennedy) só existem "
                "pelo CEP."),
        "rais": rais, "ipp": ipp,
    }


# ------------------------------------------------------------------ dicionário das tabelas
def anos_por_coluna(base):
    """Da estatística de cada ano: em que anos a coluna existe e quantos '{ñ class}' viraram NULL."""
    exist, nc, linhas = {}, {}, {}
    for f in sorted(STATS.glob(f"{base}_*.json")):
        info = json.loads(f.read_text())
        if info["rotulo"].endswith("legado"):
            continue
        a = info["ano"]
        linhas[a] = info["linhas_rio"]
        for c, s in info["colunas"].items():
            exist.setdefault(c, []).append(a)
            if s["nao_class"]:
                nc.setdefault(c, {})[str(a)] = s["nao_class"]
    return exist, nc, linhas


def bairros_ipp_cat():
    """Código IPP (inteiro, como em bairro_ipp_cep) -> nome do bairro, da malha IPP 2023."""
    g = json.loads(GEO_IPP.read_text())
    return {str(int(f["properties"]["codbairro"])): f["properties"]["nome"] for f in g["features"]}


# Colunas cujo rótulo vem de tabela externa (CBO, CNAE): o preenchimento usa só os códigos de ignorado.
EXTERNAS = {"cbo_2002_ocupacao", "cnae_2_0_subclasse", "cnae_2_0_classe", "cnae_95_classe"}
NAO_CONTINUAS = {"idade", "qtd_hora_contr", "qtd_dias_afastamento", "ano_chegada_brasil", "qtd_vinculos_clt",
                 "qtd_vinculos_ativos", "qtd_vinculos_estatutarios", "cep_estab"}
ROTULO_IGNORADO = re.compile(r"ignorad|ñ ?class|n[aã]o classific|n[aã]o ident", re.I)


def codigos_validos(c, item):
    """Lista dos códigos que contam como preenchimento real: têm rótulo (leiaute ou período) e não são de
    ignorado. None = coluna sem lista completa de categorias (usa só codigos_ignorado)."""
    if c in EXTERNAS or c in NAO_CONTINUAS:
        return None
    cat = dict(item.get("categorias", {}))
    for per in item.get("categorias_por_periodo", []):
        cat.update(per["categorias"])
    if len(cat) < 2:
        return None
    ign = set(str(x) for x in item.get("codigos_ignorado", []))
    return sorted(int(k) for k, v in cat.items() if k.lstrip("-").isdigit() and k not in ign
                  and not ROTULO_IGNORADO.search(str(v)))


def condicao_valida(c, item, tipo):
    """Expressão SQL (filtro) de preenchimento real da coluna c."""
    if tipo == "VARCHAR" or tipo.startswith("DECIMAL"):
        return f'"{c}" is not null'
    val = codigos_validos(c, item)
    if val is not None:
        return f'"{c}" in ({", ".join(map(str, val))})'
    ign = ", ".join(str(x) for x in item.get("codigos_ignorado", IGNORADO_GERAL))
    return f'"{c}" is not null and "{c}" not in ({ign})'


def preenchimento(base, itens, anos):
    """% de linhas com preenchimento real por coluna e ano, e os códigos observados (colunas codificadas)."""
    con = duckdb.connect()
    con.execute("set memory_limit='2GB'; set threads=4")
    out, obs = {}, {}
    for a in anos:
        f = DESTINO[base] / nome_arquivo(base, str(a))
        if not f.exists():
            continue
        tem = {r[0] for r in con.execute(f"select column_name from (describe select * from '{f}')").fetchall()}
        cs = [c for c in itens if c in tem]
        partes = [f"count(*) filter (where {condicao_valida(c, itens[c], RC.TIPOS[base][c])})" for c in cs]
        r = con.execute(f"select count(*), {', '.join(partes)} from '{f}'").fetchone()
        for c, v in zip(cs, r[1:]):
            out.setdefault(c, {})[str(a)] = round(100 * v / r[0], 1)
        for c in cs:
            t = RC.TIPOS[base][c]
            if t in ("UTINYINT", "TINYINT", "USMALLINT", "SMALLINT") and c not in NAO_CONTINUAS:
                for v, n in con.execute(f'select "{c}", count(*) from \'{f}\' group by 1').fetchall():
                    if v is not None:
                        obs.setdefault(c, {}).setdefault(str(v), []).append(a)
    return out, obs


def montar_tabela(base, lay, extra_cat, notas_col, titulo, tabela):
    exist, nc, linhas = anos_por_coluna(base)
    tipos = RC.TIPOS[base]
    colunas = [c for c in RC.CANONICAS[base] if c not in RC.FORA_DO_RIO and c in exist]
    if base == "estab":
        colunas += RC.ESTAB_DERIVADAS
        exist["bairro_ipp_cep"] = exist.get("cep_estab", [])
        extra_cat = dict(extra_cat, bairro_ipp_cep=bairros_ipp_cat())
    anos = sorted(linhas)
    var = {"ano": {"descricao": DESC_EXTRA["ano"], "tipo": "USMALLINT", "anos": anos}}
    for c in colunas:
        d = lay.get(c, {})
        cat = dict(d.get("categorias", {}))
        cat.update(extra_cat.get(c, {}))
        item = {"descricao": DESC_EXTRA.get(c) or d.get("descricao") or c, "tipo": tipos[c], "anos": exist[c]}
        if not (tipos[c] == "VARCHAR" or tipos[c].startswith("DECIMAL")) and c not in NAO_CONTINUAS:
            item["codigos_ignorado"] = IGNORADO.get(c, IGNORADO_GERAL)
        if cat:
            item["categorias"] = dict(sorted(cat.items(), key=lambda kv: int(kv[0]) if kv[0].lstrip("-").isdigit() else 0))
        if c in notas_col:
            extra = dict(notas_col[c])
            if "categorias" in extra:
                item["categorias"] = {**item.get("categorias", {}), **extra.pop("categorias")}
            item.update(extra)
        var[c] = item
    pre, obs = preenchimento(base, {c: var[c] for c in colunas}, anos)
    for c in colunas:
        item, p = var[c], pre.get(c, {})
        item["preenchimento_pct"] = p
        item["anos_preenchida"] = [int(a) for a, v in sorted(p.items()) if v >= 1.0]
        if c in obs:
            rotulados = set(item.get("categorias", {}))
            for per in item.get("categorias_por_periodo", []):
                rotulados |= set(per["categorias"])
            sem = {v: anos_v for v, anos_v in obs[c].items() if v not in rotulados}
            if sem and rotulados:
                item["codigos_sem_rotulo"] = sem
        if c in nc:
            item["nao_classificado_virou_nulo"] = nc[c]
    return {"tabela": tabela, "titulo": titulo, "gerado_em": HOJE,
            "fonte": "RAIS, microdados públicos não identificados (PDET/MTE), ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/",
            "linhas_por_ano": {str(a): n for a, n in sorted(linhas.items())},
            "preenchimento": ("preenchimento_pct = % das linhas do ano com preenchimento real: nas colunas com lista de "
                              "categorias, só os códigos com rótulo que não são de ignorado (codigos_sem_rotulo e "
                              "codigos_ignorado não contam); em CBO e CNAE, valor não nulo fora de codigos_ignorado; em "
                              "valores e quantidades, não nulo. anos_preenchida = anos com pelo menos 1%. "
                              "Arquivo Legado de 2023 fora destas contagens."),
            "variaveis": var}


def notas_comuns(base):
    n = {
        "bairros_rj": {"tabela": "dados/dic/bairros_rj.json", "nota":
                       "Código de bairro da RAIS (aba BAIRRO_RJ do leiaute). Só é informado até 2021: em 2022 vem 9997 "
                       "ou 0, e de 2023 em diante (eSocial) vem 999997 em todas as linhas."},
        "cnae_2_0_subclasse": {"tabela": "dados/dic/cnae.json", "chave_tabela":
                               "lpad(CAST(cnae_2_0_subclasse AS VARCHAR), 7, '0')"},
        "cnae_2_0_classe": {"tabela": "dados/dic/cnae.json", "chave_tabela":
                            "lpad(CAST(cnae_2_0_classe AS VARCHAR), 5, '0')"},
        "cnae_95_classe": {"tabela": "dados/dic/cnae.json (classe_95)", "chave_tabela":
                           "lpad(CAST(cnae_95_classe AS VARCHAR), 5, '0')"},
        "natureza_juridica": {"fonte_categorias": "IBGE/CONCLA, Tabela de Natureza Jurídica 2021; códigos que saíram "
                              "da tabela com o rótulo abreviado do leiaute da RAIS"},
    }
    if base == "vinculos":
        n["cbo_2002_ocupacao"] = {"tabela": "dados/dic/cbo.json", "chave_tabela":
                                  "lpad(CAST(cbo_2002_ocupacao AS VARCHAR), 6, '0')"}
        n["municipio_trab"] = {"nota": "Município onde o empregado trabalha. Quase vazio desde 2023 (eSocial: 999999)."}
        n["categoria_trabalhador"] = {"fonte_categorias": "eSocial S-1.3, Tabela 01 - Categorias de Trabalhadores"}
        n["raca_cor"] = {"nota": ("De 2010 a 2022 (e no 2023 Legado) cerca de 13% das linhas vêm com 99, código fora do "
                                  "leiaute, no lugar do '{ñ class}' de 2006–2009: conta como não classificado. 9 = "
                                  "não identificado.")}
    else:
        n["bairro_ipp_cep"] = {"tabela": "dados/dic/bairros_rj.json (ipp)"}
    return n


OBS = "sem leiaute oficial com estas faixas; rótulo pela faixa observada nos microdados (validacao_rais.md, seção 7)"


def notas_esocial_vinculos(faixas):
    """Categorias que mudaram nos arquivos recentes (2022, 2023 eSocial, 2023 Legado, 2024–2025). O MTE não
    publicou leiaute com elas; cada rótulo diz de onde vem. A conferência nos microdados (mínimo e máximo da
    variável contínua dentro de cada código) está em validacao_rais.md, seção 7."""
    dez = faixas["faixa_rem_dez_sm"]
    escala_dez = {k: v for k, v in dez.items() if k not in ("0", "99")}
    return {
        "faixa_rem_media_sm": {"categorias_por_periodo": [
            {"anos": [2022, 2023, 2024, 2025],
             "categorias": {**escala_dez, "99": "Sem remuneração no ano / não classificado"},
             "fonte": ("escala da 'FAIXA REMUNERAÇÃO MÉDIA DE DEZEMBRO' do leiaute (1 = até 0,50 SM ... 12 = mais "
                       "de 20 SM); conferido pelo mínimo e máximo de vl_rem_media_sm em cada código")},
            {"anos": ["2023_legado"],
             "categorias": {**faixas["faixa_rem_media_sm"], "98": "Abaixo de 0,30 SM ou sem remuneração (faixa observada)"},
             "fonte": "0–11 do leiaute antigo; 98 " + OBS}],
            "nota": ("Quebra de codificação em 2022: de 2006 a 2021 (e no 2023 Legado) o código 0 é 'até 0,50 SM' "
                     "e 11 é 'mais de 20 SM'; em 2022 e de 2023 em diante (eSocial) o 1 é 'até 0,50 SM' e o 12 é "
                     "'mais de 20 SM'. O mesmo código quer dizer faixas diferentes: compare anos pelo valor "
                     "(vl_rem_media_nom), não pelo código.")},
        "faixa_rem_dez_sm": {"categorias_por_periodo": [{
            "anos": [2023, "2023_legado", 2024, 2025],
            "categorias": {**escala_dez, "99": "Não ativo em dezembro / sem remuneração em dezembro"},
            "fonte": "leiaute antigo; a partir de 2023 não há o código 0 (não ativo em dezembro), que vem como 99"}]},
        "faixa_hora_contrat": {"categorias_por_periodo": [{
            "anos": [2022, 2023, "2023_legado", 2024, 2025],
            "categorias": {**faixas["faixa_hora_contrat"], "7": "45 a 47 horas (faixa observada)",
                           "8": "48 a 60 horas (faixa observada)", "99": "Não classificado"},
            "fonte": "1–6 do leiaute; 7, 8 e 99 " + OBS}],
            "nota": "Em 2023 (eSocial) a faixa nem sempre bate com qtd_hora_contr (ver validacao_rais.md)."},
        "faixa_tempo_emprego": {"categorias_por_periodo": [{
            "anos": [2022, 2023, "2023_legado", 2024, 2025],
            "categorias": {"0": "0 mês (faixa observada)", **faixas["faixa_tempo_emprego"]},
            "fonte": "1–8 do leiaute; 0 " + OBS}]},
        **{f"causa_afastamento_{i}": {"categorias_por_periodo": [{
            "anos": [2023, 2024, 2025], "categorias": {"999": "Sem afastamento"},
            "fonte": ("código do eSocial fora do leiaute; equivale ao 99 (SEM AFASTAMENTOS) do leiaute antigo: "
                      "conferido que 999 ocorre se e só se qtd_dias_afastamento = 0")}],
            "nota": ("2006–2009: quem não teve afastamento vem como '{ñ class}' (NULL); de 2010 a 2022 e no 2023 "
                     "Legado, como 99; de 2023 em diante (eSocial), como 999. Em 2010 e 2011 a fonte traz 99 em todas as "
                     "linhas, mesmo com dias de afastamento: a causa não veio nesses dois anos.")} for i in (1, 2, 3)},
        "mes_desligamento": {"nota": ("Quem não foi desligado vem como 0 na maior parte dos anos, mas como "
                                      "'{ñ class}' (NULL) em 2019–2022 e no 2023 Legado.")},
        "vl_rem_media_sm": {"nota": ("De 2023 em diante (eSocial e Legado), de 1 a 3,5 mil linhas por ano trazem "
                                     "valores acima de 150 SM (até ~190 mil), incompatíveis com a faixa: parecem "
                                     "valores em R$. Para comparar remuneração, prefira vl_rem_media_nom.")},
        "tipo_admissao_trabalhador": {"nota": ("De 2023 em diante (eSocial e Legado) não aparece o código 1 "
                                               "(primeiro emprego): admissões vêm como 2 (reemprego) ou transferências.")},
        "municipio_trab": {"nota": ("Município onde o empregado trabalha. De 2023 em diante (eSocial) vem 999999 "
                                    "(não informado) em quase todas as linhas.")},
        "categoria_trabalhador": {"nota": "Só existe no arquivo eSocial (2023+)."},
        "ind_vinculo_abandonado": {"categorias": {"0": "Não", "1": "Sim"}, "nota": "Só existe no arquivo eSocial (2023+)."},
        "tipo_salario": {"nota": ("Só existe no arquivo público de 2018; o leiaute público não traz as categorias. "
                                  "Nome canônico pelo De-Para do MTE (aba VINC_ID).")},
        "vl_salario_contratual": {"nota": ("Só existe no arquivo público de 2018 (valor do salário contratual, R$). "
                                           "Nome canônico pelo De-Para do MTE (aba VINC_ID).")},
    }


NOTAS_ESOCIAL_ESTAB = {
    "ind_estab_participante_pat": {"nota": "2023+ (eSocial): 9 em todas as linhas, código fora do leiaute (não informado)."},
    "ind_rais_negativa": {"nota": ("2023+ (eSocial): aparece o código 2, fora do leiaute (menos de 700 "
                                   "estabelecimentos por ano, todos com zero vínculo ativo).")},
    "bairros_rj": {"tabela": "dados/dic/bairros_rj.json", "nota": (
        "Código de bairro da RAIS (aba BAIRRO_RJ do leiaute). Só é informado até 2021: em 2022 vem 9997 ou 0 e de 2023 "
        "em diante (eSocial) 999997. Para bairro em qualquer ano a partir de 2014, use bairro_ipp_cep.")},
    "cnae_2_0_classe": {"nota": ("2023+: o arquivo eSocial repete a subclasse nesta coluna; o pipeline grava a classe "
                                 "como os 5 primeiros dígitos da subclasse (conferido: classe = subclasse em 100% "
                                 "das linhas desses anos).")},
    "cnae_95_classe": {"nota": ("2023+: o arquivo eSocial traz 4 dígitos (sem o dígito verificador); o pipeline "
                                "recupera o código de 5 dígitos pela lista de classes CNAE 95 do leiaute "
                                "(os 4 primeiros dígitos identificam a classe). O código 9999 do eSocial (classe "
                                "CNAE 2.0 sem correspondente na CNAE 95) vira 999, o código que o leiaute antigo "
                                "usa para a mesma situação (ex.: 2022).")},
}


def main():
    SAIDA.mkdir(parents=True, exist_ok=True)
    lay_v, wb_v = layouts("vinculos")
    lay_e, _ = layouts("estab")
    faixas = ler_faixas(wb_v)
    meses = ler_mes(wb_v)
    muni = ler_lista(wb_v, "municipio")
    nj = natureza_juridica()
    esoc = esocial_tabela01()
    bairro_cat = ler_bairro_rj(wb_v)
    bairro_cat.update({"9997": "Ignorado (2022; fora do leiaute)", "999997": "Ignorado (eSocial 2023+; fora do leiaute)"})

    def nat(lay):
        cat = dict(lay.get("natureza_juridica", {}).get("categorias", {}))
        cat.update(nj)
        return cat

    extra_v = {c: faixas[c] for c in faixas}
    extra_v.update({"mes_admissao": meses, "mes_desligamento": meses, "municipio_trab": muni, "municipio": muni,
                    "natureza_juridica": nat(lay_v), "categoria_trabalhador": esoc, "bairros_rj": bairro_cat,
                    "tipo_estabelecimento": {"1": "CNPJ", "3": "CEI", "5": "CAEPF", "6": "CNO"}})
    extra_e = {"municipio": muni, "natureza_juridica": nat(lay_e), "bairros_rj": bairro_cat,
               "tipo_estabelecimento": {"1": "CNPJ", "3": "CEI", "5": "CAEPF", "6": "CNO"}}
    for c in ("ind_estab_participante_simples", "ind_atividade_ano", "ind_estab_participante_pat",
              "ind_rais_negativa", "ind_cei_vinculado"):
        extra_e.setdefault(c, {"0": "Não", "1": "Sim"})

    nv = notas_comuns("vinculos")
    for c, extra in notas_esocial_vinculos(faixas).items():
        nv.setdefault(c, {}).update(extra)
    ne = notas_comuns("estab")
    for c, extra in NOTAS_ESOCIAL_ESTAB.items():
        ne.setdefault(c, {}).update(extra)

    dv = montar_tabela("vinculos", lay_v, extra_v, nv, "RAIS Vínculos - município do Rio", "rais_vinculos")
    dv["fontes_categorias"] = {"leiautes": URL_FTP_LAYOUT + "vínculos/ (2006–2014, 2015, 2016, 2017, 2018e2019, 2020)",
                               "de_para_esocial": "https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/acoes-e-programas/programas-projetos-acoes-obras-e-atividades/estatisticas-trabalho/rais/rais-2024/rais-2024-1/de-para-microdados.xlsx",
                               "natureza_juridica": "https://concla.ibge.gov.br/images/concla/documentacao/CONCLA-TNJ2021-EstruturaDetalhada.pdf",
                               "esocial_tabela01": "https://www.gov.br/esocial/pt-br/documentacao-tecnica/leiautes-esocial-v-s-1-3-nt-07-2026-rev-24-09-2026/tabelas.html"}
    de = montar_tabela("estab", lay_e, extra_e, ne, "RAIS Estabelecimentos - município do Rio", "rais_estab")
    de["fontes_categorias"] = {"leiautes": URL_FTP_LAYOUT + "estabelecimento/ (2002a2013, 2014a2017, 2018e2019)",
                               "natureza_juridica": dv["fontes_categorias"]["natureza_juridica"]}
    escrever("rais_vinculos.json", dv)
    escrever("rais_estab.json", de)
    escrever("cbo.json", cbo_json())
    escrever("cnae.json", cnae_json(wb_v))
    escrever("bairros_rj.json", bairros_json(wb_v))


def escrever(nome, obj):
    p = SAIDA / nome
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    print(nome, round(p.stat().st_size / 1e3, 1), "KB")


if __name__ == "__main__":
    main()
