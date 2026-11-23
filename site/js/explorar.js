// Explorar: construtor de cruzamentos. Gera um SQL legível, executa no motor e mostra tabela, gráfico e avisos.
import { el, esc, num, pct, mb, segundos, ident, literal, strSQL, paraCSV, baixarTexto, dicaErro } from './util.js';
import { dimensoes, numericas } from './dimensoes.js';
import { desenharGrafico } from './grafico.js';

export const CV_CAUTELA = 0.15;
export const CV_NAO_CONFIAVEL = 0.30;

export function avisoCV(cv) {
  if (cv === null || cv === undefined || !Number.isFinite(cv)) return { classe: 'cv-na', texto: 'CV indefinido' };
  if (cv > CV_NAO_CONFIAVEL) return { classe: 'cv-ruim', texto: 'não confiável' };
  if (cv > CV_CAUTELA) return { classe: 'cv-cautela', texto: 'use com cautela' };
  return { classe: 'cv-ok', texto: '' };
}

const TAXAS = [
  { id: 'desocupacao', rotulo: 'Taxa de desocupação', num: 'VD4002 = 2', den: 'VD4001 = 1', vars: ['VD4001', 'VD4002'],
    nota: 'desocupados / pessoas na força de trabalho' },
  { id: 'participacao', rotulo: 'Taxa de participação na força de trabalho', num: 'VD4001 = 1', den: 'V2009 >= 14', vars: ['VD4001', 'V2009'],
    nota: 'força de trabalho / pessoas de 14 anos ou mais' },
  { id: 'nivel_ocupacao', rotulo: 'Nível da ocupação', num: 'VD4002 = 1', den: 'V2009 >= 14', vars: ['VD4002', 'V2009'],
    nota: 'ocupados / pessoas de 14 anos ou mais' },
  { id: 'personalizada', rotulo: 'Razão personalizada (numerador e denominador em SQL)', vars: [] },
];

function basesExploraveis(cat) {
  return Object.values(cat.tabelas).filter(t => t.arquivos.length && cat.dic[t.chave] && Object.keys(cat.dic[t.chave]).length
    && (t.amostral || t.manifesto === 'rais'));
}

function periodos(t) {
  if (t.colTrimestre) {
    const out = [];
    for (const a of t.arquivos) {
      const tris = Array.isArray(a.trimestres) && a.trimestres.length ? a.trimestres : [1, 2, 3, 4];
      for (const q of tris) out.push({ id: `${a.ano}-${q}`, ano: a.ano, tri: Number(q), rotulo: `${a.ano}T${q}` });
    }
    return out;
  }
  return t.anos.map(a => ({ id: String(a), ano: a, rotulo: String(a) }));
}

function selectBusca(rotulo, opcoes, valor, { vazio = null, id } = {}) {
  const sel = el('select', { id });
  const busca = el('input', { type: 'search', placeholder: 'filtrar…', 'aria-label': `Filtrar ${rotulo}`, class: 'busca-opcao' });
  const preencher = () => {
    const q = busca.value.trim().toLowerCase();
    const atual = sel.value || valor;
    sel.innerHTML = '';
    if (vazio) sel.append(el('option', { value: '' }, vazio));
    for (const o of opcoes) {
      if (q && !o.rotulo.toLowerCase().includes(q) && o.id !== atual) continue;
      sel.append(el('option', { value: o.id, selected: o.id === atual }, o.rotulo));
    }
  };
  busca.addEventListener('input', preencher);
  preencher();
  if (valor !== undefined && valor !== null) sel.value = valor;
  return { wrap: el('label', { class: 'campo' }, el('span', {}, rotulo), busca, sel), sel };
}

function opcoesCategorias(dim) {
  if (!dim || !dim.categorias) return [];
  return Object.entries(dim.categorias).map(([c, r]) => ({ codigo: c, rotulo: `${c} · ${r}` }));
}

