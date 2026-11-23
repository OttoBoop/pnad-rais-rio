// Consultar: a pergunta é uma frase com menus. Monta os parâmetros, chama o gerador de SQL (explorar.js) e mostra.
import { el, faixasAnos, dicaErro } from './util.js';
import { dimensoes } from './dimensoes.js';
import { planejar, mostrar, periodos, juntarStats } from './explorar.js';
import { BASES, MEDIDAS, VARIAVEIS, EXEMPLOS, chaveCuradoria } from './curadoria.js';

const MAIS = '__mais__';
const CURTA = '__curta__';
const semAcento = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Rótulos da RAIS vêm em maiúsculas; na tela ficam em caixa de frase.
const bonito = s => (/[a-zà-ú]/.test(s) ? s : s.charAt(0) + s.slice(1).toLowerCase());

export function estadoParaHash(e) {
  const p = new URLSearchParams();
  p.set('b', e.base); p.set('m', e.medida);
  if (e.por) p.set('por', e.por);
  if (e.e) p.set('e', e.e);
  if (e.ini) p.set('de', e.ini);
  if (e.fim) p.set('ate', e.fim);
  if (e.ativos === false) p.set('at', '0');
  const f = (e.conds || []).filter(c => c.dim && c.valores && c.valores.length).map(c => `${c.dim}~${c.valores.join('|')}`);
  if (f.length) p.set('f', f.join(';'));
  return `#consultar?${p.toString()}`;
}

