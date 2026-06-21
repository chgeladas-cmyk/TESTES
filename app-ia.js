/**
 * app-ia.js — Módulo de Inteligência Artificial
 * CH Geladas PDV v8.0
 *
 * LocalAnalyzer:
 *  1. Diagnóstico de estoque (esgotados, stock baixo, margem baixa, sem giro)
 *  2. Previsão de ruptura (dias até esgotar por produto)
 *  3. Comparativo hoje vs histórico
 *  4. Melhor horário para promoção
 *  5. Sugestão de packs automáticos
 *  6. Análise de delivery
 *  7. Resumo financeiro
 *
 * IAService: chat com Claude API (opcional)
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   LOCAL ANALYZER
═══════════════════════════════════════════════════════════ */
const LocalAnalyzer = (() => {

  function _fmt(v)  { return Utils.formatCurrency(v); }
  function _esc(t)  { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _pct(v)  { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

  /* ── Coleta dados brutos ──────────────────────────────── */
  function _getData() {
    const estoque    = Store.Selectors.getEstoque()    || [];
    const vendas     = Store.Selectors.getVendas()     || [];
    const config     = Store.Selectors.getConfig()     || {};
    const delivery   = Store.Selectors.getDelivery()   || {};
    const thresh     = config.alertaStock ?? 3;

    // ── Mapas de produto ──
    const estoqueMap = {};
    estoque.forEach(p => { estoqueMap[String(p.id)] = p; });

    // ── Contagem de vendas por produto ──
    const vendaProd = {};
    vendas.forEach(v => (v.itens || []).forEach(it => {
      const key = String(it.prodId || '');
      if (!vendaProd[key]) vendaProd[key] = { nome: it.nome || key, qtd: 0, receita: 0, custo: 0, dias: new Set() };
      const qtd = it.desconto || it.qtd || 1;
      vendaProd[key].qtd     += qtd;
      vendaProd[key].receita += it.preco  || 0;
      vendaProd[key].custo   += it.custo  || 0;
      if (v.dataCurta) vendaProd[key].dias.add(v.dataCurta);
    }));

    // ── Datas ──
    const isoHoje  = Utils.todayISO();
    const dispHoje = Utils.today();

    // ── Vendas de hoje ──
    const vendasHoje = vendas.filter(v => {
      const dc = v.dataCurta || '';
      return dc === isoHoje || dc === dispHoje || (v.data || '').startsWith(dispHoje);
    });

    // ── Vendas dos últimos 30 dias (exceto hoje) ──
    const hoje30 = new Date();
    hoje30.setDate(hoje30.getDate() - 30);
    const vendasRecentes = vendas.filter(v => {
      const dc = v.dataCurta || '';
      if (dc === isoHoje || dc === dispHoje) return false;
      try {
        const d = dc.includes('-') ? new Date(dc) : new Date(dc.split('/').reverse().join('-'));
        return d >= hoje30;
      } catch { return false; }
    });

    // ── Dias únicos com vendas (últimos 30 dias) ──
    const diasComVenda = new Set(vendasRecentes.map(v => v.dataCurta || '').filter(Boolean));
    const numDias      = Math.max(diasComVenda.size, 1);

    // ── Receita média diária (histórico) ──
    const receitaHistorico = vendasRecentes.reduce((s, v) => s + (v.total || 0), 0);
    const mediaReceitaDia  = receitaHistorico / numDias;

    // ── Vendas por hora (histórico) ──
    const porHora = Array(24).fill(0);
    vendas.forEach(v => {
      const hora = v.hora || '';
      if (!hora) return;
      const h = parseInt(hora.split(':')[0]);
      if (!isNaN(h)) porHora[h]++;
    });

    // ── Co-ocorrência de produtos por venda ──
    const coOcorrencia = {};
    vendas.forEach(v => {
      const ids = (v.itens || []).map(it => String(it.prodId || it.nome || '')).filter(Boolean);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = [ids[i], ids[j]].sort().join('||');
          coOcorrencia[key] = (coOcorrencia[key] || 0) + 1;
        }
      }
    });

    return {
      estoque, vendas, config, delivery, thresh,
      estoqueMap, vendaProd, porHora, coOcorrencia,
      vendasHoje, vendasRecentes, numDias,
      isoHoje, dispHoje,
      receitaHistorico, mediaReceitaDia,
      totalReceita:  vendas.reduce((s, v) => s + (v.total || 0), 0),
      totalLucro:    vendas.reduce((s, v) => s + (v.lucro  || 0), 0),
      receitaHoje:   vendasHoje.reduce((s, v) => s + (v.total || 0), 0),
      lucroHoje:     vendasHoje.reduce((s, v) => s + (v.lucro || 0), 0),
      capitalParado: estoque.reduce((s, p) => s + p.qtdUn * (p.custoUn || 0), 0),
      esgotados:     Store.Selectors.getOutOfStockItems(),
      baixoStock:    Store.Selectors.getLowStockItems(),
      topVendidos:   Object.values(vendaProd).sort((a,b) => b.qtd - a.qtd).slice(0, 5),
      semGiro:       estoque.filter(p => p.qtdUn > 0 && !vendaProd[String(p.id)]),
    };
  }

  /* ══════════════════════════════════════════════════════
     1. DIAGNÓSTICO DE ESTOQUE
  ══════════════════════════════════════════════════════ */
  function _cardEstoque(d, cards) {

    // Esgotados
    if (d.esgotados.length > 0) {
      const perdaEst = d.esgotados.reduce((s, p) => {
        const giro = d.vendaProd[String(p.id)];
        return s + (giro ? (giro.receita / Math.max(giro.qtd,1)) * 2 : 0);
      }, 0);
      cards.push({
        cor:'red', icon:'fa-times-circle', prioridade: 1,
        titulo: d.esgotados.length + ' Produto(s) Esgotado(s)',
        subtitulo: perdaEst > 0 ? 'Perda estimada: ' + _fmt(perdaEst) + '/dia' : 'Repor com urgência',
        corpo: _lista(d.esgotados.slice(0,6).map(p => ({
          esq: _esc(p.nome), dir: '<span class="badge b-red text-[8px]">ESGOTADO</span>'
        }))) + '<p class="text-[10px] text-red-300/70 mt-3 font-bold">⚡ Repor estoque imediatamente para não perder vendas.</p>'
      });
    }

    // Stock baixo
    if (d.baixoStock.length > 0) {
      cards.push({
        cor:'amber', icon:'fa-exclamation-triangle', prioridade: 2,
        titulo: d.baixoStock.length + ' Produto(s) com Stock Baixo',
        subtitulo: 'Abaixo de ' + d.thresh + ' unidades',
        corpo: _lista(d.baixoStock.slice(0,6).map(p => ({
          esq: _esc(p.nome), dir: '<span class="badge b-amber text-[8px]">' + p.qtdUn + ' und</span>'
        }))) + '<p class="text-[10px] text-amber-300/70 mt-3 font-bold">⚡ Fazer pedido de reposição antes de esgotar.</p>'
      });
    }

    // Margem baixa < 20%
    const margemBaixa = d.estoque.filter(p =>
      p.precoUn > 0 && p.custoUn > 0 &&
      ((p.precoUn - p.custoUn) / p.precoUn * 100) < 20
    );
    if (margemBaixa.length > 0) {
      cards.push({
        cor:'orange', icon:'fa-percentage', prioridade: 3,
        titulo: margemBaixa.length + ' Produto(s) com Margem Baixa',
        subtitulo: 'Abaixo de 20% — vendendo quase no custo',
        corpo: '<ul class="mt-3">' + margemBaixa.slice(0,5).map(p => {
          const m   = ((p.precoUn - p.custoUn) / p.precoUn * 100).toFixed(0);
          const sug = (p.custoUn * 1.40).toFixed(2);
          return '<li class="py-1.5 border-b border-white/5 last:border-0">' +
            '<div class="flex justify-between">' +
            '<span class="text-[11px] font-bold text-slate-300">' + _esc(p.nome) + '</span>' +
            '<span class="badge b-red text-[8px]">' + m + '% margem</span></div>' +
            '<p class="text-[9px] text-emerald-400/80 font-bold mt-0.5">Preço sugerido: R$ ' + sug + ' → margem 40%</p></li>';
        }).join('') + '</ul>' +
        '<p class="text-[10px] text-amber-300/70 mt-3 font-bold">💡 Ajustar preços ou renegociar custo com fornecedor.</p>'
      });
    }

    // Sem giro
    if (d.semGiro.length > 0) {
      const vp = d.semGiro.reduce((s, p) => s + p.qtdUn * (p.custoUn || 0), 0);
      cards.push({
        cor:'slate', icon:'fa-archive', prioridade: 7,
        titulo: d.semGiro.length + ' Produto(s) sem Nenhuma Venda',
        subtitulo: 'Capital parado: ' + _fmt(vp),
        corpo: _lista(d.semGiro.slice(0,5).map(p => ({
          esq: _esc(p.nome),
          dir: '<span class="text-[10px] text-slate-500 font-bold">' + p.qtdUn + ' und · ' + _fmt(p.qtdUn*(p.custoUn||0)) + '</span>'
        }))) + '<p class="text-[10px] text-slate-400/80 mt-3 font-bold">💡 Criar promoção ou pack para escoar estes produtos.</p>'
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     2. PREVISÃO DE RUPTURA
  ══════════════════════════════════════════════════════ */
  function _cardRuptura(d, cards) {
    if (d.vendas.length === 0 || d.estoque.length === 0) return;

    const previsoes = [];

    d.estoque.forEach(p => {
      if (p.qtdUn <= 0) return;
      const giro = d.vendaProd[String(p.id)];
      if (!giro || giro.qtd === 0) return;

      // Giro diário = total vendido / dias com venda (máx 30)
      const diasComVendaProd = Math.max(giro.dias.size, 1);
      const giroDiario       = giro.qtd / Math.min(diasComVendaProd, 30);
      if (giroDiario === 0) return;

      const diasRestantes = Math.floor(p.qtdUn / giroDiario);
      if (diasRestantes <= 7) {
        previsoes.push({
          nome: p.nome,
          qtdUn: p.qtdUn,
          dias: diasRestantes,
          giroDiario: giroDiario.toFixed(1),
        });
      }
    });

    if (previsoes.length === 0) return;

    previsoes.sort((a, b) => a.dias - b.dias);

    const corpo = '<ul class="mt-3">' + previsoes.slice(0, 6).map(p => {
      const cor  = p.dias <= 2 ? 'text-red-400' : p.dias <= 4 ? 'text-amber-400' : 'text-yellow-400';
      const icon = p.dias <= 2 ? '🔴' : p.dias <= 4 ? '🟡' : '🟠';
      return '<li class="py-1.5 border-b border-white/5 last:border-0">' +
        '<div class="flex justify-between items-center">' +
        '<span class="text-[11px] font-bold text-slate-300">' + icon + ' ' + _esc(p.nome) + '</span>' +
        '<span class="text-[10px] font-black ' + cor + '">~' + p.dias + ' dia(s)</span></div>' +
        '<p class="text-[9px] text-slate-500 font-bold mt-0.5">Giro: ' + p.giroDiario + '/dia · Stock: ' + p.qtdUn + ' und</p></li>';
    }).join('') + '</ul>' +
    '<p class="text-[10px] text-amber-300/70 mt-3 font-bold">⚡ Repor antes de esgotar para não perder vendas!</p>';

    cards.push({
      cor: 'orange', icon: 'fa-clock', prioridade: 2,
      titulo: previsoes.length + ' Produto(s) com Ruptura Prevista',
      subtitulo: 'Baseado no giro diário médio',
      corpo
    });
  }

  /* ══════════════════════════════════════════════════════
     3. COMPARATIVO HOJE vs HISTÓRICO
  ══════════════════════════════════════════════════════ */
  function _cardHoje(d, cards) {
    if (d.vendas.length === 0) return;

    const recHoje  = d.receitaHoje;
    const lucHoje  = d.lucroHoje;
    const media    = d.mediaReceitaDia;
    const diff     = media > 0 ? ((recHoje - media) / media * 100) : 0;
    const acima    = diff >= 0;
    const cor      = acima ? 'emerald' : 'red';
    const seta     = acima ? '📈' : '📉';
    const diffCls  = acima ? 'text-emerald-400' : 'text-red-400';

    // Vendas de hoje por hora
    const hojeHora = Array(24).fill(0);
    d.vendasHoje.forEach(v => {
      const h = parseInt((v.hora || '').split(':')[0]);
      if (!isNaN(h)) hojeHora[h]++;
    });
    const picoHoje = hojeHora.reduce((best, val, h) => val > best.val ? {h, val} : best, {h:0, val:0});

    const corpo =
      '<div class="grid grid-cols-2 gap-2 mt-3">' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Receita Hoje</p><p class="text-sm font-black text-white">' + _fmt(recHoje) + '</p></div>' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Média Diária</p><p class="text-sm font-black text-blue-400">' + _fmt(media) + '</p></div>' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Variação</p><p class="text-sm font-black ' + diffCls + '">' + seta + ' ' + _pct(diff) + '</p></div>' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Lucro Hoje</p><p class="text-sm font-black text-emerald-400">' + _fmt(lucHoje) + '</p></div>' +
      '</div>' +
      (picoHoje.val > 0 ? '<p class="text-[10px] text-slate-400/80 mt-3 font-bold">🕐 Pico hoje: ' + picoHoje.h + 'h com ' + picoHoje.val + ' venda(s)</p>' : '') +
      (!acima && media > 0 ? '<p class="text-[10px] text-red-300/70 mt-2 font-bold">💡 Hoje abaixo da média — considere ativar uma promoção.</p>' : '');

    cards.push({
      cor, icon: 'fa-calendar-day', prioridade: 0,
      titulo: 'Desempenho de Hoje',
      subtitulo: d.vendasHoje.length + ' venda(s) · ' + (media > 0 ? _pct(diff) + ' vs média' : 'primeiro dia com dados'),
      corpo
    });
  }

  /* ══════════════════════════════════════════════════════
     4. MELHOR HORÁRIO PARA PROMOÇÃO
  ══════════════════════════════════════════════════════ */
  function _cardHorario(d, cards) {
    const total = d.porHora.reduce((s, v) => s + v, 0);
    if (total < 5) return; // poucos dados

    // Top 3 horas de pico
    const ranking = d.porHora
      .map((cnt, h) => ({ h, cnt }))
      .filter(x => x.cnt > 0)
      .sort((a, b) => b.cnt - a.cnt);

    if (ranking.length === 0) return;

    const pico1 = ranking[0];
    const pico2 = ranking[1];
    const pico3 = ranking[2];

    // Hora morta (menos vendas, entre 10h e 22h)
    const mortas = d.porHora
      .map((cnt, h) => ({ h, cnt }))
      .filter(x => x.h >= 10 && x.h <= 22 && x.cnt >= 0)
      .sort((a, b) => a.cnt - b.cnt);
    const horaMorta = mortas[0];

    // Hora ideal para promoção = 1h antes do pico principal
    const horaPromo = pico1.h > 0 ? pico1.h - 1 : pico1.h;

    const barra = (cnt) => {
      const pct = Math.round((cnt / pico1.cnt) * 100);
      return '<div class="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden"><div class="h-full bg-blue-500 rounded-full" style="width:' + pct + '%"></div></div>';
    };

    const corpo =
      '<div class="mt-3 space-y-2">' +
      [pico1, pico2, pico3].filter(Boolean).map((p, i) => {
        const labels = ['🥇','🥈','🥉'];
        return '<div class="flex items-center gap-3">' +
          '<span class="text-[11px] w-6 text-center">' + labels[i] + '</span>' +
          '<span class="text-[11px] font-black text-slate-300 w-8">' + p.h + 'h</span>' +
          barra(p.cnt) +
          '<span class="text-[10px] font-black text-blue-400 w-12 text-right">' + p.cnt + ' vnd</span>' +
          '</div>';
      }).join('') +
      '</div>' +
      '<div class="mt-3 grid grid-cols-2 gap-2">' +
      '<div class="bg-emerald-500/8 border border-emerald-500/20 rounded-xl p-3">' +
        '<p class="text-[8px] text-slate-500 uppercase font-black mb-1">⚡ Ativar promoção às</p>' +
        '<p class="text-base font-black text-emerald-400">' + horaPromo + 'h</p>' +
        '<p class="text-[9px] text-slate-500 font-bold">1h antes do pico</p>' +
      '</div>' +
      (horaMorta ? '<div class="bg-slate-800/60 border border-white/5 rounded-xl p-3">' +
        '<p class="text-[8px] text-slate-500 uppercase font-black mb-1">😴 Hora mais fraca</p>' +
        '<p class="text-base font-black text-slate-400">' + horaMorta.h + 'h</p>' +
        '<p class="text-[9px] text-slate-500 font-bold">Ideal p/ reposição</p>' +
      '</div>' : '') +
      '</div>';

    cards.push({
      cor:'blue', icon:'fa-clock', prioridade: 5,
      titulo: 'Horários de Pico',
      subtitulo: 'Pico principal: ' + pico1.h + 'h — ativar promoção às ' + horaPromo + 'h',
      corpo
    });
  }

  /* ══════════════════════════════════════════════════════
     5. SUGESTÃO DE PACKS AUTOMÁTICOS
  ══════════════════════════════════════════════════════ */
  function _cardPacks(d, cards) {
    if (Object.keys(d.coOcorrencia).length === 0) return;

    const pares = Object.entries(d.coOcorrencia)
      .filter(([, cnt]) => cnt >= 2)
      .sort(([, a],[, b]) => b - a)
      .slice(0, 5);

    if (pares.length === 0) return;

    const corpo = '<ul class="mt-3">' + pares.map(([key, cnt]) => {
      const [idA, idB] = key.split('||');
      const nomeA = d.vendaProd[idA]?.nome || d.estoqueMap[idA]?.nome || idA;
      const nomeB = d.vendaProd[idB]?.nome || d.estoqueMap[idB]?.nome || idB;
      const pA = d.estoqueMap[idA]?.precoUn || 0;
      const pB = d.estoqueMap[idB]?.precoUn || 0;
      const precoJunto = pA > 0 && pB > 0 ? _fmt((pA + pB) * 0.90) : '—';

      return '<li class="py-2 border-b border-white/5 last:border-0">' +
        '<div class="flex justify-between items-center">' +
        '<span class="text-[11px] font-bold text-slate-300">' + _esc(nomeA) + ' + ' + _esc(nomeB) + '</span>' +
        '<span class="badge b-blue text-[8px]">' + cnt + 'x juntos</span></div>' +
        (pA > 0 && pB > 0 ? '<p class="text-[9px] text-emerald-400/80 font-bold mt-0.5">Pack sugerido: ' + precoJunto + ' (-10%) vs ' + _fmt(pA+pB) + ' separados</p>' : '') +
        '</li>';
    }).join('') + '</ul>' +
    '<p class="text-[10px] text-violet-300/70 mt-3 font-bold">💡 Criar packs com desconto aumenta ticket médio e escoa estoque.</p>';

    cards.push({
      cor:'violet', icon:'fa-boxes', prioridade: 6,
      titulo: pares.length + ' Combinação(ões) Frequente(s)',
      subtitulo: 'Produtos comprados juntos — sugestão de packs',
      corpo
    });
  }

  /* ══════════════════════════════════════════════════════
     6. ANÁLISE DE DELIVERY
  ══════════════════════════════════════════════════════ */
  function _cardDelivery(d, cards) {
    const pedidos = d.delivery.pedidos || [];
    if (pedidos.length === 0) return;

    const pendentes   = pedidos.filter(p => p.status !== 'entregue' && p.status !== 'CANCELADO');
    const entregues   = pedidos.filter(p => p.status === 'entregue');
    const cancelados  = pedidos.filter(p => p.status === 'CANCELADO');

    // Zona mais lucrativa
    const porZona = {};
    pedidos.filter(p => p.status === 'entregue').forEach(p => {
      const z = p.zona || p.zonaId || 'Sem zona';
      if (!porZona[z]) porZona[z] = { total: 0, qtd: 0 };
      porZona[z].total += p.total || 0;
      porZona[z].qtd++;
    });
    const zonas = Object.entries(porZona).sort(([,a],[,b]) => b.total - a.total);

    // Entregador com mais entregas
    const porEntregador = {};
    pedidos.filter(p => p.status === 'entregue').forEach(p => {
      const e = p.entregador || p.entregadorId || 'Sem entregador';
      if (!porEntregador[e]) porEntregador[e] = 0;
      porEntregador[e]++;
    });
    const topEntregador = Object.entries(porEntregador).sort(([,a],[,b]) => b-a)[0];

    const totalDelivery = entregues.reduce((s, p) => s + (p.total || 0), 0);

    const corpo =
      '<div class="grid grid-cols-3 gap-2 mt-3">' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Pendentes</p><p class="text-sm font-black ' + (pendentes.length > 0 ? 'text-amber-400' : 'text-slate-400') + '">' + pendentes.length + '</p></div>' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Entregues</p><p class="text-sm font-black text-emerald-400">' + entregues.length + '</p></div>' +
      '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Cancelados</p><p class="text-sm font-black ' + (cancelados.length > 0 ? 'text-red-400' : 'text-slate-400') + '">' + cancelados.length + '</p></div>' +
      '</div>' +
      '<div class="mt-3 space-y-1.5">' +
      '<div class="flex justify-between items-center bg-slate-900/40 rounded-lg px-3 py-2"><span class="text-[10px] text-slate-400 font-bold">Receita Delivery</span><span class="text-[11px] font-black text-emerald-400">' + _fmt(totalDelivery) + '</span></div>' +
      (zonas.length > 0 ? '<div class="flex justify-between items-center bg-slate-900/40 rounded-lg px-3 py-2"><span class="text-[10px] text-slate-400 font-bold">🏆 Zona mais lucrativa</span><span class="text-[11px] font-black text-blue-400">' + _esc(String(zonas[0][0])) + ' · ' + _fmt(zonas[0][1].total) + '</span></div>' : '') +
      (topEntregador ? '<div class="flex justify-between items-center bg-slate-900/40 rounded-lg px-3 py-2"><span class="text-[10px] text-slate-400 font-bold">⭐ Top entregador</span><span class="text-[11px] font-black text-violet-400">' + _esc(String(topEntregador[0])) + ' · ' + topEntregador[1] + ' entregas</span></div>' : '') +
      '</div>' +
      (pendentes.length >= 3 ? '<p class="text-[10px] text-amber-300/70 mt-3 font-bold">⚡ ' + pendentes.length + ' pedidos pendentes — verificar status!</p>' : '');

    cards.push({
      cor: pendentes.length > 3 ? 'amber' : 'blue',
      icon: 'fa-motorcycle', prioridade: 4,
      titulo: 'Análise de Delivery',
      subtitulo: pedidos.length + ' pedido(s) · ' + (pendentes.length > 0 ? pendentes.length + ' pendente(s)' : 'tudo entregue ✅'),
      corpo
    });
  }

  /* ══════════════════════════════════════════════════════
     7. TOP VENDIDOS + RESUMO FINANCEIRO
  ══════════════════════════════════════════════════════ */
  function _cardTopEFinanceiro(d, cards) {
    // Top vendidos
    if (d.topVendidos.length > 0) {
      cards.push({
        cor:'emerald', icon:'fa-star', prioridade: 8,
        titulo: 'Top ' + d.topVendidos.length + ' Mais Vendidos',
        subtitulo: 'Receita: ' + _fmt(d.topVendidos.reduce((s,v)=>s+v.receita,0)),
        corpo: _lista(d.topVendidos.map(v => {
          const prod = d.estoqueMap[Object.keys(d.vendaProd).find(k => d.vendaProd[k] === v) || ''];
          const qtdAtual = prod?.qtdUn ?? '—';
          const ok = prod ? prod.qtdUn > d.thresh : true;
          return {
            esq: (ok ? '✅' : '⚠️') + ' ' + _esc(v.nome),
            dir: '<span class="text-[10px] text-emerald-400 font-black">' + v.qtd + ' vnd · ' + qtdAtual + ' stk</span>'
          };
        })) + '<p class="text-[10px] text-emerald-300/70 mt-3 font-bold">💡 Garantir que estes produtos NUNCA fiquem esgotados.</p>'
      });
    }

    // Resumo financeiro
    if (d.totalReceita > 0) {
      const margem = (d.totalLucro / d.totalReceita * 100).toFixed(1);
      const mcls   = margem >= 30 ? 'text-emerald-400' : margem >= 15 ? 'text-amber-400' : 'text-red-400';
      cards.push({
        cor:'blue', icon:'fa-chart-pie', prioridade: 9,
        titulo: 'Resumo Financeiro Global',
        subtitulo: d.vendas.length + ' venda(s) registada(s)',
        corpo:
          '<div class="grid grid-cols-2 gap-2 mt-3">' +
          '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Receita Total</p><p class="text-sm font-black text-white">' + _fmt(d.totalReceita) + '</p></div>' +
          '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Lucro</p><p class="text-sm font-black ' + mcls + '">' + _fmt(d.totalLucro) + '</p></div>' +
          '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Margem Média</p><p class="text-sm font-black ' + mcls + '">' + margem + '%</p></div>' +
          '<div class="bg-slate-900/60 rounded-xl p-3 text-center"><p class="text-[8px] text-slate-500 uppercase font-black mb-1">Capital Estoque</p><p class="text-sm font-black text-blue-400">' + _fmt(d.capitalParado) + '</p></div>' +
          '</div>' +
          (Number(margem) < 20 ? '<p class="text-[10px] text-red-300/80 font-bold mt-3">⚠️ Margem abaixo de 20% — rever preços ou custos urgente!</p>' : '')
      });
    }
  }

  /* ── Helpers ─────────────────────────────────────────── */
  function _lista(rows) {
    return '<ul class="mt-3">' + rows.map(r =>
      '<li class="flex justify-between items-center py-1.5 border-b border-white/5 last:border-0">' +
      '<span class="text-[11px] font-bold text-slate-300 truncate mr-2">' + r.esq + '</span>' +
      r.dir + '</li>'
    ).join('') + '</ul>';
  }

  /* ── Ponto de entrada: gera todos os cards ──────────── */
  function analisarTudo() {
    const d     = _getData();
    const cards = [];

    if (d.estoque.length === 0) {
      return [{
        cor:'slate', icon:'fa-box-open', prioridade:1,
        titulo:'Estoque Vazio',
        subtitulo:'Cadastre produtos para ver análises',
        corpo:'<p class="text-[11px] text-slate-400 mt-2">Vá à aba <strong class="text-blue-400">Estoque</strong> e cadastre os seus produtos.</p>'
      }];
    }

    _cardHoje(d, cards);
    _cardEstoque(d, cards);
    _cardRuptura(d, cards);
    _cardHorario(d, cards);
    _cardDelivery(d, cards);
    _cardPacks(d, cards);
    _cardTopEFinanceiro(d, cards);

    return cards.sort((a, b) => a.prioridade - b.prioridade);
  }

  /* ── Render dos cards ───────────────────────────────── */
  const COR = {
    red:     { bg:'bg-red-500/8 border-red-500/25',      icon:'text-red-400',     titulo:'text-red-300',     dot:'bg-red-400'     },
    amber:   { bg:'bg-amber-500/8 border-amber-500/25',  icon:'text-amber-400',   titulo:'text-amber-300',   dot:'bg-amber-400'   },
    orange:  { bg:'bg-orange-500/8 border-orange-500/25',icon:'text-orange-400',  titulo:'text-orange-300',  dot:'bg-orange-400'  },
    emerald: { bg:'bg-emerald-500/8 border-emerald-500/25',icon:'text-emerald-400',titulo:'text-emerald-300',dot:'bg-emerald-400' },
    blue:    { bg:'bg-blue-500/8 border-blue-500/25',    icon:'text-blue-400',    titulo:'text-blue-300',    dot:'bg-blue-400'    },
    violet:  { bg:'bg-violet-500/8 border-violet-500/25',icon:'text-violet-400',  titulo:'text-violet-300',  dot:'bg-violet-400'  },
    slate:   { bg:'bg-slate-800/60 border-white/5',      icon:'text-slate-400',   titulo:'text-slate-300',   dot:'bg-slate-500'   },
  };

  function renderCards(cards) {
    return cards.map(c => {
      const s = COR[c.cor] || COR.slate;
      return '<div class="rounded-2xl border p-5 ' + s.bg + '">' +
        '<div class="flex items-start gap-3">' +
        '<div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ' + s.bg + '">' +
        '<i class="fas ' + c.icon + ' ' + s.icon + ' text-sm"></i></div>' +
        '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-2 mb-0.5">' +
        '<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ' + s.dot + '"></span>' +
        '<p class="text-[12px] font-black ' + s.titulo + '">' + c.titulo + '</p></div>' +
        '<p class="text-[10px] text-slate-500 font-bold">' + c.subtitulo + '</p>' +
        c.corpo +
        '</div></div></div>';
    }).join('');
  }

  return { analisarTudo, renderCards };
})();


/* ═══════════════════════════════════════════════════════════
   IA SERVICE — Claude API (opcional)
═══════════════════════════════════════════════════════════ */
const IAService = (() => {
  const MODEL   = 'claude-sonnet-4-20250514';
  const API_URL = 'https://api.anthropic.com/v1/messages';

  function _buildContext() {
    const estoque  = Store.Selectors.getEstoque() || [];
    const vendas   = Store.Selectors.getVendas()  || [];
    const config   = Store.Selectors.getConfig()  || {};
    const delivery = Store.Selectors.getDelivery() || {};

    const totalReceita = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const totalLucro   = vendas.reduce((s, v) => s + (v.lucro  || 0), 0);

    const contagemProd = {};
    vendas.forEach(v => (v.itens || []).forEach(it => {
      if (!contagemProd[it.nome]) contagemProd[it.nome] = { qtd: 0, receita: 0 };
      contagemProd[it.nome].qtd     += it.desconto || 1;
      contagemProd[it.nome].receita += it.preco || 0;
    }));
    const topProdutos = Object.entries(contagemProd)
      .sort((a,b) => b[1].qtd - a[1].qtd).slice(0,8)
      .map(([nome,d]) => ({ nome, qtd: d.qtd, receita: Number(d.receita.toFixed(2)) }));

    return {
      estabelecimento: config.nome || 'PDV App',
      data: new Date().toLocaleDateString('pt-BR', { weekday:'long', year:'numeric', month:'long', day:'numeric' }),
      estoque: {
        total: estoque.length,
        esgotados: Store.Selectors.getOutOfStockItems().map(p => p.nome),
        baixoStock: Store.Selectors.getLowStockItems().map(p => ({ nome: p.nome, qtd: p.qtdUn })),
        capitalTotal: estoque.reduce((s, p) => s + p.qtdUn * (p.custoUn || 0), 0).toFixed(2),
      },
      vendas: {
        total: vendas.length,
        receita: totalReceita.toFixed(2),
        lucro: totalLucro.toFixed(2),
        margem: totalReceita > 0 ? (totalLucro/totalReceita*100).toFixed(1)+'%' : '0%',
        topProdutos,
      },
      delivery: {
        pedidos: (delivery.pedidos||[]).length,
        pendentes: (delivery.pedidos||[]).filter(p => p.status !== 'entregue').length,
      }
    };
  }

  async function analisar(pergunta) {
    const apiKey = Store.Selectors.getConfig()?.anthropicApiKey || '';
    if (!apiKey) throw new Error('API Key não configurada. Acesse ⚙️ Configurações → Anthropic API Key.');

    const ctx = _buildContext();
    const sys = 'És o assistente do PDV "' + ctx.estabelecimento + '". Analisa os dados e dá sugestões práticas em português brasileiro. Usa emojis, seja direto. Máximo 500 palavras.\n\nDADOS:\n' + JSON.stringify(ctx, null, 2);
    const msg = pergunta || 'Faz análise completa e dá as 5 sugestões mais importantes.';

    const res = await fetch(API_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': apiKey,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true',
      },
      body: JSON.stringify({ model:MODEL, max_tokens:1000, system:sys, messages:[{role:'user',content:msg}] })
    });

    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error?.message || 'Erro HTTP ' + res.status);
    }
    const data = await res.json();
    return data.content?.map(b => b.text||'').join('') || '';
  }

  return { analisar };
})();