export function montarExplorar(raiz, ctx) {
  const { cat, motor } = ctx;
  const bases = basesExploraveis(cat);
  raiz.innerHTML = '';
  if (!bases.length) {
    raiz.append(el('p', { class: 'aviso' }, 'Nenhuma base com dicionário publicada nos manifestos ainda.'));
    return;
  }
  const est = { base: bases[0].chave, filtros: [] };
  const form = el('form', { class: 'painel explorar-form', id: 'ex-form' });
  const saida = el('div', { class: 'explorar-saida', id: 'ex-saida' }, el('p', { class: 'mudo' }, 'Escolha a base, a medida e o recorte, e clique em Calcular.'));
  raiz.append(form, saida);

  function render() {
    const t = cat.tabelas[est.base];
    const dims = dimensoes(cat, t.chave);
    const nums = numericas(cat, t.chave);
    const vars = cat.dic[t.chave] || {};
    const per = periodos(t);
    form.innerHTML = '';

    const selBase = el('select', { id: 'ex-base' }, bases.map(b => el('option', { value: b.chave, selected: b.chave === est.base }, b.titulo || b.chave)));
    selBase.addEventListener('change', () => { est.base = selBase.value; est.filtros = []; est.medida = null; est.linha = est.coluna = ''; render(); });
    form.append(el('label', { class: 'campo' }, el('span', {}, 'Base'), selBase));

    // Medida
    const mp = t.amostral ? macrosPNAD(motor, t) : null;
    const medidas = t.amostral
      ? [{ id: 'proporcao', rotulo: 'Proporção (distribuição da variável das linhas)', macro: 'proporcao' }, { id: 'taxa', rotulo: 'Taxa ou razão', macro: 'razao' },
        { id: 'media', rotulo: 'Média de uma variável numérica', macro: 'media' }, { id: 'total', rotulo: 'Total (pessoas ou soma de uma variável)', macro: mp.total }]
        .filter(m => m.macro && mp.tem(m.macro))
      : [{ id: 'contagem', rotulo: t.chave.includes('estab') ? 'Contagem de estabelecimentos' : 'Contagem de vínculos' }, { id: 'soma', rotulo: 'Soma' }, { id: 'media', rotulo: 'Média' }, { id: 'mediana', rotulo: 'Mediana' }];
    if (!medidas.length) {
      form.append(el('p', { class: 'aviso' }, 'Os macros de estimação desta base ainda não estão em sql/estimacao_pnad.sql. A consulta por SQL funciona.'));
      return;
    }
    if (!medidas.some(m => m.id === est.medida)) est.medida = medidas.some(m => m.id === 'taxa') && vars.VD4002 ? 'taxa' : medidas[0].id;
    const selMed = el('select', { id: 'ex-medida' }, medidas.map(m => el('option', { value: m.id, selected: m.id === est.medida }, m.rotulo)));
    selMed.addEventListener('change', () => { est.medida = selMed.value; render(); });
    form.append(el('label', { class: 'campo' }, el('span', {}, 'Medida'), selMed));

    if (t.amostral && est.medida === 'taxa') {
      const taxas = TAXAS.filter(x => x.vars.every(v => vars[v]));
      if (!taxas.some(x => x.id === est.taxa)) est.taxa = taxas[0].id;
      const selT = el('select', { id: 'ex-taxa' }, taxas.map(x => el('option', { value: x.id, selected: x.id === est.taxa }, x.rotulo)));
      selT.addEventListener('change', () => { est.taxa = selT.value; render(); });
      form.append(el('label', { class: 'campo' }, el('span', {}, 'Taxa'), selT));
      const tx = TAXAS.find(x => x.id === est.taxa);
      if (tx.id === 'personalizada') {
        const iNum = el('input', { id: 'ex-num', class: 'mono', value: est.num || 'VD4009 IN (2, 4)', spellcheck: 'false' });
        const iDen = el('input', { id: 'ex-den', class: 'mono', value: est.den || 'VD4002 = 1', spellcheck: 'false' });
        iNum.addEventListener('input', () => { est.num = iNum.value; });
        iDen.addEventListener('input', () => { est.den = iDen.value; });
        est.num = iNum.value; est.den = iDen.value;
        form.append(el('label', { class: 'campo' }, el('span', {}, 'Numerador (condição ou valor)'), iNum),
          el('label', { class: 'campo' }, el('span', {}, 'Denominador'), iDen));
      } else {
        form.append(el('p', { class: 'nota' }, `${tx.nota}: `, el('code', {}, `${tx.num}`), ' / ', el('code', {}, tx.den)));
      }
    }
    if (['media', 'soma', 'mediana', 'total'].includes(est.medida)) {
      const opY = (est.medida === 'total' ? [{ id: '1', rotulo: 'pessoas (cada pessoa vale 1)' }] : []).concat(nums.map(n => ({ id: n.nome, rotulo: `${n.nome} · ${n.descricao}` })));
      if (!opY.some(n => n.id === est.y)) est.y = est.medida === 'total' ? '1' : (nums.find(n => /^(VD4020|VD4016|vl_rem_media_nom|qtd_vinculos_ativos)$/.test(n.nome)) || nums[0] || {}).nome;
      const s = selectBusca(est.medida === 'total' ? 'Somar' : 'Variável numérica', opY, est.y, { id: 'ex-y' });
      s.sel.addEventListener('change', () => { est.y = s.sel.value; });
      form.append(s.wrap);
      if (!t.amostral) {
        const cz = el('input', { type: 'checkbox', id: 'ex-zeros', checked: est.zeros !== false });
        cz.addEventListener('change', () => { est.zeros = cz.checked; });
        form.append(el('label', { class: 'check' }, cz, ' Excluir valores nulos e zerados (vínculos sem remuneração informada)'));
      }
    }
    if (!t.amostral && t.ativo) {
      const ca = el('input', { type: 'checkbox', id: 'ex-ativos', checked: est.ativos !== false });
      ca.addEventListener('change', () => { est.ativos = ca.checked; });
      form.append(el('label', { class: 'check' }, ca, ` Só vínculos ativos em 31/12 (${t.ativo} = 1)`));
    }

    // Linhas e colunas
    const opDims = dims.map(d => ({ id: d.id, rotulo: d.rotulo }));
    if (est.linha === undefined) est.linha = '';
    if (est.medida === 'proporcao' && !est.linha) est.linha = (dims.find(d => d.id === 'V2010') || dims[0] || {}).id || '';
    const sl = selectBusca(est.medida === 'proporcao' ? 'Linhas (variável distribuída)' : 'Linhas', opDims, est.linha, { vazio: est.medida === 'proporcao' ? null : '— nenhuma (total) —', id: 'ex-linha' });
    const sc = selectBusca('Colunas', opDims, est.coluna || '', { vazio: '— nenhuma —', id: 'ex-coluna' });
    sl.sel.addEventListener('change', () => { est.linha = sl.sel.value; });
    sc.sel.addEventListener('change', () => { est.coluna = sc.sel.value; });
    form.append(el('div', { class: 'linha-campos' }, sl.wrap, sc.wrap));

    // Período
    if (!per.some(p => p.id === est.ini)) est.ini = per[per.length - 1].id;
    if (!per.some(p => p.id === est.fim)) est.fim = per[per.length - 1].id;
    const sIni = el('select', { id: 'ex-ini' }, per.map(p => el('option', { value: p.id, selected: p.id === est.ini }, p.rotulo)));
    const sFim = el('select', { id: 'ex-fim' }, per.map(p => el('option', { value: p.id, selected: p.id === est.fim }, p.rotulo)));
    sIni.addEventListener('change', () => { est.ini = sIni.value; });
    sFim.addEventListener('change', () => { est.fim = sFim.value; });
    form.append(el('div', { class: 'linha-campos' },
      el('label', { class: 'campo' }, el('span', {}, t.colTrimestre ? 'De (trimestre)' : 'De (ano)'), sIni),
      el('label', { class: 'campo' }, el('span', {}, 'Até'), sFim)));

    // Filtros
    const caixa = el('div', { class: 'filtros' });
    est.filtros.forEach((f, i) => {
      const d = dims.find(x => x.id === f.dim);
      const s = selectBusca(`Filtro ${i + 1}`, opDims, f.dim, { id: `ex-filtro-${i}` });
      s.sel.addEventListener('change', () => { f.dim = s.sel.value; f.valores = []; render(); });
      const cats = opcoesCategorias(d);
      const multi = el('select', { multiple: true, size: Math.min(6, Math.max(3, cats.length)), id: `ex-filtro-${i}-valores`, 'aria-label': 'Categorias' },
        cats.map(c => el('option', { value: c.codigo, selected: (f.valores || []).includes(c.codigo) }, c.rotulo)));
      multi.addEventListener('change', () => { f.valores = [...multi.selectedOptions].map(o => o.value); });
      const rem = el('button', { type: 'button', class: 'secundario pequeno', onclick: () => { est.filtros.splice(i, 1); render(); } }, 'remover');
      caixa.append(el('div', { class: 'filtro' }, s.wrap, cats.length ? multi : el('p', { class: 'nota' }, 'Sem lista de categorias: use o filtro em SQL.'), rem));
    });
    const add = el('button', { type: 'button', class: 'secundario pequeno', id: 'ex-add-filtro', onclick: () => { est.filtros.push({ dim: (dims[0] || {}).id, valores: [] }); render(); } }, '+ filtro');
    const livre = el('input', { id: 'ex-filtro-livre', class: 'mono', placeholder: t.amostral ? 'ex.: V2009 BETWEEN 25 AND 59' : 'ex.: idade BETWEEN 25 AND 59', value: est.livre || '', spellcheck: 'false' });
    livre.addEventListener('input', () => { est.livre = livre.value; });
    form.append(el('fieldset', { class: 'grupo' }, el('legend', {}, 'Filtros'), caixa, add,
      el('label', { class: 'campo' }, el('span', {}, 'Filtro em SQL (opcional, entra com AND)'), livre)));

    const btn = el('button', { type: 'submit', id: 'ex-calcular' }, 'Calcular');
    form.append(el('div', { class: 'acoes' }, btn));
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const t = cat.tabelas[est.base];
    const dims = dimensoes(cat, t.chave);
    const btn = form.querySelector('#ex-calcular');
    let plano = null;
    btn.disabled = true;
    saida.innerHTML = '';
    saida.append(el('p', { class: 'mudo', role: 'status' }, 'Calculando…'));
    try {
      plano = await montarSQL(cat, motor, t, dims, est);
      const r = await motor.consultar(plano.sql, { origem: 'explorar', silencioso: Boolean(plano.previa) });
      if (plano.previa) motor.emitir('consulta', juntarStats(plano.previa, r.stats));
      mostrar(saida, plano, r, ctx);
    } catch (e) {
      if (plano && plano.previa && e.stats) motor.emitir('consulta', juntarStats(plano.previa, e.stats));
      saida.innerHTML = '';
      saida.append(el('p', { class: 'erro' }, String(e.message || e) + dicaErro(e.message || e)));
      if (e.sqlGerado) saida.append(botaoVerSQL(ctx, e.sqlGerado));
    } finally {
      btn.disabled = false;
    }
  });

  render();
}