function hashParaEstado(hash) {
  const i = hash.indexOf('?');
  if (!/^#consultar/.test(hash) || i < 0) return null;
  const p = new URLSearchParams(hash.slice(i + 1));
  if (!p.get('b')) return null;
  return {
    base: p.get('b'), medida: p.get('m'), por: p.get('por') || '', e: p.get('e') || '', ini: p.get('de'), fim: p.get('ate'),
    ativos: p.get('at') !== '0', usar: p.get('usar') || '',
    conds: (p.get('f') || '').split(';').filter(Boolean).map(x => { const [dim, v] = x.split('~'); return { dim, valores: (v || '').split('|').filter(Boolean) }; }),
  };
}

export function montarConsultar(raiz, ctx) {
  const { cat, motor } = ctx;
  const bases = Object.keys(BASES).filter(k => cat.tabelas[k] && cat.tabelas[k].arquivos.length && cat.dic[k]);
  raiz.innerHTML = '';
  if (!bases.length) { raiz.append(el('p', { class: 'aviso' }, 'Nenhuma base publicada nos manifestos ainda.')); return null; }

  const est = { base: bases[0], medida: null, conds: [], por: '', e: '', ativos: true };
  const mais = {}; // seletores em modo "todas as variáveis"
  const chips = el('div', { class: 'chips', id: 'cq-exemplos' });
  const form = el('form', { class: 'painel frase', id: 'cq-form' });
  const saida = el('div', { class: 'explorar-saida', id: 'cq-saida' });
  raiz.append(el('p', { class: 'mudo chips-titulo' }, 'Experimente:'), chips, form, saida);

  const cache = {};
  const dimsDe = chave => cache[chave] || (cache[chave] = dimensoes(cat, chave));
  const medidasDe = chave => MEDIDAS[chaveCuradoria(chave)].filter(m => (m.vars || []).every(v => cat.dic[chave][v]));
  const curtaDe = chave => {
    const ids = new Set(dimsDe(chave).map(d => d.id));
    return VARIAVEIS[chaveCuradoria(chave)].map(g => ({ grupo: g.grupo, itens: g.itens.filter(i => ids.has(i.id)) })).filter(g => g.itens.length);
  };
  const itemCurto = (chave, id) => curtaDe(chave).flatMap(g => g.itens).find(i => i.id === id);
  const nomeDim = (chave, id) => {
    const c = itemCurto(chave, id);
    if (c) return c.nome;
    const d = dimsDe(chave).find(x => x.id === id);
    return d ? d.rotulo.replace(/^[^·]+· /, '') : id;
  };

  function intervalo() {
    const per = periodos(cat.tabelas[est.base]);
    let ia = per.findIndex(p => p.id === est.ini), ib = per.findIndex(p => p.id === est.fim);
    if (ia > ib) [ia, ib] = [ib, ia];
    return { per, a: per[ia], b: per[ib] };
  }

  // Uma variável serve para o período escolhido? Usa anos, anos_preenchida e preenchimento_pct do dicionário.
  function disponibilidade(dim) {
    const t = cat.tabelas[est.base];
    const v = (cat.dic[est.base] || {})[dim.variavel] || {};
    const { a, b } = intervalo();
    const anosPer = t.anos.filter(x => x >= a.ano && x <= b.ano);
    const pctDe = ano => (v.preenchimento_pct ? v.preenchimento_pct[String(ano)] : undefined);
    const serve = ano => {
      const p = pctDe(ano);
      if (p !== undefined) return p >= 50;
      const lista = v.anos_preenchida || v.anos || dim.anos;
      return !Array.isArray(lista) || lista.includes(ano);
    };
    const bons = anosPer.filter(serve);
    const todos = t.anos.filter(serve);
    if (!bons.length) return { ok: false, motivo: todos.length ? `só tem dado em ${faixasAnos(todos)}` : 'sem dado' };
    const avisos = [];
    if (bons.length < anosPer.length) avisos.push(`sem dado em ${faixasAnos(anosPer.filter(x => !bons.includes(x)))}`);
    const baixos = bons.map(x => [x, pctDe(x)]).filter(([, p]) => p !== undefined && p < 95);
    if (baixos.length) {
      const pior = baixos.reduce((m, x) => (x[1] < m[1] ? x : m));
      avisos.push(`preenchida em ${String(pior[1]).replace('.', ',')}% dos registros de ${pior[0]}`);
    }
    return { ok: true, aviso: avisos.join('; ') };
  }

  function normalizar() {
    const t = cat.tabelas[est.base];
    const ms = medidasDe(est.base);
    if (!ms.some(m => m.id === est.medida)) est.medida = ms[0].id;
    const per = periodos(t);
    const ult = per[per.length - 1].id;
    if (est.ini === 'primeiro') est.ini = per[0].id;
    if (!per.some(p => p.id === est.ini)) est.ini = ult;
    if (!per.some(p => p.id === est.fim)) est.fim = ult;
    const ids = new Set(dimsDe(est.base).map(d => d.id));
    if (!ids.has(est.por)) est.por = '';
    if (!ids.has(est.e)) est.e = '';
    est.conds = (est.conds || []).filter(c => ids.has(c.dim));
    const m = ms.find(x => x.id === est.medida);
    if (m.exigePor && !est.por) est.por = (curtaDe(est.base)[0].itens.find(i => i.id === 'V2010') || curtaDe(est.base)[0].itens[0]).id;
    if (est.e && est.e === est.por) est.e = '';
  }

  // Menu de variável: lista curta em grupos; "mais variáveis…" troca pela busca em todas.
  function seletorDim(chaveUI, valor, aoMudar, { vazio = null, rotulo } = {}) {
    const dims = dimsDe(est.base);
    const curta = curtaDe(est.base);
    const naCurta = !valor || curta.some(g => g.itens.some(i => i.id === valor));
    const caixa = el('span', { class: 'seletor' });
    const opcao = (id, nome) => {
      const d = dims.find(x => x.id === id);
      const disp = disponibilidade(d);
      return el('option', { value: id, selected: id === valor, disabled: !disp.ok && id !== valor }, disp.ok ? nome : `${nome} (${disp.motivo})`);
    };
    const sel = el('select', { id: `cq-${chaveUI}`, 'aria-label': rotulo });
    if (naCurta && !mais[chaveUI]) {
      if (vazio) sel.append(el('option', { value: '' }, vazio));
      for (const g of curta) sel.append(el('optgroup', { label: g.grupo }, g.itens.map(i => opcao(i.id, i.nome))));
      sel.append(el('option', { value: MAIS }, 'mais variáveis…'));
      sel.value = valor || '';
      caixa.append(sel);
    } else {
      const busca = el('input', { type: 'search', class: 'busca-opcao', placeholder: 'buscar em todas as variáveis…', 'aria-label': 'Buscar variável', id: `cq-${chaveUI}-busca` });
      const todas = dims.filter(d => !d.categorias || Object.keys(d.categorias).length > 1);
      const encher = () => {
        const q = semAcento(busca.value.trim());
        sel.innerHTML = '';
        sel.append(el('option', { value: CURTA }, '← voltar à lista curta'));
        if (vazio) sel.append(el('option', { value: '' }, vazio));
        for (const d of todas) {
          if (q && d.id !== valor && !semAcento(d.rotulo).includes(q)) continue;
          sel.append(opcao(d.id, d.rotulo));
        }
        sel.value = valor && todas.some(d => d.id === valor) ? valor : (vazio ? '' : CURTA);
      };
      busca.addEventListener('input', encher);
      encher();
      caixa.append(busca, sel);
    }
    sel.addEventListener('change', () => {
      if (sel.value === MAIS) { mais[chaveUI] = true; render(); const b = form.querySelector(`#cq-${chaveUI}-busca`); if (b) b.focus(); return; }
      if (sel.value === CURTA) { mais[chaveUI] = false; aoMudar(''); render(); return; }
      aoMudar(sel.value); render();
    });
    return caixa;
  }

  // Categorias de uma condição: botão com resumo que abre busca + caixas de marcar.
  function seletorCategorias(cond, i) {
    const d = dimsDe(est.base).find(x => x.id === cond.dim);
    const cats = d && d.categorias ? Object.entries(d.categorias).map(([c, r]) => ({ c, r: bonito(String(r)) })) : [];
    const det = el('details', { class: 'multi', id: `cq-cond-${i}-valores` });
    const resumo = el('summary', {});
    const escreve = () => {
      const esc = cats.filter(x => cond.valores.includes(x.c));
      resumo.textContent = !esc.length ? 'escolha…' : esc.length <= 2 ? esc.map(x => x.r).join(' ou ') : `${esc.length} escolhidas`;
      resumo.classList.toggle('vazio', !esc.length);
    };
    const lista = el('div', { class: 'multi-lista' });
    const busca = el('input', { type: 'search', class: 'busca-opcao', placeholder: `buscar em ${cats.length} categorias…`, 'aria-label': 'Buscar categoria' });
    const encher = () => {
      const q = semAcento(busca.value.trim());
      lista.innerHTML = '';
      let n = 0;
      for (const x of cats) {
        const marcado = cond.valores.includes(x.c);
        if (q && !marcado && !semAcento(x.r).includes(q) && !x.c.includes(q)) continue;
        if (++n > 200) { lista.append(el('p', { class: 'nota' }, 'Mostrando 200; use a busca para achar as outras.')); break; }
        const cb = el('input', { type: 'checkbox', value: x.c, checked: marcado });
        cb.addEventListener('change', () => {
          cond.valores = cb.checked ? [...cond.valores, x.c] : cond.valores.filter(v => v !== x.c);
          escreve();
        });
        lista.append(el('label', { class: 'check' }, cb, ` ${x.r}`));
      }
      if (!n) lista.append(el('p', { class: 'nota' }, 'Nenhuma categoria com esse texto.'));
    };
    busca.addEventListener('input', encher);
    det.append(resumo, el('div', { class: 'multi-painel' }, cats.length > 8 ? busca : null, lista));
    escreve(); encher();
    return det;
  }

  function linha(palavra, ...controles) {
    return el('div', { class: 'frase-linha' }, el('span', { class: 'frase-palavra' }, palavra), el('div', { class: 'frase-controles' }, ...controles));
  }

  function render() {
    normalizar();
    const t = cat.tabelas[est.base];
    const ms = medidasDe(est.base);
    const m = ms.find(x => x.id === est.medida);
    const per = periodos(t);
    form.innerHTML = '';

    const selMed = el('select', { id: 'cq-medida', 'aria-label': 'O que ver' }, ms.map(x => el('option', { value: x.id, selected: x.id === est.medida }, x.nome)));
    selMed.addEventListener('change', () => { est.medida = selMed.value; render(); });
    const extrasMedida = [];
    if (t.ativo && !t.amostral) {
      const ca = el('input', { type: 'checkbox', id: 'cq-ativos', checked: est.ativos !== false });
      ca.addEventListener('change', () => { est.ativos = ca.checked; });
      extrasMedida.push(el('label', { class: 'check' }, ca, ' só os vínculos ativos em 31/12 (sem marcar, entram todos os que existiram no ano)'));
    }
    form.append(linha('Quero ver', selMed, ...extrasMedida, m.nota ? el('p', { class: 'nota' }, m.nota) : null));

    const selBase = el('select', { id: 'cq-base', 'aria-label': 'Base' }, bases.map(b => el('option', { value: b, selected: b === est.base }, BASES[b].nome)));
    selBase.addEventListener('change', () => { est.base = selBase.value; est.conds = []; est.por = est.e = ''; est.ini = est.fim = null; for (const k of Object.keys(mais)) delete mais[k]; render(); });
    form.append(linha('na base', selBase, el('p', { class: 'nota', id: 'cq-base-dica' }, BASES[est.base].dica)));

    // Condições
    const conds = el('div', { class: 'frase-conds' });
    est.conds.forEach((c, i) => {
      const d = dimsDe(est.base).find(x => x.id === c.dim);
      const disp = d ? disponibilidade(d) : { ok: true };
      conds.append(el('div', { class: 'frase-cond' },
        i ? el('span', { class: 'frase-e' }, 'e') : null,
        seletorDim(`cond-${i}`, c.dim, v => { c.dim = v; c.valores = []; if (!v) est.conds.splice(i, 1); }, { rotulo: `Condição ${i + 1}` }),
        el('span', { class: 'frase-e' }, 'é'),
        seletorCategorias(c, i),
        el('button', { type: 'button', class: 'secundario pequeno', 'aria-label': 'Remover condição', onclick: () => { est.conds.splice(i, 1); render(); } }, 'tirar'),
        disp.ok && disp.aviso ? el('p', { class: 'nota aviso-leve' }, `Atenção: ${disp.aviso}.`) : null));
    });
    const primeira = curtaDe(est.base)[0].itens[0].id;
    const add = el('button', { type: 'button', class: 'secundario pequeno', id: 'cq-add-cond', onclick: () => { est.conds.push({ dim: primeira, valores: [] }); render(); } },
      est.conds.length ? '+ outra condição' : '+ escolher um grupo (sem isso, entra todo mundo)');
    form.append(linha(t.chave === 'rais_estab' ? 'de quais' : 'de quem', conds, add));

    // Separações
    const avisoSep = id => {
      const d = id && dimsDe(est.base).find(x => x.id === id);
      const disp = d ? disponibilidade(d) : null;
      return disp && disp.ok && disp.aviso ? el('p', { class: 'nota aviso-leve' }, `Atenção: ${disp.aviso}.`) : null;
    };
    form.append(linha(m.exigePor ? 'distribuído por' : 'separado por',
      seletorDim('por', est.por, v => { est.por = v; }, { vazio: m.exigePor ? null : '— nada (só o total) —', rotulo: 'Separado por' }), avisoSep(est.por)));
    form.append(linha('e por', seletorDim('e', est.e, v => { est.e = v; }, { vazio: '— nada —', rotulo: 'E por' }), avisoSep(est.e)));

    // Período
    const sIni = el('select', { id: 'cq-ini', 'aria-label': 'Início' }, per.map(p => el('option', { value: p.id, selected: p.id === est.ini }, p.rotulo)));
    const sFim = el('select', { id: 'cq-fim', 'aria-label': 'Fim' }, per.map(p => el('option', { value: p.id, selected: p.id === est.fim }, p.rotulo)));
    sIni.addEventListener('change', () => { est.ini = sIni.value; render(); });
    sFim.addEventListener('change', () => { est.fim = sFim.value; render(); });
    const atalho = (txt, f) => el('button', { type: 'button', class: 'secundario pequeno', onclick: () => { f(); render(); } }, txt);
    form.append(linha('em', sIni, el('span', { class: 'frase-e' }, 'até'), sFim,
      atalho('só o último', () => { est.ini = est.fim = per[per.length - 1].id; }),
      atalho('série inteira', () => { est.ini = per[0].id; est.fim = per[per.length - 1].id; }),
      el('p', { class: 'nota' }, est.ini === est.fim ? 'Um período só: gráfico de barras.' : 'Vários períodos: gráfico de linha, uma linha por grupo.')));

    form.append(el('div', { class: 'acoes' }, el('button', { type: 'submit', id: 'cq-ver' }, 'Ver resultado')));
  }

  function tituloFrase() {
    const m = medidasDe(est.base).find(x => x.id === est.medida);
    const { a, b } = intervalo();
    const partes = [m.nome.replace(/^(o|a|os|as) /, '').replace(/ \(.*\)$/, '')];
    for (const c of est.conds) {
      if (!c.valores.length) continue;
      const d = dimsDe(est.base).find(x => x.id === c.dim);
      const rot = c.valores.map(v => bonito(String((d.categorias || {})[v] ?? v)));
      partes.push(`${nomeDim(est.base, c.dim).replace(/ \(.*\)$/, '').replace(/^Situação: .*/, 'situação')}: ${rot.length > 3 ? `${rot.length} categorias` : rot.join(' ou ')}`);
    }
    let s = partes.join(' · ');
    const seps = [est.por, est.e].filter(Boolean).map(id => nomeDim(est.base, id).replace(/ \(.*\)$/, '').toLowerCase());
    if (seps.length) s += `, por ${seps.join(' e ')}`;
    return `${s} — ${BASES[est.base].curto}, ${a.id === b.id ? a.rotulo : `${a.rotulo} a ${b.rotulo}`}`;
  }

  async function rodar() {
    normalizar();
    const t = cat.tabelas[est.base];
    const dims = dimsDe(est.base);
    const m = medidasDe(est.base).find(x => x.id === est.medida);
    const btn = form.querySelector('#cq-ver');
    let plano = null;
    if (btn) btn.disabled = true;
    saida.innerHTML = '';
    saida.append(el('p', { class: 'mudo', role: 'status' }, 'Calculando…'));
    try {
      const { a } = intervalo();
      if (m.desde && a.ano < m.desde) throw new Error(`Esta medida só existe de ${m.desde} em diante. Mude o início do período.`);
      const vazias = est.conds.filter(c => !c.valores.length);
      if (vazias.length) throw new Error(`Escolha ao menos uma categoria em "${nomeDim(est.base, vazias[0].dim)}", ou tire a condição.`);
      for (const id of [est.por, est.e, ...est.conds.map(c => c.dim)].filter(Boolean)) {
        const disp = disponibilidade(dims.find(d => d.id === id));
        if (!disp.ok) throw new Error(`"${nomeDim(est.base, id)}" não tem dado no período escolhido (${disp.motivo}).`);
      }
      const p = { base: est.base, ...m.est, ativos: est.ativos, linha: est.por, coluna: est.e, ini: est.ini, fim: est.fim,
        filtros: est.conds.map(c => ({ dim: c.dim, valores: c.valores })) };
      try { history.replaceState(null, '', estadoParaHash(est)); } catch { /* sem history */ }
      plano = await planejar(cat, motor, t, dims, p);
      const r = await motor.consultar(plano.sql, { origem: 'consultar', silencioso: Boolean(plano.previa) });
      if (plano.previa) motor.emitir('consulta', juntarStats(plano.previa, r.stats));
      plano.titulo = tituloFrase();
      plano.notaMedida = m.nota || '';
      plano.nomeLinha = est.por ? nomeDim(est.base, est.por) : null;
      plano.nomeColuna = est.e ? nomeDim(est.base, est.e) : null;
      plano.soRotulo = true;
      plano.decimais = m.decimais;
      plano.ordenarBarras = Boolean(est.por) && !(itemCurto(est.base, est.por) || {}).ordinal;
      for (const x of r.linhas) for (const k of ['linha_rotulo', 'coluna_rotulo']) if (typeof x[k] === 'string') x[k] = bonito(x[k]);
      mostrar(saida, plano, r, ctx);
      const acoes = saida.querySelector('.acoes');
      if (acoes) {
        const copiar = el('button', { type: 'button', class: 'secundario', id: 'cq-link' }, 'Copiar link desta consulta');
        copiar.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(location.href); copiar.textContent = 'Link copiado'; } catch { copiar.textContent = 'Copie o endereço da página'; }
        });
        acoes.append(copiar);
      }
      if (!r.linhas.length) saida.append(el('p', { class: 'aviso' }, 'Nenhum registro com essas condições.'));
    } catch (e) {
      if (plano && plano.previa && e.stats) motor.emitir('consulta', juntarStats(plano.previa, e.stats));
      saida.innerHTML = '';
      saida.append(el('p', { class: 'erro', id: 'cq-erro' }, String(e.message || e) + dicaErro(e.message || e)));
      if (plano && plano.sql) saida.append(el('button', { type: 'button', class: 'secundario', onclick: () => ctx.abrirNoEditor(plano.sql) }, 'Abrir no SQL'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  form.addEventListener('submit', ev => { ev.preventDefault(); rodar(); });

  function definir(novo, executar = true) {
    if (!novo || !bases.includes(novo.base)) return;
    Object.assign(est, { conds: [], por: '', e: '', ini: null, fim: null, ativos: true }, JSON.parse(JSON.stringify(novo)));
    for (const k of Object.keys(mais)) delete mais[k];
    // Vindo do Dicionário: "usar" = sep (vira separação) ou cond (vira condição a preencher).
    render();
    if (executar) rodar();
  }

  for (const ex of EXEMPLOS) {
    if (!bases.includes(ex.estado.base)) continue;
    chips.append(el('button', { type: 'button', class: 'chip', onclick: () => { definir(ex.estado); form.scrollIntoView({ block: 'nearest' }); } }, ex.titulo));
  }

  const doHash = hashParaEstado(location.hash);
  if (doHash) definir(doHash, !doHash.usar);
  else { render(); saida.append(el('p', { class: 'mudo' }, 'Monte a frase acima e clique em "Ver resultado", ou comece por um dos exemplos.')); }

  return { definir, rodar, estado: () => JSON.parse(JSON.stringify(est)), aoHash: () => { const h = hashParaEstado(location.hash); if (h) definir(h, !h.usar); } };
}
