// Rotas por hash, cabeçalho (estado do motor e medidor) e as páginas Início e Arquivos.
import { carregarCatalogo } from './catalogo.js';
import { Motor } from './motor.js';
import { el, num, mb, segundos, faixasAnos } from './util.js';
import { montarExplorar } from './explorar.js';
import { montarSQL } from './sql.js';
import { montarDicionario } from './dicionario.js';

const ROTAS = ['inicio', 'explorar', 'sql', 'dicionario', 'metodologia', 'arquivos'];
const montadas = new Set();
const ctx = { cat: null, motor: null, editor: null };
window.__app = ctx;

function rotaAtual() {
  const h = location.hash.replace(/^#/, '').split('?')[0];
  return ROTAS.includes(h) ? h : 'inicio';
}

function hospedagem(host) {
  if (host === location.host) return 'este site';
  if (/huggingface\.co$/.test(host)) return 'Hugging Face';
  if (/github\.io$/.test(host)) return 'GitHub Pages';
  return host;
}

function nomeDownload(a) {
  return a.urlManifesto.split('/').pop().replace(/\.zip$/i, '.parquet');
}

function urlDownload(a) {
  if (a.host === location.host) return a.url;
  if (/huggingface\.co$/.test(a.host)) return a.url + (a.url.includes('?') ? '&' : '?') + 'download=true';
  return a.url;
}

function periodoTabela(t) {
  if (t.colTrimestre) {
    const pri = t.arquivos[0], ult = t.arquivos[t.arquivos.length - 1];
    const tp = Array.isArray(pri.trimestres) && pri.trimestres.length ? pri.trimestres[0] : null;
    const tu = Array.isArray(ult.trimestres) && ult.trimestres.length ? ult.trimestres[ult.trimestres.length - 1] : null;
    if (tp && tu) return `${pri.ano}T${tp} a ${ult.ano}T${tu}`;
  }
  return t.anos.length ? faixasAnos(t.anos) : '—';
}

function montarInicio() {
  const { cat } = ctx;
  document.getElementById('inicio-manifestos').textContent = cat.manifestos.map(m => m.ok
    ? `${m.url.split('/').pop()}, gerado em ${m.gerado_em || '—'}`
    : `${m.url.split('/').pop()}: ainda não publicado`).join('; ');
  const tab = document.getElementById('tab-cobertura');
  tab.innerHTML = '';
  tab.append(el('thead', {}, el('tr', {}, ['Tabela no SQL', 'Base', 'Período', 'Arquivos', 'Linhas', 'Tamanho', 'Onde'].map(c => el('th', {}, c)))));
  const tabelas = Object.values(cat.tabelas).filter(t => t.arquivos.length);
  tab.append(el('tbody', {}, tabelas.map(t => el('tr', {},
    el('td', {}, el('code', {}, t.chave)), el('td', {}, t.titulo || ''), el('td', {}, periodoTabela(t)),
    el('td', { class: 'num' }, num(t.arquivos.length)), el('td', { class: 'num' }, t.linhas ? num(t.linhas) : '—'),
    el('td', { class: 'num' }, t.bytes ? mb(t.bytes) : '—'), el('td', {}, [...new Set(t.arquivos.map(a => hospedagem(a.host)))].join(', '))))));
  if (!tabelas.length) tab.append(el('tbody', {}, el('tr', {}, el('td', { colspan: 7 }, 'Nenhum manifesto publicado ainda.'))));
  const faltam = cat.manifestos.filter(m => !m.ok);
  if (faltam.length) tab.after(el('p', { class: 'aviso' }, `Ainda sem dados: ${faltam.map(m => m.nome.toUpperCase()).join(' e ')} (manifesto não publicado).`));
}

function montarArquivos() {
  const raiz = document.getElementById('arquivos-raiz');
  raiz.innerHTML = '';
  for (const t of Object.values(ctx.cat.tabelas)) {
    if (!t.arquivos.length) continue;
    raiz.append(el('h2', {}, t.titulo || t.chave), el('p', { class: 'mudo' }, el('code', {}, t.chave), t.nota ? ` · ${t.nota}` : '',
      t.dicionario ? [' · dicionário: ', el('a', { href: t.dicionario, download: t.dicionario.split('/').pop() }, t.dicionario.split('/').pop())] : ''));
    const tab = el('table', { class: 'dados' },
      el('thead', {}, el('tr', {}, ['Ano', ...(t.colTrimestre ? ['Trimestres'] : []), 'Linhas', 'Tamanho', 'Onde', 'Download'].map(c => el('th', {}, c)))),
      el('tbody', {}, t.arquivos.map(a => el('tr', {},
        el('td', {}, a.ano ?? '—'), t.colTrimestre ? el('td', {}, Array.isArray(a.trimestres) ? a.trimestres.join(', ') : '—') : null,
        el('td', { class: 'num' }, a.linhas ? num(a.linhas) : '—'), el('td', { class: 'num' }, a.bytes ? mb(a.bytes) : '—'),
        el('td', {}, hospedagem(a.host)),
        el('td', {}, el('a', { href: urlDownload(a), download: nomeDownload(a), class: 'baixar' }, nomeDownload(a)))))));
    raiz.append(el('div', { class: 'rolagem' }, tab));
  }
  if (!raiz.children.length) raiz.append(el('p', { class: 'aviso' }, 'Nenhum manifesto publicado ainda.'));
}

function mostrarRota() {
  const r = rotaAtual();
  for (const s of document.querySelectorAll('[data-pagina]')) s.hidden = s.dataset.pagina !== r;
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('ativa', a.dataset.rota === r);
  if (!ctx.cat) return;
  if (!montadas.has(r)) {
    if (r === 'inicio') { montarInicio(); montadas.add(r); }
    if (r === 'arquivos') { montarArquivos(); montadas.add(r); }
    if (r === 'dicionario') { montarDicionario(document.getElementById('dicionario-raiz'), ctx); montadas.add(r); }
    if (r === 'explorar' || r === 'sql') {
      montadas.add(r);
      ctx.motor.iniciar().then(() => {
        if (r === 'explorar') montarExplorar(document.getElementById('explorar-raiz'), ctx);
        else ctx.editor = montarSQL(document.getElementById('sql-raiz'), ctx);
      }).catch(e => {
        document.getElementById(`${r}-raiz`).innerHTML = '';
        document.getElementById(`${r}-raiz`).append(el('p', { class: 'erro' }, `O motor não carregou: ${e.message || e}`));
      });
    }
  } else if (r === 'sql' && ctx.editor) {
    const m = location.hash.match(/^#sql\?q=(.*)$/);
    if (m) { try { ctx.editor.definir(decodeURIComponent(m[1])); } catch { /* hash inválido */ } }
  }
  if (r !== 'inicio') window.scrollTo(0, 0);
}

ctx.abrirNoEditor = sql => {
  try { sessionStorage.setItem('sql-texto', sql); } catch { /* sem armazenamento */ }
  if (ctx.editor) ctx.editor.definir(sql);
  location.hash = 'sql';
};

function ligarCabecalho() {
  const st = document.getElementById('motor-status');
  const med = document.getElementById('medidor');
  const det = document.getElementById('medidor-detalhe');
  let ultima = null;
  ctx.motor.on('estado', ({ estado, detalhe }) => {
    st.textContent = estado === 'pronto' ? `Motor pronto · ${detalhe}` : estado === 'erro' ? `Motor com erro: ${detalhe}` : `Motor: ${detalhe}…`;
    st.className = `pilula ${estado}`;
    atualizarMotorInicio();
  });
  ctx.motor.on('consulta', s => {
    ultima = s;
    med.textContent = `Última consulta: ${mb(s.dados.bytes)} · ${s.dados.req} req · sessão ${mb(s.sessao.dados.bytes)}`;
    if (!det.hidden) detalhar();
    atualizarMotorInicio();
  });
  function detalhar() {
    det.innerHTML = '';
    if (!ultima) { det.append(el('p', {}, 'Nenhuma consulta ainda.')); return; }
    const s = ultima;
    det.append(el('p', {}, `Última consulta (${s.origem}): ${mb(s.dados.bytes)} de dados em ${s.dados.req} requisições, ${segundos(s.ms)}.`
      + (s.motor.req ? ` Motor e extensões: ${mb(s.motor.bytes)} em ${s.motor.req} requisições.` : '')
      + ` Sessão: ${mb(s.sessao.dados.bytes)} de dados em ${s.sessao.dados.req} requisições; motor e extensões ${mb(s.sessao.motor.bytes)} (descomprimido; fica no cache do navegador).`));
    const hosts = Object.entries(s.porHost);
    if (hosts.length) det.append(el('table', { class: 'dados compacta' }, el('thead', {}, el('tr', {}, ['Servidor', 'Requisições', 'Bytes'].map(c => el('th', {}, c)))),
      el('tbody', {}, hosts.map(([h, x]) => el('tr', {}, el('td', {}, h), el('td', { class: 'num' }, x.req), el('td', { class: 'num' }, mb(x.bytes)))))));
    det.append(el('p', { class: 'nota' }, 'Os bytes são contados no worker do DuckDB, resposta por resposta (HEAD e leituras parciais). No Hugging Face cada leitura passa antes por um redirecionamento, uma resposta pequena que o navegador segue sozinho e que o medidor não vê.'));
  }
  med.addEventListener('click', () => {
    det.hidden = !det.hidden;
    med.setAttribute('aria-expanded', String(!det.hidden));
    if (!det.hidden) detalhar();
  });
}

function atualizarMotorInicio() {
  const p = document.getElementById('inicio-motor');
  if (!p || !ctx.motor) return;
  const s = ctx.motor.medidor.sessao;
  p.textContent = `Nesta sessão: ${mb(s.dados.bytes)} de dados em ${num(s.dados.req)} requisições; motor e extensões (DuckDB-WASM, httpfs e parquet): ${mb(s.motor.bytes)} (contagem aproximada), baixados na primeira visita e guardados no cache do navegador.`;
}

async function iniciar() {
  window.addEventListener('hashchange', mostrarRota);
  mostrarRota();
  try {
    ctx.cat = await carregarCatalogo();
  } catch (e) {
    document.getElementById('conteudo').prepend(el('p', { class: 'erro' }, `Não foi possível ler os manifestos: ${e.message || e}`));
    return;
  }
  ctx.motor = new Motor(ctx.cat);
  ligarCabecalho();
  atualizarMotorInicio();
  ctx.motor.iniciar().catch(e => console.error(e));
  mostrarRota();
}

iniciar();
