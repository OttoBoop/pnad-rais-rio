// Motor: DuckDB-WASM 1.32.0 (jsDelivr) com o contorno de leitura parcial, medidor de bytes e views sob demanda.
import { absoluta } from './catalogo.js';
import { strSQL, faixasAnos } from './util.js';

export const VERSAO_DUCKDB_WASM = '1.32.0';
const URL_DUCKDB = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${VERSAO_DUCKDB_WASM}/+esm`;
const SQL_ESTIMACAO = 'sql/estimacao_pnad.sql';

// O worker do DuckDB lê os arquivos por XMLHttpRequest síncrono. Este código roda antes do worker oficial,
// substitui XMLHttpRequest e fetch no escopo do worker e manda cada resposta (URL, status, bytes) por BroadcastChannel.
function codigoWorker(canal, mainWorker) {
  return `
const canal = new BroadcastChannel(${JSON.stringify(canal)});
const X0 = self.XMLHttpRequest;
function tam(x) { try { const r = x.response; if (!r) return 0; if (typeof r === 'string') return r.length; return r.byteLength ?? r.size ?? 0; } catch (e) { return 0; } }
function rel(x) { canal.postMessage({ tipo: 'rede', via: 'xhr', url: x.__u, final: x.responseURL || '', metodo: x.__m, status: x.status, bytes: tam(x) }); }
self.XMLHttpRequest = class extends X0 {
  open(m, u, a, ...r) { this.__m = String(m).toUpperCase(); this.__u = String(u); this.__a = a !== false; return arguments.length < 3 ? super.open(m, u) : super.open(m, u, a, ...r); }
  send(b) { if (this.__a) this.addEventListener('loadend', () => rel(this), { once: true }); try { return super.send(b); } finally { if (!this.__a) rel(this); } }
};
const F0 = self.fetch.bind(self);
self.fetch = async (rec, init) => {
  const r = await F0(rec, init);
  const u = typeof rec === 'string' ? rec : (rec && rec.url) || String(rec);
  canal.postMessage({ tipo: 'rede', via: 'fetch', url: u, final: r.url, metodo: (init && init.method) || 'GET', status: r.status, bytes: Number(r.headers.get('content-length')) || 0 });
  return r;
};
canal.onmessage = e => { if (e.data && e.data.tipo === 'ping') canal.postMessage({ tipo: 'pong', id: e.data.id }); };
importScripts(${JSON.stringify(mainWorker)});
`;
}

function ehMotor(url) {
  return /extensions\.duckdb\.org|cdn\.jsdelivr\.net/.test(url || '');
}

class Medidor {
  constructor() {
    this.nome = 'pnad-rais-rio-medidor-' + Math.random().toString(36).slice(2);
    this.canal = new BroadcastChannel(this.nome);
    this.sessao = { dados: { req: 0, bytes: 0 }, motor: { req: 0, bytes: 0 } };
    this.log = [];
    this.seq = 0;
    this.pendentes = new Map();
    this.canal.onmessage = e => {
      const d = e.data || {};
      if (d.tipo === 'rede') {
        const classe = ehMotor(d.url) ? 'motor' : 'dados';
        this.sessao[classe].req += 1;
        this.sessao[classe].bytes += d.bytes || 0;
        this.seq += 1;
        this.log.push({ ...d, classe, seq: this.seq, t: performance.now() });
        if (this.log.length > 5000) this.log.splice(0, 1000);
      } else if (d.tipo === 'pong') {
        const f = this.pendentes.get(d.id);
        if (f) { this.pendentes.delete(d.id); f(); }
      }
    };
  }
  // Espera o worker esvaziar a fila de mensagens: o pong chega depois de todos os relatos anteriores.
  sincronizar() {
    return new Promise(res => {
      const id = Math.random().toString(36).slice(2);
      const t = setTimeout(() => { this.pendentes.delete(id); res(); }, 1500);
      this.pendentes.set(id, () => { clearTimeout(t); res(); });
      this.canal.postMessage({ tipo: 'ping', id });
    });
  }
  marca() {
    return { dados: { ...this.sessao.dados }, motor: { ...this.sessao.motor }, seq: this.seq };
  }
  diferenca(m) {
    const requisicoes = this.log.filter(r => r.seq > m.seq);
    const porHost = {};
    for (const r of requisicoes) {
      let h = '';
      try { h = new URL(r.url).host; } catch { h = r.url; }
      const x = porHost[h] || (porHost[h] = { req: 0, bytes: 0, classe: r.classe });
      x.req += 1; x.bytes += r.bytes || 0;
    }
    return {
      dados: { req: this.sessao.dados.req - m.dados.req, bytes: this.sessao.dados.bytes - m.dados.bytes },
      motor: { req: this.sessao.motor.req - m.motor.req, bytes: this.sessao.motor.bytes - m.motor.bytes },
      porHost, requisicoes,
    };
  }
}

// Converte um resultado Arrow em {colunas, tipos, linhas}.
function converter(tabela) {
  const campos = tabela.schema.fields;
  const colunas = campos.map(f => f.name);
  const tipos = campos.map(f => String(f.type));
  const n = tabela.numRows;
  const linhas = new Array(n);
  for (let i = 0; i < n; i++) linhas[i] = {};
  campos.forEach((f, j) => {
    const vet = tabela.getChildAt(j);
    const tipo = tipos[j];
    const ehData = /^Date|^Timestamp/.test(tipo);
    const escala = /^Decimal/.test(tipo) ? (f.type.scale || 0) : null;
    for (let i = 0; i < n; i++) {
      let v = vet.get(i);
      if (v === null || v === undefined) { linhas[i][f.name] = null; continue; }
      if (typeof v === 'bigint') v = (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : v.toString();
      else if (escala !== null && v instanceof Uint32Array) {
        let b = 0n;
        for (let k = v.length - 1; k >= 0; k--) b = (b << 32n) + BigInt(v[k]);
        if (v[v.length - 1] & 0x80000000) b -= 1n << BigInt(32 * v.length);
        v = Number(b) / 10 ** escala;
      } else if (ehData && typeof v === 'number') v = new Date(v);
      else if (typeof v === 'object' && !(v instanceof Date)) {
        v = typeof v.toJSON === 'function' ? v.toJSON() : (typeof v.toArray === 'function' ? Array.from(v.toArray()) : v);
        v = JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'bigint' ? Number(x) : x));
      }
      linhas[i][f.name] = v;
    }
  });
  return { colunas, tipos, linhas };
}

export class Motor {
  constructor(catalogo) {
    this.cat = catalogo;
    this.medidor = new Medidor();
    this.fila = Promise.resolve();
    this.objetos = new Map(); // nome (minúsculo) -> {nome, sql, deps, criado, tipo, descricao}
    this.ouvintes = { estado: new Set(), consulta: new Set() };
    this.estado = 'parado';
    this.macrosEstimacao = [];
    this.textoEstimacao = '';
    this.versao = null;
  }

  on(evento, f) { this.ouvintes[evento].add(f); return () => this.ouvintes[evento].delete(f); }
  emitir(evento, x) { for (const f of this.ouvintes[evento]) { try { f(x); } catch (e) { console.error(e); } } }
  definirEstado(estado, detalhe = '') { this.estado = estado; this.detalhe = detalhe; this.emitir('estado', { estado, detalhe }); }

  async iniciar() {
    if (this.pronto) return this.pronto;
    this.pronto = this._iniciar().catch(e => { this.definirEstado('erro', String(e.message || e)); throw e; });
    return this.pronto;
  }

  async _iniciar() {
    this.definirEstado('carregando', 'baixando o DuckDB-WASM');
    const duckdb = await import(URL_DUCKDB);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const url = URL.createObjectURL(new Blob([codigoWorker(this.medidor.nome, bundle.mainWorker)], { type: 'text/javascript' }));
    const worker = new Worker(url);
    this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(url);
    await this.db.open({ path: ':memory:', query: { castBigIntToDouble: true, castDecimalToDouble: true } });
    this.conn = await this.db.connect();
    this.definirEstado('carregando', 'carregando a extensão httpfs');
    // Contorno obrigatório na 1.32: sem ele o DuckDB-WASM baixa o arquivo inteiro.
    await this.conn.query('SET builtin_httpfs=false');
    await this.conn.query('LOAD httpfs');
    await this.conn.query('SET enable_http_metadata_cache=true');
    this.versao = (await this.conn.query('SELECT version() AS v')).toArray()[0].v;
    this.definirEstado('carregando', 'registrando tabelas e dicionários');
    await this._registrar();
    this.definirEstado('pronto', `DuckDB ${this.versao} (WASM ${VERSAO_DUCKDB_WASM})`);
  }

  async _registrar() {
    const linhasCatalogo = [];
    for (const t of Object.values(this.cat.tabelas)) {
      const urls = t.arquivos.map(a => a.url);
      if (!urls.length) continue;
      const fonte = urls.length === 1 ? `read_parquet(${strSQL(urls[0])})`
        : `read_parquet([${urls.map(strSQL).join(', ')}], union_by_name=true)`;
      this.objetos.set(t.chave.toLowerCase(), {
        nome: t.chave, tipo: 'view', deps: [], criado: false,
        sql: `CREATE OR REPLACE VIEW ${t.chave} AS SELECT * FROM ${fonte}`,
      });
      linhasCatalogo.push([t.chave, 'view', `${t.titulo || t.chave}. Todos os arquivos; abre ${urls.length} arquivo(s) na primeira consulta.`, faixasAnos(t.anos), urls.length, t.linhas || null, t.bytes ? t.bytes / 1048576 : null]);
      const comAno = t.arquivos.filter(a => a.ano !== null);
      if (comAno.length === urls.length) {
        const nome = `${t.chave}_periodo`;
        await this.conn.query(`CREATE OR REPLACE MACRO ${nome}(a0, a1) AS TABLE SELECT * FROM read_parquet(list_where([${comAno.map(a => strSQL(a.url)).join(', ')}], list_transform([${comAno.map(a => a.ano).join(', ')}], lambda y: y BETWEEN a0 AND a1)), union_by_name=true)`);
        t.macroPeriodo = nome;
        linhasCatalogo.push([`${nome}(ano_inicial, ano_final)`, 'macro de tabela', `${t.titulo || t.chave}, só os arquivos dos anos pedidos (não abre os outros).`, faixasAnos(t.anos), urls.length, null, null]);
      }
    }

    // Macros de estimação da PNAD: o arquivo é executado na primeira vez que uma consulta usa um dos macros.
    try {
      const r = await fetch(SQL_ESTIMACAO, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this.textoEstimacao = await r.text();
      const semComentarios = this.textoEstimacao.replace(/--[^\n]*/g, '');
      this.macrosEstimacao = [...semComentarios.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+)?MACRO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gi)]
        .map(m => ({ nome: m[1], parametros: m[2].split(',').map(s => s.trim()).filter(Boolean) }));
      const deps = [...this.objetos.keys()].filter(n => new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, 'i').test(semComentarios));
      const script = { nome: SQL_ESTIMACAO, tipo: 'script', deps, criado: false, sql: this.textoEstimacao };
      for (const m of this.macrosEstimacao) {
        this.objetos.set(m.nome.toLowerCase(), script);
        linhasCatalogo.push([`${m.nome}(${m.parametros.join(', ')})`, 'macro de estimação', `Definido em ${SQL_ESTIMACAO}; usa ${deps.join(', ') || '—'}.`, null, null, null, null]);
      }
    } catch (e) {
      this.erroEstimacao = String(e.message || e);
    }

    await this._criarDicionarios(linhasCatalogo);
    this.regexObjetos = this.objetos.size
      ? new RegExp(`(?<![A-Za-z0-9_])(${[...this.objetos.keys()].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_])`, 'gi')
      : null;
  }

  async _criarDicionarios(linhasCatalogo) {
    await this.conn.query(`CREATE OR REPLACE TABLE dic_variaveis (tabela VARCHAR, variavel VARCHAR, descricao VARCHAR, tipo VARCHAR, anos INTEGER[], n_categorias INTEGER, categorias_em VARCHAR)`);
    await this.conn.query(`CREATE OR REPLACE TABLE dic_categorias (tabela VARCHAR, variavel VARCHAR, codigo VARCHAR, codigo_num BIGINT, rotulo VARCHAR)`);
    await this.conn.query(`CREATE OR REPLACE TABLE catalogo (objeto VARCHAR, tipo VARCHAR, descricao VARCHAR, anos VARCHAR, arquivos INTEGER, linhas BIGINT, mb DOUBLE)`);
    const vars = [], cats = [];
    const vistos = new Set();
    const codNum = c => (/^-?\d+$/.test(c) && Math.abs(Number(c)) < Number.MAX_SAFE_INTEGER ? String(Number(c)) : 'NULL');
    const addCat = (tabela, variavel, cod, rot) => {
      const k = `${tabela}|${variavel}|${codNum(cod) === 'NULL' ? cod : codNum(cod)}`;
      if (vistos.has(k)) return;
      vistos.add(k);
      cats.push(`(${strSQL(tabela)}, ${strSQL(variavel)}, ${strSQL(cod)}, ${codNum(cod)}, ${strSQL(rot)})`);
    };
    for (const [tabela, vs] of Object.entries(this.cat.dic)) {
      for (const [nome, v] of Object.entries(vs)) {
        const anos = Array.isArray(v.anos) ? `[${v.anos.map(Number).filter(Number.isFinite).join(',')}]` : 'NULL';
        const c = v.categorias || {};
        vars.push(`(${strSQL(tabela)}, ${strSQL(nome)}, ${strSQL(v.descricao || '')}, ${strSQL(v.tipo || '')}, ${anos}, ${Object.keys(c).length}, ${v.classificacao ? strSQL(v.classificacao) : 'NULL'})`);
        for (const [cod, rot] of Object.entries(c)) addCat(tabela, nome, cod, rot);
        // Variável ligada a uma classificação: os rótulos da folha (CBO, CNAE, COD, bairros) também ficam
        // sob a própria variável; os códigos especiais do dicionário da tabela, inseridos antes, prevalecem.
        const cl = v.classificacao && this.cat.classificacoes[v.classificacao];
        const folha = cl && v.nivelClassificacao ? cl.niveis[v.nivelClassificacao] : null;
        if (folha) for (const [cod, rot] of Object.entries(folha)) addCat(tabela, nome, cod, rot);
      }
    }
    for (const [nome, cl] of Object.entries(this.cat.classificacoes)) {
      for (const [nivel, mapa] of Object.entries(cl.niveis || {})) {
        for (const [cod, rot] of Object.entries(mapa)) addCat(nome, nivel, cod, rot);
      }
    }
    const inserir = async (tabela, valores) => {
      for (let i = 0; i < valores.length; i += 800) await this.conn.query(`INSERT INTO ${tabela} VALUES ${valores.slice(i, i + 800).join(',\n')}`);
    };
    await inserir('dic_variaveis', vars);
    await inserir('dic_categorias', cats);
    linhasCatalogo.push(['dic_variaveis', 'tabela', 'Dicionário: uma linha por variável de cada tabela (descrição, tipo, anos).', null, null, vars.length, null]);
    linhasCatalogo.push(['dic_categorias', 'tabela', 'Rótulos das categorias (tabela, variavel, codigo, codigo_num, rotulo), inclusive CBO, CNAE e bairros quando publicados.', null, null, cats.length, null]);
    linhasCatalogo.push(['catalogo', 'tabela', 'Esta lista.', null, null, null, null]);
    await inserir('catalogo', linhasCatalogo.map(l => `(${l.map(x => x === null || x === undefined ? 'NULL' : (typeof x === 'number' ? String(x) : strSQL(x))).join(', ')})`));
  }

  // Cria, na ordem certa, as views e scripts que o texto da consulta menciona e que ainda não existem.
  async _garantir(sql) {
    if (!this.regexObjetos) return [];
    const criados = [];
    const visitar = async obj => {
      if (obj.criado) return;
      for (const d of obj.deps) await visitar(this.objetos.get(d));
      if (obj.criado) return;
      await this.conn.query(obj.sql);
      obj.criado = true;
      criados.push(obj.nome);
    };
    const nomes = new Set([...sql.matchAll(this.regexObjetos)].map(m => m[1].toLowerCase()));
    for (const n of nomes) await visitar(this.objetos.get(n));
    return criados;
  }

  // Executa uma consulta (fila única, para o medidor atribuir os bytes à consulta certa).
  consultar(sql, opcoes = {}) {
    const tarefa = this.fila.then(() => this._consultar(sql, opcoes));
    this.fila = tarefa.catch(() => {});
    return tarefa;
  }

  async _consultar(sql, { origem = 'sql', silencioso = false } = {}) {
    await this.iniciar();
    await this.medidor.sincronizar();
    const m = this.medidor.marca();
    const t0 = performance.now();
    let resultado, erro, criados = [];
    try {
      criados = await this._garantir(sql);
      resultado = converter(await this.conn.query(sql));
    } catch (e) {
      erro = e;
    }
    const ms = performance.now() - t0;
    await this.medidor.sincronizar();
    const rede = this.medidor.diferenca(m);
    const stats = { ms, origem, criados, ...rede, sessao: { dados: { ...this.medidor.sessao.dados }, motor: { ...this.medidor.sessao.motor } }, erro: erro ? String(erro.message || erro) : null };
    if (!silencioso) this.emitir('consulta', stats);
    if (erro) { erro.stats = stats; throw erro; }
    resultado.stats = stats;
    return resultado;
  }
}
