"""Pipeline da PNAD Contínua (IBGE) para o município do Rio: Parquet, dicionários e manifest.

Rodar sempre com `python -I` (os arquivos baixados são dados não confiáveis) e de fora da pasta dos brutos:

    python -I repo/pipeline/pnad.py catalogo      # lista o FTP do IBGE e grava o catálogo
    python -I repo/pipeline/pnad.py extrair       # baixa um zip por vez, separa o Rio, valida e apaga o zip
    python -I repo/pipeline/pnad.py tipos         # decide o tipo de cada coluna (regra de largura do CONTRATO)
    python -I repo/pipeline/pnad.py parquet       # grava um Parquet por tabela e ano (site/dados/pnad/)
    python -I repo/pipeline/pnad.py deflatores    # deflatores trimestrais e da visita anual (UF 33)
    python -I repo/pipeline/pnad.py dicionarios   # site/dados/dic/pnad_*.json, cod_pnad.json, cnae_domiciliar.json
    python -I repo/pipeline/pnad.py manifest      # site/dados/manifest_pnad.json
    python -I repo/pipeline/pnad.py validar       # confere tipos iguais em todos os anos (union_by_name)
    python -I repo/pipeline/pnad.py tudo          # tudo acima, em ordem

Opções: --brutos <pasta> (padrão: <raiz>/brutos/pnad), --tabela trimestral|visita1|visita5, --ano AAAA.

Fluxo de memória e disco: um arquivo por vez. O zip nacional (~230 MB) é lido em fluxo com `bsdtar -xOf`;
só as linhas do Rio (UF=33 e Capital=33) vão para `brutos/pnad/rio/<tabela>/<arquivo>.txt.gz`, que é o
insumo das etapas seguintes. Depois da validação da contagem, o zip é apagado.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

PIPE = Path(__file__).resolve().parent
REPO = PIPE.parent
SITE = REPO / "site"
RAIZ = REPO.parent
FTP = "https://ftp.ibge.gov.br/Trabalho_e_Rendimento/Pesquisa_Nacional_por_Amostra_de_Domicilios_continua"

ARQ_CATALOGO = PIPE / "pnad_catalogo.json"
ARQ_REGISTRO = PIPE / "pnad_registro.json"
ARQ_TIPOS = PIPE / "pnad_tipos.json"

TABELAS = {
    "trimestral": {"nome": "pnad_trimestral", "peso": "V1028", "periodo": ["Ano", "Trimestre"],
                   "titulo": "PNAD Contínua trimestral", "pasta": "trimestral"},
    "visita1": {"nome": "pnad_visita1", "peso": "V1032", "periodo": ["Ano"],
                "titulo": "PNAD Contínua anual, 1ª visita", "pasta": "anual"},
    "visita5": {"nome": "pnad_visita5", "peso": "V1032", "periodo": ["Ano"],
                "titulo": "PNAD Contínua anual, 5ª visita", "pasta": "anual"},
}
ORDEM = ["Ano", "Trimestre", "Estrato", "UPA", "V1008", "V2003"]
REPLICA = re.compile(r"V10\d{5}")
# Pesos e projeções de população: DOUBLE por regra do CONTRATO, mesmo quando o dado vem sem ".".
PESOS = {"V1027", "V1028", "V1029", "V1030", "V1031", "V1032", "V1033", "V1034"}
LINHA_INPUT = re.compile(r"@(\d+)\s+(\w+)\s+(\$?)(\d+)\.(\d*)\s*(?:/\*\s*(.*?)\s*\*/)?")
TIPOS_PA = {"UTINYINT": pa.uint8(), "USMALLINT": pa.uint16(), "UINTEGER": pa.uint32(), "UBIGINT": pa.uint64(),
            "TINYINT": pa.int8(), "SMALLINT": pa.int16(), "INTEGER": pa.int32(), "BIGINT": pa.int64(),
            "DOUBLE": pa.float64(), "VARCHAR": pa.string()}


def log(msg: str):
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def ler_json(caminho: Path, padrao):
    return json.loads(caminho.read_text(encoding="utf-8")) if caminho.exists() else padrao


def gravar_json(caminho: Path, obj, compacto=False):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_suffix(caminho.suffix + ".tmp")
    if compacto:
        tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    else:
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(caminho)


# ----------------------------------------------------------------------------- FTP

def listar(caminho: str) -> list[str]:
    with urllib.request.urlopen(f"{FTP}/{caminho}", timeout=120) as r:
        html = r.read().decode("utf-8", "replace")
    return [h for h in re.findall(r'href="([^"]+)"', html) if not h.startswith(("?", "/", "http"))]


def tamanho_remoto(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=120) as r:
        return int(r.headers["Content-Length"])


def anos_do_nome(nome: str) -> list[int]:
    m = re.search(r"_(\d{4})_a_(\d{4})_", nome)
    if m:
        return list(range(int(m.group(1)), int(m.group(2)) + 1))
    m = re.search(r"_(\d{4})_visita", nome)
    return [int(m.group(1))] if m else []


def cmd_catalogo(a):
    cat = {"gerado_em": dt.date.today().isoformat(), "ftp": FTP, "dados": [], "docs": {}}
    base = "Trimestral/Microdados"
    for d in listar(f"{base}/"):
        if re.fullmatch(r"\d{4}/", d):
            for f in listar(f"{base}/{d}"):
                m = re.fullmatch(r"PNADC_(\d{2})(\d{4})(?:_\d{8})?\.zip", f)
                if m:
                    cat["dados"].append({"tabela": "trimestral", "ano": int(m.group(2)), "trimestre": int(m.group(1)),
                                         "nome": f, "url": f"{FTP}/{base}/{d}{f}"})
    docs_tri = listar(f"{base}/Documentacao/")
    for chave, padrao in [("dicionario_trimestral", r"Dicionario_e_input_\d+\.zip"), ("deflatores", r"Deflatores\.zip"),
                          ("cod", r"Estrutura_Ocupacao_COD\.xls"),
                          ("cnae", r"Estrutura_Atividade_CNAE_Domiciliar_2_0\.xls")]:
        achados = sorted(f for f in docs_tri if re.fullmatch(padrao, f))
        cat["docs"][chave] = {"nome": achados[-1], "url": f"{FTP}/{base}/Documentacao/{achados[-1]}"}
    geral = "Anual/Microdados/Visita/Documentacao_Geral"
    defl = sorted(f for f in listar(f"{geral}/") if re.fullmatch(r"deflator_PNADC_\d{4}\.xls", f))
    cat["docs"]["deflator_visita"] = {"nome": defl[-1], "url": f"{FTP}/{geral}/{defl[-1]}"}
    for v in (1, 5):
        pasta = f"Anual/Microdados/Visita/Visita_{v}"
        for f in listar(f"{pasta}/Dados/"):
            m = re.fullmatch(rf"PNADC_(\d{{4}})_visita{v}(?:_\d+)?\.zip", f)
            if m:
                cat["dados"].append({"tabela": f"visita{v}", "ano": int(m.group(1)), "trimestre": None,
                                     "nome": f, "url": f"{FTP}/{pasta}/Dados/{f}"})
        for f in listar(f"{pasta}/Documentacao/"):
            for tipo in ("input", "dicionario"):
                if f.startswith(tipo) and f.endswith((".txt", ".xls")):
                    for ano in anos_do_nome(f):
                        cat["docs"].setdefault(f"visita{v}", {}).setdefault(str(ano), {})[tipo] = {
                            "nome": f, "url": f"{FTP}/{pasta}/Documentacao/{f}"}
    cat["dados"].sort(key=lambda d: (d["tabela"], d["ano"], d["trimestre"] or 0))
    gravar_json(ARQ_CATALOGO, cat)
    n = Counter(d["tabela"] for d in cat["dados"])
    log(f"catálogo: {dict(n)} arquivos de dados; docs em {ARQ_CATALOGO.name}")


def catalogo() -> dict:
    if not ARQ_CATALOGO.exists():
        raise SystemExit("rode antes: pnad.py catalogo")
    return ler_json(ARQ_CATALOGO, {})


def baixar(url: str, destino: Path, aliases: list[Path] = ()) -> Path:
    """Baixa com retomada e confere o tamanho com o Content-Length. Reaproveita um arquivo local igual."""
    tam = tamanho_remoto(url)
    for alt in [destino, *aliases]:
        if alt.exists() and alt.stat().st_size == tam:
            return alt
    destino.parent.mkdir(parents=True, exist_ok=True)
    for tentativa in range(4):
        r = subprocess.run(["curl", "-fsS", "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", str(destino), url])
        if destino.exists() and destino.stat().st_size == tam:
            return destino
        log(f"download incompleto ({r.returncode}), tentativa {tentativa + 1}: {destino.name}")
    raise RuntimeError(f"download falhou: {url}")


def doc_local(chave: str, info: dict) -> Path:
    sub = {"dicionario_trimestral": "trimestral"}.get(chave, "geral")
    aliases = [a.brutos / "dic.zip"] if chave == "dicionario_trimestral" else []
    return baixar(info["url"], a.brutos / "doc" / sub / info["nome"], aliases)


# ----------------------------------------------------------------------------- layout

def parse_input(txt: bytes) -> list[dict]:
    layout = []
    for linha in txt.decode("latin1").splitlines():
        m = LINHA_INPUT.search(linha)
        if m:
            ini, nome, char, larg, dec, rotulo = m.groups()
            layout.append({"ini": int(ini) - 1, "nome": nome, "larg": int(larg), "char": char == "$",
                           "dec": int(dec) if dec else 0, "rotulo": (rotulo or "").strip()})
    if not layout:
        raise ValueError("input SAS sem campos")
    return layout


def layout_de(tabela: str, ano: int) -> list[dict]:
    cat = catalogo()
    if tabela == "trimestral":
        z = doc_local("dicionario_trimestral", cat["docs"]["dicionario_trimestral"])
        txt = subprocess.run(["bsdtar", "-xOf", str(z), "input_PNADC_trimestral.txt"], check=True,
                             capture_output=True).stdout
    else:
        info = cat["docs"][tabela][str(ano)]["input"]
        txt = baixar(info["url"], a.brutos / "doc" / tabela / info["nome"]).read_bytes()
    return parse_input(txt)


def campo(layout, nome):
    return next(c for c in layout if c["nome"] == nome)


# ----------------------------------------------------------------------------- extração

def arquivo_rio(item: dict) -> Path:
    return a.brutos / "rio" / item["tabela"] / (Path(item["nome"]).stem + ".txt.gz")


def extrair_item(item: dict, registro: dict):
    chave = item["nome"]
    destino = arquivo_rio(item)
    if chave in registro and destino.exists() and registro[chave].get("ok"):
        return False
    layout = layout_de(item["tabela"], item["ano"])
    fim = max(c["ini"] + c["larg"] for c in layout)
    uf, cap, v1023 = campo(layout, "UF"), campo(layout, "Capital"), campo(layout, "V1023")
    assert (uf["ini"], uf["larg"], cap["ini"], cap["larg"]) == (5, 2, 7, 2), "UF/Capital fora da posição esperada"
    sem_data = re.sub(r"_\d{8}(?=\.zip$)", "", item["nome"])
    alias = [a.brutos / sem_data, a.brutos / re.sub(r"_\d+(?=\.zip$)", "", item["nome"])]
    log(f"baixando {item['nome']}")
    z = baixar(item["url"], a.brutos / item["nome"], alias)
    membros = subprocess.run(["bsdtar", "-tf", str(z)], check=True, capture_output=True, text=True).stdout.split()
    if len(membros) != 1 or not membros[0].lower().endswith(".txt"):
        raise RuntimeError(f"{z.name}: conteúdo inesperado {membros}")
    sha = hashlib.sha256()
    with open(z, "rb") as fz:
        for bloco in iter(lambda: fz.read(1 << 20), b""):
            sha.update(bloco)
    destino.parent.mkdir(parents=True, exist_ok=True)
    tmp = destino.with_suffix(".tmp")
    lidas = rio = 0
    larguras, anos, tris, areas = Counter(), Counter(), Counter(), Counter()
    proc = subprocess.Popen(["bsdtar", "-xOf", str(z)], stdout=subprocess.PIPE)
    with gzip.open(tmp, "wb", compresslevel=6) as out:
        for raw in proc.stdout:
            lidas += 1
            if raw[5:7] == b"33" and raw[7:9] == b"33":
                linha = raw.rstrip(b"\r\n")
                larguras[len(linha)] += 1
                anos[linha[0:4].decode()] += 1
                tris[linha[4:5].decode()] += 1
                areas[linha[v1023["ini"]:v1023["ini"] + 1].decode()] += 1
                out.write(linha + b"\n")
                rio += 1
    rc = proc.wait()
    erros = []
    if rc != 0:
        erros.append(f"bsdtar saiu com {rc}")
    if lidas < 100_000 or rio < 1_000:
        erros.append(f"contagem implausível: lidas={lidas} rio={rio}")
    if set(larguras) != {fim}:
        erros.append(f"largura das linhas {dict(larguras)} diferente do layout ({fim})")
    if set(anos) != {str(item["ano"])}:
        erros.append(f"Ano no arquivo {dict(anos)}")
    if item["trimestre"] and set(tris) != {str(item["trimestre"])}:
        erros.append(f"Trimestre no arquivo {dict(tris)}")
    if set(areas) != {"1"}:
        erros.append(f"V1023 (tipo de área) {dict(areas)}: esperado só 1 = capital")
    if erros:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{item['nome']}: " + "; ".join(erros))
    tmp.replace(destino)
    registro[chave] = {"tabela": item["tabela"], "ano": item["ano"], "trimestre": item["trimestre"],
                       "url": item["url"], "bytes_zip": z.stat().st_size, "sha256_zip": sha.hexdigest(),
                       "linhas_brasil": lidas, "linhas_rio": rio, "largura": fim,
                       "bytes_rio_gz": destino.stat().st_size, "extraido_em": dt.datetime.now().isoformat(timespec="seconds"),
                       "ok": True}
    gravar_json(ARQ_REGISTRO, registro)
    z.unlink()
    log(f"{item['nome']}: Brasil={lidas} Rio={rio} gz={destino.stat().st_size / 1e6:.1f} MB; zip apagado")
    return True


def itens_filtrados(cat):
    for item in cat["dados"]:
        if a.tabela and item["tabela"] != a.tabela:
            continue
        if a.ano and item["ano"] != a.ano:
            continue
        yield item


def cmd_extrair(a_):
    cat = catalogo()
    registro = ler_json(ARQ_REGISTRO, {})
    for item in itens_filtrados(cat):
        extrair_item(item, registro)


# ----------------------------------------------------------------------------- leitura das linhas do Rio

def linhas_do_ano(tabela: str, ano: int) -> pa.Array:
    registro = ler_json(ARQ_REGISTRO, {})
    itens = sorted((r for r in registro.values() if r["tabela"] == tabela and r["ano"] == ano and r.get("ok")),
                   key=lambda r: r["trimestre"] or 0)
    linhas = []
    for r in itens:
        nome = Path(r["url"]).name
        with gzip.open(arquivo_rio({"tabela": tabela, "nome": nome}), "rb") as f:
            linhas.extend(l.rstrip(b"\n").decode("latin1") for l in f)
    esperado = sum(r["linhas_rio"] for r in itens)
    if len(linhas) != esperado:
        raise RuntimeError(f"{tabela} {ano}: {len(linhas)} linhas lidas, registro diz {esperado}")
    return pa.array(linhas, pa.string())


def fatia(arr: pa.Array, c: dict) -> pa.Array:
    s = pc.utf8_trim_whitespace(pc.utf8_slice_codeunits(arr, c["ini"], c["ini"] + c["larg"]))
    return pc.if_else(pc.equal(s, ""), pa.scalar(None, pa.string()), s)


def anos_disponiveis(tabela: str) -> list[int]:
    registro = ler_json(ARQ_REGISTRO, {})
    return sorted({r["ano"] for r in registro.values() if r["tabela"] == tabela and r.get("ok")})


# ----------------------------------------------------------------------------- tipos

def tipo_por_largura(larg: int, negativo: bool) -> str:
    if larg <= 2:
        t = "UTINYINT"
    elif larg <= 4:
        t = "USMALLINT"
    elif larg <= 9:
        t = "UINTEGER"
    else:
        t = "UBIGINT"
    if negativo:
        t = {"UTINYINT": "SMALLINT", "USMALLINT": "INTEGER", "UINTEGER": "BIGINT", "UBIGINT": "BIGINT"}[t]
    return t


def cmd_tipos(a_):
    perfil = defaultdict(lambda: {"larg": set(), "dec": False, "ponto": False, "negativo": False, "texto": set(),
                                  "max": 0})
    anos_var = defaultdict(lambda: defaultdict(list))
    for tabela in TABELAS:
        for ano in anos_disponiveis(tabela):
            layout = layout_de(tabela, ano)
            arr = linhas_do_ano(tabela, ano)
            for c in layout:
                if REPLICA.fullmatch(c["nome"]):
                    continue
                p = perfil[c["nome"]]
                p["larg"].add(c["larg"])
                p["dec"] |= c["dec"] > 0
                s = pc.drop_null(fatia(arr, c))
                if len(s) == 0:
                    continue
                anos_var[tabela][c["nome"]].append(ano)
                inteiro = pc.match_substring_regex(s, r"^[0-9]+$")
                decimal = pc.match_substring_regex(s, r"^[0-9]*\.[0-9]+$|^[0-9]+\.$")
                negativo = pc.match_substring_regex(s, r"^-[0-9]*\.?[0-9]+$")
                p["ponto"] |= pc.any(decimal).as_py()
                p["negativo"] |= pc.any(negativo).as_py()
                outros = pc.filter(s, pc.invert(pc.or_(pc.or_(inteiro, decimal), negativo)))
                if len(outros):
                    p["texto"].update(pc.unique(outros).to_pylist()[:5])
                ints = pc.filter(s, inteiro)
                if len(ints):
                    p["max"] = max(p["max"], pc.max(pc.cast(ints, pa.uint64())).as_py())
            log(f"tipos: {tabela} {ano} ({len(arr)} linhas)")
            del arr
    tipos, decisoes = {}, []
    for nome, p in perfil.items():
        larg = max(p["larg"])
        if p["texto"]:
            t = "VARCHAR"
            decisoes.append(f"{nome}: VARCHAR (conteúdo não numérico, ex.: {sorted(p['texto'])[:5]})")
        elif nome in PESOS or p["dec"] or p["ponto"]:
            t = "DOUBLE"
            if nome not in PESOS:
                decisoes.append(f"{nome}: DOUBLE (o dado traz '.')")
        else:
            t = tipo_por_largura(larg, p["negativo"])
            if p["negativo"]:
                decisoes.append(f"{nome}: {t} (há valores negativos; tipo com sinal)")
            limite = {"UTINYINT": 255, "USMALLINT": 65535, "UINTEGER": 2**32 - 1}.get(t)
            if limite and p["max"] > limite:
                raise RuntimeError(f"{nome}: máximo {p['max']} não cabe em {t}")
        if len(p["larg"]) > 1:
            decisoes.append(f"{nome}: larguras diferentes entre layouts {sorted(p['larg'])}; vale a maior ({larg})")
        tipos[nome] = t
    gravar_json(ARQ_TIPOS, {
        "gerado_em": dt.date.today().isoformat(),
        "regra": "largura no layout do IBGE: até 2 dígitos UTINYINT; 3-4 USMALLINT; 5-9 UINTEGER; 10+ UBIGINT; "
                 "pesos/projeções (V1027-V1034) e campos com '.' DOUBLE; conteúdo não numérico VARCHAR. "
                 "O tipo de cada nome de variável é o mesmo em todas as tabelas e anos.",
        "tipos": tipos, "anos": {t: dict(v) for t, v in anos_var.items()}, "log": decisoes})
    for d in decisoes:
        log("  " + d)
    log(f"tipos: {len(tipos)} variáveis -> {ARQ_TIPOS.name}; {Counter(tipos.values())}")


# ----------------------------------------------------------------------------- Parquet

def destino_parquet(tabela: str, ano: int) -> Path:
    t = TABELAS[tabela]
    return SITE / "dados" / "pnad" / t["pasta"] / f"{t['nome']}_{ano}.zip"


def construir_tabela(tabela: str, ano: int, tipos: dict) -> pa.Table:
    layout = layout_de(tabela, ano)
    arr = linhas_do_ano(tabela, ano)
    cols = {}
    for c in layout:
        if REPLICA.fullmatch(c["nome"]):
            continue
        s = fatia(arr, c)
        t = tipos[c["nome"]]
        cols[c["nome"]] = s if t == "VARCHAR" else pc.cast(s, TIPOS_PA[t])
    tab = pa.table(cols)
    chaves = [c for c in ORDEM if c in tab.column_names]
    return tab.sort_by([(c, "ascending") for c in chaves])


def cmd_parquet(a_):
    import duckdb
    tipos = ler_json(ARQ_TIPOS, {})["tipos"]
    registro = ler_json(ARQ_REGISTRO, {})
    con = duckdb.connect()
    con.execute("SET threads=2; SET memory_limit='2GB'")
    for tabela, cfg in TABELAS.items():
        if a.tabela and tabela != a.tabela:
            continue
        for ano in anos_disponiveis(tabela):
            if a.ano and ano != a.ano:
                continue
            tab = construir_tabela(tabela, ano, tipos)
            destino = destino_parquet(tabela, ano)
            destino.parent.mkdir(parents=True, exist_ok=True)
            tmp = destino.with_suffix(".tmp")
            pq.write_table(tab, tmp, compression="zstd", compression_level=19, row_group_size=max(tab.num_rows, 1),
                           use_dictionary=True, write_statistics=True)
            esperado = sum(r["linhas_rio"] for r in registro.values() if r["tabela"] == tabela and r["ano"] == ano)
            peso = cfg["peso"]
            n, rg = con.execute(f"SELECT count(*), (SELECT count(DISTINCT row_group_id) FROM parquet_metadata('{tmp}')) "
                                f"FROM read_parquet('{tmp}')").fetchone()
            if n != esperado or rg != 1:
                raise RuntimeError(f"{destino.name}: {n} linhas (esperado {esperado}), {rg} blocos")
            tipos_lidos = dict(con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('{tmp}'))").fetchall())
            difs = {k: (v, tipos[k]) for k, v in tipos_lidos.items() if v != tipos[k]}
            if difs:
                raise RuntimeError(f"{destino.name}: tipos lidos diferentes do esperado {difs}")
            # integridade: o peso calibrado soma a projeção da população do posest (V1029 por trimestre no
            # trimestral; V1030 no ano, nas visitas)
            proj, grupo = ("V1029", "Trimestre") if tabela == "trimestral" else ("V1030", "Ano")
            pops = con.execute(f"SELECT {grupo}, sum({peso}), min({proj}), max({proj}) FROM read_parquet('{tmp}') "
                               f"GROUP BY 1 ORDER BY 1").fetchall()
            ruins = [p for p in pops if p[2] != p[3] or abs(p[1] - p[2]) > 1e-6 * p[2]]
            if ruins:
                raise RuntimeError(f"{destino.name}: soma de {peso} diferente de {proj}: {ruins}")
            tmp.replace(destino)
            log(f"{destino.name}: {n} linhas, {tab.num_columns} colunas, {destino.stat().st_size / 1e6:.2f} MB, "
                f"soma de {peso} = {proj} em {len(pops)} período(s) ({pops[0][1]:,.0f})")
            del tab


# ----------------------------------------------------------------------------- deflatores

def xls_linhas(caminho: Path):
    import xlrd
    b = xlrd.open_workbook(str(caminho), logfile=open("/dev/null", "w"))
    s = b.sheet_by_index(0)
    return [[c.value for c in s.row(r)] for r in range(s.nrows)]


def cmd_deflatores(a_):
    cat = catalogo()
    z = doc_local("deflatores", cat["docs"]["deflatores"])
    membros = subprocess.run(["bsdtar", "-tf", str(z)], check=True, capture_output=True, text=True).stdout.split()
    xls = [m for m in membros if m.lower().endswith(".xls")]
    pasta = a.brutos / "doc" / "geral" / "deflatores"
    pasta.mkdir(parents=True, exist_ok=True)
    subprocess.run(["bsdtar", "-xf", str(z), "-C", str(pasta), xls[0]], check=True)
    linhas = xls_linhas(pasta / xls[0])
    cab = [str(c).strip() for c in linhas[0]]
    assert cab == ["Ano", "trim", "UF", "Habitual", "Efetivo"], cab
    trim_cal = {"01-02-03": 1, "04-05-06": 2, "07-08-09": 3, "10-11-12": 4}
    reg = [dict(zip(cab, l)) for l in linhas[1:] if str(l[2]).strip().split(".")[0] == "33"]
    tab = pa.table({
        "Ano": pa.array([int(float(r["Ano"])) for r in reg], pa.uint16()),
        "trim": pa.array([str(r["trim"]).strip() for r in reg], pa.string()),
        "Trimestre": pa.array([trim_cal.get(str(r["trim"]).strip()) for r in reg], pa.uint8()),
        "UF": pa.array([33] * len(reg), pa.uint8()),
        "Habitual": pa.array([float(r["Habitual"]) for r in reg], pa.float64()),
        "Efetivo": pa.array([float(r["Efetivo"]) for r in reg], pa.float64()),
    })
    destino = SITE / "dados" / "pnad" / "deflatores.zip"
    destino.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(tab, destino, compression="zstd", compression_level=19, row_group_size=max(tab.num_rows, 1))
    log(f"deflatores.zip: {tab.num_rows} linhas (UF 33, {xls[0]}), {destino.stat().st_size / 1e3:.1f} KB")
    # deflator da visita anual (Documentacao_Geral): CO1/CO1e/CO2/CO2e/CO3 por ano, trimestre e UF
    info = cat["docs"]["deflator_visita"]
    xv = baixar(info["url"], a.brutos / "doc" / "geral" / info["nome"])
    linhas = xls_linhas(xv)
    cab = [str(c).strip() for c in linhas[0]]
    reg = [dict(zip(cab, l)) for l in linhas[1:] if l and str(l[2]).strip().split(".")[0] == "33"]
    colunas = {"Ano": pa.array([int(float(r["ano"])) for r in reg], pa.uint16()),
               "Trimestre": pa.array([int(float(r["trim"])) for r in reg], pa.uint8()),
               "UF": pa.array([33] * len(reg), pa.uint8())}
    for c in cab[3:]:
        colunas[c] = pa.array([float(r[c]) if r[c] != "" else None for r in reg], pa.float64())
    tab = pa.table(colunas)
    destino = SITE / "dados" / "pnad" / "deflatores_visita.zip"
    pq.write_table(tab, destino, compression="zstd", compression_level=19, row_group_size=max(tab.num_rows, 1))
    log(f"deflatores_visita.zip: {tab.num_rows} linhas (UF 33, {info['nome']}), colunas {cab[3:]}, "
        f"{destino.stat().st_size / 1e3:.1f} KB")


# ----------------------------------------------------------------------------- dicionários

def norm_codigo(v) -> str:
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else str(v)
    s = str(v).strip()
    return str(int(s)) if re.fullmatch(r"\d+", s) else s


def limpa(s) -> str:
    if isinstance(s, float):
        s = str(int(s)) if s == int(s) else str(s)
    return re.sub(r"\s+", " ", str(s)).strip()


def parse_dicionario_xls(caminho: Path) -> dict:
    """Lê o dicionário do IBGE: uma linha por variável e as linhas seguintes com as categorias."""
    out, atual, parte = {}, None, ""
    for l in xls_linhas(caminho)[3:]:
        l = (l + [""] * 8)[:8]
        pos, tam, cod, quesito, desc, cat_tipo, cat_desc, periodo = l
        codigo = limpa(cod)
        if codigo == "" and limpa(tam) == "" and limpa(pos).startswith("Parte"):
            parte = limpa(pos)
            continue
        if codigo and limpa(tam):
            atual = {"descricao": limpa(desc), "quesito": limpa(quesito), "periodo": limpa(periodo), "parte": parte,
                     "categorias": {}, "valores": [], "nulo": None}
            out[codigo] = atual
        if atual is None:
            continue
        ct, cd = cat_tipo, limpa(cat_desc)
        if isinstance(ct, float) or re.fullmatch(r"\s*\d+\s*", str(ct)):
            atual["categorias"][norm_codigo(ct)] = cd
        elif limpa(ct) != "":
            atual["valores"].append(f"{limpa(ct)}: {cd}" if cd else limpa(ct))
        elif cd:
            if re.search(r"n[ãa]o aplic|branco", cd, re.I):
                atual["nulo"] = cd
            else:
                atual["valores"].append(cd)
    return out


def cmd_dicionarios(a_):
    cat = catalogo()
    tipos_info = ler_json(ARQ_TIPOS, {})
    tipos, anos_var = tipos_info["tipos"], tipos_info["anos"]
    hoje = dt.date.today().isoformat()
    classif = {"V4010": "dados/dic/cod_pnad.json", "V4041": "dados/dic/cod_pnad.json",
               "V4013": "dados/dic/cnae_domiciliar.json", "V4044": "dados/dic/cnae_domiciliar.json"}
    for tabela, cfg in TABELAS.items():
        anos = anos_disponiveis(tabela)
        if not anos:
            continue
        if tabela == "trimestral":
            z = doc_local("dicionario_trimestral", cat["docs"]["dicionario_trimestral"])
            pasta = a.brutos / "doc" / "trimestral" / "xls"
            pasta.mkdir(parents=True, exist_ok=True)
            membros = subprocess.run(["bsdtar", "-tf", str(z)], check=True, capture_output=True, text=True).stdout.split()
            xls = [m for m in membros if m.lower().endswith(".xls")][0]
            subprocess.run(["bsdtar", "-xf", str(z), "-C", str(pasta), xls], check=True)
            por_ano = {ano: (parse_dicionario_xls(pasta / xls), layout_de(tabela, ano)) for ano in [anos[-1]]}
            fontes = [cat["docs"]["dicionario_trimestral"]["nome"]]
        else:
            por_ano, fontes = {}, []
            for ano in anos:
                info = cat["docs"][tabela][str(ano)]["dicionario"]
                x = baixar(info["url"], a.brutos / "doc" / tabela / info["nome"])
                por_ano[ano] = (parse_dicionario_xls(x), layout_de(tabela, ano))
                fontes.append(info["nome"])
        variaveis = {}
        for ano in sorted(por_ano):
            dic, layout = por_ano[ano]
            for c in layout:
                nome = c["nome"]
                if REPLICA.fullmatch(nome):
                    continue
                d = dic.get(nome, {})
                v = variaveis.setdefault(nome, {"descricao": "", "tipo": tipos[nome], "anos": [], "categorias": {},
                                                "_cats_ano": {}})
                v["descricao"] = d.get("descricao") or c["rotulo"] or v["descricao"]
                for k in ("quesito", "periodo", "parte", "nulo"):
                    if d.get(k):
                        v[k] = d[k]
                if d.get("valores"):
                    v["valores"] = d["valores"]
                if d.get("categorias"):
                    v["categorias"].update(d["categorias"])
                    v["_cats_ano"][ano] = d["categorias"]
                if nome in classif:
                    v["classificacao"] = classif[nome]
        for nome, v in variaveis.items():
            v["anos"] = anos_var.get(tabela, {}).get(nome, [])
            cats = v.pop("_cats_ano")
            distintas = {json.dumps(c, sort_keys=True) for c in cats.values()}
            if len(distintas) > 1:
                v["categorias_por_ano"] = {str(k): c for k, c in sorted(cats.items())}
            if not v["categorias"]:
                del v["categorias"]
        destino = SITE / "dados" / "dic" / f"{cfg['nome']}.json"
        gravar_json(destino, {"tabela": cfg["nome"], "titulo": cfg["titulo"], "fonte": "IBGE, PNAD Contínua",
                              "arquivos_ibge": fontes, "gerado_em": hoje,
                              "nota": "Códigos das categorias como inteiros, iguais aos valores do Parquet (sem zeros à "
                                      "esquerda). 'nulo' diz o que significa o valor vazio (NULL). 'anos' são os anos "
                                      "com algum valor não nulo no Rio. Pesos replicados (V10 + 5 dígitos) não estão "
                                      "nos arquivos.",
                              "variaveis": variaveis}, compacto=True)
        log(f"{destino.name}: {len(variaveis)} variáveis, {destino.stat().st_size / 1e3:.0f} KB")
    cmd_classificacoes(cat, hoje)


def cmd_classificacoes(cat, hoje):
    # COD: Grande Grupo | Subgrupo principal | Subgrupo | Grupo de base | Denominação
    x = doc_local("cod", cat["docs"]["cod"])
    niveis_cod = ["grande_grupo", "subgrupo_principal", "subgrupo", "grupo_base"]
    larg_cod = [1, 2, 3, 4]
    estr = {n: {} for n in niveis_cod}
    hier, folhas, pais = {}, {}, [None] * 4
    for l in xls_linhas(x)[3:]:
        for i, n in enumerate(niveis_cod):
            if limpa(l[i]) != "":
                cod = limpa(l[i]).zfill(larg_cod[i])
                estr[n][cod] = limpa(l[4])
                pais[i] = cod
                for j in range(i + 1, 4):
                    pais[j] = None
                if n == "grupo_base":
                    folhas[str(int(cod))] = limpa(l[4])
                    hier[str(int(cod))] = {"codigo": cod, "subgrupo": pais[2], "subgrupo_principal": pais[1],
                                           "grande_grupo": pais[0]}
                break
    # V4010 = 0000 não está na estrutura do COD; o IBGE o define em Grupamentos_ocupacionais_atividades_PNADC.pdf
    folhas["0"] = "Ocupações maldefinidas"
    hier["0"] = {"codigo": "0000", "subgrupo": None, "subgrupo_principal": None, "grande_grupo": None}
    gravar_json(SITE / "dados" / "dic" / "cod_pnad.json", {
        "titulo": "Classificação de Ocupações para Pesquisas Domiciliares (COD)", "fonte": "IBGE",
        "arquivo_ibge": cat["docs"]["cod"]["nome"], "gerado_em": hoje, "variaveis": ["V4010", "V4041"],
        "nota": "'categorias' é o grupo de base (4 dígitos), com a chave como inteiro igual ao Parquet "
                "(0110 vira 110). 'niveis' traz os níveis acima com o código original, e 'hierarquia' liga cada "
                "grupo de base aos níveis acima. Os grupamentos ocupacionais de divulgação do IBGE são os grandes "
                "grupos, mais 'Ocupações maldefinidas' (V4010 = 0000, chave 0), conforme "
                "Grupamentos_ocupacionais_atividades_PNADC.pdf.",
        "categorias": folhas, "hierarquia": hier, "niveis": estr}, compacto=True)
    log(f"cod_pnad.json: {len(folhas)} grupos de base; {[len(v) for v in estr.values()]} por nível")
    # CNAE Domiciliar 2.0: Seção | Divisão | Classe | Denominação
    x = doc_local("cnae", cat["docs"]["cnae"])
    niveis_cn = ["secao", "divisao", "classe"]
    larg_cn = [1, 2, 5]
    estr = {n: {} for n in niveis_cn}
    hier, folhas, pais = {}, {}, [None] * 3
    for l in xls_linhas(x)[3:]:
        for i, n in enumerate(niveis_cn):
            if limpa(l[i]) != "":
                cod = limpa(l[i])
                cod = cod.zfill(larg_cn[i]) if cod.isdigit() else cod
                estr[n][cod] = limpa(l[3])
                pais[i] = cod
                for j in range(i + 1, 3):
                    pais[j] = None
                if n == "classe":
                    folhas[str(int(cod))] = limpa(l[3])
                    hier[str(int(cod))] = {"codigo": cod, "divisao": pais[1], "secao": pais[0]}
                break
    # grupamentos de atividade de divulgação (Grupamentos_ocupacionais_atividades_PNADC.pdf, por seção)
    grupamentos = {"A": "Agricultura, pecuária, produção florestal, pesca e aquicultura",
                   "B,C,D,E": "Indústria geral", "F": "Construção",
                   "G": "Comércio; reparação de veículos automotores e motocicletas",
                   "H": "Transporte, armazenagem e correio", "I": "Alojamento e alimentação",
                   "J,K,L,M,N": "Informação, comunicação e atividades financeiras, imobiliárias, profissionais e "
                                "administrativas",
                   "O,P,Q": "Administração pública, defesa e seguridade social, educação, saúde humana e serviços "
                            "sociais",
                   "T": "Serviços domésticos", "R,S,U": "Outros serviços", "V": "Atividades maldefinidas"}
    secao_grup = {s: k for k in grupamentos for s in k.split(",")}
    estr["grupamento"] = grupamentos
    for h in hier.values():
        h["grupamento"] = secao_grup.get(h["secao"])
    gravar_json(SITE / "dados" / "dic" / "cnae_domiciliar.json", {
        "titulo": "CNAE Domiciliar 2.0", "fonte": "IBGE", "arquivo_ibge": cat["docs"]["cnae"]["nome"],
        "gerado_em": hoje, "variaveis": ["V4013", "V4044"],
        "nota": "'categorias' é a classe (5 dígitos), com a chave como inteiro igual ao Parquet (01101 vira 1101). "
                "'niveis' traz seção e divisão com o código original e os grupamentos de atividade de divulgação do "
                "IBGE (Grupamentos_ocupacionais_atividades_PNADC.pdf, chave = seções); 'hierarquia' liga cada "
                "classe a eles.",
        "categorias": folhas, "hierarquia": hier, "niveis": estr}, compacto=True)
    log(f"cnae_domiciliar.json: {len(folhas)} classes; {[len(v) for v in estr.values()]} por nível")


# ----------------------------------------------------------------------------- manifest e validação

def cmd_manifest(a_):
    import duckdb
    con = duckdb.connect()
    tabs = {}
    for tabela, cfg in TABELAS.items():
        arquivos = []
        for ano in anos_disponiveis(tabela):
            f = destino_parquet(tabela, ano)
            if not f.exists():
                continue
            n, = con.execute(f"SELECT count(*) FROM read_parquet('{f}')").fetchone()
            item = {"ano": ano, "url": str(f.relative_to(SITE)), "bytes": f.stat().st_size, "linhas": n}
            if tabela == "trimestral":
                item["trimestres"] = [t for (t,) in con.execute(
                    f"SELECT DISTINCT Trimestre FROM read_parquet('{f}') ORDER BY 1").fetchall()]
            arquivos.append(item)
        if arquivos:
            tabs[cfg["nome"]] = {"titulo": cfg["titulo"], "fonte": "IBGE", "peso": cfg["peso"], "estrato": "Estrato",
                                 "upa": "UPA", "periodo": cfg["periodo"],
                                 "dicionario": f"dados/dic/{cfg['nome']}.json", "arquivos": arquivos}
    for nome, arq, titulo, periodo, nota in [
        ("pnad_deflatores", "deflatores.zip", "Deflatores da PNAD Contínua trimestral (UF 33)", ["Ano", "Trimestre"],
         "Habitual e Efetivo por trimestre móvel ('trim'); 'Trimestre' preenchido só nos trimestres civis. "
         "Rendimento real = rendimento x deflator (preços do último trimestre do arquivo do IBGE). Junte por Ano, "
         "Trimestre e UF."),
        ("pnad_deflatores_visita", "deflatores_visita.zip", "Deflatores da PNAD Contínua anual por visita (UF 33)",
         ["Ano", "Trimestre"],
         "Conforme deflacionamento_PNADC_anual_visita.txt do IBGE: CO1 (rendimento habitual) e CO1e (efetivo) "
         "levam a preços médios do próprio ano; CO2 (habitual) e CO2e (efetivo), a preços médios do último ano do "
         "arquivo; CO3, a preços médios do último ano, para a linha de US$ 1,90 do ODS 1.1.1. Rendimento real = "
         "rendimento x deflator. Junte por Ano, Trimestre e UF.")]:
        f = SITE / "dados" / "pnad" / arq
        if f.exists():
            n, = con.execute(f"SELECT count(*) FROM read_parquet('{f}')").fetchone()
            tabs[nome] = {"titulo": titulo, "fonte": "IBGE", "peso": None, "estrato": None, "upa": None,
                          "periodo": periodo, "dicionario": None, "nota": nota,
                          "arquivos": [{"ano": None, "url": f"dados/pnad/{arq}", "bytes": f.stat().st_size, "linhas": n}]}
    destino = SITE / "dados" / "manifest_pnad.json"
    gravar_json(destino, {"gerado_em": dt.date.today().isoformat(), "macros": "sql/estimacao_pnad.sql",
                          "tabelas": tabs})
    log(f"manifest_pnad.json: {[(k, len(v['arquivos'])) for k, v in tabs.items()]}")


def cmd_validar(a_):
    import duckdb
    con = duckdb.connect()
    con.execute("SET threads=2; SET memory_limit='2GB'")
    tipos = ler_json(ARQ_TIPOS, {})["tipos"]
    for tabela, cfg in TABELAS.items():
        arqs = [str(destino_parquet(tabela, ano)) for ano in anos_disponiveis(tabela)
                if destino_parquet(tabela, ano).exists()]
        if not arqs:
            continue
        for f in arqs:
            for col, tipo in con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('{f}'))").fetchall():
                if tipo != tipos[col]:
                    raise RuntimeError(f"{f}: {col} {tipo} != {tipos[col]}")
        lista = "[" + ",".join(f"'{f}'" for f in arqs) + "]"
        n, ncol = con.execute(f"SELECT count(*), (SELECT count(*) FROM (DESCRIBE SELECT * FROM read_parquet({lista}, union_by_name=true))) "
                              f"FROM read_parquet({lista}, union_by_name=true)").fetchone()
        soma = con.execute(f"SELECT sum({cfg['peso']}) FROM read_parquet({lista}, union_by_name=true)").fetchone()[0]
        log(f"validar {cfg['nome']}: {len(arqs)} arquivos, {n} linhas, {ncol} colunas, union_by_name ok, "
            f"soma dos pesos {soma:,.0f}")


def main():
    global a
    p = argparse.ArgumentParser()
    p.add_argument("etapa", choices=["catalogo", "extrair", "tipos", "parquet", "deflatores", "dicionarios",
                                     "manifest", "validar", "tudo"])
    p.add_argument("--brutos", type=Path, default=RAIZ / "brutos" / "pnad")
    p.add_argument("--tabela", choices=list(TABELAS))
    p.add_argument("--ano", type=int)
    a = p.parse_args()
    a.brutos = a.brutos.resolve()
    if a.brutos == PIPE or PIPE in a.brutos.parents:
        raise SystemExit("os brutos não podem ficar dentro da pasta do pipeline")
    etapas = {"catalogo": cmd_catalogo, "extrair": cmd_extrair, "tipos": cmd_tipos, "parquet": cmd_parquet,
              "deflatores": cmd_deflatores, "dicionarios": cmd_dicionarios, "manifest": cmd_manifest,
              "validar": cmd_validar}
    if a.etapa == "tudo":
        for e in ["catalogo", "extrair", "tipos", "parquet", "deflatores", "dicionarios", "manifest", "validar"]:
            etapas[e](a)
    else:
        etapas[a.etapa](a)


a = None
if __name__ == "__main__":
    sys.exit(main())