/* ═══════════════════════════════════════════════════════════
   IA RENDERER
═══════════════════════════════════════════════════════════ */
const IARenderer = (() => {

  let _mensagens = [];
  let _analisando = false;

  function renderIA() {
    const panel = Utils.el('tab-ia');
    if (!panel) return;

    const config    = Store.Selectors.getConfig() || {};
    const temApiKey = !!(config.anthropicApiKey || '').trim();
    const estoque   = Store.Selectors.getEstoque() || [];
    const vendas    = Store.Selectors.getVendas()  || [];
    const baixo     = Store.Selectors.getLowStockItems();
    const esgotado  = Store.Selectors.getOutOfStockItems();

    const cards     = LocalAnalyzer.analisarTudo();
    const cardsHtml = LocalAnalyzer.renderCards(cards);

    const apiStatusBadge = temApiKey
      ? '<span class="ml-auto inline-flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[8px] font-black px-2 py-0.5 rounded-full"><span class="w-1 h-1 bg-emerald-400 rounded-full animate-pulse"></span>ATIVO</span>'
      : '<span class="ml-auto inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[8px] font-black px-2 py-0.5 rounded-full"><i class="fas fa-key text-[7px] mr-0.5"></i>SEM API KEY</span>';

    const apiKeyNotice = !temApiKey ? `
      <div class="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-3">
        <p class="text-[11px] font-bold text-amber-300 mb-2"><i class="fas fa-key mr-2"></i>Configure a API Key para ativar o chat com IA</p>
        <p class="text-[10px] text-slate-400 mb-3">1. Acesse <strong class="text-amber-400">console.anthropic.com</strong><br>2. Crie uma API Key<br>3. Cole em <strong class="text-blue-400">⚙️ Configurações → Anthropic API Key</strong></p>
        <button onclick="abrirConfig()" class="w-full py-2.5 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-300 font-black text-xs uppercase tracking-wide transition-all"><i class="fas fa-cog mr-2"></i>Abrir Configurações</button>
      </div>` : '';

    const btnD = !temApiKey ? 'disabled' : '';
    const btnBase = 'glass rounded-2xl p-3 text-left border border-white/5 transition-all ' + (!temApiKey ? 'opacity-30 cursor-not-allowed' : 'hover:border-violet-500/30 group');

    panel.innerHTML = `
      <div class="max-w-2xl mx-auto space-y-4 pb-6">

        <!-- HEADER -->
        <div class="glass rounded-[1.75rem] p-5 relative overflow-hidden">
          <div class="absolute inset-0 bg-gradient-to-br from-violet-900/20 via-blue-900/10 to-transparent pointer-events-none"></div>
          <div class="relative flex items-center gap-3">
            <div class="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/25 flex-shrink-0">
              <i class="fas fa-robot text-white"></i>
            </div>
            <div class="flex-1 min-w-0">
              <h2 class="text-sm font-black text-white">Análise Inteligente</h2>
              <p class="text-[10px] text-violet-400 font-bold">${config.nome || 'PDV App'} · ${cards.length} análise(s) ativas</p>
            </div>
            <button onclick="IARenderer.renderIA()" class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-all" title="Atualizar">
              <i class="fas fa-sync-alt text-xs"></i>
            </button>
          </div>
        </div>

        <!-- MINI STATS -->
        <div class="grid grid-cols-4 gap-2">
          <div class="glass rounded-2xl p-3 text-center border border-blue-500/15">
            <i class="fas fa-boxes text-blue-400 text-base mb-1 block"></i>
            <p class="text-sm font-black text-white">${estoque.length}</p>
            <p class="text-[8px] font-black text-slate-500 uppercase">Produtos</p>
          </div>
          <div class="glass rounded-2xl p-3 text-center border border-emerald-500/15">
            <i class="fas fa-receipt text-emerald-400 text-base mb-1 block"></i>
            <p class="text-sm font-black text-white">${vendas.length}</p>
            <p class="text-[8px] font-black text-slate-500 uppercase">Vendas</p>
          </div>
          <div class="glass rounded-2xl p-3 text-center border ${esgotado.length > 0 ? 'border-red-500/30' : 'border-white/5'}">
            <i class="fas fa-times-circle ${esgotado.length > 0 ? 'text-red-400' : 'text-slate-600'} text-base mb-1 block"></i>
            <p class="text-sm font-black ${esgotado.length > 0 ? 'text-red-400' : 'text-slate-500'}">${esgotado.length}</p>
            <p class="text-[8px] font-black text-slate-500 uppercase">Esgotados</p>
          </div>
          <div class="glass rounded-2xl p-3 text-center border ${baixo.length > 0 ? 'border-amber-500/30' : 'border-white/5'}">
            <i class="fas fa-exclamation-triangle ${baixo.length > 0 ? 'text-amber-400' : 'text-slate-600'} text-base mb-1 block"></i>
            <p class="text-sm font-black ${baixo.length > 0 ? 'text-amber-400' : 'text-slate-500'}">${baixo.length}</p>
            <p class="text-[8px] font-black text-slate-500 uppercase">Stock Baixo</p>
          </div>
        </div>

        <!-- DIAGNÓSTICO AUTOMÁTICO -->
        <div>
          <p class="text-[9px] uppercase tracking-widest font-black text-slate-500 mb-3 flex items-center gap-2">
            <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
            Diagnóstico Automático · 100% local · sem internet
          </p>
          <div class="space-y-3">${cardsHtml}</div>
        </div>

        <!-- CHAT IA -->
        <div class="border-t border-white/5 pt-4">
          <p class="text-[9px] uppercase tracking-widest font-black text-slate-500 mb-3 flex items-center gap-2">
            <i class="fas fa-robot text-violet-400"></i>
            Chat com IA — Claude
            ${apiStatusBadge}
          </p>
          ${apiKeyNotice}

          <!-- Botões rápidos -->
          <div class="grid grid-cols-2 gap-2 mb-3">
            <button onclick="IARenderer.analisarGeral()" ${btnD} class="${btnBase}">
              <i class="fas fa-chart-line text-violet-400 mb-1.5 block"></i>
              <p class="text-[10px] font-black text-white">Análise Completa</p>
              <p class="text-[8px] text-slate-500 font-bold">Visão geral do negócio</p>
            </button>
            <button onclick="IARenderer.analisarStock()" ${btnD} class="${btnBase}">
              <i class="fas fa-boxes text-amber-400 mb-1.5 block"></i>
              <p class="text-[10px] font-black text-white">Análise de Stock</p>
              <p class="text-[8px] text-slate-500 font-bold">O que comprar</p>
            </button>
            <button onclick="IARenderer.analisarVendas()" ${btnD} class="${btnBase}">
              <i class="fas fa-trending-up text-emerald-400 mb-1.5 block"></i>
              <p class="text-[10px] font-black text-white">Análise de Vendas</p>
              <p class="text-[8px] text-slate-500 font-bold">Padrões e tendências</p>
            </button>
            <button onclick="IARenderer.analisarFinanceiro()" ${btnD} class="${btnBase}">
              <i class="fas fa-coins text-blue-400 mb-1.5 block"></i>
              <p class="text-[10px] font-black text-white">Saúde Financeira</p>
              <p class="text-[8px] text-slate-500 font-bold">Margens e lucro</p>
            </button>
          </div>

          <div id="iaChatBox" class="space-y-3"></div>

          <div class="glass rounded-[1.5rem] p-4 mt-3">
            <div class="flex gap-2">
              <input type="text" id="iaPergunta" class="inp flex-1 text-[12px]"
                placeholder="${temApiKey ? 'Pergunta livre... Ex: O que promover este fim de semana?' : 'Configure a API Key para usar o chat'}"
                ${!temApiKey ? 'disabled' : ''}
                onkeydown="if(event.key==='Enter') IARenderer.perguntarLivre()">
              <button onclick="IARenderer.perguntarLivre()" ${btnD}
                class="bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white px-4 rounded-2xl font-black transition-all flex-shrink-0 flex items-center">
                <i class="fas fa-paper-plane"></i>
              </button>
            </div>
          </div>

          <div class="text-center mt-2" id="iaBtnLimpar" style="display:none">
            <button onclick="IARenderer.limparChat()" class="text-[10px] text-slate-600 hover:text-slate-400 font-bold transition-colors">
              <i class="fas fa-trash mr-1"></i>Limpar conversa
            </button>
          </div>
        </div>
      </div>`;

    if (_mensagens.length > 0) _renderChat();
  }

  function _addMsg(tipo, conteudo) { _mensagens.push({ tipo, conteudo, ts: Date.now() }); _renderChat(); }

  function _renderChat() {
    const box = Utils.el('iaChatBox');
    if (!box) return;
    const limpar = Utils.el('iaBtnLimpar');
    if (limpar) limpar.style.display = _mensagens.length ? '' : 'none';

    box.innerHTML = _mensagens.map(m => {
      if (m.tipo === 'loading')
        return '<div class="glass rounded-2xl p-4 border border-violet-500/20 animate-pulse"><div class="flex items-center gap-3"><div class="w-7 h-7 rounded-xl bg-violet-500/20 flex items-center justify-center flex-shrink-0"><i class="fas fa-robot text-violet-400 text-xs"></i></div><div class="space-y-2 flex-1"><div class="h-2 bg-slate-700 rounded w-3/4"></div><div class="h-2 bg-slate-700 rounded w-1/2"></div></div></div><p class="text-[9px] text-violet-400 font-bold mt-2 animate-pulse">🤖 Analisando...</p></div>';
      if (m.tipo === 'user')
        return '<div class="flex justify-end"><div class="bg-violet-600/20 border border-violet-500/30 rounded-2xl rounded-tr-md px-4 py-3 max-w-[85%]"><p class="text-[11px] font-bold text-violet-200">' + _esc(m.conteudo) + '</p></div></div>';
      if (m.tipo === 'erro')
        return '<div class="rounded-2xl p-4 border border-red-500/20 bg-red-500/5"><p class="text-[11px] text-red-400 font-bold"><i class="fas fa-exclamation-triangle mr-2"></i>' + _esc(m.conteudo) + '</p></div>';
      return '<div class="glass rounded-2xl p-5 border border-violet-500/15 relative overflow-hidden"><div class="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-blue-500 rounded-l-2xl"></div><div class="flex items-center gap-2 mb-3 pl-3"><div class="w-7 h-7 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center flex-shrink-0"><i class="fas fa-robot text-white text-[10px]"></i></div><span class="text-[9px] font-black text-violet-400 uppercase tracking-wide">Claude</span><span class="text-[9px] text-slate-600 ml-auto">' + new Date(m.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) + '</span></div><div class="pl-3 text-[11px] leading-relaxed text-slate-300 space-y-2">' + _md(m.conteudo) + '</div></div>';
    }).join('');

    box.lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }

  function _md(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/^### (.+)$/gm,'<h4 class="text-[12px] font-black text-white mt-3 mb-1">$1</h4>')
      .replace(/^## (.+)$/gm,'<h3 class="text-[13px] font-black text-violet-300 mt-3 mb-1">$1</h3>')
      .replace(/^# (.+)$/gm,'<h2 class="text-sm font-black text-white mt-3 mb-1">$1</h2>')
      .replace(/\*\*(.+?)\*\*/g,'<strong class="font-black text-white">$1</strong>')
      .replace(/^[-•] (.+)$/gm,'<div class="flex gap-2"><span class="text-violet-400 flex-shrink-0">▸</span><span>$1</span></div>')
      .replace(/^\d+\. (.+)$/gm,'<div class="flex gap-2"><span class="text-blue-400 flex-shrink-0 font-black text-[10px]">→</span><span>$1</span></div>')
      .replace(/^---$/gm,'<hr class="border-white/10 my-2">')
      .replace(/\n\n/g,'</p><p class="mt-2">').replace(/\n/g,'<br>');
  }

  function _esc(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function _run(pergunta, label) {
    if (_analisando) { UIService.showToast('Aguarda', 'Análise em curso...', 'warning'); return; }
    _analisando = true;
    if (label) _addMsg('user', label);
    _addMsg('loading', '');
    try {
      const resp = await IAService.analisar(pergunta);
      _mensagens = _mensagens.filter(m => m.tipo !== 'loading');
      _addMsg('ia', resp);
    } catch (e) {
      _mensagens = _mensagens.filter(m => m.tipo !== 'loading');
      _addMsg('erro', e.message);
    } finally { _analisando = false; }
  }

  function analisarGeral()      { _run(null, '📊 Análise completa do negócio'); }
  function analisarStock()      { _run('Analisa stock: esgotados, baixo stock, capital parado e sugestões de compra.', '📦 Análise de stock'); }
  function analisarVendas()     { _run('Analisa vendas: top produtos, pico de horário, ticket médio e como aumentar vendas.', '📈 Análise de vendas'); }
  function analisarFinanceiro() { _run('Analisa margens, lucro, receita e saúde financeira com recomendações práticas.', '💰 Saúde financeira'); }

  function perguntarLivre() {
    const inp = Utils.el('iaPergunta');
    const q   = (inp?.value || '').trim();
    if (!q) return;
    if (inp) inp.value = '';
    _run(q, q);
  }

  function limparChat() { _mensagens = []; _renderChat(); }

  return { renderIA, analisarGeral, analisarStock, analisarVendas, analisarFinanceiro, perguntarLivre, limparChat };
})();

/* ══ GLOBAL ══ */
function renderIA() { IARenderer.renderIA(); }

/* ═══════════════════════════════════════════════════════════════
   IA ALERTAS AUTOMÁTICOS — Roda a cada 30min em segundo plano
═══════════════════════════════════════════════════════════════ */
const IAAlertaService = (() => {
  const COOLDOWN_ALERTA_MS = 4 * 60 * 60 * 1000; // 4h entre alertas do mesmo tipo
  const _ultimoAlerta = {};

  function _podaAlertar(tipo) {
    const agora = Date.now();
    if (agora - (_ultimoAlerta[tipo] || 0) < COOLDOWN_ALERTA_MS) return false;
    _ultimoAlerta[tipo] = agora;
    return true;
  }

  function verificar() {
    const estoque   = Store.Selectors.getEstoque() || [];
    const vendas    = Store.Selectors.getVendas()  || [];
    const config    = Store.Selectors.getConfig()  || {};
    const thresh    = config.alertaStock ?? 3;

    // 1. Produtos esgotados
    const esgotados = estoque.filter(p => p.qtdUn <= 0);
    if (esgotados.length > 0 && _podaAlertar('esgotado')) {
      const nomes = esgotados.slice(0, 5).map(p => p.nome).join(', ');
      UIService.showToast('⚠️ Estoque Zerado', `${esgotados.length} produto(s): ${nomes}`, 'error');
      EventBus.emit('notif:alerta-estoque', { esgotados });
    }

    // 2. Produtos com stock baixo (apenas os mais críticos)
    const baixo = estoque.filter(p => p.qtdUn > 0 && p.qtdUn <= thresh);
    if (baixo.length > 0 && _podaAlertar('baixo_estoque')) {
      const nomes = baixo.slice(0, 3).map(p => `${p.nome}(${p.qtdUn})`).join(', ');
      UIService.showToast('⚠️ Stock Baixo', nomes, 'warning');
    }

    // 3. Queda brusca de vendas: hoje abaixo de 40% da média dos últimos 7 dias
    const isoHoje  = Utils.todayISO();
    const dispHoje = Utils.today();
    const hoje7 = new Date(); hoje7.setDate(hoje7.getDate() - 7);
    const vendas7d = vendas.filter(v => {
      const dc = v.dataCurta || '';
      try {
        const d = dc.includes('-') ? new Date(dc) : new Date(dc.split('/').reverse().join('-'));
        return d >= hoje7 && dc !== isoHoje && dc !== dispHoje;
      } catch { return false; }
    });
    const recHoje   = vendas.filter(v => v.dataCurta === isoHoje || v.dataCurta === dispHoje).reduce((s, v) => s + (v.total || 0), 0);
    const diasUnicos = new Set(vendas7d.map(v => v.dataCurta)).size;
    if (diasUnicos >= 3) {
      const media7d = vendas7d.reduce((s, v) => s + (v.total || 0), 0) / diasUnicos;
      if (recHoje > 0 && recHoje < media7d * 0.4 && _podaAlertar('queda_vendas')) {
        UIService.showToast('📉 Vendas Baixas', `Hoje: ${Utils.formatCurrency(recHoje)} vs média: ${Utils.formatCurrency(media7d)}`, 'warning');
      }
    }
  }

  // Roda ao iniciar e a cada 30min
  function init() {
    setTimeout(verificar, 10_000);
    setInterval(verificar, 30 * 60_000);
    // FIX: roda após qualquer tipo de venda (PDV, Comanda, Delivery)
    EventBus.on('venda:concluida',         verificar);
    EventBus.on('comanda:finalizada',      verificar);
    EventBus.on('delivery:status-changed', pedido => {
      if (pedido?.status === 'ENTREGUE') verificar();
    });
  }

  return Object.freeze({ verificar, init });
})();

IAAlertaService.init();
