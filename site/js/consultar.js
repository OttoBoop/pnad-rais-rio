// Consultar: a pergunta é uma frase com menus. Monta os parâmetros, chama o gerador de SQL (explorar.js) e mostra.
import { el, faixasAnos, dicaErro } from './util.js';
import { dimensoes } from './dimensoes.js';
import { planejar, mostrar, periodos, juntarStats } from './explorar.js';
import { BASES, MEDIDAS, VARIAVEIS, EXEMPLOS, ROTULOS, chaveCuradoria } from './curadoria.js';

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
    ativos: p.get('at') !== '0', usar: p.get('usar') || '', temMedida: Boolean(p.get('m')),
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
  const mudou = el('p', { class: 'aviso mudou', id: 'cq-mudou', hidden: true }, 'A pergunta mudou: o resultado abaixo é da pergunta anterior. Clique em "Ver resultado" para atualizar.');
  raiz.append(el('p', { class: 'mudo chips-titulo' }, 'Experimente:'), chips, form, mudou, saida);
  let hashExecutado = null; // estado da frase que gerou o resultado na tela
  let rodando = false;
  const naRota = () => !/^#(sql|dicionario|metodologia|arquivos)/.test(location.hash);
  // Nome por extenso da categoria (RAIS abreviada) ou o rótulo do dicionário em caixa de frase.
  const rotCat = (dimId, cod, bruto) => { const r = (ROTULOS[dimId.split('@')[0]] || {})[cod]; return dimId.includes('@') || r === undefined ? bonito(String(bruto)) : r; };
  document.addEventListener('click', ev => { for (const d of form.querySelectorAll('.multi[open]')) if (!d.contains(ev.target)) d.open = false; });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    for (const d of form.querySelectorAll('.multi[open]')) { d.open = false; d.querySelector('summary').focus(); }
  });

  const cache = {};
  const dimsDe = chave => cache[chave] || (cache[chave] = dimensoes(cat, chave));
  const medidasDe = chave => MEDIDAS[chaveCuradoria(chave)].filter(m => (m.vars || []).every(v => cat.dic[chave][v]));
  const curtaDe = chave => {
    const ids = new Set(dimsDe(chave).map(d => d.id));
    return VARIAVEIS[chaveCuradoria(chave)].map(g => ({ grupo: g.grupo, itens: g.itens.filter(i => ids.has(i.id)) })).filter(g => g.itens.length);
  };
  const itemCurto = (chave, id) => curtaDe(chave).flatMap(g => g.itens).find(i => i.id === id);
  for (const b of bases) for (const i of curtaDe(b).flatMap(g => g.itens)) if (i.vazio) dimsDe(b).find(d => d.id === i.id).vazio = i.vazio;
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

  // Troca de base sem perder a frase: a mesma variável (ou a equivalente, pelo conceito da curadoria) é mantida,
  // e as categorias são casadas pelo nome (Branca = BRANCA; Homem = Masculino). O que não existe na nova base sai, com aviso.
  const SINONIMOS = { homem: 'masculino', mulher: 'feminino' };
  const chaveRotulo = r => { const k = semAcento(String(r)).trim(); return SINONIMOS[k] || k; };
  function trocarBase(nova) {
    const velha = est.base;
    if (nova === velha) return;
    const dimsN = dimsDe(nova), dimsV = dimsDe(velha);
    const perdidos = [];
    const traduzDim = id => {
      if (!id) return '';
      if (dimsN.some(d => d.id === id)) return id;
      const c = (itemCurto(velha, id) || {}).conceito;
      const eq = c && curtaDe(nova).flatMap(g => g.itens).find(i => i.conceito === c);
      if (!eq) perdidos.push(nomeDim(velha, id));
      return eq ? eq.id : '';
    };
    const conds = [];
    for (const c of est.conds) {
      const id = traduzDim(c.dim);
      if (!id) continue;
      const cv = (dimsV.find(d => d.id === c.dim) || {}).categorias || {};
      const cn = (dimsN.find(d => d.id === id) || {}).categorias || {};
      const porRotulo = new Map(Object.entries(cn).map(([k, r]) => [chaveRotulo(r), k]));
      const valores = c.valores.map(v => (id === c.dim && cn[v] !== undefined ? v : porRotulo.get(chaveRotulo(cv[v] ?? v)))).filter(v => v !== undefined);
      if (c.valores.length && valores.length < c.valores.length) perdidos.push(`${c.valores.length - valores.length} categoria(s) de "${nomeDim(velha, c.dim)}"`);
      conds.push({ dim: id, valores: [...new Set(valores)] });
    }
    const por = traduzDim(est.por), e = traduzDim(est.e);
    // Período: mantém os mesmos anos quando a nova base os tem.
    const anoDe = pid => (pid ? Number(String(pid).slice(0, 4)) : null);
    const perN = periodos(cat.tabelas[nova]);
    const a0 = anoDe(est.ini), a1 = anoDe(est.fim);
    const ultV = periodos(cat.tabelas[velha]).slice(-1)[0];
    const noUltimo = est.ini === est.fim && est.fim === ultV.id;
    const ini = noUltimo ? null : (perN.find(p => p.ano === a0) || {}).id || null;
    const fim = noUltimo ? null : (perN.filter(p => p.ano === a1).slice(-1)[0] || {}).id || null;
    const medidaVelha = est.medida;
    Object.assign(est, { base: nova, conds, por, e, ini: ini && fim ? ini : null, fim: ini && fim ? fim : null });
    if (!medidasDe(nova).some(m => m.id === medidaVelha)) est.medida = null;
    for (const k of Object.keys(mais)) delete mais[k];
    est.avisoTroca = perdidos.length ? `Não existe em ${BASES[nova].curto} e saiu da frase: ${perdidos.join('; ')}.` : '';
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
    for (const c of est.conds) {
      const cats = (dimsDe(est.base).find(d => d.id === c.dim) || {}).categorias;
      if (cats) c.valores = (c.valores || []).filter(v => cats[v] !== undefined);
    }
    const m = ms.find(x => x.id === est.medida);
    let ia = per.findIndex(p => p.id === est.ini), ib = per.findIndex(p => p.id === est.fim);
    if (ia > ib) { [est.ini, est.fim] = [est.fim, est.ini]; [ia, ib] = [ib, ia]; }
    if (m.desde) {
      const i0 = per.findIndex(p => p.ano >= m.desde);
      if (ia < i0) est.ini = per[i0].id;
      if (ib < i0) est.fim = per[i0].id;
    }
    if (m.exigePor && !est.por) est.por = (curtaDe(est.base)[0].itens.find(i => i.id === 'V2010') || curtaDe(est.base)[0].itens[0]).id;
    if (est.e && est.e === est.por) est.e = '';
  }

  // Menu de variável: lista curta em grupos; "mais variáveis…" troca pela busca em todas.
  function seletorDim(chaveUI, valor, aoMudar, { vazio = null, rotulo, usados = [] } = {}) {
    const dims = dimsDe(est.base);
    const curta = curtaDe(est.base);
    const naCurta = !valor || curta.some(g => g.itens.some(i => i.id === valor));
    const caixa = el('span', { class: 'seletor' });
    const semSentido = (medidasDe(est.base).find(x => x.id === est.medida) || {}).semSentido || {};
    const opcao = (id, nome) => {
      const d = dims.find(x => x.id === id);
      const disp = disponibilidade(d);
      const motivo = !disp.ok ? disp.motivo : semSentido[id] ? `não serve para esta medida: ${semSentido[id]}` : usados.includes(id) ? 'já está na frase' : '';
      return el('option', { value: id, selected: id === valor, disabled: Boolean(motivo) && id !== valor }, motivo ? `${nome} (${motivo})` : nome);
    };
    const sel = el('select', { id: `cq-${chaveUI}`, 'aria-label': rotulo });
    if (!mais[chaveUI]) {
      if (vazio) sel.append(el('option', { value: '' }, vazio));
      if (!naCurta) sel.append(opcao(valor, nomeDim(est.base, valor)));
      for (const g of curta) sel.append(el('optgroup', { label: g.grupo }, g.itens.map(i => opcao(i.id, i.nome))));
      sel.append(el('option', { value: MAIS }, 'mais variáveis…'));
      sel.value = valor || '';
      caixa.append(sel);
    } else {
      const busca = el('input', { type: 'search', class: 'busca-opcao', placeholder: 'buscar em todas as variáveis…', 'aria-label': 'Buscar variável', id: `cq-${chaveUI}-busca` });
      const todas = dims.filter(d => (!d.categorias || Object.keys(d.categorias).length > 1) && !/^(UF|Capital|RM_RIDE|V1022|V1023|uf|municipio|municipio_trab)$/.test(d.variavel));
      const curto = r => (r.length > 90 ? r.slice(0, 88) + '…' : r);
      const encher = () => {
        const q = semAcento(busca.value.trim());
        sel.innerHTML = '';
        sel.append(el('option', { value: CURTA }, '← voltar à lista curta'));
        if (vazio) sel.append(el('option', { value: '' }, vazio));
        let n = 0;
        for (const d of todas) {
          if (q && d.id !== valor && !(' ' + semAcento(d.rotulo).replace(/[^a-z0-9]+/g, ' ')).includes(' ' + q)) continue;
          sel.append(opcao(d.id, curto(d.rotulo))); n++;
        }
        if (q && !n) sel.append(el('option', { value: '', disabled: true }, `nada com "${busca.value.trim()}" em ${BASES[est.base].curto}`));
        sel.value = valor && todas.some(d => d.id === valor) ? valor : (vazio || !n ? '' : CURTA);
      };
      busca.addEventListener('input', encher);
      busca.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
      encher();
      caixa.append(busca, sel);
    }
    sel.addEventListener('change', () => {
      if (sel.value === MAIS) { mais[chaveUI] = true; render(); const b = form.querySelector(`#cq-${chaveUI}-busca`); if (b) b.focus(); return; }
      if (sel.value === CURTA) { mais[chaveUI] = false; render(); return; }
      aoMudar(sel.value); render();
    });
    return caixa;
  }

  // Categorias de uma condição: botão com resumo que abre busca + caixas de marcar.
  function seletorCategorias(cond, i) {
    const d = dimsDe(est.base).find(x => x.id === cond.dim);
    const cats = d && d.categorias ? Object.entries(d.categorias).map(([c, r]) => ({ c, r: rotCat(cond.dim, c, r) })) : [];
    const ic = itemCurto(est.base, cond.dim);
    if (ic && !ic.ordinal) cats.sort((a, b) => a.r.localeCompare(b.r, 'pt-BR'));
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
    busca.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
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
    const focoId = form.contains(document.activeElement) ? document.activeElement.id : '';
    form.innerHTML = '';

    const selMed = el('select', { id: 'cq-medida', 'aria-label': 'O que ver' }, ms.map(x => el('option', { value: x.id, selected: x.id === est.medida }, x.nome)));
    selMed.addEventListener('change', () => { est.medida = selMed.value; render(); });
    const extrasMedida = [];
    if (t.ativo && !t.amostral) {
      const ca = el('input', { type: 'checkbox', id: 'cq-ativos', checked: est.ativos !== false });
      ca.addEventListener('change', () => { est.ativos = ca.checked; render(); });
      extrasMedida.push(el('label', { class: 'check' }, ca, ' só os vínculos ativos em 31/12 (sem marcar, entram todos os que existiram no ano)'));
    }
    form.append(linha('Quero ver', selMed, ...extrasMedida, m.nota ? el('p', { class: 'nota' }, m.nota) : null,
      est.medida === 'massa' && est.ativos === false ? el('p', { class: 'nota aviso-leve' }, 'Atenção: com todos os vínculos do ano, a soma junta empregos que não existiram ao mesmo tempo e fica maior que a folha de um mês.') : null));

    const selBase = el('select', { id: 'cq-base', 'aria-label': 'Base' }, bases.map(b => el('option', { value: b, selected: b === est.base }, BASES[b].nome)));
    selBase.addEventListener('change', () => { trocarBase(selBase.value); render(); });
    form.append(linha('na base', selBase, el('p', { class: 'nota', id: 'cq-base-dica' }, BASES[est.base].dica),
      est.avisoTroca ? el('p', { class: 'nota aviso-leve', id: 'cq-aviso-troca' }, est.avisoTroca) : null));

    // Condições
    const conds = el('div', { class: 'frase-conds' });
    est.conds.forEach((c, i) => {
      const d = dimsDe(est.base).find(x => x.id === c.dim);
      const disp = d ? disponibilidade(d) : { ok: true };
      conds.append(el('div', { class: 'frase-cond' },
        i ? el('span', { class: 'frase-e' }, 'e') : null,
        seletorDim(`cond-${i}`, c.dim, v => { c.dim = v; c.valores = []; if (!v) est.conds.splice(i, 1); }, { rotulo: `Condição ${i + 1}`, usados: est.conds.filter((_, j) => j !== i).map(x => x.dim) }),
        el('span', { class: 'frase-e' }, 'é'),
        seletorCategorias(c, i),
        el('button', { type: 'button', class: 'secundario pequeno', 'aria-label': 'Remover condição', onclick: () => { est.conds.splice(i, 1); render(); } }, 'tirar'),
        !disp.ok ? el('p', { class: 'nota aviso-forte' }, `Sem dado no período escolhido (${disp.motivo}). Mude o período ou tire a condição.`)
          : disp.aviso ? el('p', { class: 'nota aviso-leve' }, `Atenção: ${disp.aviso}.`) : null));
    });
    const semS = m.semSentido || {};
    const livres = curtaDe(est.base).flatMap(g => g.itens).map(i => i.id).filter(id => !est.conds.some(c => c.dim === id) && !semS[id] && disponibilidade(dimsDe(est.base).find(d => d.id === id)).ok);
    const primeira = livres[0] || curtaDe(est.base)[0].itens[0].id;
    const add = el('button', { type: 'button', class: 'secundario pequeno', id: 'cq-add-cond', onclick: () => { est.conds.push({ dim: primeira, valores: [] }); render(); } },
      est.conds.length ? '+ outra condição' : '+ escolher um grupo (sem isso, entra todo mundo)');
    form.append(linha(t.chave === 'rais_estab' ? 'de quais' : 'de quem', conds, add));

    // Separações
    const avisoSep = id => {
      const d = id && dimsDe(est.base).find(x => x.id === id);
      const disp = d ? disponibilidade(d) : null;
      if (id && semS[id]) return el('p', { class: 'nota aviso-forte' }, `Esta variável não serve para esta medida (${semS[id]}). Escolha outra.`);
      if (disp && !disp.ok) return el('p', { class: 'nota aviso-forte' }, `Sem dado no período escolhido (${disp.motivo}). Mude o período ou escolha outra variável.`);
      return disp && disp.aviso ? el('p', { class: 'nota aviso-leve' }, `Atenção: ${disp.aviso}.`) : null;
    };
    form.append(linha(m.exigePor ? 'distribuído por' : 'separado por',
      seletorDim('por', est.por, v => { est.por = v; }, { vazio: m.exigePor ? null : '— nada (só o total) —', rotulo: 'Separado por' }), avisoSep(est.por)));
    form.append(linha(m.exigePor ? 'dentro de cada' : 'e por', seletorDim('e', est.e, v => { est.e = v; }, { vazio: m.exigePor ? '— nada (o total soma 100%) —' : '— nada —', rotulo: 'E por', usados: [est.por].filter(Boolean) }), avisoSep(est.e),
      m.exigePor && est.e ? el('p', { class: 'nota' }, 'Cada grupo desta segunda variável soma 100%.') : null));

    // Período
    const cedo = p => Boolean(m.desde) && p.ano < m.desde;
    const sIni = el('select', { id: 'cq-ini', 'aria-label': 'Início' }, per.map(p => el('option', { value: p.id, selected: p.id === est.ini, disabled: cedo(p) }, p.rotulo)));
    const sFim = el('select', { id: 'cq-fim', 'aria-label': 'Fim' }, per.map(p => el('option', { value: p.id, selected: p.id === est.fim, disabled: cedo(p) }, p.rotulo)));
    sIni.addEventListener('change', () => { est.ini = sIni.value; render(); });
    sFim.addEventListener('change', () => { est.fim = sFim.value; render(); });
    const atalho = (txt, f) => el('button', { type: 'button', class: 'secundario pequeno', onclick: () => { f(); render(); } }, txt);
    form.append(linha('em', sIni, el('span', { class: 'frase-e' }, 'até'), sFim,
      atalho('só o último', () => { est.ini = est.fim = per[per.length - 1].id; }),
      atalho('série inteira', () => { est.ini = (per.find(p => !cedo(p)) || per[0]).id; est.fim = per[per.length - 1].id; }),
      el('p', { class: 'nota' }, est.ini === est.fim ? 'Um período só: gráfico de barras.' : 'Vários períodos: gráfico de linha, uma linha por grupo.')));

    form.append(el('div', { class: 'acoes' }, el('button', { type: 'submit', id: 'cq-ver', disabled: rodando }, rodando ? 'Calculando…' : 'Ver resultado')));
    if (focoId) { const f = form.querySelector('#' + CSS.escape(focoId)); if (f) f.focus(); }
    // A URL e o link "Consultar" acompanham a frase; o resultado antigo fica esmaecido até rodar de novo.
    const h = estadoParaHash(est);
    if (naRota()) { try { history.replaceState(null, '', h); } catch { /* sem history */ } }
    for (const a of document.querySelectorAll('a[data-rota="consultar"], a.marca')) a.setAttribute('href', h);
    const velho = hashExecutado !== null && h !== hashExecutado;
    saida.classList.toggle('desatualizado', velho);
    mudou.hidden = !velho;
  }

  function tituloFrase() {
    const m = medidasDe(est.base).find(x => x.id === est.medida);
    const { a, b } = intervalo();
    const t0 = cat.tabelas[est.base];
    const partes = [m.nome.replace(/^(o|a|os|as) /, '').replace(/ \(.*\)$/, '')];
    for (const c of est.conds) {
      if (!c.valores.length) continue;
      const d = dimsDe(est.base).find(x => x.id === c.dim);
      const rot = c.valores.map(v => rotCat(c.dim, v, (d.categorias || {})[v] ?? v));
      partes.push(`${nomeDim(est.base, c.dim).replace(/ \(.*\)$/, '').replace(/^Situação: .*/, 'situação')}: ${rot.length > 3 ? `${rot.length} categorias` : rot.join(' ou ')}`);
    }
    let s = partes.join(' · ');
    const seps = [est.por, est.e].filter(Boolean).map(id => nomeDim(est.base, id).replace(/ \(.*\)$/, '').toLowerCase());
    if (t0.ativo && !t0.amostral) s += est.ativos !== false ? ' (ativos em 31/12)' : ' (todos os vínculos do ano)';
    if (m.exigePor && seps.length === 2) s = `${partes.join(' · ')}: ${seps[0]} dentro de cada ${seps[1]} (cada ${seps[1]} soma 100%)`;
    else if (seps.length) s += `, por ${seps.join(' e ')}`;
    return `${s} — ${BASES[est.base].curto}, ${a.id === b.id ? a.rotulo : `${a.rotulo} a ${b.rotulo}`}`;
  }

  async function rodar() {
    if (rodando) return;
    normalizar();
    est.avisoTroca = '';
    rodando = true;
    const hRodado = estadoParaHash(est);
    const t = cat.tabelas[est.base];
    const dims = dimsDe(est.base);
    const m = medidasDe(est.base).find(x => x.id === est.medida);
    let plano = null;
    render();
    hashExecutado = null;
    saida.classList.remove('desatualizado'); mudou.hidden = true;
    saida.innerHTML = '';
    saida.append(el('p', { class: 'mudo', role: 'status' }, 'Calculando…'));
    try {
      const { a } = intervalo();
      if (m.desde && a.ano < m.desde) throw new Error(`Esta medida só existe de ${m.desde} em diante. Mude o início do período.`);
      const vazias = est.conds.filter(c => !c.valores.length);
      if (vazias.length) throw new Error(`Escolha ao menos uma categoria em "${nomeDim(est.base, vazias[0].dim)}", ou tire a condição.`);
      for (const id of [est.por, est.e, ...est.conds.map(c => c.dim)].filter(Boolean)) {
        if ((m.semSentido || {})[id]) throw new Error(`"${nomeDim(est.base, id)}" não serve para ${m.nome} (${m.semSentido[id]}). O resultado seria 0% ou 100% em tudo. Tire essa variável ou troque a medida.`);
        const disp = disponibilidade(dims.find(d => d.id === id));
        if (!disp.ok) throw new Error(`"${nomeDim(est.base, id)}" não tem dado no período escolhido (${disp.motivo}).`);
      }
      const p = { base: est.base, ...m.est, ativos: est.ativos, linha: est.por, coluna: est.e, ini: est.ini, fim: est.fim,
        filtros: est.conds.map(c => ({ dim: c.dim, valores: c.valores })) };
      plano = await planejar(cat, motor, t, dims, p);
      const r = await motor.consultar(plano.sql, { origem: 'consultar', silencioso: Boolean(plano.previa) });
      if (plano.previa) motor.emitir('consulta', juntarStats(plano.previa, r.stats));
      plano.titulo = tituloFrase();
      plano.notaMedida = m.nota || '';
      plano.nomeLinha = est.por ? nomeDim(est.base, est.por) : null;
      plano.nomeColuna = est.e ? nomeDim(est.base, est.e) : null;
      plano.soRotulo = true;
      plano.decimais = m.decimais;
      plano.temFiltro = est.conds.length > 0;
      plano.eixo = `${m.nome.replace(/^(o|a|os|as) /, '').replace(/ \(.*\)$/, '')}${m.unidade && m.unidade !== 'pessoas' && m.unidade !== 'vínculos' && m.unidade !== 'estabelecimentos' ? ` (${m.unidade})` : ''}`;
      plano.ordenarBarras = Boolean(est.por) && !(itemCurto(est.base, est.por) || {}).ordinal;
      for (const x of r.linhas) {
        if (typeof x.linha_rotulo === 'string') x.linha_rotulo = rotCat(est.por, String(x.linha), x.linha_rotulo);
        if (typeof x.coluna_rotulo === 'string') x.coluna_rotulo = rotCat(est.e, String(x.coluna), x.coluna_rotulo);
      }
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
      if (m.est.medida === 'taxa' && r.linhas.length > 1 && r.linhas.every(x => x.estimativa === 0 || x.estimativa === 1 || x.estimativa === null)) {
        saida.prepend(el('p', { class: 'aviso' }, 'Todas as taxas saíram 0% ou 100%: provavelmente a variável escolhida só existe para uma parte das pessoas (por exemplo, só para ocupados) e não serve para esta medida.'));
      }
      hashExecutado = hRodado;
    } catch (e) {
      if (plano && plano.previa && e.stats) motor.emitir('consulta', juntarStats(plano.previa, e.stats));
      saida.innerHTML = '';
      saida.append(el('p', { class: 'erro', id: 'cq-erro' }, String(e.message || e) + dicaErro(e.message || e)));
      if (plano && plano.sql) saida.append(el('button', { type: 'button', class: 'secundario', onclick: () => ctx.abrirNoEditor(plano.sql) }, 'Abrir no SQL'));
    } finally {
      rodando = false;
      render();
    }
  }

  form.addEventListener('submit', ev => { ev.preventDefault(); rodar(); });

  function definir(novo, executar = true) {
    if (!novo || !bases.includes(novo.base)) return;
    if (novo.usar) {
      // Vindo do Dicionário: a variável entra na frase que já estava montada (separação ou condição a preencher).
      const v = novo.usar === 'sep' ? novo.por : ((novo.conds || [])[0] || {}).dim;
      if (novo.base !== est.base) trocarBase(novo.base);
      normalizar();
      if (v && dimsDe(est.base).some(d => d.id === v)) {
        if (novo.usar === 'sep') { if (!est.por || est.por === v) est.por = v; else est.e = v; }
        else if (!est.conds.some(c => c.dim === v)) est.conds.push({ dim: v, valores: [] });
        if (!itemCurto(est.base, v)) mais[novo.usar === 'sep' ? (est.por === v ? 'por' : 'e') : `cond-${est.conds.length - 1}`] = false;
      }
      render();
      form.scrollIntoView({ block: 'nearest' });
      return;
    }
    Object.assign(est, { conds: [], por: '', e: '', ini: null, fim: null, ativos: true }, JSON.parse(JSON.stringify(novo)));
    for (const k of ['usar', 'temMedida']) delete est[k];
    for (const k of Object.keys(mais)) delete mais[k];
    render();
    if (executar) rodar();
  }

  for (const ex of EXEMPLOS) {
    if (!bases.includes(ex.estado.base)) continue;
    chips.append(el('button', { type: 'button', class: 'chip', onclick: () => { definir(ex.estado); form.scrollIntoView({ block: 'nearest' }); } }, ex.titulo));
  }

  const doHash = hashParaEstado(location.hash);
  if (doHash) definir(doHash, !doHash.usar && doHash.temMedida);
  else { render(); saida.append(el('p', { class: 'mudo' }, 'Monte a frase acima e clique em "Ver resultado", ou comece por um dos exemplos.')); }

  return { definir, rodar, estado: () => JSON.parse(JSON.stringify(est)), aoHash: () => {
      // Voltar para a página com a mesma frase (menu, botão Voltar) não mexe em nada nem roda de novo.
      if (location.hash === estadoParaHash(est)) return;
      const h = hashParaEstado(location.hash);
      if (h) definir(h, !h.usar);
    } };
}
