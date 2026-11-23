// Gerador de SQL dos cruzamentos (planejar) e exibição do resultado (mostrar): tabela, gráfico e avisos.
// A tela que monta os parâmetros é consultar.js.
import { el, esc, num, pct, mb, segundos, ident, literal, strSQL, paraCSV, baixarTexto, dicaErro } from './util.js';
import { desenharGrafico, tiposGrafico, baixarPNG } from './grafico.js';

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

export function basesExploraveis(cat) {
  return Object.values(cat.tabelas).filter(t => t.arquivos.length && cat.dic[t.chave] && Object.keys(cat.dic[t.chave]).length
    && (t.amostral || t.manifesto === 'rais'));
}

export function periodos(t) {
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
export function juntarStats(a, b) {
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

export async function planejar(cat, motor, t, dims, est) {
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
    rotuloMedida = `${{ soma: 'soma', media: 'média', mediana: 'mediana' }[est.medida]} de ${est.y}${est.zeros !== false ? ' (exclui nulos e zeros)' : ''}${t.ativo ? (est.ativos !== false ? ', só vínculos ativos em 31/12' : ', todos os vínculos do ano') : ''}`;
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
  return el('button', { type: 'button', class: 'secundario', id: 'ex-ver-sql', onclick: () => ctx.abrirNoEditor(sql) }, 'Abrir no SQL');
}

function rotuloCat(r, campo, dim, soRotulo = false) {
  const v = r[campo];
  if (v === null || v === undefined) return dim && dim.vazio ? dim.vazio : (dim && dim.nulo ? `(vazio: ${dim.nulo})` : (soRotulo ? 'Sem informação' : '(vazio)'));
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
    plano.semTitulo ? null : el('h3', {}, (plano.titulo || plano.rotuloMedida).replace(/^./, c => c.toUpperCase())),
    plano.titulo && plano.notaMedida ? el('p', { class: 'nota' }, plano.notaMedida) : null,
    el('p', { class: 'mudo', id: 'ex-stats' }, `${num(r.linhas.length)} linhas · ${segundos(tot.ms)} · ${mb(tot.bytes)} baixados em ${tot.req} requisições${p ? ' (em duas consultas: categorias e estimativas)' : ''}${tot.criados.length ? ` · abriu ${tot.criados.join(', ')}` : ''}`)));

  const A = t.colAno || 'ano', T = t.colTrimestre;
  const linhas = r.linhas.filter(x => !(plano.amostral && plano.titulo && Number(x.n_amostra) === 0)).map(x => {
    const o = { ...x };
    o._vazio = Boolean(plano.linha) && (x.linha === null || x.linha === undefined);
    o._periodo = T ? `${x[A]}T${x[T]}` : String(x[plano.amostral ? A : 'ano']);
    if (plano.linha) o._linha = rotuloCat(x, 'linha', plano.linha, plano.soRotulo);
    if (plano.coluna) o._coluna = rotuloCat(x, 'coluna', plano.coluna, plano.soRotulo);
    if (plano.amostral) o._aviso = avisoCV(x.cv);
    return o;
  });

  plano.aditivo = ['contagem', 'soma', 'total'].includes(plano.medida);
  const umPeriodo = new Set(linhas.map(x => x._periodo)).size <= 1;
  // Registro administrativo com separação: quanto cada grupo é do total do período.
  const comPct = !plano.amostral && plano.aditivo && Boolean(plano.linha);
  if (comPct) {
    // Com duas separações, a parcela é dentro de cada grupo da primeira (ex.: composição por porte dentro do bairro).
    const chave = x => (plano.coluna ? `${x._periodo}\u0001${x._linha}` : x._periodo);
    const tot = {};
    for (const x of linhas) tot[chave(x)] = (tot[chave(x)] || 0) + Number(x.valor || 0);
    for (const x of linhas) x._pct = tot[chave(x)] ? Number(x.valor) / tot[chave(x)] : null;
  }
  const nomePct = plano.coluna ? `% dentro de ${(plano.nomeLinha || 'cada grupo').toLowerCase()}` : `% do total${plano.temFiltro ? ' filtrado' : ''}`;
  if (plano.ordenarBarras && umPeriodo) {
    // Mesma ordem do gráfico: grupos da primeira separação do maior para o menor; sem informação por último.
    const campo = plano.amostral ? 'estimativa' : 'valor';
    const peso = new Map();
    for (const x of linhas) { const v = Number(x[campo]) || 0; peso.set(x._linha, plano.aditivo ? (peso.get(x._linha) || 0) + v : Math.max(peso.get(x._linha) ?? -Infinity, v)); }
    linhas.sort((a, b) => (a._vazio - b._vazio) || (peso.get(b._linha) - peso.get(a._linha)));
  }
  const colunasCSV = r.colunas.concat(comPct ? ['pct_do_total'] : [], plano.amostral ? ['aviso_cv'] : []);
  const linhasCSV = () => linhas.map(x => { const o = {}; for (const c of r.colunas) o[c] = x[c]; if (comPct) o.pct_do_total = x._pct; if (plano.amostral) o.aviso_cv = x._aviso.texto; return o; });

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
    el('button', { type: 'button', class: 'secundario', id: 'ex-csv', onclick: () => baixarTexto(`${t.chave}_${plano.medida}.csv`, paraCSV(colunasCSV, linhasCSV())) }, 'CSV'),
    el('button', { type: 'button', class: 'secundario', onclick: () => baixarTexto(`${t.chave}_${plano.medida}_excel.csv`, paraCSV(colunasCSV, linhasCSV(), 'br')) }, 'CSV (Excel pt-BR)'),
    el('button', { type: 'button', class: 'secundario', id: 'ex-png', onclick: () => baixarPNG(ultimoGrafico, plano.titulo || plano.rotuloMedida, `${t.chave}_${plano.medida}.png`).catch(e => console.error(e)) }, 'Baixar gráfico (PNG)'),
    botaoVerSQL(ctx, plano.sql));
  saida.append(botoes);

  let ultimoGrafico = null;
  const graf = el('div', { class: 'grafico', id: 'ex-grafico' });
  const desenhar = () => desenharGrafico(graf, linhas, plano).then(g => { ultimoGrafico = g; })
    .catch(e => { graf.innerHTML = ''; graf.append(el('p', { class: 'nota' }, 'Gráfico indisponível: ' + esc(e.message || e))); });
  const tipos = tiposGrafico(plano, linhas);
  if (tipos.length > 1) {
    if (!tipos.some(x => x.id === plano.tipoGrafico)) plano.tipoGrafico = tipos[0].id;
    const grupo = el('div', { class: 'seg', id: 'ex-tipos', role: 'group', 'aria-label': 'Tipo de gráfico' });
    for (const tp of tipos) {
      const b = el('button', { type: 'button', class: 'seg-b', 'data-tipo': tp.id, 'aria-pressed': String(tp.id === plano.tipoGrafico) }, tp.nome);
      b.addEventListener('click', () => {
        plano.tipoGrafico = tp.id;
        for (const o of grupo.children) o.setAttribute('aria-pressed', String(o === b));
        desenhar();
      });
      grupo.append(b);
    }
    saida.append(grupo);
  }
  saida.append(graf);

  // Tabela
  const fmtEst = v => plano.amostral ? (plano.ehProporcao ? pct(v, 2) : num(v, plano.decimais ?? 2)) : (plano.ehMonetario ? num(v, 2) : num(v, Number.isInteger(v) ? 0 : 2));
  // IC de valor que não pode ser negativo (pessoas, %, reais): o limite de baixo para em zero na tela; o CSV traz o valor calculado.
  const icInf = x => (Number(x.estimativa) >= 0 ? Math.max(0, x.ic95_inf) : x.ic95_inf);
  const cab = ['Período', ...(plano.linha ? [plano.nomeLinha || 'Grupo'] : []), ...(plano.coluna ? [plano.nomeColuna || 'Subgrupo'] : [])];
  const tab = el('table', { class: 'dados', id: 'ex-tabela' });
  if (plano.amostral) {
    tab.append(el('thead', {}, el('tr', {}, [...cab, 'Estimativa', 'Erro-padrão', 'IC 95%', 'CV', 'n amostral', 'Aviso'].map(c => el('th', {}, c)))));
    tab.append(el('tbody', {}, linhas.map(x => el('tr', { class: x._aviso.classe },
      el('td', {}, x._periodo), plano.linha ? el('td', {}, x._linha) : null, plano.coluna ? el('td', {}, x._coluna) : null,
      el('td', { class: 'num' }, fmtEst(x.estimativa)),
      el('td', { class: 'num' }, plano.ehProporcao ? num(x.ep * 100, 2) + ' p.p.' : num(x.ep, plano.decimais ?? 2)),
      el('td', { class: 'num' }, `${fmtEst(icInf(x))} a ${fmtEst(x.ic95_sup)}`),
      el('td', { class: 'num' }, pct(x.cv, 1)),
      el('td', { class: 'num' }, num(x.n_amostra)),
      el('td', {}, x._aviso.texto)))));
  } else {
    tab.append(el('thead', {}, el('tr', {}, [...cab, 'Valor', ...(comPct ? [nomePct] : []), ...(plano.medida === 'contagem' ? [] : ['Registros'])].map(c => el('th', {}, c)))));
    tab.append(el('tbody', {}, linhas.map(x => el('tr', {},
      el('td', {}, x._periodo), plano.linha ? el('td', {}, x._linha) : null, plano.coluna ? el('td', {}, x._coluna) : null,
      el('td', { class: 'num' }, fmtEst(x.valor)), comPct ? el('td', { class: 'num' }, x._pct === null ? '—' : pct(x._pct, 1)) : null, plano.medida === 'contagem' ? null : el('td', { class: 'num' }, num(x.registros))))));
  }
  const caixaTab = el('div', { class: 'rolagem' }, tab);
  if (plano.linha && plano.coluna) {
    // Tabela cruzada: grupos da primeira separação nas linhas, da segunda nas colunas.
    const campo = plano.amostral ? 'estimativa' : 'valor';
    const cols = [...new Set(linhas.map(x => x._coluna))];
    const chaves = [...new Set(linhas.map(x => `${x._periodo}\u0001${x._linha}`))];
    const mapa = new Map(linhas.map(x => [`${x._periodo}\u0001${x._linha}\u0001${x._coluna}`, x]));
    const cruz = el('table', { class: 'dados', id: 'ex-cruzada' },
      el('thead', {}, el('tr', {}, ['Período', plano.nomeLinha || 'Linha', ...cols].map(c => el('th', {}, c)))),
      el('tbody', {}, chaves.map(k => { const [p, l] = k.split('\u0001'); return el('tr', {}, el('td', {}, p), el('td', {}, l),
        cols.map(c => { const x = mapa.get(`${k}\u0001${c}`); return el('td', { class: `num ${x && x._aviso ? x._aviso.classe : ''}`, title: x && plano.amostral ? `IC 95%: ${fmtEst(icInf(x))} a ${fmtEst(x.ic95_sup)} · CV ${pct(x.cv, 1)} · n ${num(x.n_amostra)}` : '' }, x ? fmtEst(x[campo]) : '—'); })); })));
    const caixaCruz = el('div', { class: 'rolagem' }, cruz, plano.amostral ? el('p', { class: 'nota' }, 'A tabela cruzada mostra só o valor; IC 95%, CV e n estão na tabela completa (e ao passar o mouse na célula).') : null);
    caixaCruz.hidden = true;
    const seg = el('div', { class: 'seg', id: 'ex-tabelas', role: 'group', 'aria-label': 'Formato da tabela' });
    const bt = (txt, cruzada) => { const b = el('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(!cruzada) }, txt);
      b.addEventListener('click', () => { caixaCruz.hidden = !cruzada; caixaTab.hidden = cruzada; for (const o of seg.children) o.setAttribute('aria-pressed', String(o === b)); }); return b; };
    seg.append(bt('Tabela completa', false), bt(`Tabela cruzada (${(plano.nomeLinha || 'linhas').toLowerCase()} × ${(plano.nomeColuna || 'colunas').toLowerCase()})`, true));
    saida.append(seg, caixaTab, caixaCruz);
  } else saida.append(caixaTab);

  if (plano.amostral) saida.append(el('p', { class: 'nota' }, 'n amostral = pessoas na amostra que entram no denominador. O limite de baixo do IC para em zero quando o cálculo daria número negativo. Linhas em amarelo: CV entre 15% e 30%; em vermelho: CV acima de 30%.'));

  desenhar();
}