// Macros de estimação de sql/estimacao_pnad.sql: pnad_<medida>(...) na trimestral e
// pnad_anual_<medida>('pnad_visitaN', ...) nas anuais por visita.
function macrosPNAD(motor, t) {
  const nomes = new Set((motor.macrosEstimacao || []).map(m => m.nome));
  const anual = t.chave !== 'pnad_trimestral';
  const prefixo = anual ? 'pnad_anual_' : 'pnad_';
  const tem = m => nomes.has(prefixo + m);
  return {
    anual, tem,
    total: tem('total_cal') ? 'total_cal' : (tem('total') ? 'total' : null),
    chamar: (m, ...args) => `${prefixo}${m}(${[...(anual ? [strSQL(t.chave)] : []), ...args].join(', ')})`,
  };
}

// Junta as estatísticas de duas consultas (categorias + estimativas) para o medidor do cabeçalho.
function juntarStats(a, b) {
  const porHost = {};
  for (const x of [a.porHost, b.porHost]) {
    for (const [h, v] of Object.entries(x || {})) {
      const y = porHost[h] || (porHost[h] = { req: 0, bytes: 0, classe: v.classe });
      y.req += v.req; y.bytes += v.bytes;
    }
  }
  return {
    ...b, ms: a.ms + b.ms, origem: 'explorar (2 consultas)', criados: [...a.criados, ...b.criados], porHost,
    dados: { req: a.dados.req + b.dados.req, bytes: a.dados.bytes + b.dados.bytes },
    motor: { req: a.motor.req + b.motor.req, bytes: a.motor.bytes + b.motor.bytes },
    requisicoes: [...(a.requisicoes || []), ...(b.requisicoes || [])],
  };
}

