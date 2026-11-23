// Gráficos com Observable Plot (versão fixada). Linha para séries no tempo; barras para um período só.
import { el, num } from './util.js';

const URL_PLOT = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm';
const MAX_SERIES = 8;
const MAX_BARRAS = 60;
const CORTE = 40;
// Largura do rótulo em pixels, na fonte dos eixos do Plot (12px, sans-serif).
let ctx2d = null;
function larguraTexto(s) {
  if (!ctx2d) { ctx2d = document.createElement('canvas').getContext('2d'); ctx2d.font = '12px system-ui, sans-serif'; }
  return ctx2d.measureText(String(s || '')).width;
}
function cortarPx(s, maxPx) {
  let t = String(s || '');
  if (larguraTexto(t) <= maxPx) return t;
  while (t.length > 4 && larguraTexto(t + '…') > maxPx) t = t.slice(0, -1);
  return t + '…';
}
// Rótulo longo é cortado no eixo; o texto inteiro fica na dica e na tabela.
const cortar = (s, n = CORTE) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
let plotP = null;

function cores() {
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v(`--serie-${i}`)),
    texto: v('--fg'), mudo: v('--muted'), linha: v('--line'), fundo: v('--card'),
  };
}

export async function desenharGrafico(alvo, linhas, plano) {
  alvo.innerHTML = '';
  if (!linhas.length) return;
  const Plot = await (plotP || (plotP = import(URL_PLOT)));
  const c = cores();
  const campo = plano.amostral ? 'estimativa' : 'valor';
  const escala = plano.amostral && plano.ehProporcao ? 100 : 1;
  const unidade = plano.amostral && plano.ehProporcao ? '%' : '';
  const serieDe = x => [x._linha, x._coluna].filter(Boolean).join(' · ') || 'Município do Rio';
  let dados = linhas.filter(x => Number.isFinite(x[campo])).map(x => ({
    periodo: x._periodo, serie: serieDe(x), linha: x._linha || 'Município do Rio', coluna: x._coluna || null,
    y: x[campo] * escala,
    y1: plano.amostral ? x.ic95_inf * escala : null, y2: plano.amostral ? x.ic95_sup * escala : null,
    cv: x.cv, aviso: x._aviso ? x._aviso.texto : '', n: plano.amostral ? x.n_amostra : x.registros,
  }));
  if (!dados.length) return;
  const periodos = [...new Set(dados.map(d => d.periodo))];
  const largura = Math.max(300, Math.min(1100, alvo.clientWidth || 640));
  const fmtY = v => num(v, plano.amostral ? (escala === 100 ? 1 : 2) : (Math.abs(v) >= 1000 ? 0 : 2)) + unidade;
  const titulo = d => `${d.serie}\n${d.periodo}: ${fmtY(d.y)}${d.y1 !== null ? `\nIC 95%: ${fmtY(d.y1)} a ${fmtY(d.y2)}\nCV: ${num(d.cv * 100, 1)}%${d.aviso ? ` (${d.aviso})` : ''}` : ''}\n${plano.amostral ? 'n amostral' : 'registros'}: ${num(d.n)}`;
  const rotuloEixo = plano.amostral ? (unidade ? 'estimativa (%)' : 'estimativa') : (plano.medida === 'contagem' ? 'contagem' : 'valor');
  const notas = [];
  let fig;

  if (periodos.length > 1) {
    let series = [...new Set(dados.map(d => d.serie))];
    if (series.length > MAX_SERIES) {
      // As maiores séries (pela média no período) entram no gráfico; a tabela tem todas.
      const media = s => { const v = dados.filter(d => d.serie === s).map(d => d.y); return v.reduce((a, b) => a + b, 0) / v.length; };
      const manter = new Set([...series].sort((a, b) => media(b) - media(a)).slice(0, MAX_SERIES));
      notas.push(`O gráfico mostra ${MAX_SERIES} de ${series.length} séries (as de maior valor médio); a tabela tem todas.`);
      series = series.filter(s => manter.has(s));
      dados = dados.filter(d => manter.has(d.serie));
    }
    const passo = Math.ceil(periodos.length / Math.max(4, Math.floor(largura / 70)));
    // Série anual: eixo numérico, e a linha é interrompida nos anos sem dado (ex.: RAIS ainda incompleta).
    const anual = periodos.every(p => /^\d{4}$/.test(p));
    let escalaX;
    if (anual) {
      for (const d of dados) d.x = Number(d.periodo);
      const anos = dados.map(d => d.x), a0 = Math.min(...anos), a1 = Math.max(...anos);
      const faltam = [];
      for (const s of series) {
        const tem = new Set(dados.filter(d => d.serie === s).map(d => d.x));
        for (let a = a0; a <= a1; a++) if (!tem.has(a)) faltam.push({ x: a, y: NaN, y1: NaN, y2: NaN, serie: s, periodo: String(a) });
      }
      if (faltam.length) notas.push(`Sem dado publicado em ${[...new Set(faltam.map(f => f.x))].join(', ')}: a linha é interrompida nesses anos.`);
      dados = dados.concat(faltam).sort((p, q) => p.x - q.x);
      escalaX = { type: 'linear', label: null, tickFormat: v => String(v), ticks: Math.min(a1 - a0 + 1, Math.max(4, Math.floor(largura / 60))) };
    } else {
      for (const d of dados) d.x = d.periodo;
      escalaX = { type: 'point', domain: periodos, label: null, ticks: periodos.filter((_, i) => i % passo === 0), tickRotate: periodos.length > 8 ? -35 : 0 };
    }
    const validos = dados.filter(d => Number.isFinite(d.y));
    fig = Plot.plot({
      width: largura, height: 360, marginLeft: 64, marginBottom: 48,
      style: { background: 'transparent', color: c.texto, fontSize: '12px' },
      x: escalaX,
      y: { grid: true, label: rotuloEixo, zero: !plano.amostral || plano.ehProporcao, tickFormat: v => num(v, Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 1) },
      color: { domain: series, range: c.series.slice(0, series.length), legend: series.length > 1 },
      marks: [
        plano.amostral ? Plot.areaY(dados, { x: 'x', y1: 'y1', y2: 'y2', fill: 'serie', fillOpacity: 0.14, curve: 'linear' }) : null,
        Plot.lineY(dados, { x: 'x', y: 'y', stroke: 'serie', strokeWidth: 2 }),
        Plot.dot(validos, { x: 'x', y: 'y', fill: 'serie', r: 3, stroke: c.fundo, strokeWidth: 1 }),
        Plot.tip(validos, Plot.pointerX({ x: 'x', y: 'y', title: titulo })),
      ],
    });
    if (plano.amostral) notas.push('Faixa sombreada: IC 95%.');
  } else {
    if (dados.length > MAX_BARRAS) {
      notas.push(`O gráfico mostra as ${MAX_BARRAS} primeiras de ${dados.length} barras; a tabela tem todas.`);
      dados = dados.slice(0, MAX_BARRAS);
    }
    const temColuna = dados.some(d => d.coluna);
    const teto = (largura < 500 ? 160 : 300) - 14;
    const rotY = v => cortarPx(cortar(v), teto);
    const linhasUnicas = [...new Set(dados.map(d => d.linha))];
    const opac = d => (/não confiável/.test(d.aviso) ? 0.35 : /cautela/.test(d.aviso) ? 0.65 : 1);
    const alturaFacet = Math.max(28, linhasUnicas.length * 22 + 12);
    const facetas = temColuna ? [...new Set(dados.map(d => d.coluna))].length : 1;
    fig = Plot.plot({
      width: largura, height: Math.min(2400, facetas * alturaFacet + 70), marginBottom: 42,
      marginLeft: Math.max(90, Math.max(...linhasUnicas.map(s => larguraTexto(rotY(s)))) + 14), marginRight: temColuna ? Math.min(140, largura * 0.22) : 24,
      style: { background: 'transparent', color: c.texto, fontSize: '12px' },
      x: { grid: true, label: rotuloEixo, labelAnchor: 'right', zero: true, tickFormat: v => num(v, Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 1) },
      y: { label: null, domain: linhasUnicas, tickFormat: v => rotY(v) },
      fy: temColuna ? { label: null, tickFormat: v => cortar(v, 22) } : undefined,
      marks: [
        Plot.barX(dados, { x: 'y', y: 'linha', fy: temColuna ? 'coluna' : undefined, fill: c.series[0], fillOpacity: opac, rx: 2, insetTop: 2, insetBottom: 2 }),
        plano.amostral ? Plot.ruleY(dados, { y: 'linha', fy: temColuna ? 'coluna' : undefined, x1: 'y1', x2: 'y2', stroke: c.texto, strokeWidth: 1.5 }) : null,
        Plot.ruleX([0], { stroke: c.mudo }),
        Plot.tip(dados, Plot.pointerY({ x: 'y', y: 'linha', fy: temColuna ? 'coluna' : undefined, title: titulo })),
      ],
    });
    if (plano.amostral) notas.push('Traço: IC 95%. Barras mais claras: CV entre 15% e 30% (meio-tom) ou acima de 30% (bem claras).');
  }
  alvo.append(fig);
  for (const n of notas) alvo.append(el('p', { class: 'nota' }, n));
}
