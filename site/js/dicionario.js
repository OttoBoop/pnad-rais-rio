// Dicionário: busca por código, descrição e rótulo de categoria, com os anos em que a variável existe.
import { el, esc, faixasAnos, num } from './util.js';
import { BASES } from './curadoria.js';

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function montarDicionario(raiz, ctx) {
  const { cat } = ctx;
  raiz.innerHTML = '';
  const entradas = [];
  for (const [tabela, vars] of Object.entries(cat.dic)) {
    const t = cat.tabelas[tabela];
    for (const [nome, v] of Object.entries(vars)) {
      const cats = v.categorias ? Object.entries(v.categorias) : [];
      entradas.push({
        tabela, titulo: (t && t.titulo) || tabela, nome, v, cats,
        chave: normalizar(`${nome} ${v.descricao} ${v.quesito || ''} ${cats.map(([c, r]) => `${c} ${r}`).join(' ')}`),
      });
    }
  }
  for (const [nome, cl] of Object.entries(cat.classificacoes)) {
    for (const [nivel, mapa] of Object.entries(cl.niveis || {})) {
      const cats = Object.entries(mapa);
      entradas.push({
        tabela: nome, titulo: cl.titulo || nome, nome: nivel, classificacao: true, cats,
        v: { descricao: `${cl.titulo || nome}: nível ${nivel.replace(/_/g, ' ')}`, tipo: '', anos: null },
        chave: normalizar(`${nome} ${nivel} ${cats.map(([c, r]) => `${c} ${r}`).join(' ')}`),
      });
    }
  }
  const tabelas = [...new Set(entradas.map(e => e.tabela))];
  const busca = el('input', { type: 'search', id: 'dic-busca', placeholder: 'código, descrição ou categoria (ex.: V2010, rendimento, programador)', 'aria-label': 'Buscar no dicionário' });
  const selTab = el('select', { id: 'dic-tabela', 'aria-label': 'Tabela' }, el('option', { value: '' }, 'Todas as tabelas'),
    tabelas.map(t => el('option', { value: t }, (cat.tabelas[t] && cat.tabelas[t].titulo) || (cat.classificacoes[t] && cat.classificacoes[t].titulo) || t)));
  const contagem = el('p', { class: 'mudo', id: 'dic-contagem' });
  const lista = el('div', { class: 'dic-lista', id: 'dic-lista' });
  const mais = el('button', { type: 'button', class: 'secundario', hidden: true }, 'Mostrar mais');
  let limite = 60;

  function render() {
    const termos = normalizar(busca.value).split(/\s+/).filter(Boolean);
    const filtradas = entradas.filter(e => (!selTab.value || e.tabela === selTab.value) && termos.every(t => e.chave.includes(t)));
    contagem.textContent = `${num(filtradas.length)} de ${num(entradas.length)} variáveis e níveis`;
    lista.innerHTML = '';
    for (const e of filtradas.slice(0, limite)) lista.append(item(e, termos));
    mais.hidden = filtradas.length <= limite;
  }

  function item(e, termos) {
    const v = e.v;
    const meta = [
      el('span', { class: 'etiqueta' }, e.titulo),
      v.tipo ? el('span', { class: 'etiqueta' }, v.tipo) : null,
      v.anos ? el('span', { class: 'etiqueta', title: 'anos com algum valor não nulo no Rio' }, faixasAnos(v.anos)) : null,
      v.classificacao ? el('span', { class: 'etiqueta' }, `códigos em ${v.classificacao}`) : null,
    ];
    const det = el('div', { class: 'dic-item' },
      el('div', { class: 'dic-topo' }, el('code', { class: 'dic-nome' }, e.nome), el('span', { class: 'dic-desc' }, v.descricao || '')),
      el('div', { class: 'dic-meta' }, meta),
      v.quesito ? el('p', { class: 'nota' }, `Quesito: ${v.quesito}`) : null,
      v.periodo ? el('p', { class: 'nota' }, `Período de referência: ${v.periodo}`) : null,
      v.nulo ? el('p', { class: 'nota' }, `Valor vazio (NULL): ${v.nulo}`) : null,
      v.valores && v.valores.length ? el('p', { class: 'nota' }, `Valores: ${v.valores.join('; ')}`) : null,
      v.nota ? el('p', { class: 'nota' }, v.nota) : null,
      Array.isArray(v.anos_preenchida) ? el('p', { class: 'nota' }, `Preenchida (1% ou mais das linhas) em: ${faixasAnos(v.anos_preenchida)}`) : null,
      Array.isArray(v.codigos_ignorado) && v.codigos_ignorado.length ? el('p', { class: 'nota' }, `Códigos de ignorado: ${v.codigos_ignorado.join(', ')}`) : null,
      v.chave_tabela ? el('p', { class: 'nota' }, 'Para cruzar com a classificação: ', el('code', {}, v.chave_tabela)) : null,
      Array.isArray(v.categorias_por_periodo) && v.categorias_por_periodo.length
        ? el('p', { class: 'nota' }, `As categorias mudam por período (${v.categorias_por_periodo.map(p => Array.isArray(p.anos) ? faixasAnos(p.anos) : p.anos).join('; ')}); a lista abaixo junta todas.`) : null);
    if (e.cats.length) {
      const casam = termos.length ? e.cats.filter(([c, r]) => termos.some(t => normalizar(`${c} ${r}`).includes(t))) : [];
      const tab = el('table', { class: 'dados compacta' }, el('tbody', {}, e.cats.slice(0, 400).map(([c, r]) => el('tr', {}, el('td', { class: 'num' }, c), el('td', {}, r)))));
      const d = el('details', { open: casam.length > 0 && casam.length <= 12 },
        el('summary', {}, `${num(e.cats.length)} categorias${casam.length ? ` (${casam.length} com o termo buscado)` : ''}`),
        el('div', { class: 'rolagem' }, tab),
        e.cats.length > 400 ? el('p', { class: 'nota' }, 'Lista cortada em 400; a tabela dic_categorias tem todas.') : null);
      det.append(d);
    }
    if (!e.classificacao && BASES[e.tabela] && e.cats.length > 1) {
      const b = encodeURIComponent(e.tabela), n = encodeURIComponent(e.nome);
      det.append(el('p', { class: 'dic-usar' }, 'Usar na consulta: ',
        el('a', { href: `#consultar?b=${b}&por=${n}`, 'data-usar': 'sep' }, 'separar por esta variável'), ' · ',
        el('a', { href: `#consultar?b=${b}&f=${n}~&usar=cond`, 'data-usar': 'cond' }, 'escolher um grupo dela')));
    }
    if (v.categorias_por_ano) det.append(el('p', { class: 'nota' }, `As categorias mudam entre anos (${Object.keys(v.categorias_por_ano).join(', ')}); a lista acima junta todas. No SQL: dic_categorias.`));
    return det;
  }

  busca.addEventListener('input', () => { limite = 60; render(); });
  selTab.addEventListener('change', () => { limite = 60; render(); });
  mais.addEventListener('click', () => { limite += 120; render(); });
  raiz.append(el('div', { class: 'sql-barra' }, busca, selTab), contagem, lista, mais,
    el('p', { class: 'nota' }, 'No SQL: ', el('code', {}, 'dic_variaveis'), ' e ', el('code', {}, 'dic_categorias'), '.'));
  render();
  if (!entradas.length) lista.append(el('p', { class: 'aviso' }, 'Nenhum dicionário publicado nos manifestos ainda.'));
}

export { esc };