function filtroPeriodo(t, est) {
  const per = periodos(t);
  let ia = per.findIndex(p => p.id === est.ini), ib = per.findIndex(p => p.id === est.fim);
  if (ia > ib) [ia, ib] = [ib, ia];
  const a = per[ia], b = per[ib];
  const A = ident(t.colAno || 'ano');
  // O filtro por ano vem primeiro e sozinho: é ele que deixa o DuckDB pular os arquivos dos outros anos.
  const partes = [`${A} BETWEEN ${a.ano} AND ${b.ano}`];
  if (t.colTrimestre) {
    const inicioDoAno = per.find(p => p.ano === a.ano).tri === a.tri;
    const fimDoAno = per.filter(p => p.ano === b.ano).slice(-1)[0].tri === b.tri;
    if (!(inicioDoAno && fimDoAno)) partes.push(`${A} * 10 + ${ident(t.colTrimestre)} BETWEEN ${a.ano * 10 + a.tri} AND ${b.ano * 10 + b.tri}`);
  }
  return { sql: partes.join(' AND '), a, b, n: ib - ia + 1 };
}

function filtrosSQL(est, dims) {
  const partes = [];
  for (const f of est.filtros) {
    const d = dims.find(x => x.id === f.dim);
    if (!d || !f.valores || !f.valores.length) continue;
    partes.push(`${d.expr} IN (${f.valores.map(v => (d.rot && !d.rot.numerico) || d.texto ? strSQL(v) : literal(v)).join(', ')})`);
  }
  if (est.livre && est.livre.trim()) partes.push(`(${est.livre.trim()})`);
  return partes;
}

function juntarRotulo(alias, dim, colunaRes) {
  if (!dim || !dim.rot) return null;
  const cond = dim.rot.numerico ? `${alias}.codigo_num = ${colunaRes}` : `${alias}.codigo = ${colunaRes}::VARCHAR`;
  return `LEFT JOIN dic_categorias ${alias} ON ${alias}.tabela = ${strSQL(dim.rot.tabela)} AND ${alias}.variavel = ${strSQL(dim.rot.variavel)} AND ${cond}`;
}

async function montarSQL(cat, motor, t, dims, est) {
  const dl = dims.find(d => d.id === est.linha) || null;
  const dc = dims.find(d => d.id === est.coluna) || null;
  if (dl && dc && dl.id === dc.id) throw new Error('Linhas e colunas precisam ser variáveis diferentes.');
  const per = filtroPeriodo(t, est);
  const extras = filtrosSQL(est, dims);
  const plano = { tabela: t, medida: est.medida, linha: dl, coluna: dc, amostral: t.amostral, periodo: per };
  const cabecalho = [`-- ${t.titulo || t.chave}, ${per.a.rotulo}${per.a.id !== per.b.id ? ` a ${per.b.rotulo}` : ''}, município do Rio`];

  if (t.amostral) {
    const mp = macrosPNAD(motor, t);
    const A = ident(t.colAno), T = t.colTrimestre ? ident(t.colTrimestre) : null;
    const partesFiltro = [per.sql, ...extras];
    let blocos = [];
    let rotuloMedida, macroUsado;
    const grupoDe = (comLinha) => {
      const campos = [];
      if (comLinha && dl) campos.push(`'linha': ${dl.expr}`);
      if (dc) campos.push(`'coluna': ${dc.expr}`);
      return campos.length ? `{${campos.join(', ')}}` : 'true';
    };
    if (dc) partesFiltro.push(`${dc.expr} IS NOT NULL`);
    if (est.medida === 'proporcao') {
      if (!dl) throw new Error('A proporção precisa de uma variável nas linhas.');
      partesFiltro.push(`${dl.expr} IS NOT NULL`);
      const filtro = partesFiltro.join(' AND ');
      // Categorias presentes no recorte (consulta pequena, só a coluna da variável).
      const distintos = await motor.consultar(`SELECT DISTINCT ${dl.expr} AS v FROM ${t.chave} WHERE ${filtro} ORDER BY 1`, { origem: 'explorar (categorias)', silencioso: true });
      plano.previa = distintos.stats;
      const valores = distintos.linhas.map(x => x.v).filter(v => v !== null);
      if (!valores.length) throw new Error('Nenhum registro no recorte escolhido.');
      if (valores.length > 60) throw new Error(`A variável ${dl.variavel} tem ${valores.length} categorias no recorte; escolha um nível mais agregado.`);
      macroUsado = mp.chamar('proporcao', '…').split('(')[0];
      blocos = valores.map(v => {
        const lit = typeof v === 'number' ? String(v) : strSQL(v);
        return `  SELECT ${lit} AS linha, * FROM ${mp.chamar('proporcao', `${dl.expr} = ${lit}`, grupoDe(false), filtro)}`;
      });
      rotuloMedida = `proporção de cada categoria de ${dl.variavel}${dc ? ` dentro de ${dc.variavel}` : ''}`;
    } else {
      if (dl) partesFiltro.push(`${dl.expr} IS NOT NULL`);
      const filtro = partesFiltro.join(' AND ');
      let chamada;
      if (est.medida === 'taxa') {
        const tx = TAXAS.find(x => x.id === est.taxa) || TAXAS[0];
        const numx = tx.id === 'personalizada' ? est.num : tx.num;
        const denx = tx.id === 'personalizada' ? est.den : tx.den;
        if (!numx || !denx) throw new Error('Preencha o numerador e o denominador.');
        chamada = mp.chamar('razao', `(${numx})::DOUBLE`, `(${denx})::DOUBLE`, grupoDe(true), filtro);
        rotuloMedida = tx.id === 'personalizada' ? `razão (${numx}) / (${denx})` : `${tx.rotulo.toLowerCase()}: (${numx}) / (${denx})`;
      } else if (est.medida === 'media') {
        if (!est.y) throw new Error('Escolha a variável numérica.');
        chamada = mp.chamar('media', ident(est.y), grupoDe(true), filtro);
        rotuloMedida = `média de ${est.y}`;
      } else {
        const y = est.y === '1' || !est.y ? '1' : ident(est.y);
        chamada = mp.chamar(mp.total, y, grupoDe(true), filtro);
        rotuloMedida = y === '1' ? 'total de pessoas' : `total de ${est.y}`;
      }
      macroUsado = chamada.split('(')[0];
      blocos = [`  SELECT * FROM ${chamada}`];
    }
    cabecalho.push(`-- Medida: ${rotuloMedida}`);
    cabecalho.push(`-- Ponderado por ${t.peso}; erro-padrão por linearização (${t.estrato}/${t.upa}) no macro ${macroUsado} de sql/estimacao_pnad.sql.`);
    cabecalho.push('-- IC 95% = estimativa ± 1,96 × erro-padrão; CV = erro-padrão / estimativa.');
    const selLinha = est.medida === 'proporcao' ? 'est.linha' : 'est.grupo.linha';
    const cols = [`est.${A}`];
    if (T) cols.push(`est.${T}`);
    const joins = [];
    if (dl) { cols.push(`${selLinha} AS linha`); if (dl.rot) { cols.push('rl.rotulo AS linha_rotulo'); joins.push(juntarRotulo('rl', dl, selLinha)); } }
    if (dc) { cols.push('est.grupo.coluna AS coluna'); if (dc.rot) { cols.push('rc.rotulo AS coluna_rotulo'); joins.push(juntarRotulo('rc', dc, 'est.grupo.coluna')); } }
    cols.push('est.estimativa', 'est.ep', 'est.ic95_inf', 'est.ic95_sup', 'est.cv', 'est.n_amostra');
    const ordem = [`est.${A}`, ...(T ? [`est.${T}`] : []), ...(dl ? [selLinha] : []), ...(dc ? ['est.grupo.coluna'] : [])];
    plano.sql = `${cabecalho.join('\n')}\nWITH est AS (\n${blocos.join('\n  UNION ALL\n')}\n)\nSELECT ${cols.join(',\n  ')}\nFROM est${joins.length ? '\n' + joins.join('\n') : ''}\nORDER BY ${ordem.join(', ')}`;
    plano.rotuloMedida = rotuloMedida;
    plano.ehProporcao = est.medida === 'proporcao' || est.medida === 'taxa';
    return plano;
  }

  // RAIS: registro administrativo, sem peso nem erro amostral.
  const A = ident(t.colAno || 'ano');
  const fonte = t.macroPeriodo ? `${t.macroPeriodo}(${per.a.ano}, ${per.b.ano})` : t.chave;
  const onde = [];
  if (t.colAno) onde.push(`${A} BETWEEN ${per.a.ano} AND ${per.b.ano}`);
  if (t.ativo && est.ativos !== false) onde.push(`${ident(t.ativo)} = 1`);
  let agregado, rotuloMedida, contar = 'count(*)';
  const ehEstab = t.chave.includes('estab');
  if (est.medida === 'contagem') {
    agregado = 'count(*)';
    rotuloMedida = ehEstab ? 'número de estabelecimentos' : (t.ativo && est.ativos !== false ? 'vínculos ativos em 31/12' : 'vínculos (todos os registros do ano)');
  } else {
    if (!est.y) throw new Error('Escolha a variável numérica.');
    const y = ident(est.y);
    const f = { soma: 'sum', media: 'avg', mediana: 'median' }[est.medida];
    agregado = `${f}(${y})`;
    contar = `count(${y})`;
    if (est.zeros !== false) onde.push(`${y} > 0`);
    rotuloMedida = `${{ soma: 'soma', media: 'média', mediana: 'mediana' }[est.medida]} de ${est.y}${est.zeros !== false ? ' (exclui nulos e zeros)' : ''}`;
  }
  onde.push(...extras);
  cabecalho.push(`-- Medida: ${rotuloMedida}. Registro administrativo: sem peso e sem erro amostral.`);
  const sel = [`${A} AS ano`];
  const grp = [A];
  if (dl) { sel.push(`${dl.expr} AS linha`); grp.push(dl.expr); }
  if (dc) { sel.push(`${dc.expr} AS coluna`); grp.push(dc.expr); }
  sel.push(`${agregado} AS valor`, `${contar} AS registros`);
  const cols = ['agg.ano'];
  const joins = [];
  if (dl) { cols.push('agg.linha'); if (dl.rot) { cols.push('rl.rotulo AS linha_rotulo'); joins.push(juntarRotulo('rl', dl, 'agg.linha')); } }
  if (dc) { cols.push('agg.coluna'); if (dc.rot) { cols.push('rc.rotulo AS coluna_rotulo'); joins.push(juntarRotulo('rc', dc, 'agg.coluna')); } }
  cols.push('agg.valor', 'agg.registros');
  const ordem = ['agg.ano', ...(dl ? ['agg.linha'] : []), ...(dc ? ['agg.coluna'] : [])];
  plano.sql = `${cabecalho.join('\n')}\nWITH agg AS (\n  SELECT ${sel.join(', ')}\n  FROM ${fonte}${onde.length ? `\n  WHERE ${onde.join('\n    AND ')}` : ''}\n  GROUP BY ${grp.join(', ')}\n)\nSELECT ${cols.join(', ')}\nFROM agg${joins.length ? '\n' + joins.join('\n') : ''}\nORDER BY ${ordem.join(', ')}`;
  plano.rotuloMedida = rotuloMedida;
  plano.ehMonetario = /vl_/.test(est.y || '') && est.medida !== 'contagem';
  return plano;
}

function botaoVerSQL(ctx, sql) {
  return el('button', { type: 'button', class: 'secundario', id: 'ex-ver-sql', onclick: () => ctx.abrirNoEditor(sql) }, 'Ver SQL');
}

function rotuloCat(r, campo, dim, soRotulo = false) {
  const v = r[campo];
  if (v === null || v === undefined) return dim && dim.nulo ? `(vazio: ${dim.nulo})` : '(vazio)';
  const rot = r[campo + '_rotulo'];
  return rot ? (soRotulo ? rot : `${v} · ${rot}`) : String(v);
}

export function mostrar(saida, plano, r, ctx) {
  const t = plano.tabela;
  saida.innerHTML = '';
  const s = r.stats;
  // Soma a consulta prévia (categorias da proporção), quando houver.
  const p = plano.previa;
  const tot = { ms: s.ms + (p ? p.ms : 0), bytes: s.dados.bytes + (p ? p.dados.bytes : 0), req: s.dados.req + (p ? p.dados.req : 0), criados: [...(p ? p.criados : []), ...s.criados] };
  window.__ultimoExplorar = { sql: plano.sql, colunas: r.colunas, linhas: r.linhas, stats: { ms: tot.ms, dados: { bytes: tot.bytes, req: tot.req } } };
  saida.append(el('div', { class: 'res-cabeca' },
    plano.semTitulo ? null : el('h3', {}, plano.rotuloMedida.replace(/^./, c => c.toUpperCase())),
    el('p', { class: 'mudo', id: 'ex-stats' }, `${num(r.linhas.length)} linhas · ${segundos(tot.ms)} · ${mb(tot.bytes)} baixados em ${tot.req} requisições${p ? ' (em duas consultas: categorias e estimativas)' : ''}${tot.criados.length ? ` · abriu ${tot.criados.join(', ')}` : ''}`)));

  const A = t.colAno || 'ano', T = t.colTrimestre;
  const linhas = r.linhas.map(x => {
    const o = { ...x };
    o._periodo = T ? `${x[A]}T${x[T]}` : String(x[plano.amostral ? A : 'ano']);
    if (plano.linha) o._linha = rotuloCat(x, 'linha', plano.linha, plano.soRotulo);
    if (plano.coluna) o._coluna = rotuloCat(x, 'coluna', plano.coluna, plano.soRotulo);
    if (plano.amostral) o._aviso = avisoCV(x.cv);
    return o;
  });

  if (plano.amostral) {
    const ruins = linhas.filter(x => x._aviso.classe === 'cv-ruim').length;
    const caut = linhas.filter(x => x._aviso.classe === 'cv-cautela').length;
    if (ruins || caut) {
      saida.append(el('p', { class: 'aviso', id: 'ex-aviso-cv' }, `${ruins ? `${ruins} estimativa(s) com CV acima de 30% (não confiável)` : ''}${ruins && caut ? '; ' : ''}${caut ? `${caut} com CV entre 15% e 30% (use com cautela)` : ''}. Limites de CV são convenção deste site; veja Metodologia.`));
    }
  }
  if (!plano.amostral && t.chave.startsWith('rais_vinculos') && [plano.linha, plano.coluna].some(d => d && /bairro/i.test(d.variavel)) && plano.periodo.b.ano > 2021) {
    saida.append(el('p', { class: 'aviso' }, 'O bairro dos vínculos só vem informado até 2021: em 2022 quase todo vínculo vem como ignorado, e de 2023 em diante todos.'));
  }

  const botoes = el('div', { class: 'acoes' },
    el('button', { type: 'button', class: 'secundario', id: 'ex-csv', onclick: () => baixarTexto(`${t.chave}_${plano.medida}.csv`, paraCSV(r.colunas.concat(plano.amostral ? ['aviso_cv'] : []), r.linhas.map((x, i) => plano.amostral ? { ...x, aviso_cv: linhas[i]._aviso.texto } : x))) }, 'CSV'),
    el('button', { type: 'button', class: 'secundario', onclick: () => baixarTexto(`${t.chave}_${plano.medida}_excel.csv`, paraCSV(r.colunas.concat(plano.amostral ? ['aviso_cv'] : []), r.linhas.map((x, i) => plano.amostral ? { ...x, aviso_cv: linhas[i]._aviso.texto } : x), 'br')) }, 'CSV (Excel pt-BR)'),
    botaoVerSQL(ctx, plano.sql));
  saida.append(botoes);

  const graf = el('div', { class: 'grafico', id: 'ex-grafico' });
  saida.append(graf);

  // Tabela
  const fmtEst = v => plano.amostral ? (plano.ehProporcao ? pct(v, 2) : num(v, 2)) : (plano.ehMonetario ? num(v, 2) : num(v, Number.isInteger(v) ? 0 : 2));
  const cab = ['Período', ...(plano.linha ? ['Linha'] : []), ...(plano.coluna ? ['Coluna'] : [])];
  const tab = el('table', { class: 'dados', id: 'ex-tabela' });
  if (plano.amostral) {
    tab.append(el('thead', {}, el('tr', {}, [...cab, 'Estimativa', 'Erro-padrão', 'IC 95%', 'CV', 'n amostral', 'Aviso'].map(c => el('th', {}, c)))));
    tab.append(el('tbody', {}, linhas.map(x => el('tr', { class: x._aviso.classe },
      el('td', {}, x._periodo), plano.linha ? el('td', {}, x._linha) : null, plano.coluna ? el('td', {}, x._coluna) : null,
      el('td', { class: 'num' }, fmtEst(x.estimativa)),
      el('td', { class: 'num' }, plano.ehProporcao ? num(x.ep * 100, 2) + ' p.p.' : num(x.ep, 2)),
      el('td', { class: 'num' }, `${fmtEst(x.ic95_inf)} a ${fmtEst(x.ic95_sup)}`),
      el('td', { class: 'num' }, pct(x.cv, 1)),
      el('td', { class: 'num' }, num(x.n_amostra)),
      el('td', {}, x._aviso.texto)))));
  } else {
    tab.append(el('thead', {}, el('tr', {}, [...cab, 'Valor', 'Registros'].map(c => el('th', {}, c)))));
    tab.append(el('tbody', {}, linhas.map(x => el('tr', {},
      el('td', {}, x._periodo), plano.linha ? el('td', {}, x._linha) : null, plano.coluna ? el('td', {}, x._coluna) : null,
      el('td', { class: 'num' }, fmtEst(x.valor)), el('td', { class: 'num' }, num(x.registros))))));
  }
  saida.append(el('div', { class: 'rolagem' }, tab));
  if (plano.amostral) saida.append(el('p', { class: 'nota' }, 'n amostral = pessoas na amostra que entram no denominador. Linhas em amarelo: CV entre 15% e 30%; em vermelho: CV acima de 30%.'));

  desenharGrafico(graf, linhas, plano).catch(e => { graf.innerHTML = ''; graf.append(el('p', { class: 'nota' }, 'Gráfico indisponível: ' + esc(e.message || e))); });
}
