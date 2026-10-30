// ================================================================
// 11. ANÁLISE DE DIVERGÊNCIAS
// ================================================================
let _chartInstance = null;

// Atalhos das datas que TÊM contagem na loja (a Divergência só faz sentido entre 2 contagens).
// Substitui a necessidade de "adivinhar" no calendário nativo: o usuário clica nas datas certas.
async function renderDatasContagem() {
  const host = document.getElementById('an-datas-disp');
  if (!host) return;
  const loja = (document.getElementById('an-loja')||{}).value || currentLoja;
  const contagens = await DB.getAll('contagens');
  const datas = [...new Set(contagens.filter(c=>c.loja===loja).map(c=>c.data))].sort((a,b)=>b.localeCompare(a));
  if (!datas.length) {
    host.innerHTML = `<span class="text-muted"><i class="fas fa-circle-info me-1"></i>A ${LOJA_LABEL[loja]||loja} ainda não tem contagens salvas. Faça pelo menos duas contagens para analisar a divergência.</span>`;
    return;
  }
  const ini = document.getElementById('an-inicio').value, fim = document.getElementById('an-fim').value;
  const chips = datas.map(d=>{
    const sel = d===ini ? 'início' : d===fim ? 'fim' : '';
    const cls = sel ? 'btn-primary' : 'btn-outline-primary';
    return `<button type="button" class="btn btn-sm ${cls} py-0 px-2 me-1 mb-1" onclick="pickDataContagem('${d}')">${fmtDate(d)}${sel?` <span class="badge bg-light text-dark ms-1">${sel}</span>`:''}</button>`;
  }).join('');
  host.innerHTML = `<div class="text-muted mb-1"><i class="fas fa-calendar-check me-1"></i>Datas com contagem na ${LOJA_LABEL[loja]||loja} (em destaque) — clique para escolher <strong>início</strong> e <strong>fim</strong>:</div>${chips}`
    + (ini||fim ? ` <button type="button" class="btn btn-sm btn-link text-decoration-none py-0 px-1" onclick="limparDatasContagem()">limpar</button>` : '');
}

// Clique numa data: preenche início; o próximo clique vira o fim (mantendo início ≤ fim).
function pickDataContagem(d) {
  const iniEl = document.getElementById('an-inicio'), fimEl = document.getElementById('an-fim');
  const ini = iniEl.value, fim = fimEl.value;
  if (!ini || (ini && fim)) { iniEl.value = d; fimEl.value = ''; }   // começa nova seleção
  else if (d === ini) { /* clicou no próprio início → mantém */ }
  else if (d > ini) { fimEl.value = d; }
  else { fimEl.value = ini; iniEl.value = d; }                       // clicou antes → vira o início
  renderDatasContagem();
}

function limparDatasContagem() {
  document.getElementById('an-inicio').value = '';
  document.getElementById('an-fim').value = '';
  renderDatasContagem();
}

async function rodarAnalise() {
  const loja = document.getElementById('an-loja').value;
  const dtInicio = document.getElementById('an-inicio').value;
  const dtFim = document.getElementById('an-fim').value;

  if (!dtInicio||!dtFim) { toast('Selecione o período!','error'); return; }
  if (dtFim < dtInicio) { toast('Data fim deve ser >= data início!','error'); return; }

  document.getElementById('an-vazio').classList.add('d-none');
  document.getElementById('an-resultado').classList.add('d-none');

  try {
    const resultado = await calcDivergencias(loja, dtInicio, dtFim);
    renderResultadoAnalise(resultado, loja, dtInicio, dtFim);
  } catch(err) {
    toast('Erro na análise: '+err.message, 'error');
    console.error(err);
  }
}

// `dados` (opcional) = {contagens, vendas, compras, transferencias} já carregados — permite rodar o
// motor com dados injetados (autoteste, futuro servidor) sem tocar no IndexedDB. Sem ele, busca no DB.
async function calcDivergencias(loja, dtInicio, dtFim, dados) {
  // `vendas` NÃO entra aqui: a janela real de consumo (janIni..janFim) depende das CONTAGENS,
  // e só dá para saber qual pedir depois de calculá-la — ver a busca logo abaixo de janelaVazia.
  const [contagens, compras, transferencias] = dados
    ? [dados.contagens||[], dados.compras||[], dados.transferencias||[]]
    : await Promise.all([
        DB.getAll('contagens'), DB.getAll('compras'), DB.getAll('transferencias')
      ]);

  const contagensLoja = contagens.filter(c=>c.loja===loja).sort((a,b)=>a.data.localeCompare(b.data));
  const ctInicial = contagensLoja.filter(c=>c.data<=dtInicio).pop();
  const ctFinal = contagensLoja.filter(c=>c.data>=dtFim)[0];

  // JANELA REAL DE CONSUMO — respeita o MOMENTO de cada contagem:
  //  • "antes da noite": as vendas DAQUELE dia ainda não aconteceram →
  //       como contagem inicial, o dia ENTRA;  como final, o dia SAI.
  //  • "fim da noite": as vendas do dia já entraram na contagem →
  //       como inicial, o dia SAI (começa no dia seguinte);  como final, o dia ENTRA.
  // Assim os intervalos encaixam sem buraco nem sobreposição (o dia da contagem
  // nunca é contado em dois períodos). Padrão de contagem sem o campo = "antes".
  const momIni = (ctInicial?.momento === 'fim') ? 'fim' : 'antes';
  const momFim = (ctFinal?.momento === 'fim') ? 'fim' : 'antes';
  const janIni = (ctInicial && momIni === 'fim') ? addDiasISO(ctInicial.data, 1) : (ctInicial?.data || dtInicio);
  const janFim = (ctFinal && momFim === 'antes') ? addDiasISO(ctFinal.data, -1) : (ctFinal?.data || dtFim);
  const janelaVazia = janFim < janIni;   // 2 contagens muito próximas que se anulam

  // AGORA sim as vendas, e SÓ as da janela de consumo (31/07/2026). A janela pode ser mais LARGA
  // que o período pedido — ela vai de contagem a contagem —, por isso o pedido usa janIni/janFim
  // e não dtInicio/dtFim. O recorte é idêntico ao filtro de `vendasLoja` logo abaixo, então o
  // resultado do motor não muda; o que muda é baixar ~180 linhas em vez de 2.867.
  const vendas = dados ? (dados.vendas || [])
    : (janelaVazia ? []
       : (DB.vendasPeriodo ? await DB.vendasPeriodo(janIni, janFim) : await DB.getAll('vendas')));

  const noPeriodo = d => !janelaVazia && d >= janIni && d <= janFim;
  const comprasLoja = compras.filter(c=>c.loja===loja && noPeriodo(c.data));
  const trasIn = transferencias.filter(t=>t.loja_destino===loja && noPeriodo(t.data));
  const trasOut = transferencias.filter(t=>t.loja_origem===loja && noPeriodo(t.data));
  const vendasLoja = janelaVazia ? [] : vendas.filter(v=>v.loja===loja && v.data_fim>=janIni && v.data_inicio<=janFim);

  // Calcular consumo esperado por ingrediente
  const consumoEsperado = {};
  const bebidaConsumida = {};
  const naoMapeados = {};

  for (const venda of vendasLoja) {
    for (const item of (venda.itens||[])) {
      const map = resolverMap(item);
      if (!map) {
        const key = `${item.codigo}: ${item.produto}`;
        naoMapeados[key] = (naoMapeados[key]||0) + item.qtde;
        continue;
      }
      if (map.ignorar_no_consumo || map.categoria==='AGRUPADOR') continue;

      if (map.categoria==='ADICIONAL') {
        const ing = normIng(map.adicional_ingrediente);
        consumoEsperado[ing] = (consumoEsperado[ing]||0) + (ingEmUnidade(ing) ? map.porcao_gramas : map.porcao_gramas/1000)*item.qtde;
      } else if (['MEIA','INTEIRA','PREMIUM'].includes(map.categoria)) {
        if (!map.nome_ficha) continue; // pizza contada, mas sem receita (ex.: sobremesa) — não desconta ingrediente
        const ficha = FICHA_TECNICA[map.nome_ficha];
        if (!ficha) { naoMapeados[`ficha:${map.nome_ficha}`]=(naoMapeados[`ficha:${map.nome_ficha}`]||0)+item.qtde; continue; }
        for (const [ing, gramas] of Object.entries(ficha._ingredientes)) {
          const ingN = normIng(ing);
          if (MASSA_SET.has(ingN)) continue; // insumos da massa entram pela receita da massa
          // Ingredientes em unidade: Ovo, Cebola
          const emUnidade = ['OVO','CAIXA'].includes(ingN);
          if (emUnidade) {
            consumoEsperado[ingN] = (consumoEsperado[ingN]||0) + gramas * map.fator_consumo * item.qtde;
          } else {
            consumoEsperado[ingN] = (consumoEsperado[ingN]||0) + (gramas/1000) * map.fator_consumo * item.qtde;
          }
        }
        addConsumoMassa(consumoEsperado, map.fator_consumo*item.qtde);
        addConsumoEmbalagem(consumoEsperado, map.categoria, map.fator_consumo*item.qtde, item.sku);
      } else if (map.categoria==='BEBIDA') {
        const beb = norm(map.bebida_estoque);
        bebidaConsumida[beb] = (bebidaConsumida[beb]||0) + item.qtde;
      }
    }
  }

  // Unir bebidas em consumoEsperado
  for (const [k,v] of Object.entries(bebidaConsumida)) {
    consumoEsperado[k] = (consumoEsperado[k]||0) + v;
  }

  // Calcular real por ingrediente
  const ings = new Set([
    ...Object.keys(ctInicial?.ingredientes||{}),
    ...Object.keys(ctFinal?.ingredientes||{}),
    ...Object.keys(consumoEsperado)
  ]);

  const resultado = [];
  const resultadoBebidas = []; // bebidas analisadas à parte (não entram em desperdício/CMV/ABC)

  for (const ing of ings) {
    // Atendimento (limpeza/serviço) é controle de estoque, NÃO entra na divergência nem no
    // CMV — o cmvCeoInventario lê justamente este `resultado`, então pular aqui cobre os dois.
    if (typeof ehAtendimento === 'function' && ehAtendimento(ing)) continue;
    const ingN = norm(ing);
    const bebida = ehBebida(ing);
    const inicial = ctInicial?.ingredientes?.[ing]?.total || ctInicial?.ingredientes?.[ingN]?.total || 0;
    const final_ = ctFinal?.ingredientes?.[ing]?.total || ctFinal?.ingredientes?.[ingN]?.total || 0;
    const un = ctInicial?.ingredientes?.[ing]?.unidade || ctFinal?.ingredientes?.[ing]?.unidade || getUnidadeIngrediente(ing);

    let comprasTotal = 0;
    for (const c of comprasLoja) {
      if (normIng(c.ingrediente)===ing || norm(c.ingrediente)===ingN) {
        comprasTotal += c.quantidade_base||0;
      }
    }

    let traInTotal = 0, traOutTotal = 0;
    for (const t of trasIn) {
      if (normIng(t.ingrediente)===ing || norm(t.ingrediente)===ingN) traInTotal += t.quantidade||0;
    }
    for (const t of trasOut) {
      if (normIng(t.ingrediente)===ing || norm(t.ingrediente)===ingN) traOutTotal += t.quantidade||0;
    }

    const consumoReal = inicial + comprasTotal + traInTotal - traOutTotal - final_;
    const esperado = consumoEsperado[ing] || consumoEsperado[ingN] || 0;
    // Quanto DEVERIA ter sobrado na contagem final se o consumo seguisse a ficha
    const sobraEsperada = inicial + comprasTotal + traInTotal - traOutTotal - esperado;
    const divergencia = consumoReal - esperado;
    const custo = custoPagoIng(ing, janIni, janFim, compras, loja); // preço REALMENTE pago (fallback: base)
    const impacto = divergencia * custo;

    if (inicial===0 && comprasTotal===0 && esperado===0 && final_===0) continue;

    // "Entrada não explicada": o estoque final ficou MAIOR do que tudo que entrou
    // (inicial + compras + transferências). Fisicamente impossível sem lançar uma
    // compra/transferência que faltou, ou erro de contagem. consumoReal < 0 indica isso.
    const impossivel = consumoReal < -0.01;

    // "Provável erro de contagem": consumo real e esperado com FATOR absurdo (≥3x p/ um dos lados)
    // E impacto material (≥ R$60). Não é fisicamente impossível (por isso não é furo), mas é grande
    // demais p/ ser desperdício real — quase sempre é contagem digitada errada (ex.: calabresa 8kg
    // quando deveria ter 25kg). Fica FORA do gráfico de impacto (a barra gigante achata as barras
    // reais de ~R$1.000) e ganha selo "revisar" na tabela.
    const fator = (esperado>0 && consumoReal>0) ? Math.max(consumoReal/esperado, esperado/consumoReal) : 0;
    const suspeito = !impossivel && esperado>0 && consumoReal>0 && fator>=3 && Math.abs(impacto)>=60;

    const linha = {ing, unidade:un, inicial, final:final_, sobraEsperada, comprasTotal, traInTotal, traOutTotal, consumoReal, esperado, divergencia, custo, impacto, impossivel, suspeito, fator};
    if (bebida) resultadoBebidas.push(linha); else resultado.push(linha);
  }

  // Para cada FURO (consumo negativo), aponta ENTRE QUAIS CONTAGENS o erro está (pedido do Gabriel:
  // filtrando o mês inteiro ele não sabia qual contagem corrigir): varre os pares CONSECUTIVOS de
  // contagens dentro da janela e recalcula o consumo do insumo em cada sub-janela; onde der negativo,
  // é ali que a contagem (ou uma compra não lançada) está errada.
  const ctsJanela = (ctInicial && ctFinal)
    ? contagensLoja.filter(c=>c.data>=ctInicial.data && c.data<=ctFinal.data) : [];
  for (const linha of [...resultado, ...resultadoBebidas]) {
    if (!linha.impossivel) continue;
    linha.culpas = [];
    const ingN2 = norm(linha.ing);
    for (let i=0;i<ctsJanela.length-1;i++) {
      const a = ctsJanela[i], b = ctsJanela[i+1];
      const qa = a.ingredientes?.[linha.ing]?.total ?? a.ingredientes?.[ingN2]?.total ?? 0;
      const qb = b.ingredientes?.[linha.ing]?.total ?? b.ingredientes?.[ingN2]?.total ?? 0;
      let cp=0; for (const c of comprasLoja) if (c.data>a.data && c.data<=b.data && (normIng(c.ingrediente)===linha.ing || norm(c.ingrediente)===ingN2)) cp += c.quantidade_base||0;
      let ti=0, to=0;
      for (const t of trasIn)  if (t.data>a.data && t.data<=b.data && (normIng(t.ingrediente)===linha.ing || norm(t.ingrediente)===ingN2)) ti += t.quantidade||0;
      for (const t of trasOut) if (t.data>a.data && t.data<=b.data && (normIng(t.ingrediente)===linha.ing || norm(t.ingrediente)===ingN2)) to += t.quantidade||0;
      const cons = qa + cp + ti - to - qb;
      if (cons < -0.01) linha.culpas.push({de:a.data, ate:b.data, valor:cons});
    }
  }

  // Ordena pelo VALOR (com sinal), não pelo módulo: perdas (positivas) no topo,
  // sobras (negativas) embaixo — assim gastos e sobras não ficam misturados.
  resultado.sort((a,b)=>b.impacto-a.impacto);
  resultadoBebidas.sort((a,b)=>b.impacto-a.impacto);

  // Cobertura de vendas: a divergência só faz sentido se as vendas cobrirem
  // (quase) todo o intervalo entre as duas contagens. Senão, o consumo esperado
  // fica subestimado e aparece uma "perda" gigante e falsa.
  const diaMs = 86400000;
  const ini = (ctInicial && ctFinal && !janelaVazia) ? janIni : null;
  const fim = (ctInicial && ctFinal && !janelaVazia) ? janFim : null;
  let diasJanela = 0, diasVendas = 0;
  if (ini && fim) {
    diasJanela = Math.round((new Date(fim) - new Date(ini)) / diaMs) + 1;
    for (const v of vendasLoja) {
      const a = v.data_inicio < ini ? ini : v.data_inicio;
      const b = v.data_fim > fim ? fim : v.data_fim;
      const d = Math.round((new Date(b) - new Date(a)) / diaMs) + 1;
      if (d > 0) diasVendas += d;
    }
  }
  const coberturaVendas = diasJanela > 0 ? diasVendas / diasJanela : 0;

  return {
    resultado,
    resultadoBebidas,
    naoMapeados,
    temInicial: !!ctInicial,
    temFinal: !!ctFinal,
    ctInicialData: ctInicial?.data,
    ctFinalData: ctFinal?.data,
    momIni, momFim, janIni, janFim, janelaVazia,
    diasJanela, diasVendas, coberturaVendas
  };
}

// Selo de status da linha de divergência: furo (consumo negativo) ou revisar (fator absurdo).
function seloDiverg(r) {
  if (r.impossivel) return ` <span class="selo selo-furo" title="Consumo negativo: o estoque final ficou MAIOR do que tudo que entrou — faltou lançar compra/transferência, ou a contagem está errada. Fica fora das somas e bloqueia o fechamento.">⚑ furo</span>`;
  if (r.suspeito)   return ` <span class="selo selo-revisar" title="Consumo real ${fmtNum(r.fator,1)}× o esperado — grande demais p/ ser desperdício real. Provável erro de contagem: confira antes de tratar como perda. Fora do gráfico.">⚠ revisar ${fmtNum(r.fator,0)}×</span>`;
  return '';
}
function clsImpacto(r) { return Math.abs(r.impacto) > 100 ? 'div-critica' : Math.abs(r.impacto) > 30 ? 'div-atencao' : 'div-ok'; }
let _rastreioLoja = '';   // loja da última análise de Divergências (p/ o rastreio ao clicar no insumo)

// RASTREIO de um insumo: linha do tempo (contagens · compras · transferências) da loja da análise,
// com o consumo real de cada período entre contagens (flag de furo quando o consumo dá negativo).
async function abrirRastreio(ingEnc){
  if (typeof bootstrap==='undefined'){ toast('Recarregue a página com internet.','warning'); return; }
  const ing = decodeURIComponent(ingEnc), loja = _rastreioLoja;
  const ingN = normIng(ing), ingNn = norm(ing);
  const match = nome => normIng(nome)===ingN || norm(nome)===ingNn;
  const [allCt, allCp, allTr] = await Promise.all([DB.getAll('contagens'), DB.getAll('compras'), DB.getAll('transferencias')]);
  const contagens = allCt.filter(c=>c.loja===loja).map(c=>{
    const key = Object.keys(c.ingredientes||{}).find(k=>match(k));
    return key!=null ? {data:c.data, val:(c.ingredientes[key].total||0), un:(c.ingredientes[key].unidade||'')} : null;
  }).filter(Boolean).sort((a,b)=>a.data.localeCompare(b.data));
  const compras = allCp.filter(c=>c.loja===loja && match(c.ingrediente));
  const transf = allTr.filter(t=>match(t.ingrediente) && (t.loja_origem===loja||t.loja_destino===loja));
  const un = (contagens[0]?.un) || getUnidadeIngrediente(ing) || '';
  const fmtV = v => fmtNum(v,2)+' '+esc(un);

  // eventos ordenados: contagem (ord 0) antes de compra/transf do mesmo dia
  const eventos = [];
  for (const c of contagens) eventos.push({data:c.data, ord:0, tipo:'contagem', val:c.val});
  for (const c of compras) eventos.push({data:c.data, ord:1, tipo:'compra', qtd:c.quantidade_base||0, valor:c.valor_total||0, forn:c.fornecedor||''});
  for (const t of transf) eventos.push({data:t.data, ord:1, tipo:'transf', qtd:t.quantidade||0, entra:(t.loja_destino===loja), outra:(t.loja_destino===loja?t.loja_origem:t.loja_destino)});
  eventos.sort((a,b)=> a.data.localeCompare(b.data) || a.ord-b.ord);

  let html='', prevCt=null, accEntra=0, nFuros=0;
  if (!eventos.length) html = '<div class="text-muted text-center py-4">Sem registros deste insumo nesta loja.</div>';
  for (const e of eventos){
    if (e.tipo==='contagem'){
      if (prevCt){
        const consumo = prevCt.val + accEntra - e.val;
        const furo = consumo < -0.01;
        if (furo) nFuros++;
        html += `<div class="rt-seg ${furo?'rt-furo':''}"><i class="fas fa-arrow-down-long me-1"></i>Consumo real no período:
          <strong>${fmtNum(consumo,2)} ${esc(un)}</strong>${furo?' <span class="selo selo-furo">⚑ furo — contou mais do que tinha; falta lançar compra/transf ou a contagem errou</span>':''}
          <span class="text-muted small d-block">${fmtNum(prevCt.val,2)} + ${fmtNum(accEntra,2)} entrou − ${fmtNum(e.val,2)} contado</span></div>`;
      }
      html += `<div class="rt-node rt-ct"><span class="rt-dot"><i class="fas fa-clipboard-check"></i></span>
        <div><strong>${fmtDate(e.data)}</strong> · Contagem <span class="rt-val">${fmtV(e.val)}</span></div></div>`;
      prevCt = e; accEntra = 0;
    } else if (e.tipo==='compra'){
      accEntra += e.qtd;
      html += `<div class="rt-node rt-cp"><span class="rt-dot"><i class="fas fa-cart-shopping"></i></span>
        <div>${fmtDate(e.data)} · Compra <strong class="text-success">+${fmtV(e.qtd)}</strong>
          ${e.valor?`<span class="text-muted">· ${fmtBRL(e.valor)}</span>`:''}${e.forn?`<span class="text-muted small d-block">${esc(e.forn)}</span>`:''}</div></div>`;
    } else {
      accEntra += e.entra ? e.qtd : -e.qtd;
      html += `<div class="rt-node rt-tr"><span class="rt-dot"><i class="fas fa-right-left"></i></span>
        <div>${fmtDate(e.data)} · Transferência <strong class="${e.entra?'text-success':'text-danger'}">${e.entra?'+':'−'}${fmtV(e.qtd)}</strong>
          <span class="text-muted small d-block">${e.entra?'entrou de':'saiu para'} ${LOJA_LABEL[e.outra]||e.outra}</span></div></div>`;
    }
  }

  const totalComprado = compras.reduce((s,c)=>s+(c.quantidade_base||0),0);
  const totalPago = compras.reduce((s,c)=>s+(c.valor_total||0),0);
  document.getElementById('rt-titulo').innerHTML = `${esc(ing)} <span class="badge ${LOJA_BADGE[loja]||'bg-dark'}">${LOJA_LABEL[loja]||loja}</span>`;
  document.getElementById('rt-resumo').innerHTML = `<span class="text-muted">${contagens.length} contagem(ns) · ${compras.length} compra(s) (${fmtNum(totalComprado,2)} ${esc(un)} · ${fmtBRL(totalPago)}) · ${transf.length} transferência(s)${nFuros?` · <strong class="text-danger">${nFuros} furo(s)</strong>`:''}</span>`;
  document.getElementById('rt-timeline').innerHTML = html;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('rastreioModal')).show();
}
// Célula do nome do insumo: link que abre o RASTREIO (linha do tempo de contagens/compras/transferências).
function ingCelula(r) { return `<a href="#" class="ing-link" onclick="abrirRastreio('${encodeURIComponent(r.ing)}');return false" title="Ver o rastreio deste insumo — contagens, compras e transferências na linha do tempo">${esc(r.ing)}</a>${seloDiverg(r)}`; }

// Linha da tabela de INSUMOS. Colunas: inicial | +compras | ±transf ‖ contado | esperado ‖ real | esperado ‖ diverg | impacto.
function tabelaDivergLinha(r, decNum, decDiv) {
  const cls = clsImpacto(r);
  const traNet = r.traInTotal - r.traOutTotal;
  const traStr = traNet===0 ? '—' : (traNet>0?'+':'')+fmtNum(traNet,decNum);
  const rowCls = r.impossivel ? 'tr-impossivel' : (r.suspeito ? 'tr-suspeito' : '');
  return `<tr class="${rowCls}">
    <td class="fw-semibold">${ingCelula(r)}</td>
    <td class="text-end">${fmtNum(r.inicial,decNum)}</td>
    <td class="text-end text-success">${r.comprasTotal?'+'+fmtNum(r.comprasTotal,decNum):'—'}</td>
    <td class="text-end ${traNet!==0?'text-warning':''}">${traStr}</td>
    <td class="text-end fw-semibold col-grp">${fmtNum(r.final,decNum)}</td>
    <td class="text-end text-muted">${fmtNum(r.sobraEsperada,decNum)}</td>
    <td class="text-end col-grp">${fmtNum(r.consumoReal,decNum)}</td>
    <td class="text-end">${fmtNum(r.esperado,decNum)}</td>
    <td class="text-end col-grp ${cls}">${r.divergencia>0?'+':''}${fmtNum(r.divergencia,decDiv)}</td>
    <td class="text-end ${cls} fw-bold">${r.impacto>0?'▲':'▼'} ${fmtBRL(Math.abs(r.impacto))}</td>
  </tr>`;
}

// Linha da tabela de BEBIDAS. Colunas: inicial | +compras | ±transf ‖ final ‖ vendido | saiu ‖ diverg | impacto.
function tabelaBebidaLinha(r) {
  const cls = clsImpacto(r);
  const traNet = r.traInTotal - r.traOutTotal;
  const traStr = traNet===0 ? '—' : (traNet>0?'+':'')+fmtNum(traNet,0);
  const rowCls = r.impossivel ? 'tr-impossivel' : (r.suspeito ? 'tr-suspeito' : '');
  return `<tr class="${rowCls}">
    <td class="fw-semibold">${ingCelula(r)}</td>
    <td class="text-end">${fmtNum(r.inicial,0)}</td>
    <td class="text-end text-success">${r.comprasTotal?'+'+fmtNum(r.comprasTotal,0):'—'}</td>
    <td class="text-end ${traNet!==0?'text-warning':''}">${traStr}</td>
    <td class="text-end fw-semibold col-grp">${fmtNum(r.final,0)}</td>
    <td class="text-end col-grp">${fmtNum(r.esperado,0)}</td>
    <td class="text-end">${fmtNum(r.consumoReal,0)}</td>
    <td class="text-end col-grp ${cls}">${r.divergencia>0?'+':''}${fmtNum(r.divergencia,0)}</td>
    <td class="text-end ${cls} fw-bold">${r.impacto>0?'▲':'▼'} ${fmtBRL(Math.abs(r.impacto))}</td>
  </tr>`;
}

// ================================================================
//  COMPARATIVO ENTRE LOJAS (Estoque & CMV) — league table p/ decisão de CEO.
//  Cada loja pela SUA janela de contagens no mês; a melhor em cada métrica leva a coroa.
// ================================================================
async function renderComparativoEstoque(){
  popularSelMeses('ce-mes');
  const mes = document.getElementById('ce-mes').value || today().slice(0,7);
  const ano=+mes.slice(0,4), m=+mes.slice(5,7);
  const ini = mes+'-01';
  const ultimo = new Date(ano, m, 0).getDate();
  let fim = `${mes}-${String(ultimo).padStart(2,'0')}`;
  if (mes===today().slice(0,7)) fim = today();
  const mLbl = MES_ABREV[m-1]+'/'+mes.slice(2,4);

  // Pizzas pela régua única (resumo do TOTEM) — a tabela de vendas inteira não precisa mais descer aqui.
  const contagens = await DB.getAll('contagens');
  const pag = await carregarPagamentos().catch(()=>null);
  const ceo = await carregarCEO().catch(()=>null);
  const LOJAS=['PLANALTO','BURITIS','VENDA_NOVA'];
  const dados={};
  for (const loja of LOJAS){
    const cts=contagens.filter(c=>c.loja===loja).sort((a,b)=>a.data.localeCompare(b.data));
    const effIni=[...cts].reverse().find(c=>c.data<=ini)?.data || cts.find(c=>c.data>=ini && c.data<fim)?.data;
    const effFim=cts.find(c=>c.data>=fim)?.data || [...cts].reverse().find(c=>c.data<=fim && effIni && c.data>effIni)?.data;
    if(!effIni||!effFim||effFim<=effIni){ dados[loja]=null; continue; }
    let d; try{ d=await calcDivergencias(loja,effIni,effFim);}catch(e){ dados[loja]=null; continue; }
    if(!d.temInicial||!d.temFinal||d.janelaVazia){ dados[loja]=null; continue; }
    let cmvReal=0,esperado=0,perda=0,furos=0; const porIns=[];
    for(const r of d.resultado){ if(r.impossivel){furos++;continue;}
      const c=r.consumoReal*r.custo; cmvReal+=c; esperado+=r.esperado*r.custo; perda+=Math.max(r.impacto,0);
      if (r.consumoReal>0) porIns.push({ing:r.ing,custo:c,real:r.consumoReal,unidade:r.unidade}); }
    const pizzas=pizzasDaJanela(ceo, loja, d);   // null = resumo do TOTEM não carregou → "—"
    const receita=pag?faturamentoFormas(pag,loja,d.janIni,d.janFim).total:0;
    const muss=porIns.find(x=>normIng(x.ing)==='MUSSARELA');
    dados[loja]={ de:d.ctInicialData, ate:d.ctFinalData, janIni:d.janIni, janFim:d.janFim, furos, pizzas, receita,
      cmvReal, esperado, perda,
      cmvPct: receita>0?cmvReal/receita*100:null,
      custoPizza: pizzas>0?cmvReal/pizzas:null,
      perdaPct: cmvReal>0?perda/cmvReal*100:null,
      muss: muss?{custo:muss.custo, rPorPizza:pizzas>0?muss.custo/pizzas:null, pctCMV:cmvReal>0?muss.custo/cmvReal*100:null}:null,
      top: porIns.slice().sort((a,b)=>b.custo-a.custo).slice(0,5), cmvTot:cmvReal };
  }
  const com=LOJAS.filter(l=>dados[l]);
  const cont=document.getElementById('ce-conteudo'), vazio=document.getElementById('ce-vazio');
  if (com.length<1){ cont.innerHTML=''; vazio.classList.remove('d-none'); return; }
  vazio.classList.add('d-none');

  // helpers de "melhor" e célula com coroa+gap
  const melhor=(get, lower=true)=>{ const vs=com.map(l=>get(dados[l])).filter(v=>v!=null); if(!vs.length)return null; return lower?Math.min(...vs):Math.max(...vs); };
  const cel=(get, fmt, lower=true)=>{
    const best=melhor(get,lower);
    return com.map(l=>{ const v=get(dados[l]);
      if (v==null) return `<td class="text-end text-muted">—</td>`;
      const isBest = best!=null && Math.abs(v-best)<1e-6;
      const gap = best!=null? Math.abs(v-best):0;
      const gapStr = (isBest||gap<1e-6)?'' : `<div class="ce-gap">${lower?'+':'−'}${fmt(gap)}</div>`;
      return `<td class="text-end ${isBest?'ce-best':''}">${isBest?'<i class="fas fa-crown ce-crown" title="melhor da rede"></i> ':''}<span class="ce-num">${fmt(v)}</span>${gapStr}</td>`;
    }).join('');
  };
  const thLojas = com.map(l=>`<th class="text-end"><span class="badge ${LOJA_BADGE[l]}">${LOJA_LABEL[l]}</span></th>`).join('');

  // HERO: ranking por CMV% (menor = mais eficiente)
  const rank=[...com].filter(l=>dados[l].cmvPct!=null).sort((a,b)=>dados[a].cmvPct-dados[b].cmvPct);
  const medalha=['🥇','🥈','🥉'];
  const hero = rank.length ? `<div class="row g-3 mb-3">${rank.map((l,i)=>{ const d=dados[l];
    return `<div class="col-md-4"><div class="ce-hero-card ${i===0?'ce-hero-top':''}">
      <div class="d-flex justify-content-between align-items-start">
        <span class="badge ${LOJA_BADGE[l]}">${LOJA_LABEL[l]}</span><span class="ce-medal">${medalha[i]||''}</span></div>
      <div class="ce-hero-num">${fmtNum(d.cmvPct,1)}<span class="ce-hero-unit">% CMV</span></div>
      <div class="small text-muted">${d.custoPizza!=null?fmtBRL(d.custoPizza)+'/pizza':'—'} · ${d.pizzas!=null?fmtNum(d.pizzas,0):'—'} pizzas</div>
      <div class="ce-hero-win">${fmtDate(d.janIni).slice(0,5)}–${fmtDate(d.janFim).slice(0,5)}</div>
    </div></div>`; }).join('')}</div>` : '';

  // TABELA-LIGA
  const linha=(lbl, sub, get, fmt, lower=true)=>`<tr><td>${lbl}${sub?`<div class="small text-muted">${sub}</div>`:''}</td>${cel(get,fmt,lower)}</tr>`;
  const tabela=`<div class="card mb-3"><div class="card-header"><i class="fas fa-ranking-star me-1"></i>Placar da rede <span class="text-muted fw-normal small">— ${mLbl} · quem gasta menos p/ vender</span></div>
    <div class="card-body p-0"><table class="table mb-0 align-middle tbl-zebra ce-table"><thead class="table-light"><tr><th>Indicador</th>${thLojas}</tr></thead><tbody>
      ${linha('CMV real','custo do que saiu do estoque',d=>d.cmvReal,v=>fmtBRL(v))}
      ${linha('CMV % da receita','quanto de cada R$ vira custo',d=>d.cmvPct,v=>fmtNum(v,1)+'%')}
      ${linha('Custo de ingrediente / pizza','o número que decide preço',d=>d.custoPizza,v=>fmtBRL(v))}
      ${linha('Perda bruta','desperdício acima da ficha',d=>d.perda,v=>fmtBRL(v))}
      ${linha('Perda % do CMV','quanto do custo é perda',d=>d.perdaPct,v=>fmtNum(v,1)+'%')}
      ${linha('Pizzas no período','volume (mais = melhor)',d=>d.pizzas,v=>fmtNum(v,0),false)}
    </tbody></table></div>
    <div class="card-footer small text-muted">Cada loja pela SUA janela de contagens no mês (datas nos cartões acima). A <i class="fas fa-crown ce-crown"></i> é a melhor; o número abaixo é o quanto as outras estão atrás.</div></div>`;

  // MUSSARELA EM FOCO (o maior insumo)
  const temMuss=com.some(l=>dados[l].muss);
  const mussCard = temMuss ? `<div class="card mb-3"><div class="card-header"><i class="fas fa-cheese me-1" style="color:var(--queijo)"></i>Mussarela em foco <span class="text-muted fw-normal small">— o maior insumo do CMV</span></div>
    <div class="card-body p-0"><table class="table mb-0 align-middle tbl-zebra ce-table"><thead class="table-light"><tr><th>Mussarela</th>${thLojas}</tr></thead><tbody>
      ${linha('Custo consumido','no período',d=>d.muss?d.muss.custo:null,v=>fmtBRL(v))}
      ${linha('R$ / pizza','peso da mussarela por pizza',d=>d.muss?d.muss.rPorPizza:null,v=>fmtBRL(v))}
      ${linha('% do CMV','fatia do custo total',d=>d.muss?d.muss.pctCMV:null,v=>fmtNum(v,1)+'%')}
    </tbody></table></div></div>` : '';

  // GASTOS PRINCIPAIS por loja (top 5 insumos, barra proporcional ao maior)
  const gastos=`<div class="row g-3 mb-3">${com.map(l=>{ const d=dados[l]; const maxC=Math.max(...d.top.map(x=>x.custo),1);
    return `<div class="col-md-4"><div class="card h-100"><div class="card-header py-2"><span class="badge ${LOJA_BADGE[l]}">${LOJA_LABEL[l]}</span> <span class="text-muted small">maiores gastos</span></div>
      <div class="card-body py-2">${d.top.map(x=>`<div class="ce-bar-row"><div class="d-flex justify-content-between"><span class="ce-bar-lbl">${esc(x.ing)}</span><span class="ce-bar-val">${fmtBRL(x.custo)}</span></div>
        <div class="ce-bar"><span style="width:${Math.round(x.custo/maxC*100)}%"></span></div></div>`).join('')||'<div class="text-muted small">sem dados</div>'}</div></div></div>`; }).join('')}</div>`;

  // LEITURA DE CEO — pontos em comum + vantagens competitivas + atenção
  const bullets=[];
  const rkCusto=[...com].filter(l=>dados[l].custoPizza!=null).sort((a,b)=>dados[a].custoPizza-dados[b].custoPizza);
  if (rkCusto.length>=2){ const best=rkCusto[0], worst=rkCusto[rkCusto.length-1];
    const eco=(dados[worst].custoPizza-dados[best].custoPizza)*dados[worst].pizzas;
    bullets.push(`<i class="fas fa-trophy text-warning me-1"></i><strong>${LOJA_LABEL[best]}</strong> é a mais eficiente: <strong>${fmtBRL(dados[best].custoPizza)}/pizza</strong>. Se <strong>${LOJA_LABEL[worst]}</strong> (${fmtBRL(dados[worst].custoPizza)}) chegasse lá, economizaria <strong>${fmtBRL(eco)}</strong> no período.`);
  }
  const mussPcts=com.filter(l=>dados[l].muss&&dados[l].muss.pctCMV!=null).map(l=>dados[l].muss.pctCMV);
  if (mussPcts.length>=2 && Math.min(...mussPcts)>=20) bullets.push(`<i class="fas fa-cheese me-1" style="color:var(--queijo)"></i><strong>Ponto em comum:</strong> a mussarela pesa ${fmtNum(Math.min(...mussPcts),0)}–${fmtNum(Math.max(...mussPcts),0)}% do CMV nas lojas — é onde uma negociação de preço rende mais.`);
  const rkPerda=[...com].filter(l=>dados[l].perdaPct!=null).sort((a,b)=>dados[b].perdaPct-dados[a].perdaPct);
  if (rkPerda.length && dados[rkPerda[0]].perdaPct>0) bullets.push(`<i class="fas fa-triangle-exclamation text-danger me-1"></i><strong>Atenção:</strong> ${LOJA_LABEL[rkPerda[0]]} tem a maior perda (${fmtNum(dados[rkPerda[0]].perdaPct,1)}% do CMV, ${fmtBRL(dados[rkPerda[0]].perda)}) — vale abrir as Divergências dela.`);
  const comFuro=com.filter(l=>dados[l].furos>0);
  if (comFuro.length) bullets.push(`<i class="fas fa-ban text-danger me-1"></i>${comFuro.map(l=>LOJA_LABEL[l]).join(', ')} tem contagem furada no período — o CMV dela pode estar subestimado até corrigir.`);
  const semDados=LOJAS.filter(l=>!dados[l]);
  if (semDados.length) bullets.push(`<i class="fas fa-circle-info me-1 text-muted"></i>${semDados.map(l=>LOJA_LABEL[l]).join(', ')} ficou de fora: sem 2 contagens no período.`);
  const leitura=bullets.length?`<div class="card mb-3" style="background:var(--massa)"><div class="card-body py-3">
    <div class="mb-2"><i class="fas fa-lightbulb text-primary me-1"></i><strong>Leitura para decidir</strong></div>
    <ul class="mb-0" style="list-style:none;padding-left:0;line-height:1.9">${bullets.map(b=>`<li>${b}</li>`).join('')}</ul></div></div>`:'';

  cont.innerHTML = hero + tabela + mussCard + gastos + leitura;
}

function renderResultadoAnalise(data, loja, dtInicio, dtFim) {
  _rastreioLoja = loja;   // guarda p/ o rastreio ao clicar num insumo
  const {resultado, resultadoBebidas, naoMapeados, temInicial, temFinal, ctInicialData, ctFinalData, momIni, momFim, janIni, janFim, janelaVazia, diasJanela, diasVendas, coberturaVendas} = data;

  const avisoEl = document.getElementById('an-aviso-cobertura');
  const momLabel = m => m==='fim' ? '🌙 fim da noite' : '🌅 antes da noite';
  let avisoHTML = '';

  // Deixa CLARO quais dias de venda entraram no consumo (regra do momento da contagem).
  if (temInicial && temFinal) {
    if (janelaVazia) {
      avisoHTML += `<div class="alert alert-warning py-2"><i class="fas fa-circle-info me-1"></i>
        Pelas datas e horários informados, <strong>não sobra nenhum dia de venda</strong> entre as duas contagens.
        Confira as datas e o momento (abertura/fechamento) de cada uma.</div>`;
    } else {
      avisoHTML += `<div class="alert alert-info py-2 mb-2"><i class="fas fa-calendar-check me-1"></i>
        <strong>Vendas consideradas:</strong> ${fmtDate(janIni)} a ${fmtDate(janFim)}
        <span class="text-muted">— contagem inicial ${momLabel(momIni)}, final ${momLabel(momFim)}.</span>
        <span class="d-block small text-muted mt-1">O dia de uma contagem feita <em>antes da noite</em> não entra no consumo daquele período (entra no próximo).</span></div>`;
    }
  }

  // Aviso de cobertura de vendas (evita "divergência gigante" falsa)
  if (temInicial && temFinal && !janelaVazia && diasJanela > 0 && coberturaVendas < 0.8) {
    const pct = Math.round(coberturaVendas * 100);
    avisoHTML += `<div class="alert alert-warning">
      <strong><i class="fas fa-triangle-exclamation me-1"></i>Atenção: vendas incompletas neste período.</strong>
      O intervalo entre as contagens tem <strong>${diasJanela} dias</strong>, mas só há vendas TOTEM para <strong>${diasVendas} dia(s)</strong> (${pct}% do período).
      Sem as vendas do período inteiro, o "consumo esperado" fica baixo e a divergência aparece <strong>muito maior do que a real</strong> (falsa perda).
      Para uma análise confiável, escolha um período em que as contagens de início e fim estejam logo antes e depois de vendas TOTEM importadas — ou importe as vendas que faltam.</div>`;
  }
  avisoEl.innerHTML = avisoHTML;

  // Cards de sumário — DEFINIÇÕES OFICIAIS (auditoria 02/07): variação líquida = real − esperado
  // (sobra abate perda; pode ser negativa) e perda bruta = só as perdas. Furos (consumo negativo)
  // ficam FORA das duas somas — são erro de dado, não economia.
  const semFuro = resultado.filter(r=>!r.impossivel);
  const variacaoTotal = semFuro.reduce((s,r)=>s+r.impacto,0);
  const perdaBrutaTotal = semFuro.reduce((s,r)=>s+Math.max(r.impacto,0),0);
  const nFuros = resultado.length - semFuro.length;
  document.getElementById('an-cards').innerHTML = `
    <div class="col-6 col-md"><div class="stat-card h-100">
      <div class="lbl">Loja</div><div class="val fs-5">${LOJA_LABEL[loja]}</div></div></div>
    <div class="col-6 col-md"><div class="stat-card h-100">
      <div class="lbl">Contagem inicial</div>
      <div class="val fs-6">${temInicial ? fmtDate(ctInicialData) : '<span class="text-danger">Não encontrada</span>'}</div></div></div>
    <div class="col-6 col-md"><div class="stat-card h-100">
      <div class="lbl">Contagem final</div>
      <div class="val fs-6">${temFinal ? fmtDate(ctFinalData) : '<span class="text-danger">Não encontrada</span>'}</div></div></div>
    <div class="col-6 col-md"><div class="stat-card h-100" ${detAttr('an-perda','Ver insumo a insumo o que formou a perda')}>
      <div class="lbl">Perda bruta <span title="Só as perdas (consumo acima da ficha). Sobra NÃO abate. Furos fora." style="cursor:help">ⓘ</span></div>
      <div class="val ${perdaBrutaTotal>0?'text-danger':'text-success'}">${fmtBRL(perdaBrutaTotal)}</div></div></div>
    <div class="col-6 col-md"><div class="stat-card h-100" ${detAttr('an-variacao','Ver o que perdeu e o que sobrou')}>
      <div class="lbl">Variação líquida <span title="CMV real − CMV esperado (sobras abatem perdas). Furos fora." style="cursor:help">ⓘ</span></div>
      <div class="val ${variacaoTotal>0?'text-danger':variacaoTotal<0?'text-primary':''}">${variacaoTotal>=0?'+':'−'} ${fmtBRL(Math.abs(variacaoTotal))}</div></div></div>
    ${nFuros?`<div class="col-6 col-md"><div class="stat-card h-100" ${detAttr('an-furos','Ver quais itens estão com furo e qual contagem revisar')}>
      <div class="lbl text-danger">Furos (consumo negativo)</div>
      <div class="val text-danger">${nFuros}</div></div></div>`:''}`;

  // Contexto do drill-down: as MESMAS linhas que a tabela abaixo já mostra.
  _detCtx.an = {loja, resultado, semFuro, variacaoTotal, perdaBrutaTotal, nFuros,
                janIni, janFim, ctInicialData, ctFinalData, temInicial, temFinal};

  if (!temInicial || !temFinal) {
    toast('⚠️ Contagem inicial ou final não encontrada. Os cálculos podem estar incompletos.', 'warning');
  }

  // Tabela
  const tbody = document.getElementById('an-tbody');
  tbody.innerHTML = resultado.map(r => tabelaDivergLinha(r, 2, 3)).join('');

  // Alertas de qualidade da contagem: (1) entradas não explicadas (furo, consumo negativo) e
  // (2) contagens provavelmente erradas (fator absurdo). As duas apontam CONTAGENS a revisar antes
  // de acreditar na perda — respondem "qual contagem tem gasto provavelmente errado?".
  const elLogico = document.getElementById('an-alerta-logico');
  let logHTML = '';
  const impossiveis = resultado.filter(r=>r.impossivel);
  if (impossiveis.length) {
    const linhas = impossiveis.map(r=>{
      const subiu = -r.consumoReal; // quanto sobrou além do que entrou
      const onde = (r.culpas && r.culpas.length)
        ? ` — <strong class="text-danger">erro entre as contagens de ${r.culpas.map(c=>`${fmtDate(c.de)} → ${fmtDate(c.ate)} (${fmtNum(-c.valor,2)} ${esc(r.unidade||'')} a mais)`).join(' e de ')}</strong>`
        : ' — <span class="text-muted">não deu pra isolar em qual contagem (o excesso se espalha pela janela toda; confira as contagens das pontas)</span>';
      return `<li><strong>${esc(r.ing)}</strong>: o estoque ficou <strong>${fmtNum(subiu,2)} ${esc(r.unidade||'')}</strong> acima do que entrou (custo aprox. ${fmtBRL(Math.abs(r.impacto))})${onde}</li>`;
    }).join('');
    logHTML += `<div class="alert alert-danger">
      <strong><i class="fas fa-circle-exclamation me-1"></i>Entradas não explicadas (furo) — confira estes itens:</strong>
      <div class="small mt-1">O estoque final ficou <em>maior</em> do que tudo que entrou (início + compras ± transferências). Isso normalmente significa que <strong>faltou lançar uma compra/transferência</strong> ou houve <strong>erro de contagem</strong>.</div>
      <ul class="small mb-0 mt-2">${linhas}</ul></div>`;
  }
  const suspeitos = resultado.filter(r=>r.suspeito);
  if (suspeitos.length) {
    const linhas = suspeitos.map(r=>{
      const lado = r.consumoReal>r.esperado ? 'saiu MUITO mais' : 'saiu MUITO menos';
      return `<li><strong>${esc(r.ing)}</strong>: consumo real <strong>${fmtNum(r.consumoReal,2)} ${esc(r.unidade||'')}</strong> vs esperado <strong>${fmtNum(r.esperado,2)}</strong> — <span class="selo selo-revisar">${fmtNum(r.fator,0)}× fora</span> (${lado}, impacto ${fmtBRL(Math.abs(r.impacto))}). Reconfira a contagem de ${temFinal?fmtDate(ctFinalData):'fim'}.</li>`;
    }).join('');
    logHTML += `<div class="alert" style="background:rgba(231,165,43,.12);border:1px solid rgba(231,165,43,.5)">
      <strong style="color:#8a5a00"><i class="fas fa-triangle-exclamation me-1"></i>Contagens provavelmente erradas — revise antes de tratar como perda:</strong>
      <div class="small mt-1">O consumo real ficou <strong>3× ou mais</strong> longe do esperado. Quase sempre é <strong>número digitado errado na contagem</strong> (ex.: 8 kg onde deveria ter ~25 kg), não desperdício de verdade — por isso ficam <strong>fora do gráfico de impacto</strong>.</div>
      <ul class="small mb-0 mt-2">${linhas}</ul></div>`;
  }
  elLogico.innerHTML = logHTML;

  // Tabela exclusiva de BEBIDAS (desvios) — só aparece se houver bebidas com movimento
  const bebs = resultadoBebidas || [];
  const bebCard = document.getElementById('an-bebidas-card');
  const bebTbody = document.getElementById('an-beb-tbody');
  const bebResumo = document.getElementById('an-beb-resumo');
  if (bebs.length) {
    bebCard.classList.remove('d-none');
    bebTbody.innerHTML = bebs.map(r => tabelaBebidaLinha(r)).join('');
    const impBeb = bebs.reduce((s,r)=>s+r.impacto,0);
    const sumindo = bebs.filter(r=>r.divergencia>0.5).length;
    bebResumo.innerHTML = `<span class="text-muted">${bebs.length} bebida(s) · `+
      (sumindo ? `<strong class="text-danger">${sumindo}</strong> com sumiço além do vendido · ` : '')+
      `desvio total <strong class="${impBeb>0?'text-danger':impBeb<0?'text-primary':''}">${fmtBRL(Math.abs(impBeb))}</strong></span>`;
  } else {
    bebCard.classList.add('d-none');
    bebTbody.innerHTML = '';
    bebResumo.innerHTML = '';
  }

  // Gráfico — SÓ perdas/sobras plausíveis. Furos (consumo negativo) e itens "revisar" (fator absurdo,
  // provável erro de contagem) ficam FORA: a barra gigante de um erro achatava as barras reais de ~R$1.000
  // e estragava a leitura. Os itens tirados aparecem numa nota abaixo do gráfico e com selo na tabela.
  if (_chartInstance) { _chartInstance.destroy(); _chartInstance=null; }
  const plausiveis = resultado.filter(r=>!r.impossivel && !r.suspeito);
  const foraGrafico = resultado.length - plausiveis.length;
  const top = [...plausiveis].sort((a,b)=>Math.abs(b.impacto)-Math.abs(a.impacto)).slice(0,15);
  const notaEl = document.getElementById('an-chart-nota');
  if (notaEl) notaEl.innerHTML = foraGrafico
    ? `<i class="fas fa-triangle-exclamation text-warning me-1"></i><strong>${foraGrafico}</strong> ite${foraGrafico>1?'ns':'m'} fora do gráfico (furo ou provável erro de contagem) — veja os selos <span class="selo selo-furo">⚑ furo</span> / <span class="selo selo-revisar">⚠ revisar</span> na tabela. O gráfico mostra só perdas/sobras plausíveis, na escala certa.`
    : '';
  const ctx = document.getElementById('an-chart').getContext('2d');
  _chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(r=>r.ing),
      datasets: [{
        label: 'Impacto R$',
        data: top.map(r=>Math.abs(r.impacto)),
        backgroundColor: top.map(r=>r.divergencia>0?'rgba(192,57,43,0.7)':'rgba(52,152,219,0.7)'),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive:true,
      plugins: {legend:{display:false},
        tooltip:{callbacks:{label:c=>(top[c.dataIndex].divergencia>0?'Perda ':'Sobra ')+fmtBRL(Math.abs(top[c.dataIndex].impacto))}}},
      scales: {x:{ticks:{callback:v=>'R$'+v.toFixed(0)}}}
    }
  });

  // Não mapeados
  if (Object.keys(naoMapeados).length) {
    document.getElementById('an-nao-mapeados').classList.remove('d-none');
    document.getElementById('an-nao-mapeados-lista').innerHTML = Object.entries(naoMapeados).map(([k,v])=>`${k} (${v}x)`).join('<br>');
  } else {
    document.getElementById('an-nao-mapeados').classList.add('d-none');
  }

  document.getElementById('an-resultado').classList.remove('d-none');
}

// ================================================================
// 11B. PAINEL GERENCIAL — KPIs, mix de sabores, gramatura, compras
// ================================================================
let _pnCharts = [];
let _pnAtualizando = false;
const PN_CORES = ['#922b21','#1a5276','#145a32','#b9770e','#6c3483','#117a65','#a04000','#283747','#7b241c','#1f618d','#9a7d0a','#515a5a'];

// Devolve o canvas destruindo qualquer gráfico que ainda esteja usando ele
function pnCanvas(id) {
  const el = document.getElementById(id);
  Chart.getChart(el)?.destroy();
  return el;
}

function fmtPct(x, dec=1) {
  if (x===null || x===undefined || !isFinite(x)) return '—';
  return x.toLocaleString('pt-BR',{minimumFractionDigits:dec,maximumFractionDigits:dec})+'%';
}

// Custo dos ingredientes de 1 pizza inteira (ficha técnica × custo).
// custoFn(ing) opcional: por padrão usa o preço-base; o Painel passa o preço PAGO.
function custoFichaSabor(nome, custoFn) {
  const ficha = FICHA_TECNICA[nome];
  if (!ficha) return null;
  const fCusto = custoFn || getCustoIng;
  let custo = 0, completo = true;
  for (const [ing,g] of Object.entries(ficha._ingredientes)) {
    const n = normIng(ing);
    if (MASSA_SET.has(n)) continue; // custo da massa somado à parte
    const emUn = ['OVO','CAIXA'].includes(n);
    const c = fCusto(n);
    custo += (emUn ? g : g/1000) * c;
    if (!c && (emUn || g>=10)) completo = false; // ingrediente relevante sem custo cadastrado
  }
  // custo da massa (por pizza inteira)
  for (const [ing,d] of Object.entries(MASSA_RECEITA)) custo += d.qtdBase * fCusto(ing);
  // custo da embalagem (1 caixa por pizza inteira)
  custo += CAIXA_POR_PIZZA * fCusto(normIng('CAIXA DE PIZZA'));
  return {custo, completo};
}

// Nome do sabor para o mix: ficha técnica, ou nome do produto sem o prefixo MEIA/INTEIRA
function nomeSaborMix(m, it) {
  return m.nome_ficha
    || norm(it.produto||'').replace(/^(MEIA|1\/2|INTEIRA|PIZZA|PREMIUM)\s+/,'').trim()
    || ('CÓD '+it.codigo);
}

// ================================================================
//  PAINEL DO CEO (v1: financeiro + canais + pico). Lê pedidos_resumo.json
//  (agregados, sem PII). Receita vem do TOTEM; 99Food no BRUTO (repasse depois).
// ================================================================
const CEO_CANAIS = ['Balcao','Entrega propria','99Food','Outros'];
// Canais REAIS (fora "Outros"/JANTA) — usado no CEO e no Dashboard para faturamento/pizzas por canal.
const CANAIS_BASE = ['Balcao','Entrega propria','99Food'];  // FASE 1: padrão da marca (semente PPV)
let CANAIS_REAIS = CANAIS_BASE.slice();                    // por empresa via aplicarConfigVendas() — sem config = igual à semente
const CEO_CANAL_LABEL = {'Balcao':'Balcão','Entrega propria':'Entrega própria','99Food':'99Food','Outros':'Outros'};
const CEO_CANAL_COR = {'Balcao':'#1a5276','Entrega propria':'#145a32','99Food':'#e67e22','Outros':'#7f8c8d'};
// Fator de recebimento do 99Food por loja: o bruto do TOTEM NÃO é o que cai na conta.
// Aproximação do estudo de repasse (mai/jun 2026); o repasse REAL da planilha entra numa próxima etapa.
let FATOR_99 = {PLANALTO:0.47, BURITIS:0.40, VENDA_NOVA:0.43, _default:0.43};  // idem
let _ceoData = null, _ceoCharts = [], _ceoBusy = false, _ceoPending = false;

// --- Repasse REAL da 99Food lançado MANUALMENTE pelo usuário (lista data+valor por loja) ---
// Guardado no navegador (localStorage). Chave 'LOJA|AAAA-MM-DD' → valor líquido (R$). Esse valor
// PASSA NA FRENTE da estimativa por fator E do valor vindo do JSON do TOTEM. Entra no backup.
let _repasse99Cache = null;
function getRepasse99Manual() {
  if (_repasse99Cache) return _repasse99Cache;
  try { _repasse99Cache = JSON.parse(localStorage.getItem('repasse99_manual_v1')) || {}; } catch(e) { _repasse99Cache = {}; }
  return _repasse99Cache;
}
function setRepasse99Manual(obj) {
  _repasse99Cache = obj || {};
  localStorage.setItem('repasse99_manual_v1', JSON.stringify(_repasse99Cache));
}
// Repasse 99 EFETIVO por 'LOJA|AAAA-MM-DD': o que veio da planilha (arr do JSON) + o lançado à mão
// por cima. Fonte única do 99Food — usada em Dashboard, CEO e Comparativo (evita 3 cópias do mesmo laço).
function repasseEfetivo(arr) {
  const m = {};
  for (const r of (arr||[])) m[r.loja+'|'+r.data] = r.repasse;
  Object.assign(m, getRepasse99Manual());   // lançamento manual passa na frente
  return m;
}

// ================================================================
//  CUSTOS FIXOS (aba própria, sub-aba do CEO — o DRE só LÊ daqui).
//  Cadastro: lista de gastos com tipo EXATO (mesmo valor todo mês: aluguel, contabilidade…)
//  ou VARIÁVEL (digitado a cada mês: água, luz, royalties…). Valores por chave
//  'AAAA-MM' (rede) ou 'AAAA-MM|LOJA'. Exato entra pelo padrão sem digitar; valor do
//  mês digitado passa na frente. Tudo no localStorage e no backup.
// ================================================================
const DRE_CAMPOS = [   // seeds da migração (eram os 5 campos fixos do DRE antigo)
  {k:'folha',     lbl:'Folha (CLT)'},
  {k:'ocupacao',  lbl:'Aluguel + energia + água + gás'},
  {k:'royalties', lbl:'Royalties + fundo de marketing'},
  {k:'juros',     lbl:'Juros do empréstimo'},
  {k:'outros',    lbl:'Outros custos fixos'},
];
// ---- CATEGORIAS do DRE = a taxonomia do Gabriel (a planilha FECHAMENTO dele, 08/07). CMV e Bebidas
// são AUTOMÁTICOS (consumo do estoque); dentro de Pessoal, freela/motoboy vêm do TOTEM. O que o Gabriel
// DIGITA cai só nestas categorias. Empréstimo e Retirada de capital ficam ABAIXO da linha (fora do EBITDA).
const DRE_GRUPOS_BASE = ['Pessoal','Fixos','Variáveis','Imposto','Royalties','CASA','Empréstimo','Retirada de capital'];
const DRE_GRUPOS_ABAIXO = ['CASA','Empréstimo','Retirada de capital'];   // não entram no EBITDA (CASA = despesa pessoal)
// chave anti-duplicidade de custo: nome normalizado (sem acento/caixa/pontuação/parênteses) + loja.
// Assim "Gás (Unigás)" ≈ "gas", "Energia elétrica" ≈ "energia eletrica" — pega variação trivial de digitação.
function chaveCF(nome, loja){
  const n = String(nome||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/\([^)]*\)/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  return n + '|' + (loja||'');
}
// tokens significativos do nome (p/ detectar "parecidos" que a chave exata não pega)
function tokensCF(nome){
  const stop=new Set(['de','da','do','das','dos','e','a','o','com','por','the','sistema','mensalidade','conta']);
  return new Set(String(nome||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(t=>t.length>2 && !stop.has(t)));
}
// cor semântica por categoria do DRE (paleta da marca do site) — usada na banda de grupo da Custos Fixos
const GRUPO_COR = {'Pessoal':'#21294e','Fixos':'#4054b2','Variáveis':'#c12628','Imposto':'#E7A52B','Royalties':'#cc3366','CASA':'#8a90a0','Empréstimo':'#6B7280','Retirada de capital':'#6B7280'};
let _dreGruposCache = null;
function getDREGrupos() {
  if (_dreGruposCache) return _dreGruposCache;
  try { _dreGruposCache = JSON.parse(localStorage.getItem('dre_grupos_v1')); } catch(e){ _dreGruposCache = null; }
  if (!Array.isArray(_dreGruposCache) || !_dreGruposCache.length) _dreGruposCache = [...DRE_GRUPOS_BASE];
  return _dreGruposCache;
}
function setDREGrupos(list) { _dreGruposCache = [...new Set((list||[]).map(s=>String(s).trim()).filter(Boolean))]; localStorage.setItem('dre_grupos_v1', JSON.stringify(_dreGruposCache)); }
// Adivinha o grupo de um gasto pelo nome (migração + sugestão no cadastro).
// Adivinha a CATEGORIA de um gasto pelo nome, na taxonomia do Gabriel. Variáveis é o balde-padrão
// (uber, combustível, cartão, manutenção, outros — como na planilha dele).
function grupoPorNome(nome) {
  const n = (nome||'').toLowerCase();
  if (/retirada|distribui[cç]|s[oó]cio.*retir/.test(n)) return 'Retirada de capital';
  if (/juros|empr[eé]stimo|amortiz/.test(n)) return 'Empréstimo';
  if (/pr[oó].?labore|s[oó]cio|folha|sal[aá]rio|inss\b|ir\b|fgts|freela|funcion|13[oº]|f[eé]rias|passagem|vale|adiantamento|rescis[aã]o/.test(n)) return 'Pessoal';
  if (/simples|imposto|\bdas\b|darf/.test(n)) return 'Imposto';
  if (/royalt|fundo de mkt|fundo mkt|o\.?s\.?a/.test(n)) return 'Royalties';
  if (/aluguel|energia|luz|[aá]gua|g[aá]s|telefon|internet|condom|iptu|contabil|contador|honor[aá]rio|sistema|software|mensalidade|alvar[aá]|pjbank|cf inform|innovation/.test(n)) return 'Fixos';
  return 'Variáveis';   // uber, combustível, gasolina, fatura cartão, manutenção, marketing, limpeza, material, perda, tarifa, outros…
}
// Natureza do custo p/ o DRE (pedido do Gabriel 07/07): FIXO (repete todo mês, independe de vender) ×
// VARIÁVEL (acompanha o movimento). É eixo DIFERENTE do "Exato/Variável" (que é só sobre repetir o valor).
// Usado no split do DRE e no Ponto de Equilíbrio (só os FIXOS entram no numerador do PE).
function naturezaPadrao(nome, grupo) {
  // Fixo = repete todo mês, independe de vender (Fixos + a folha/pró-labore do Pessoal).
  // Variável = acompanha o movimento (freela/motoboy, Variáveis, Imposto, Royalties, CMV, Bebidas).
  const g = grupo || grupoPorNome(nome);
  const n = (nome||'').toLowerCase();
  if (g === 'Fixos') return 'fixo';
  if (g === 'Pessoal') return /freela|freel|motoboy|taxa (cozinha|atendimento)/.test(n) ? 'variavel' : 'fixo';
  return 'variavel';
}
let _dreCustosCache = null, _cfCadCache = null;
function getDRECustosAll() {
  if (_dreCustosCache) return _dreCustosCache;
  try { _dreCustosCache = JSON.parse(localStorage.getItem('dre_custos_v1')) || {}; } catch(e) { _dreCustosCache = {}; }
  return _dreCustosCache;
}
function getDRECustos(chave) { return getDRECustosAll()[chave] || {}; }
function setDRECusto(chave, campo, valor) {
  const all = {...getDRECustosAll()};
  all[chave] = {...(all[chave]||{})};
  if (isNaN(valor) || valor<=0) delete all[chave][campo]; else all[chave][campo] = valor;
  if (!Object.keys(all[chave]).length) delete all[chave];
  _dreCustosCache = all;
  localStorage.setItem('dre_custos_v1', JSON.stringify(all));
}
function getCFCad() {
  if (_cfCadCache) return _cfCadCache;
  try { _cfCadCache = JSON.parse(localStorage.getItem('dre_custos_cad_v1')); } catch(e) { _cfCadCache = null; }
  if (!Array.isArray(_cfCadCache)) {
    // migração: os 5 campos antigos viram itens VARIÁVEIS da rede (valores por mês já salvos continuam valendo)
    _cfCadCache = DRE_CAMPOS.map(c=>{ const g=grupoPorNome(c.lbl); return {id:c.k, nome:c.lbl, tipo:'variavel', padrao:0, loja:'', grupo:g, natureza:naturezaPadrao(c.lbl,g)}; });
    setCFCad(_cfCadCache);
  }
  // migração leve: garante grupo E natureza (Fixo/Variável) em cadastros antigos
  let mig=false; for (const it of _cfCadCache) {
    if (!it.grupo) { it.grupo = grupoPorNome(it.nome); mig=true; }
    if (!it.natureza) { it.natureza = naturezaPadrao(it.nome, it.grupo); mig=true; }
  }
  // migração v2 (08/07): adota a TAXONOMIA do Gabriel (Pessoal/Fixos/Variáveis/Imposto/Royalties/
  // Empréstimo/Retirada). Roda UMA vez: reclassifica todo gasto pelo nome e reseta os grupos.
  if (localStorage.getItem('dre_taxonomia_v2') !== '1') {
    for (const it of _cfCadCache) { it.grupo = grupoPorNome(it.nome); it.natureza = naturezaPadrao(it.nome, it.grupo); }
    _dreGruposCache = [...DRE_GRUPOS_BASE];
    localStorage.setItem('dre_grupos_v1', JSON.stringify(_dreGruposCache));
    localStorage.setItem('dre_taxonomia_v2', '1');
    mig = true;
  }
  if (mig) setCFCad(_cfCadCache);
  return _cfCadCache;
}
function setCFCad(list) { _cfCadCache = list||[]; localStorage.setItem('dre_custos_cad_v1', JSON.stringify(_cfCadCache)); }

// ---- SANGRIAS do caixa (saídas CD='D' do TOTEM) → custos do DRE, por FUNÇÃO (pedido do Gabriel) ----
const SANGRIA_CATS = ['Motoboy','Freelancer Cozinha','Freelancer Atendimento','Fornecedor','Manutenção','Ajuste','Outros','Ignorar'];
const SANGRIA_GRUPO = {'Motoboy':'Pessoal','Freelancer Cozinha':'Pessoal','Freelancer Atendimento':'Pessoal','Fornecedor':'Outros','Manutenção':'Ocupação','Ajuste':'Outros','Outros':'Outros'};
// PLANO DE CONTAS do TOTEM (vw_financeiro.Plano) → categoria de função do DRE. É a fonte MAIS
// confiável: distingue TAXA COZINHA × TAXA ATENDIMENTO e marca matéria-prima pela conta (não pelo
// texto do documento). Matéria-prima/revenda/embalagem paga pelo caixa já entra no CMV pela aba
// Compras → "Ignorar" por padrão (o Gabriel reclassifica p/ "Fornecedor" o que NÃO lançou em Compras).
const SANGRIA_PLANO_MATERIA = ['QUEIJO','MUSSARELA','BEBIDA','TRIGO','MOLHO','BACON','CREME DE LEITE',
  'CHOCOLATE','FRANGO','OLEO','EMBALAGEN','MATERIA PRIMA','MATERIA-PRIMA','REVENDA','CALABRESA','CATUPIRY',
  'PRESUNTO','MILHO','CHEDDAR','GORGONZOLA','DOCE DE LEITE','GOIABADA','PEPPERONI','LOMBO','BATATA'];
function planoParaCategoria(plano) {
  const p = norm(plano);
  if (!p) return null;
  if (p.includes('MOTOBOY')) return 'Motoboy';
  if (p.includes('COZINHA')) return 'Freelancer Cozinha';
  if (p.includes('ATENDIMENTO')) return 'Freelancer Atendimento';
  if (p.includes('OBRA') || p.includes('MANUTEN')) return 'Manutenção';
  if (SANGRIA_PLANO_MATERIA.some(m=>p.includes(m))) return 'Ignorar';
  return null;   // OUTROS / plano desconhecido → tenta a descrição depois
}
// Quando o plano é OUTROS/vazio, tenta pela DESCRIÇÃO. Na Buritis lançam muita sangria de freelancer
// com plano OUTROS e só o nome/palavra na descrição (ex.: "CRISTIAN COZINHA", "MICAELY FRELLANCER").
function categoriaPelaDescricao(desc) {
  const d = norm(desc);
  if (!d) return null;
  if (d.includes('MOTOBOY')) return 'Motoboy';
  if (d.includes('COZINHA')) return 'Freelancer Cozinha';
  if (d.includes('ATENDIMENTO')) return 'Freelancer Atendimento';
  if (d.includes('FREEL') || d.includes('FREL')) return 'Freelancer Cozinha';  // freelancer sem especificar → cozinha
  if (d.includes('UBER')) return 'Outros';
  return null;   // só um nome, sem palavra-chave → o usuário cria uma regra na aba Corrigir categorias
}
// Categoria-padrão: PLANO DE CONTAS do TOTEM (confiável) → DESCRIÇÃO (freelancer tageado como OUTROS)
// → palpite do extrator (por Documento) → Outros.
function sangriaCatPadrao(s) {
  const porPlano = planoParaCategoria(s.plano);
  if (porPlano) return porPlano;
  const porDesc = categoriaPelaDescricao(s.descricao);
  if (porDesc) return porDesc;
  const c = s.categoria || '';
  if (c==='Motoboy') return 'Motoboy';
  if (c==='Freelancer') return 'Freelancer Cozinha';        // sem plano: default cozinha; reclassifica atendimento
  // Fornecedor pago em dinheiro e Ajuste de caixa NÃO entram por padrão: o fornecedor já cai no CMV
  // pela aba Compras (somar de novo dobraria o custo) e o ajuste é acerto de caixa, não despesa.
  if (c==='Compras/Fornecedores') return 'Ignorar';
  if (c==='Ajuste') return 'Ignorar';
  return 'Outros';
}
let _sangCorrCache=null, _sangRegrasCache=null;
function sangKey(s){ return `${s.loja}|${s.data}|${Math.round((s.valor||0)*100)}|${(s.descricao||'').slice(0,40)}`; }
function getSangCorr(){ if(_sangCorrCache) return _sangCorrCache; try{_sangCorrCache=JSON.parse(localStorage.getItem('sangrias_correcao_v1'))||{};}catch(e){_sangCorrCache={};} if(typeof _sangCorrCache!=='object'||!_sangCorrCache)_sangCorrCache={}; return _sangCorrCache; }
function setSangCorr(o){ _sangCorrCache=o||{}; localStorage.setItem('sangrias_correcao_v1', JSON.stringify(_sangCorrCache)); }
function getSangRegras(){ if(_sangRegrasCache) return _sangRegrasCache; try{_sangRegrasCache=JSON.parse(localStorage.getItem('sangrias_regras_v1'));}catch(e){_sangRegrasCache=null;} if(!Array.isArray(_sangRegrasCache))_sangRegrasCache=[]; return _sangRegrasCache; }
function setSangRegras(l){ _sangRegrasCache=l||[]; localStorage.setItem('sangrias_regras_v1', JSON.stringify(_sangRegrasCache)); }
// Categoria FINAL de uma sangria: correção manual (por chave) > regra (descrição contém) > padrão do TOTEM.
function categoriaSangria(s){
  const k=sangKey(s), corr=getSangCorr();
  if (corr[k]) return corr[k];
  const desc=(s.descricao||'').toLowerCase();
  for (const r of getSangRegras()) if (r.contem && desc.includes(String(r.contem).toLowerCase())) return r.categoria;
  return sangriaCatPadrao(s);
}
// Total das sangrias do mês por categoria de função, p/ o DRE. 'Ignorar' fica fora (já contabilizado noutro lugar).
function sangriasDRE(pagData, lojaSel, ini, fim){
  const out={total:0, porCat:{}, n:0};
  const arr=(pagData&&pagData.sangrias)||[];
  for (const s of arr){
    if (lojaSel && s.loja!==lojaSel) continue;
    if (ini && s.data<ini) continue;
    if (fim && s.data>fim) continue;
    const cat=categoriaSangria(s);
    if (cat==='Ignorar') continue;
    const v=s.valor||0; out.porCat[cat]=(out.porCat[cat]||0)+v; out.total+=v; out.n++;
  }
  return out;
}

// ---- EMPRÉSTIMOS entre lojas: movimento de caixa (NÃO entra no resultado), fica em aberto até quitar ----
let _empCache=null;
function getEmprestimos(){ if(_empCache) return _empCache; try{_empCache=JSON.parse(localStorage.getItem('emprestimos_lojas_v1'));}catch(e){_empCache=null;} if(!Array.isArray(_empCache))_empCache=[]; return _empCache; }
function setEmprestimos(l){ _empCache=l||[]; localStorage.setItem('emprestimos_lojas_v1', JSON.stringify(_empCache)); }
// Saldo em aberto: por loja (positivo = tem a receber de outra; negativo = deve a outra).
function emprestimosAberto(){
  const abertos=getEmprestimos().filter(e=>!e.quitado);
  const porLoja={};
  for (const e of abertos){ porLoja[e.origem]=(porLoja[e.origem]||0)+(e.valor||0); porLoja[e.destino]=(porLoja[e.destino]||0)-(e.valor||0); }
  return {abertos, porLoja};
}
// Total do mês p/ o DRE. Cada GASTO pertence a um escopo (loja:'' = rede/geral, ou uma loja).
// DRE da REDE soma TODOS os gastos; DRE de uma loja soma só os gastos DAQUELA loja (os "rede/geral"
// não são rateados — aparecem só na visão rede). Valor efetivo: exato = padrão (ou o valor do mês,
// se digitado por cima); variável = só o valor digitado no mês. Chave dos valores = 'AAAA-MM'.
function dreCustosTotal(mes, lojaSel) {
  const vals = getDRECustos(mes);
  const out = { total:0, exatos:0, variaveis:0, natFixo:0, natVar:0, nExatos:0, nVariaveis:0, itens:[] };
  for (const it of getCFCad()) {
    if (lojaSel && (it.loja||'') !== lojaSel) continue;
    const v = vals[it.id] != null ? vals[it.id] : (it.tipo==='exato' ? (it.padrao||0) : 0);
    if (v>0) { out.itens.push({...it, valor:v});
      if (it.tipo==='exato'){ out.exatos+=v; out.nExatos++; } else { out.variaveis+=v; out.nVariaveis++; }
      // natureza do custo (Fixo × Variável) — eixo separado, usado no DRE e no Ponto de Equilíbrio
      if ((it.natureza || naturezaPadrao(it.nome, it.grupo)) === 'variavel') out.natVar+=v; else out.natFixo+=v; }
  }
  out.total = out.exatos + out.variaveis;
  return out;
}
function cfMes() { return (document.getElementById('cf-mes')||{}).value || today().slice(0,7); }
function popularGrupoSelect(sel, val){ if(!sel) return; sel.innerHTML = getDREGrupos().map(g=>`<option value="${esc(g)}"${g===val?' selected':''}>${esc(g)}</option>`).join(''); }
let _cfViewAtiva='visao', _cfGrupoAberto=null, _cfReviewGroups=[];
function cfSetView(view) {
  _cfViewAtiva=view||'visao';
  document.querySelectorAll('#page-custosfixos .cf-view').forEach(el=>el.classList.toggle('active',el.id===`cf-view-${_cfViewAtiva}`));
  document.querySelectorAll('#page-custosfixos [data-cf-view]').forEach(el=>el.classList.toggle('active',el.dataset.cfView===_cfViewAtiva));
}
function cfMesDeslocado(ym, delta) {
  const d=new Date(parseInt(ym.slice(0,4),10),parseInt(ym.slice(5,7),10)-1+delta,1);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function cfValorEfetivo(it, vals) { return vals[it.id]!=null ? vals[it.id] : (it.tipo==='exato'?(it.padrao||0):0); }
function cfResumoEscopo(mes, cad) {
  const vals=getDRECustos(mes); let total=0,natFixo=0,natVar=0,abaixo=0,preenchidos=0;
  for (const it of cad) { const v=cfValorEfetivo(it,vals); if(v>0){ preenchidos++; total+=v;
      if(DRE_GRUPOS_ABAIXO.includes(it.grupo)) abaixo+=v;
      if((it.natureza||naturezaPadrao(it.nome,it.grupo))==='variavel')natVar+=v; else natFixo+=v; } }
  return {total,natFixo,natVar,abaixo,operacional:Math.max(total-abaixo,0),preenchidos,esperados:cad.length,
    pct:cad.length?Math.round(preenchidos/cad.length*100):100};
}
function cfToggleGrupoIndex(i) {
  const g=_cfReviewGroups[i]; _cfGrupoAberto=_cfGrupoAberto===g?null:g;
  document.querySelectorAll('#cf-revisao .cf-group').forEach((el,idx)=>el.classList.toggle('open',_cfGrupoAberto===_cfReviewGroups[idx]));
}
function renderCFRevisao(mes,cad,porGrupo,gruposComItem,badgeLoja) {
  const host=document.getElementById('cf-revisao'); if(!host)return;
  const vals=getDRECustos(mes); _cfReviewGroups=gruposComItem;
  if(_cfGrupoAberto && !gruposComItem.includes(_cfGrupoAberto))_cfGrupoAberto=null;
  const html=gruposComItem.map((g,i)=>{
    const its=porGrupo[g], preenchidos=its.filter(it=>cfValorEfetivo(it,vals)>0).length;
    const total=its.reduce((s,it)=>s+cfValorEfetivo(it,vals),0), aberto=_cfGrupoAberto===g;
    const rows=its.map(it=>{const vMes=vals[it.id], efetivo=cfValorEfetivo(it,vals), nv=it.natureza||naturezaPadrao(it.nome,it.grupo);
      return `<div class="cf-review-row"><div><div class="cf-review-name">${esc(it.nome)}</div><div class="cf-review-meta">${badgeLoja(it)} · ${nv==='variavel'?'variável':'fixo'}${it.tipo==='exato'?' · recorrente':''}</div></div>
        <div class="cf-review-meta">${efetivo>0?'<span class="text-success"><i class="fas fa-circle-check me-1"></i>preenchido</span>':'<span class="text-warning"><i class="fas fa-clock me-1"></i>pendente</span>'}</div>
        <input type="text" inputmode="decimal" class="form-control form-control-sm text-end" value="${vMes!=null?fmtNum(vMes,2):(it.tipo==='exato'&&it.padrao?fmtNum(it.padrao,2):'')}" placeholder="0,00" data-cf-valor="${it.id}" onchange="cfValorInput(this)" onkeydown="if(event.key==='Enter'){this.blur()}" aria-label="Valor de ${esc(it.nome)}"></div>`;}).join('');
    return `<div class="cf-group${aberto?' open':''}"><button type="button" class="cf-group-head" onclick="cfToggleGrupoIndex(${i})"><span><span class="cf-dot" style="background:${Object.hasOwn(GRUPO_COR,g)?GRUPO_COR[g]:'#8a90a0'}"></span><span class="cf-group-title">${esc(g)}</span><span class="cf-group-meta ms-2">${preenchidos}/${its.length} preenchidos</span></span><span class="cf-group-total">${fmtBRL(total)}</span><i class="fas fa-chevron-right cf-group-chev"></i></button><div class="cf-group-body">${rows}</div></div>`;
  }).join('');
  host.innerHTML=`<div class="d-flex justify-content-between align-items-end mb-2"><div><h6 class="mb-0">Revisão por grupo</h6><div class="small text-muted">Abra somente o grupo que vai conferir ou preencher.</div></div></div>${html||'<div class="alert alert-light border">Nenhum gasto cadastrado neste filtro.</div>'}`;
}
function renderCFExecutivo(mes,cad,resumo,escopoLbl,mLbl,porGrupo) {
  const status=document.getElementById('cf-status');
  if(status) status.innerHTML=`<div class="cf-status"><div class="d-flex justify-content-between gap-2 flex-wrap"><div><div class="fw-bold" style="color:var(--forno)"><i class="fas ${resumo.pct===100?'fa-circle-check text-success':'fa-clock text-warning'} me-1"></i>Fechamento ${resumo.pct===100?'completo':'em andamento'} · ${mLbl}</div><div class="small text-muted">${resumo.preenchidos} de ${resumo.esperados} gastos preenchidos para ${esc(escopoLbl)}.</div></div><button class="btn btn-sm btn-outline-primary" onclick="cfSetView('lancamentos')">${resumo.esperados-resumo.preenchidos>0?`Revisar ${resumo.esperados-resumo.preenchidos} pendência(s)`:'Conferir lançamentos'}</button></div><div class="cf-status-track"><span style="width:${resumo.pct}%"></span></div></div>`;
  const meses=Array.from({length:6},(_,i)=>cfMesDeslocado(mes,i-5));
  const hist=meses.map(m=>({mes:m,...cfResumoEscopo(m,cad)})), max=Math.max(...hist.map(x=>x.total),1);
  const evol=document.getElementById('cf-evolucao');
  if(evol)evol.innerHTML=`<div class="cf-evolution">${hist.map(x=>{const lbl=MES_ABREV[parseInt(x.mes.slice(5,7),10)-1];const h=Math.max(Math.round(x.total/max*135),3);return `<div class="cf-evolution-col"><div class="cf-evolution-value">${x.total?fmtBRL(x.total).replace('R$ ','R$'): '—'}</div><div class="cf-evolution-bar ${x.pct<100?'incompleto':''}" style="height:${h}px" title="${lbl}: ${fmtBRL(x.total)} · ${x.preenchidos}/${x.esperados} preenchidos"></div><div class="cf-evolution-label">${lbl}${x.mes===mes?'*':''}</div></div>`;}).join('')}</div><div class="small text-muted mt-2"><span style="display:inline-block;width:12px;height:8px;background:#26334D" class="me-1"></span>comparável <span style="display:inline-block;width:12px;height:8px;background:#AAB1BE" class="ms-2 me-1"></span>incompleto · * mês selecionado</div>`;
  const {abertos,porLoja}=emprestimosAberto(), saldoAberto=abertos.reduce((s,e)=>s+(e.valor||0),0);
  const conex=document.getElementById('cf-conexoes');
  if(conex)conex.innerHTML=`<div class="mb-3"><div class="small text-muted">Despesa operacional → reduz o EBITDA</div><div class="fs-4 fw-bold" style="font-family:Fraunces;color:var(--forno)">${fmtBRL(resumo.operacional)}</div></div><div class="border-top pt-2 mb-2"><div class="small text-muted">Empréstimos entre lojas → movem caixa, não viram despesa</div><div class="fw-bold">${fmtBRL(saldoAberto)} <span class="small text-muted fw-normal">em ${abertos.length} aberto(s)</span></div></div><div class="border-top pt-2"><div class="small text-muted">Retiradas / itens abaixo da linha</div><div class="fw-bold">${fmtBRL(resumo.abaixo)}</div></div><button class="btn btn-sm btn-outline-secondary mt-3" onclick="cfSetView('emprestimos')">Ver saldos entre lojas</button>`;
  const pend=resumo.esperados-resumo.preenchidos, comparavel=resumo.pct===100;
  const decisoes=document.getElementById('cf-decisoes');
  if(decisoes)decisoes.innerHTML=`<div class="cf-decision-grid"><div class="cf-decision-card"><div class="eyebrow">Qualidade do fechamento</div><div class="value">${pend?pend+' pendência(s)':'Mês conferido'}</div><div class="copy">${pend?'Complete antes de usar o resultado como definitivo.':'Os gastos cadastrados têm valor para o mês.'}</div></div><div class="cf-decision-card"><div class="eyebrow">Comparação mensal</div><div class="value">${comparavel?'Liberada':'Protegida'}</div><div class="copy">${comparavel?'O mês pode ser comparado com períodos igualmente completos.':'O app não chama ausência de lançamento de economia.'}</div></div><div class="cf-decision-card"><div class="eyebrow">Caixa entre lojas</div><div class="value">${abertos.length?abertos.length+' em aberto':'Sem pendência'}</div><div class="copy">${abertos.length?Object.entries(porLoja).filter(([,v])=>Math.abs(v)>.005).map(([l,v])=>`${LOJA_LABEL[l]||l} ${v>0?'recebe':'paga'} ${fmtBRL(Math.abs(v))}`).join(' · '):'Nenhuma loja deve ou tem a receber.'}</div></div></div>`;
}
function renderCFHistorico(mes,cad,gruposComItem,porGrupo) {
  const host=document.getElementById('cf-historico');if(!host)return;
  const meses=Array.from({length:6},(_,i)=>cfMesDeslocado(mes,i-5));
  const head=meses.map(m=>`<th class="text-end">${MES_ABREV[parseInt(m.slice(5,7),10)-1]}/${m.slice(2,4)}</th>`).join('');
  const rows=gruposComItem.map(g=>`<tr><td class="fw-semibold">${esc(g)}</td>${meses.map(m=>{const vals=getDRECustos(m),its=porGrupo[g]||[],v=its.reduce((s,it)=>s+cfValorEfetivo(it,vals),0),n=its.filter(it=>cfValorEfetivo(it,vals)>0).length;return `<td class="text-end">${v?fmtBRL(v):'—'}<small>${n}/${its.length} preenchidos</small></td>`;}).join('')}</tr>`).join('');
  const totals=meses.map(m=>cfResumoEscopo(m,cad));
  host.innerHTML=`<div class="card"><div class="card-header"><i class="fas fa-chart-column me-1"></i>Histórico real por grupo <span class="small text-muted fw-normal">— valores e completude lado a lado</span></div><div class="card-body p-0"><div class="table-responsive"><table class="table table-sm mb-0 align-middle cf-history-table"><thead class="table-light"><tr><th>Grupo</th>${head}</tr></thead><tbody>${rows}<tr class="fw-bold table-light"><td>Total</td>${totals.map(x=>`<td class="text-end">${fmtBRL(x.total)}<small>${x.preenchidos}/${x.esperados} preenchidos</small></td>`).join('')}</tr></tbody></table></div></div><div class="card-footer small text-muted"><i class="fas fa-shield-halved me-1"></i>Uma variação só deve ser tratada como economia ou estouro quando os dois meses estiverem igualmente fechados.</div></div>`;
}
function renderCustosFixos() {
  popularSelMeses('cf-mes');
  const mes = cfMes();
  const vals = getDRECustos(mes);
  const filtro = document.getElementById('cf-loja').value;   // filtro de EXIBIÇÃO ('*'=todos)
  const cad = getCFCad().filter(it => filtro==='*' || (it.loja||'') === (filtro==='' ? '' : filtro));
  const mLbl = `${MES_ABREV[parseInt(mes.slice(5,7),10)-1]}/${mes.slice(2,4)}`;
  document.getElementById('cf-titulo').textContent = `— ${mLbl}`;
  popularGrupoSelect(document.getElementById('cf-novo-grupo'));
  const bm = document.getElementById('cf-batch-mes'); if (bm) bm.textContent = mLbl;
  const badgeLoja = it => (it.loja ? `<span class="badge ${LOJA_BADGE[it.loja]||'bg-dark'}">${LOJA_LABEL[it.loja]||it.loja}</span>` : '<span class="badge bg-secondary">Rede/geral</span>');
  const natBadge = it => { const nv=(it.natureza||naturezaPadrao(it.nome,it.grupo)); return `<span class="badge ${nv==='variavel'?'bg-secondary':'bg-success'}" role="button" onclick="cfNaturezaToggle('${esc(it.id)}')" title="Custo ${nv==='variavel'?'VARIÁVEL (acompanha o movimento)':'FIXO (repete todo mês)'} — clique p/ alternar. Afeta o Ponto de Equilíbrio.">${nv==='variavel'?'Variável':'Fixo'}</span>`; };
  const valEfetivo = it => cfValorEfetivo(it,vals);
  const grpOpts = sel => getDREGrupos().map(g=>`<option${g===sel?' selected':''}>${esc(g)}</option>`).join('');
  const linha = it => {
    const vMes = vals[it.id];
    return `<tr>
      <td class="fw-semibold">${esc(it.nome)}<div class="mt-1 d-flex gap-1 flex-wrap">${badgeLoja(it)} ${natBadge(it)}</div></td>
      <td><select class="form-select form-select-sm cf-sel-ghost" title="Categoria do DRE — mude aqui se o gasto caiu no lugar errado" onchange="cfGrupoInput('${esc(it.id)}',this.value)">${grpOpts(it.grupo||'Outros')}</select></td>
      <td class="text-end">
        <input type="text" inputmode="decimal" class="form-control form-control-sm text-end d-inline-block ${vMes==null&&it.tipo==='exato'?'text-muted':''}" style="width:120px"
          value="${vMes!=null?fmtNum(vMes,2):(it.tipo==='exato'&&it.padrao?fmtNum(it.padrao,2):'')}" placeholder="0,00" data-cf-valor="${it.id}" onchange="cfValorInput(this)"
          title="${it.tipo==='exato'?'Pré-preenchido com o valor automático; edite se este mês foi diferente.':'Valor deste mês.'}">
        ${it.tipo==='exato'?`<div class="mt-1 text-end"><span class="cf-auto-chip" onclick="cfEditarPadrao('${esc(it.id)}')" title="Este gasto se preenche sozinho todo mês. Clique para mudar o valor automático."><i class="fas fa-rotate me-1"></i>auto: ${it.padrao?fmtBRL(it.padrao):'definir'}</span></div>`:''}
      </td>
      <td class="text-center"><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removerCustoFixo('${esc(it.id)}')" title="Remover do cadastro"><i class="fas fa-trash"></i></button></td>
    </tr>`;
  };
  // agrupa por grande grupo, na ordem cadastrada (grupos sem item não aparecem)
  const ordem = getDREGrupos();
  const porGrupo = {}; for (const it of cad) (porGrupo[it.grupo||'Outros']=porGrupo[it.grupo||'Outros']||[]).push(it);
  const gruposComItem = [...ordem.filter(g=>porGrupo[g]), ...Object.keys(porGrupo).filter(g=>!ordem.includes(g))];
  let html = '';
  if (!cad.length) html = '<tr><td colspan="4" class="text-center text-muted py-4">Nenhum gasto neste filtro. Cole os gastos do fechamento em <strong>Colar em lote</strong> (botão acima) ou cadastre um a um ao lado.</td></tr>';
  else for (const g of gruposComItem) {
    const its = porGrupo[g]; const sub = its.reduce((s,it)=>s+valEfetivo(it),0);
    const abaixo = DRE_GRUPOS_ABAIXO.includes(g) ? ' <span class="fw-normal text-muted small">· abaixo do EBITDA</span>' : '';
    html += `<tr class="cf-grp-head"><td colspan="2"><span class="cf-dot" style="background:${Object.hasOwn(GRUPO_COR,g)?GRUPO_COR[g]:'#8a90a0'}"></span>${esc(g)} <span class="fw-normal text-muted small">(${its.length})</span>${abaixo}</td><td class="text-end">${fmtBRL(sub)}</td><td></td></tr>`;
    html += its.map(linha).join('');
  }
  document.getElementById('cf-tbody').innerHTML = html;
  const totFiltro = cfResumoEscopo(mes, cad);
  document.getElementById('cf-tfoot').innerHTML = `
    <tr class="fw-bold"><td colspan="2">Total ${filtro==='*'?'da rede':(filtro===''?'Rede/geral':LOJA_LABEL[filtro]||filtro)} no mês</td>
      <td class="text-end">${fmtBRL(totFiltro.total)}</td><td></td></tr>`;
  // Placar do mês (segue o filtro de exibição)
  const escopoLbl = filtro==='*'?'rede inteira':(filtro===''?'Rede/geral':LOJA_LABEL[filtro]||filtro);
  const hero = document.getElementById('cf-hero');
  if (hero) hero.innerHTML = `
    <div class="col-12 col-md-4"><div class="cf-tile t-total"><div class="t-lbl">Total do mês · ${esc(escopoLbl)}</div>
      <div class="t-val">${fmtBRL(totFiltro.total)}</div><div class="small text-muted">${totFiltro.preenchidos} gasto(s) em ${mLbl}</div></div></div>
    <div class="col-6 col-md-4"><div class="cf-tile t-fixo"><div class="t-lbl">Custos fixos</div>
      <div class="t-val">${fmtBRL(totFiltro.natFixo)}</div><div class="small text-muted">repetem todo mês — definem o ponto de equilíbrio</div></div></div>
    <div class="col-6 col-md-4"><div class="cf-tile t-var"><div class="t-lbl">Custos variáveis</div>
      <div class="t-val">${fmtBRL(totFiltro.natVar)}</div><div class="small text-muted">acompanham o movimento do mês</div></div></div>`;
  renderCFRevisao(mes,cad,porGrupo,gruposComItem,badgeLoja);
  renderCFExecutivo(mes,cad,totFiltro,escopoLbl,mLbl,porGrupo);
  renderCFHistorico(mes,cad,gruposComItem,porGrupo);
  renderEmprestimosCF();
  renderCFAuto(mes, filtro);   // bloco "o app lança sozinho" (async, com cache — não trava a digitação)
  cfSetView(_cfViewAtiva);
}

// ---- "O app lança sozinho no DRE": CMV, Bebidas e Freela/Motoboy do caixa — SÓ LEITURA. Existe para
// ninguém digitar esses gastos de novo na aba (entrariam em DOBRO no DRE — já aconteceu com BEBIDA).
// Cache em memória por mês|filtro: recalcular inventário a cada tecla travaria a tabela.
let _cfAutoCache = {};
async function renderCFAuto(mes, filtro) {
  const host = document.getElementById('cf-auto'); if (!host) return;
  const key = mes + '|' + filtro;
  if (_cfAutoCache[key]) { host.innerHTML = _cfAutoCache[key]; return; }
  host.innerHTML = '<div class="small text-muted"><i class="fas fa-circle-notch fa-spin me-1"></i>calculando o que o app lança sozinho…</div>';
  try {
    const {ini, fim} = limitesDoMes(mes);
    const lojaSel = (filtro==='*' || filtro==='') ? '' : filtro;
    const lojas = lojaSel ? [lojaSel] : LOJAS_ATIVAS();
    const inv = await cmvCeoInventario(lojas, ini, fim);
    const cmvT = inv.ok ? inv.real + inv.estimadoFora : await cmvPeriodoCEO(lojaSel, ini, fim);
    const bebT = inv.ok ? inv.bebReal : 0;
    const pag = await carregarPagamentos().catch(()=>null);
    const sang = pag ? sangriasDRE(pag, lojaSel, ini, fim) : {porCat:{}, total:0};
    const pesT = (sang.porCat['Motoboy']||0) + (sang.porCat['Freelancer Cozinha']||0) + (sang.porCat['Freelancer Atendimento']||0);
    const bloco = (lbl, v, tip) => `<div class="cf-auto-bloco" title="${esc(tip)}"><div class="ab-lbl">${lbl}</div><div class="ab-val">${fmtBRL(v)}</div></div>`;
    const html = `<div class="cf-auto-card">
      <div class="ab-head"><i class="fas fa-wand-magic-sparkles me-1"></i><strong>O app lança sozinho no DRE</strong> — não cadastre estes gastos aqui (entrariam em dobro):</div>
      <div class="d-flex flex-wrap gap-2 align-items-stretch">
        ${bloco('CMV — insumos (consumo)', cmvT, inv.ok ? 'Inventário entre contagens + estimativa por ficha nos dias sem cobertura' : 'Estimado por ficha (sem 2 contagens no mês)')}
        ${bloco('Bebidas (consumo)', bebT, 'Consumo de bebidas medido pelas contagens')}
        ${bloco('Freela + Motoboy (caixa)', pesT, 'Sangrias do caixa TOTEM categorizadas — entram em Pessoal no DRE')}
        <button class="btn btn-sm btn-outline-secondary align-self-center" onclick="showPage('ceo')"><i class="fas fa-file-invoice-dollar me-1"></i>ver no DRE</button>
      </div></div>`;
    _cfAutoCache[key] = html; host.innerHTML = html;
  } catch(e) { host.innerHTML = ''; }
}
// Edita o valor automático (padrão mensal) de um gasto "exato" — chip "auto" na tabela
function cfEditarPadrao(id){
  const it = getCFCad().find(x=>x.id===id); if(!it) return;
  const resp = prompt(`Valor automático mensal de "${it.nome}" (preenche sozinho todo mês):`, it.padrao?fmtNum(it.padrao,2):'');
  if (resp===null) return;
  const v = parseValorBR(resp);
  setCFCad(getCFCad().map(x=>x.id===id?{...x, padrao:(isNaN(v)||v<=0)?0:+v.toFixed(2)}:x));
  renderCustosFixos();
}
function cfGrupoInput(id, grupo){ setCFCad(getCFCad().map(it=>it.id===id?{...it,grupo}:it)); renderCustosFixos(); }
function cfNaturezaToggle(id){ setCFCad(getCFCad().map(it=>it.id===id?{...it,natureza:(it.natureza==='variavel'?'fixo':'variavel')}:it)); renderCustosFixos(); }

// ---- SIMULAÇÃO DE CMV (pedido do Gabriel 07/07): mexer no % de CMV e ver o resultado/equilíbrio que o mês teria dado ----
let _simBase=null, _simPct=null;
function simSetPct(p){ p=parseFloat(p); _simPct=(isFinite(p)&&p>=0)?p:null; renderSimCMV(); }
function simFromInput(){ const el=document.getElementById('sim-cmv'); const v=parseFloat(String(el&&el.value||'').replace(',','.')); _simPct=isFinite(v)&&v>=0?v:null; renderSimCMV(); }
function renderSimCMV(){
  const host=document.getElementById('ceo-sim'); if(!host) return;
  const b=_simBase; if(!b||!(b.fat>0)){ host.innerHTML=''; return; }
  const cmvReal=b.cmvReal, pctReal=cmvReal/b.fat*100;
  let pct=(_simPct!=null)?_simPct:pctReal; if(pct>95)pct=95; if(pct<0)pct=0;
  const cmvSim=pct/100*b.fat;
  const ebitdaSim=b.fat - cmvSim - b.custoNaoCmv;     // = receita − CMV − demais operacionais
  const resSim=ebitdaSim - b.belowLine;               // lucro (após empréstimo/retirada)
  const resReal=(b.fat - cmvReal - b.custoNaoCmv) - b.belowLine;
  const delta=resSim-resReal;
  const mcAbs=ebitdaSim + b.cfFixo, mcFrac=b.fat>0?mcAbs/b.fat:0;
  const beSim= mcFrac>0.01 ? b.cfFixo/mcFrac : null;
  const economia=(pctReal-pct)/100*b.fat;   // CMV a menos vs real (positivo = economizou)
  host.innerHTML=`
    <div class="card" style="border-color:var(--queijo)">
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap" style="background:rgba(231,165,43,.10)">
        <span><i class="fas fa-flask me-1 text-primary"></i><strong>Simulação — e se o CMV fosse outro?</strong>
          <span class="text-muted small">mexa no % e veja o resultado e o equilíbrio que o mês teria dado</span></span>
      </div>
      <div class="card-body">
        <div class="d-flex align-items-center gap-2 flex-wrap mb-3">
          <label class="small text-muted mb-0">CMV simulado:</label>
          <div class="input-group input-group-sm" style="width:118px">
            <input type="number" step="0.5" min="0" max="95" id="sim-cmv" class="form-control text-end" value="${fmtNum(pct,1)}" onchange="simFromInput()">
            <span class="input-group-text">%</span>
          </div>
          <button class="btn btn-sm btn-outline-secondary" onclick="simSetPct(${pctReal.toFixed(1)})">Real (${fmtNum(pctReal,1)}%)</button>
          ${b.espPct!=null?`<button class="btn btn-sm btn-outline-secondary" onclick="simSetPct(${b.espPct.toFixed(1)})">Ficha (${fmtNum(b.espPct,1)}%)</button>`:''}
          <button class="btn btn-sm btn-outline-secondary" onclick="simSetPct(30)">Saudável (30%)</button>
        </div>
        <div class="row g-3 text-center">
          <div class="col-6 col-md-3"><div class="small text-muted">CMV simulado</div>
            <div class="fw-bold fs-5" style="font-family:'Fraunces',serif">${fmtBRL(cmvSim)}</div>
            <div class="small text-muted">${fmtNum(pct,1)}% da receita</div></div>
          <div class="col-6 col-md-3"><div class="small text-muted">Resultado do mês</div>
            <div class="fw-bold fs-5 ${resSim>=0?'text-success':'text-danger'}" style="font-family:'Fraunces',serif">${fmtBRL(resSim)}</div>
            <div class="small ${delta>=0?'text-success':'text-danger'}">${delta>=0?'▲ +':'▼ −'}${fmtBRL(Math.abs(delta))} vs real</div></div>
          <div class="col-6 col-md-3"><div class="small text-muted">Ponto de equilíbrio</div>
            <div class="fw-bold fs-5" style="font-family:'Fraunces',serif">${beSim?fmtBRL(beSim):'—'}</div>
            <div class="small ${beSim&&b.fat>=beSim?'text-success':'text-danger'}">${beSim?(b.fat>=beSim?'faturamento cobre':'faltariam '+fmtBRL(beSim-b.fat)):'margem negativa'}</div></div>
          <div class="col-6 col-md-3"><div class="small text-muted">CMV economizado</div>
            <div class="fw-bold fs-5 ${economia>=0?'text-success':'text-danger'}" style="font-family:'Fraunces',serif">${economia>=0?'':'−'}${fmtBRL(Math.abs(economia))}</div>
            <div class="small text-muted">vs CMV real (${fmtNum(pctReal,1)}%)</div></div>
        </div>
        <div class="small text-muted mt-2"><i class="fas fa-circle-info me-1"></i>Mantém tudo do mês igual (faturamento, custos fixos, variáveis e sangrias) e só troca o CMV — pra ver o quanto o CMV sozinho decide o resultado. Não altera seus dados.</div>
      </div>
    </div>`;
}

// ---- PONTO DE EQUILÍBRIO onde o GABRIEL escolhe o que "cresce com a venda" (08/07) ----
// A conta é a padrão de CVP: equilíbrio = custos FIXOS ÷ margem de contribuição %, onde a margem
// desconta SÓ os custos que ele marcou como variáveis. Sem eu deduzir a classificação.
const BE_VAR_DEFAULT = ['CMV','Bebidas','Freela','Motoboy','Imposto','Royalties','SangOutros'];
let _beCtx=null, _beChart=null;
function getBEVar(){ try{ const s=JSON.parse(localStorage.getItem('be_variaveis_v1')); if(Array.isArray(s)) return new Set(s); }catch(e){} return new Set(BE_VAR_DEFAULT); }
function setBEVar(s){ localStorage.setItem('be_variaveis_v1', JSON.stringify([...s])); }
function beToggle(k){ const s=getBEVar(); if(s.has(k)) s.delete(k); else s.add(k); setBEVar(s); renderBE(); if(_simBase){ _simBase.cfFixo=_beCtx.buckets.filter(b=>!getBEVar().has(b.k)).reduce((t,b)=>t+b.val,0); renderSimCMV(); } }
function renderBE(){
  const host=document.getElementById('ceo-be'); if(!host||!_beCtx) return;
  const {fat,buckets,ini,fim}=_beCtx; if(!(fat>0)||!buckets.length){ host.innerHTML=''; return; }
  const varSet=getBEVar();
  let variavel=0, fixo=0;
  for(const b of buckets){ if(varSet.has(b.k)) variavel+=b.val; else fixo+=b.val; }
  const margemFrac = fat>0 ? (fat-variavel)/fat : 0;
  const be = (fixo>0 && margemFrac>0.01) ? fixo/margemFrac : null;
  const cobriu = be? fat/be*100 : 0, acima = be? fat-be : 0;
  const chips = buckets.map(b=>{ const on=varSet.has(b.k);
    return `<button type="button" class="be-chip ${on?'on':''}" onclick="beToggle('${b.k}')" title="${on?'cresce com a venda (variável) — clique p/ marcar como fixo':'fixo — clique p/ marcar que cresce com a venda'}"><i class="fas ${on?'fa-arrow-trend-up':'fa-lock'} me-1"></i>${esc(b.lbl)} <span class="be-chip-v">${fmtBRL(b.val)}</span></button>`;
  }).join('');
  if(_beChart){ try{_beChart.destroy();}catch(e){} _beChart=null; }
  host.innerHTML = `<div class="card">
    <div class="card-header d-flex justify-content-between align-items-center flex-wrap">
      <span><i class="fas fa-scale-unbalanced-flip me-1 text-primary"></i><strong>Ponto de equilíbrio</strong> <span class="text-muted small">— a partir de quanto o mês se paga</span></span>
      ${be!=null?`<span class="${acima>=0?'text-success':'text-danger'} fw-bold">${acima>=0?'ACIMA em '+fmtBRL(acima):'faltam '+fmtBRL(-acima)}</span>`:''}
    </div>
    <div class="card-body">
      <div class="mb-3"><div class="small text-muted mb-1">Marque o que <strong>cresce com a venda</strong> — <span style="color:#145a32">verde = variável</span>, <span class="text-muted">cinza = fixo</span>:</div>
        <div class="d-flex flex-wrap gap-1">${chips}</div></div>
      ${be!=null? `
      <div class="row g-3 my-1 text-center">
        <div class="col-4"><div class="small text-muted">Equilíbrio (receita mínima)</div><div class="fw-bold fs-5" style="font-family:'Fraunces',serif">${fmtBRL(be)}</div></div>
        <div class="col-4"><div class="small text-muted">Você já faturou</div><div class="fw-bold fs-5 ${cobriu>=100?'text-success':''}" style="font-family:'Fraunces',serif">${fmtNum(cobriu,0)}%</div></div>
        <div class="col-4"><div class="small text-muted">Margem de contribuição</div><div class="fw-bold fs-5" style="font-family:'Fraunces',serif">${fmtNum(margemFrac*100,1)}%</div></div>
      </div>
      <div style="height:220px"><canvas id="ceo-be-chart"></canvas></div>
      <div class="small text-muted mt-1"><i class="fas fa-circle-info me-1"></i>Custos fixos <strong>${fmtBRL(fixo)}</strong> ÷ margem de contribuição <strong>${fmtNum(margemFrac*100,1)}%</strong> = equilíbrio <strong>${fmtBRL(be)}</strong>. Cada R$1 vendido, depois dos variáveis, deixa ${fmtBRL(margemFrac)}.</div>`
      : `<div class="alert alert-warning py-2 small mb-0"><i class="fas fa-triangle-exclamation me-1"></i>Para calcular o equilíbrio, deixe pelo menos um custo como <strong>fixo</strong> e nem tudo como variável (senão não há margem).</div>`}
    </div></div>`;
  if(be!=null){
    const maxX=Math.max(fat,be)*1.15, N=24, xs=Array.from({length:N+1},(_,i)=>maxX*i/N);
    const iBE=Math.round(be/maxX*N), iVoce=Math.round(fat/maxX*N);
    _beChart=new Chart(document.getElementById('ceo-be-chart'), {
      type:'line',
      data:{ labels: xs.map(x=>'R$'+Math.round(x/1000)+'k'),
        datasets:[
          {label:'Custos fixos', data: xs.map(()=>Math.round(fixo)), borderColor:'#E7A52B', borderDash:[6,4], borderWidth:2, backgroundColor:'rgba(231,165,43,.10)', fill:'origin', pointRadius:0, tension:0, order:3},
          {label:'+ Variáveis (= custo total)', data: xs.map(x=>Math.round(fixo + (1-margemFrac)*x)), borderColor:'#922b21', borderWidth:2, backgroundColor:'rgba(146,43,33,.08)', fill:'-1', pointRadius:0, tension:0, order:2},
          {label:'Receita', data: xs.map(x=>Math.round(x)), borderColor:'#145a32', borderWidth:2.5, fill:false, pointRadius:0, tension:0, order:1},
          {label:'Equilíbrio', data: xs.map((x,i)=> i===iBE ? Math.round(be) : null), pointRadius:6, pointStyle:'rectRot', pointBackgroundColor:'#26334D', borderColor:'#26334D', showLine:false, order:0},
          {label:'Você está aqui', data: xs.map((x,i)=> i===iVoce ? Math.round(fat) : null), pointRadius:7, pointBackgroundColor:'#E7A52B', borderColor:'#26334D', pointBorderWidth:2, showLine:false, order:0},
        ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{position:'bottom', labels:{boxWidth:12, font:{size:11}}}, tooltip:{callbacks:{label:ctx=>` ${ctx.dataset.label}: ${fmtBRL(ctx.parsed.y)}`}} },
        scales:{ x:{title:{display:true,text:'Receita do mês',font:{size:10}}, ticks:{maxRotation:0, autoSkip:true, maxTicksLimit:8}}, y:{beginAtZero:true, ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}} } }
    });
    _ceoCharts.push(_beChart);
  }
}

// ---- DRILL-DOWN DOS KPIs DO CEO (pedido do Gabriel 07/07): clicar no card abre o detalhe do número ----
let _kpiCtx = null;
// Junta o detalhe por insumo de todas as lojas da janela (cmvCeoInventario guarda em porLoja[l].itens)
function kpiAgregaItens(inv){
  const map={};
  for (const l of inv.lojasOk) for (const it of (inv.porLoja[l].itens||[])) {
    const m = map[it.ing] = map[it.ing] || {ing:it.ing, unidade:it.unidade, qReal:0, qEsp:0, real:0, esp:0, furo:false, suspeito:false};
    m.qReal+=it.qReal; m.qEsp+=it.qEsp; m.real+=it.real; m.esp+=it.esp;
    m.furo=m.furo||it.furo; m.suspeito=m.suspeito||it.suspeito;
  }
  return Object.values(map);
}
function kpiJanelasTxt(inv){
  return inv.lojasOk.map(l=>{ const p=inv.porLoja[l];
    return `${LOJA_LABEL[l]||l}: contagens ${fmtDate(p.de)} → ${fmtDate(p.ate)}`; }).join(' · ');
}
// ===== DRILL-DOWN: clicar num bloco e ver o que tem dentro (06/08/2026) ====================
// Uma janela só (#kpiModal, a mesma do CEO) + um REGISTRO de detalhamentos.
//
// REGRA DE OURO: um detalhamento NÃO CALCULA NADA NOVO. Ele só re-agrupa os MESMOS arrays que a
// tela já usou, guardados em `_detCtx` no momento do render. Se um detalhe precisar de um recorte
// que a tela não fez (faturamento por loja, por exemplo), ele chama a MESMA fonte única
// (faturamentoFormas / descontosPeriodo / calcDivergencias) com outro argumento — nunca reimplementa
// a conta. É isto que garante que abrir o detalhe jamais mostre um número diferente do bloco.
let _detCtx = {};
const DETALHES = {};                       // chave -> () => ({titulo, corpo})  (pode ser async)

// Atributos que tornam um bloco clicável e navegável pelo teclado.
function detAttr(chave, dica) {
  const k = argJS(chave);
  return `class="det-card" role="button" tabindex="0"${dica?` title="${esc(dica)}"`:''}`
       + ` onclick="abrirDetalhe('${k}')"`
       + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirDetalhe('${k}');}"`;
}
// ⚠️ SEMPRE `bootstrap.Modal.getOrCreateInstance(el)`, NUNCA `new bootstrap.Modal(el)`.
// MEDIDO em 06/08/2026: com `new`, cada abertura da MESMA janela cria outra instância, e a
// instância antiga deixa o véu (`.modal-backdrop show`, opacidade 0,5 e pointer-events:auto)
// preso na tela ao fechar. Abrir/fechar 3× = 3 véus empilhados: a tela escurece e para de
// aceitar clique até recarregar. Era assim nas 13 janelas do app, inclusive nos detalhes do
// Painel do CEO, que já existiam.
async function abrirDetalhe(chave) {
  if (typeof bootstrap === 'undefined') { toast('Recarregue a página com internet.','warning'); return; }
  const base = String(chave).split(':')[0];
  const fn = DETALHES[base];
  if (!fn) { toast('Detalhamento não disponível para este bloco.','warning'); return; }
  let r;
  try { r = await fn(String(chave).slice(base.length + 1)); }
  catch (e) { console.error('detalhe', chave, e); toast('Não consegui montar o detalhe: '+e.message,'danger'); return; }
  if (!r) return;
  document.getElementById('kpiModalTitle').innerHTML = `<i class="fas fa-magnifying-glass-chart me-2 text-primary"></i>${r.titulo}`;
  document.getElementById('kpiModalBody').innerHTML = r.corpo;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('kpiModal')).show();
}

// --- peças reaproveitadas pelos detalhamentos ---
const detPct = (v, tot) => tot > 0 ? v/tot*100 : 0;
// Tabela com barra de proporção. `linhas` = [{rot, val, sub}], já ordenadas.
// O CORTE (top N) é FEITO AQUI, nunca pelo chamador com .slice(): o rodapé "Total" tem que ser o
// total DE VERDADE. Uma tabela cortada por fora somava só as linhas visíveis e continuava
// escrevendo "Total" — número menor que o do bloco que o usuário acabou de clicar.
function detTabela(cabecalho, linhas, fmt = fmtBRL, rotColuna = 'Valor', limite = 0) {
  if (!linhas.length) return '<div class="text-muted small">Sem dados no período.</div>';
  const tot = linhas.reduce((s,l)=>s+l.val, 0), max = Math.max(...linhas.map(l=>l.val), 0.0001);
  const mostra = limite > 0 ? linhas.slice(0, limite) : linhas;
  const resto = linhas.length - mostra.length;
  const somaResto = tot - mostra.reduce((s,l)=>s+l.val, 0);
  return `<table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
      <th>${esc(cabecalho)}</th><th class="text-end">${esc(rotColuna)}</th><th class="text-end">%</th><th style="width:90px"></th></tr></thead>
    <tbody>${mostra.map(l=>`<tr><td>${l.rot}${l.sub?`<br><span class="text-muted" style="font-size:11px">${l.sub}</span>`:''}</td>
      <td class="text-end">${fmt(l.val)}</td><td class="text-end">${fmtNum(detPct(l.val,tot),1)}%</td>
      <td><div class="det-bar"><span style="width:${Math.max(2,l.val/max*100)}%"></span></div></td></tr>`).join('')}
      ${resto>0?`<tr class="text-muted"><td>+ ${fmtNum(resto,0)} menores</td><td class="text-end">${fmt(somaResto)}</td>
        <td class="text-end">${fmtNum(detPct(somaResto,tot),1)}%</td><td></td></tr>`:''}</tbody>
    <tfoot><tr class="fw-bold"><td>Total</td><td class="text-end">${fmt(tot)}</td><td class="text-end">100%</td><td></td></tr></tfoot></table>`;
}
// Média por DIA DA SEMANA a partir de um mapa {data: valor} — o Gabriel pediu isto no faturamento.
function detPorDiaSemana(porDia, fmt = fmtBRL) {
  const soma = [0,0,0,0,0,0,0], dias = [0,0,0,0,0,0,0];
  for (const dt in porDia) { const w = new Date(dt+'T00:00:00').getDay(); soma[w] += porDia[dt]; dias[w]++; }
  const med = soma.map((s,w)=> dias[w] ? s/dias[w] : 0);
  const max = Math.max(...med, 0.0001);
  const melhor = med.indexOf(Math.max(...med)), pior = med.map((v,i)=>dias[i]?v:Infinity).indexOf(Math.min(...med.map((v,i)=>dias[i]?v:Infinity)));
  return `<table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
      <th>Dia da semana</th><th class="text-end">Média por dia</th><th class="text-end">Dias</th><th style="width:110px"></th></tr></thead>
    <tbody>${[1,2,3,4,5,6,0].map(w=>`<tr${w===melhor?' class="fw-semibold"':''}>
      <td>${DIAS_SEM_LONGO[w]}${w===melhor?' <span class="badge bg-success">melhor</span>':''}${w===pior&&dias[w]?' <span class="badge bg-secondary">mais fraco</span>':''}</td>
      <td class="text-end">${dias[w]?fmt(med[w]):'—'}</td><td class="text-end text-muted">${dias[w]}</td>
      <td><div class="det-bar"><span style="width:${Math.max(2,med[w]/max*100)}%"></span></div></td></tr>`).join('')}</tbody></table>`;
}
// Série diária compacta (últimos N dias do recorte), para ver o formato do período.
function detSerieDias(porDia, n = 14, fmt = fmtBRL) {
  const dts = Object.keys(porDia).sort().slice(-n);
  if (!dts.length) return '';
  const max = Math.max(...dts.map(d=>porDia[d]), 0.0001);
  return `<table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
      <th>Dia</th><th class="text-end">Valor</th><th style="width:130px"></th></tr></thead>
    <tbody>${dts.reverse().map(d=>`<tr><td class="text-nowrap">${fmtDate(d)} <span class="text-muted" style="font-size:11px">${DIAS_SEM_LONGO[new Date(d+'T00:00:00').getDay()].slice(0,3)}</span></td>
      <td class="text-end">${fmt(porDia[d])}</td><td><div class="det-bar"><span style="width:${Math.max(2,porDia[d]/max*100)}%"></span></div></td></tr>`).join('')}</tbody></table>`;
}
const detPeriodo = c => `${c.ini && c.ini!=='0000-00-00' ? fmtDate(c.ini) : 'início'} a ${c.fim && c.fim!=='9999-99-99' ? fmtDate(c.fim) : 'hoje'} · ${c.loja ? (LOJA_LABEL[c.loja]||c.loja) : 'todas as lojas'}`;

// ---------- PAGAMENTOS ----------
DETALHES['pag-entrou'] = () => { const c = _detCtx.pag; if (!c) return null;
  const formas = Object.entries(c.ff.porForma).filter(([,v])=>v>0.005).sort((a,b)=>b[1]-a[1]);
  const lojas = (c.loja ? [c.loja] : LOJAS_ATIVAS())
    .map(l => ({rot:`<span class="badge ${LOJA_BADGE[l]||''}">${esc(LOJA_LABEL[l]||l)}</span>`,
                val: faturamentoFormas(c.data, l, c.ini, c.fim).total})).filter(x=>x.val>0.005).sort((a,b)=>b.val-a.val);
  return {titulo:'Entrou no caixa — como se divide', corpo:`
    <div class="kpi-total">${fmtBRL(c.ff.total)} <span>${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> soma de tudo que entrou como pagamento de venda, forma a forma — a mesma da tabela ao lado do gráfico.
      <ul class="mb-0 mt-1"><li>Venda cancelada não entra (cancelada não vira pagamento).</li>
      <li>99Food entra pelo valor que a plataforma credita, não pelo preço de cardápio.</li>
      <li>Lançamento avulso (pix na chave, depósito) fica fora — não é venda.</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por forma de pagamento</div>
      ${detTabela('Forma', formas.map(([f,v])=>({rot:esc(PAG_LABEL[f]||f), val:v})), fmtBRL, 'Recebido')}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>${detTabela('Loja', lojas, fmtBRL, 'Recebido')}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Média por dia da semana</div>${detPorDiaSemana(c.ff.porDia)}
    <div class="fw-semibold small mb-1 mt-2">Últimos dias do período</div>${detSerieDias(c.ff.porDia)}`};
};
DETALHES['pag-forma'] = (forma) => { const c = _detCtx.pag; if (!c) return null;
  const linhasLoja = [], porDia = {};
  for (const r of (c.data.por_dia||[])) {
    if (r.forma !== forma) continue;
    if ((c.loja && r.loja !== c.loja) || r.data < c.ini || r.data > c.fim) continue;
    porDia[r.data] = (porDia[r.data]||0) + r.valor;
    const i = linhasLoja.findIndex(x=>x.k===r.loja);
    if (i<0) linhasLoja.push({k:r.loja, rot:`<span class="badge ${LOJA_BADGE[r.loja]||''}">${esc(LOJA_LABEL[r.loja]||r.loja)}</span>`, val:r.valor});
    else linhasLoja[i].val += r.valor;
  }
  const tot = c.ff.porForma[forma] || 0;
  const corrigidos = Object.keys(getPagCorrecao()).filter(k=>{ const p=k.split('|');
    return p[2]===forma && (!c.loja||p[0]===c.loja) && p[1]>=c.ini && p[1]<=c.fim; }).length;
  return {titulo:`${PAG_LABEL[forma]||forma} — quando e onde entrou`, corpo:`
    <div class="kpi-total">${fmtBRL(tot)} <span>${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3">${fmtNum(detPct(tot,c.ff.total),1)}% de tudo que entrou no período.
      ${corrigidos?` <strong>${corrigidos}</strong> valor(es) desta forma foram corrigidos à mão — a tabela abaixo mostra o valor do TOTEM, o total acima já usa a correção.`:''}</div>
    <div class="fw-semibold small mb-1">Por loja</div>${detTabela('Loja', linhasLoja.sort((a,b)=>b.val-a.val), fmtBRL, 'Recebido')}
    <div class="fw-semibold small mb-1 mt-2">Média por dia da semana</div>${detPorDiaSemana(porDia)}
    <div class="fw-semibold small mb-1 mt-2">Últimos dias</div>${detSerieDias(porDia)}`};
};
DETALHES['pag-saiu'] = () => { const c = _detCtx.pag; if (!c) return null;
  const porCat = Object.entries(c.porCat).sort((a,b)=>b[1]-a[1]);
  const porLoja = {}, porDia = {}, porDesc = {};
  for (const s of c.saidas) {
    porLoja[s.loja] = (porLoja[s.loja]||0) + s.valor;
    porDia[s.data]  = (porDia[s.data]||0)  + s.valor;
    const d = (s.descricao||'—').trim().toUpperCase(); porDesc[d] = (porDesc[d]||0) + s.valor;
  }
  const maiores = c.saidas.slice().sort((a,b)=>b.valor-a.valor).slice(0,8);
  return {titulo:'Saiu do caixa — para onde foi', corpo:`
    <div class="kpi-total">${fmtBRL(c.saidaTotal)} <span>${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>O que é:</strong> dinheiro retirado do caixa da loja (sangria) — motoboy, freelancer, fornecedor, ajustes.
      <ul class="mb-0 mt-1"><li>São ${fmtNum(c.saidas.length,0)} lançamento(s) no período.</li>
      <li>O acerto de fechamento (reclassificação entre formas) fica fora — não é gasto.</li>
      <li>Para reclassificar por função (o que vai ao DRE), use <strong>Corrigir categorias das sangrias</strong>.</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por categoria</div>
      ${detTabela('Categoria', porCat.map(([k,v])=>({rot:`<span class="d-inline-block rounded-circle me-1" style="width:9px;height:9px;background:${SAIDA_COR[k]||'#b0875a'}"></span>${esc(k)}`, val:v})))}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>
      ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`<span class="badge ${LOJA_BADGE[k]||''}">${esc(LOJA_LABEL[k]||k)}</span>`, val:v})))}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Quem mais recebeu (pela descrição do lançamento)</div>
    ${detTabela('Descrição', Object.entries(porDesc).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:esc(k), val:v})), fmtBRL, 'Valor', 10)}
    <div class="fw-semibold small mb-1 mt-2">Os 8 maiores lançamentos</div>
    <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Dia</th><th>Loja</th><th>Descrição</th><th class="text-end">Valor</th></tr></thead>
      <tbody>${maiores.map(s=>`<tr><td class="text-nowrap">${fmtDate(s.data)}</td><td><span class="badge ${LOJA_BADGE[s.loja]||''}">${esc(LOJA_LABEL[s.loja]||s.loja)}</span></td><td>${esc(s.descricao||'—')}</td><td class="text-end">${fmtBRL(s.valor)}</td></tr>`).join('')}</tbody></table>
    <div class="fw-semibold small mb-1 mt-2">Últimos dias</div>${detSerieDias(porDia)}`};
};
DETALHES['pag-cat'] = (cat) => { const c = _detCtx.pag; if (!c) return null;
  const doCat = c.saidas.filter(s=>categoriaSangria(s)===cat);
  const tot = doCat.reduce((s,x)=>s+x.valor,0);
  const porLoja = {}, porDesc = {}, porDia = {};
  for (const s of doCat) { porLoja[s.loja]=(porLoja[s.loja]||0)+s.valor; porDia[s.data]=(porDia[s.data]||0)+s.valor;
    const d=(s.descricao||'—').trim().toUpperCase(); porDesc[d]=(porDesc[d]||0)+s.valor; }
  return {titulo:`${cat} — detalhe da saída de caixa`, corpo:`
    <div class="kpi-total">${fmtBRL(tot)} <span>${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3">${fmtNum(detPct(tot,c.saidaTotal),1)}% de tudo que saiu do caixa no período, em ${fmtNum(doCat.length,0)} lançamento(s).</div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>
      ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`<span class="badge ${LOJA_BADGE[k]||''}">${esc(LOJA_LABEL[k]||k)}</span>`, val:v})))}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por descrição</div>
      ${detTabela('Descrição', Object.entries(porDesc).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:esc(k), val:v})), fmtBRL, 'Valor', 12)}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Últimos dias</div>${detSerieDias(porDia)}`};
};
DETALHES['pag-cancel'] = () => { const c = _detCtx.pag; if (!c) return null;
  const porLoja = {}, porDia = {}, nPorLoja = {};
  for (const x of (c.data.cancelamentos||[])) {
    if ((c.loja && x.loja!==c.loja) || x.data<c.ini || x.data>c.fim) continue;
    porLoja[x.loja]=(porLoja[x.loja]||0)+x.valor; nPorLoja[x.loja]=(nPorLoja[x.loja]||0)+x.n; porDia[x.data]=(porDia[x.data]||0)+x.valor;
  }
  return {titulo:'Vendas canceladas — onde acontecem', corpo:`
    <div class="kpi-total">${fmtNum(c.cancN,0)} vendas <span>${fmtBRL(c.cancVal)} · ${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>O que é:</strong> venda lançada no TOTEM e depois cancelada. Não entra no faturamento — a única linha financeira dela é o próprio cancelamento.
      <ul class="mb-0 mt-1"><li>Equivale a ${fmtNum(detPct(c.cancVal, c.ff.total + c.cancVal),1)}% de tudo que foi lançado.</li>
      <li>Muito cancelamento numa loja costuma ser erro de digitação no balcão, não fraude — vale conferir o dia.</li></ul></div>
    <div class="fw-semibold small mb-1">Por loja</div>
    ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`<span class="badge ${LOJA_BADGE[k]||''}">${esc(LOJA_LABEL[k]||k)}</span>`, sub:`${nPorLoja[k]} venda(s)`, val:v})))}
    <div class="fw-semibold small mb-1 mt-2">Dias com mais cancelamento</div>
    ${detTabela('Dia', Object.entries(porDia).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`${fmtDate(k)} <span class="text-muted" style="font-size:11px">${diaDaSemanaLongo(k)}</span>`, val:v})), fmtBRL, 'Valor', 10)}`};
};
DETALHES['pag-corr'] = () => { const c = _detCtx.pag; if (!c) return null;
  const corr = getPagCorrecao(), linhas = [];
  for (const k in corr) { const p = k.split('|');
    if ((c.loja && p[0]!==c.loja) || p[1]<c.ini || p[1]>c.fim) continue;
    linhas.push({loja:p[0], data:p[1], forma:p[2], val:corr[k]}); }
  linhas.sort((a,b)=>b.data.localeCompare(a.data));
  return {titulo:'Valores corrigidos à mão', corpo:`
    <div class="kpi-total">${fmtNum(linhas.length,0)} <span>correção(ões) · ${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3">Quando o TOTEM registra um valor diferente do que o banco mostra, você corrige o dia em <strong>Corrigir valor</strong>. A correção substitui o número do TOTEM em todas as telas (Dashboard, Pagamentos e CEO usam a mesma fonte).</div>
    ${linhas.length ? `<table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Dia</th><th>Loja</th><th>Forma</th><th class="text-end">Valor corrigido</th></tr></thead>
      <tbody>${linhas.map(l=>`<tr><td class="text-nowrap">${fmtDate(l.data)}</td><td><span class="badge ${LOJA_BADGE[l.loja]||''}">${esc(LOJA_LABEL[l.loja]||l.loja)}</span></td><td>${esc(PAG_LABEL[l.forma]||l.forma)}</td><td class="text-end">${fmtBRL(l.val)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="text-success"><i class="fas fa-check-circle me-1"></i>Nenhum valor precisou de correção neste período.</div>'}`};
};
// Descontos: 99Food e loja compartilham o corpo, mudando só o texto honesto de cada um.
function detDescontoCorpo(qual) {
  const c = _detCtx.pag; if (!c) return null;
  const d = descontosPeriodo(c.data, c.loja, c.ini, c.fim);
  if (!d.tem) return null;
  const g = qual==='99' ? d.g99 : d.gLoja;
  const porLoja = Object.entries(d.porLoja).map(([l,p])=>({l, g: qual==='99'?p.g99:p.gLoja}))
    .filter(x=>x.g.bruto>0).sort((a,b)=>b.g.dif-a.g.dif);
  const porDia = {}; for (const dt in d.porDia) { const gg = qual==='99'?d.porDia[dt].g99:d.porDia[dt].gLoja; if (gg.dif>0.005) porDia[dt]=gg.dif; }
  const explica = qual==='99' ? `
      <strong>A conta:</strong> preço de cardápio dos pedidos da 99 (itens + taxa) menos o que a 99 credita no caixa.
      <ul class="mb-0 mt-1">
      <li><strong>São duas coisas somadas:</strong> a promoção que a plataforma aplica e a comissão dela. O TOTEM grava só o valor final creditado, então não dá para separá-las aqui.</li>
      <li>Isso foi <strong>medido</strong>, não suposto: em 90 dias, o que o TOTEM registra como recebido da 99 bate 89% a 101% com o depósito real no banco (planilha CONTROLE CAIXA).</li>
      <li>Chega ao caixa <strong>${fmtNum(100-g.pct,1)}%</strong> do preço de cardápio.</li></ul>`
    : `<strong>A conta:</strong> o que o pedido somava menos o que foi cobrado, nos canais próprios (balcão e entrega própria).
      <ul class="mb-0 mt-1"><li>Valor <strong>exato</strong> — aqui não há comissão nem promoção de plataforma no meio.</li>
      <li>Aconteceu em <strong>${fmtNum(g.comDesc,0)}</strong> de ${fmtNum(g.pedidos,0)} pedidos (${fmtNum(detPct(g.comDesc,g.pedidos),1)}%).</li>
      <li>Desconto alto e repetido no mesmo dia ou na mesma loja é o que vale olhar.</li></ul>`;
  return {titulo: qual==='99' ? '99Food — do cardápio ao caixa' : 'Desconto da loja — quem deu e quando', corpo:`
    <div class="kpi-total">${fmtBRL(g.dif)} <span>${fmtNum(g.pct,1)}% do cardápio · ${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3">${explica}</div>
    <div class="fw-semibold small mb-1">Por loja</div>
    ${detTabela('Loja', porLoja.map(x=>({rot:`<span class="badge ${LOJA_BADGE[x.l]||''}">${esc(LOJA_LABEL[x.l]||x.l)}</span>`,
        sub:`${fmtBRL(x.g.bruto)} em cardápio · ${fmtNum(x.g.pct,1)}% não chegou`, val:x.g.dif})), fmtBRL, 'Diferença')}
    <div class="fw-semibold small mb-1 mt-2">Dias com a maior diferença</div>
    ${detTabela('Dia', Object.entries(porDia).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`${fmtDate(k)} <span class="text-muted" style="font-size:11px">${diaDaSemanaLongo(k)}</span>`, val:v})), fmtBRL, 'Diferença', 10)}`};
}
DETALHES['desc99']   = () => detDescontoCorpo('99');
DETALHES['descloja'] = () => detDescontoCorpo('loja');

// ---------- DASHBOARD ----------
const detBadgeLoja = l => `<span class="badge ${LOJA_BADGE[l]||''}">${esc(LOJA_LABEL[l]||l)}</span>`;
DETALHES['dash-fat'] = () => { const c = _detCtx.dash; if (!c) return null;
  if (!c.ff.temDados) return {titulo:'Faturamento do mês', corpo:`<div class="kpi-explica">As formas de pagamento não carregaram — ${dicaAtualizarTotem()}.</div>`};
  const formas = Object.entries(c.ff.porForma).filter(([,v])=>v>0.005).sort((a,b)=>b[1]-a[1]);
  const porLoja = c.lojas.map(l=>({rot:detBadgeLoja(l), val:faturamentoFormas(c.pag, l, c.ini, c.fim).total}))
    .filter(x=>x.val>0.005).sort((a,b)=>b.val-a.val);
  const cmp = c.varMesPct===null ? '' :
    `<div class="kpi-explica mb-3"><strong>Contra o mês passado:</strong> ${fmtBRL(c.fatMesAnt)} no mesmo recorte (do dia 1 ao dia ${c.diaCorte}) →
      <strong class="${c.varMesPct>=0?'text-success':'text-danger'}">${c.varMesPct>=0?'+':''}${fmtNum(c.varMesPct,1)}%</strong>.
      A comparação usa o MESMO número de dias dos dois meses, senão todo começo de mês pareceria uma queda.</div>`;
  return {titulo:`Faturamento — ${c.labelMes}`, corpo:`
    <div class="kpi-total">${fmtBRL(c.fatMes)} <span>${detPeriodo(c)}</span></div>
    ${cmp}
    <div class="kpi-explica mb-3"><strong>A conta:</strong> soma das formas de pagamento das vendas do mês — a mesma fonte da aba Pagamentos e do Painel do CEO, então os três batem.
      <ul class="mb-0 mt-1"><li>99Food entra pelo que a plataforma credita, não pelo preço de cardápio.</li>
      <li>Cancelada e lançamento avulso ficam fora.</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>${detTabela('Loja', porLoja, fmtBRL, 'Faturou')}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por forma de pagamento</div>
      ${detTabela('Forma', formas.map(([f,v])=>({rot:esc(PAG_LABEL[f]||f), val:v})), fmtBRL, 'Recebido')}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Média por dia da semana</div>${detPorDiaSemana(c.ff.porDia)}
    <div class="fw-semibold small mb-1 mt-2">Dia a dia</div>${detSerieDias(c.ff.porDia, 16)}`};
};
DETALHES['dash-media'] = () => { const c = _detCtx.dash; if (!c) return null;
  if (!c.ff.temDados) return {titulo:'Faturamento médio por dia', corpo:`<div class="kpi-explica">As formas de pagamento não carregaram — ${dicaAtualizarTotem()}.</div>`};
  const dts = Object.keys(c.ff.porDia).sort();
  const melhorDia = dts.slice().sort((a,b)=>c.ff.porDia[b]-c.ff.porDia[a])[0];
  const piorDia   = dts.slice().sort((a,b)=>c.ff.porDia[a]-c.ff.porDia[b])[0];
  return {titulo:`Faturamento médio por dia — ${c.labelMes}`, corpo:`
    <div class="kpi-total">${fmtBRL(c.fatMediaDia)} <span>por dia · ${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> ${fmtBRL(c.fatMes)} ÷ ${c.diasCorridosMes} dias corridos.
      <ul class="mb-0 mt-1"><li>São dias <strong>corridos</strong>, não dias com venda — um dia fechado puxa a média para baixo, de propósito.</li>
      ${melhorDia?`<li>Melhor dia do mês: <strong>${fmtDate(melhorDia)}</strong> (${diaDaSemanaLongo(melhorDia)}) com ${fmtBRL(c.ff.porDia[melhorDia])}.</li>`:''}
      ${piorDia?`<li>Mais fraco: <strong>${fmtDate(piorDia)}</strong> (${diaDaSemanaLongo(piorDia)}) com ${fmtBRL(c.ff.porDia[piorDia])}.</li>`:''}</ul></div>
    <div class="fw-semibold small mb-1">Média por dia da semana</div>${detPorDiaSemana(c.ff.porDia)}
    <div class="fw-semibold small mb-1 mt-2">Dia a dia</div>${detSerieDias(c.ff.porDia, 16)}`};
};
DETALHES['dash-compras'] = () => { const c = _detCtx.dash; if (!c) return null;
  const doMes = c.compras.filter(x=>c.lojas.includes(x.loja) && x.data>=c.ini && x.data<=c.fim);
  const porLoja = {}, porForn = {}, porIng = {}, porDia = {};
  for (const x of doMes) { const v = x.valor_total||0;
    porLoja[x.loja]=(porLoja[x.loja]||0)+v; porDia[x.data]=(porDia[x.data]||0)+v;
    porForn[(x.fornecedor||'—').trim()]=(porForn[(x.fornecedor||'—').trim()]||0)+v;
    porIng[x.ingrediente||'—']=(porIng[x.ingrediente||'—']||0)+v; }
  return {titulo:`Compras — ${c.labelMes}`, corpo:`
    <div class="kpi-total">${fmtBRL(c.compras30)} <span>${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> soma do valor pago nas compras lançadas no mês (nota fiscal importada ou lançamento manual), em ${fmtNum(doMes.length,0)} linha(s).
      <ul class="mb-0 mt-1"><li>É o que ENTROU no estoque no mês — não é o CMV (o que saiu). Para consumo, veja Estoque &amp; CMV.</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>
      ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:detBadgeLoja(k), val:v})), fmtBRL, 'Comprou')}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por fornecedor</div>
      ${detTabela('Fornecedor', Object.entries(porForn).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:esc(k), val:v})), fmtBRL, 'Valor', 10)}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Ingredientes que mais pesaram</div>
    ${detTabela('Ingrediente', Object.entries(porIng).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:esc(k), val:v})), fmtBRL, 'Valor', 15)}
    <div class="fw-semibold small mb-1 mt-2">Dias de maior compra</div>${detSerieDias(porDia, 12)}`};
};
DETALHES['dash-pizzas'] = () => { const c = _detCtx.dash; if (!c) return null;
  if (!c.ceo || !Array.isArray(c.ceo.pizzas_canal)) return {titulo:'Pizzas vendidas', corpo:`<div class="kpi-explica">Os dados do TOTEM não carregaram — ${dicaAtualizarTotem()}.</div>`};
  const porLoja = {}, porCanal = {}, porDia = {};
  for (const r of c.ceo.pizzas_canal) {
    if (r.data<c.ini || r.data>c.fim || !CANAIS_REAIS.includes(r.canal) || !c.lojas.includes(r.loja)) continue;
    porLoja[r.loja]=(porLoja[r.loja]||0)+r.pizzas; porCanal[r.canal]=(porCanal[r.canal]||0)+r.pizzas; porDia[r.data]=(porDia[r.data]||0)+r.pizzas;
  }
  const nPz = v => fmtNum(v,0);
  return {titulo:`Pizzas vendidas — ${c.labelMes}`, corpo:`
    <div class="kpi-total">${nPz(c.pizzas30)} <span>pizzas-equivalentes · ${detPeriodo(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A regra:</strong> inteira e premium contam <strong>1</strong>; meia conta <strong>0,5</strong> (duas meias = uma inteira).
      <ul class="mb-0 mt-1"><li>Não entram: combo, "2 sabores", pizza do dia, <strong>JANTA</strong> (consumo interno), compra de funcionário e venda cancelada.</li>
      <li>Mesma base do Painel do CEO e da aba Pizzas por Dia (fonte única).</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1">Por loja</div>
      ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:detBadgeLoja(k), val:v})), nPz, 'Pizzas')}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1">Por canal</div>
      ${detTabela('Canal', Object.entries(porCanal).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:`<span class="badge" style="background:${CEO_CANAL_COR[k]||'#7f8c8d'}">${esc(k)}</span>`, val:v})), nPz, 'Pizzas')}</div></div>
    <div class="fw-semibold small mb-1 mt-2">Média por dia da semana</div>${detPorDiaSemana(porDia, nPz)}
    <div class="fw-semibold small mb-1 mt-2">Dia a dia</div>${detSerieDias(porDia, 16, nPz)}`};
};
DETALHES['dash-estoque'] = () => { const c = _detCtx.dash; if (!c) return null;
  const porLoja = [], porIng = {};
  for (const l of c.lojas) {
    const i = c.info[l]; if (!i) continue;
    porLoja.push({rot:detBadgeLoja(l), sub: i.ct?`contagem de ${fmtDate(i.ct.data)}`:'nunca contou', val:i.valor||0});
    // MESMA conta do total (custoPagoIng): as partes somam o todo, por construção.
    if (i.ct) for (const [ing,val] of Object.entries(i.ct.ingredientes||{})) {
      const v = (val.total||0) * custoPagoIng(ing, i.ct.data, i.ct.data, c.compras, l);
      if (v>0.005) porIng[ing] = (porIng[ing]||0) + v;
    }
  }
  return {titulo:'Valor em estoque — o que segura o dinheiro parado', corpo:`
    <div class="kpi-total">${fmtBRL(c.valorRede)} <span>situação de hoje · ${c.loja?(LOJA_LABEL[c.loja]||c.loja):'todas as lojas'}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> a <strong>última contagem</strong> de cada loja × o preço que você pagou naquele insumo.
      <ul class="mb-0 mt-1"><li>Não muda com o mês escolhido no topo — estoque é foto de agora, não do passado.</li>
      <li>Contagem velha = número velho: confira a data de cada loja abaixo.</li></ul></div>
    <div class="fw-semibold small mb-1">Por loja</div>${detTabela('Loja', porLoja.sort((a,b)=>b.val-a.val), fmtBRL, 'Em estoque')}
    <div class="fw-semibold small mb-1 mt-2">Os 15 insumos com mais dinheiro parado</div>
    ${detTabela('Insumo', Object.entries(porIng).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:esc(k), val:v})), fmtBRL, 'Valor', 15)}`};
};
// ---------- ESTOQUE & CMV (Divergências) ----------
const detJanelaAn = c => `${fmtDate(c.janIni)} a ${fmtDate(c.janFim)} · ${LOJA_LABEL[c.loja]||c.loja}`;
DETALHES['an-perda'] = () => { const c = _detCtx.an; if (!c) return null;
  const perdas = c.semFuro.filter(r=>r.impacto>0.005).sort((a,b)=>b.impacto-a.impacto);
  return {titulo:'Perda bruta — de onde ela vem', corpo:`
    <div class="kpi-total">${fmtBRL(c.perdaBrutaTotal)} <span>${detJanelaAn(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> soma só do que <strong>passou</strong> da ficha, insumo a insumo (consumo real acima do esperado × preço pago).
      <ul class="mb-0 mt-1"><li>Sobra de outro insumo <strong>não abate</strong> aqui — para o número com abatimento, veja "variação líquida".</li>
      <li>Itens com furo (consumo negativo) ficam fora: são erro de dado, não perda.</li>
      <li>Combo, "2 sabores", pizza do dia e JANTA não têm ficha — parte desta perda é isso, não desperdício.</li></ul></div>
    <div class="fw-semibold small mb-1">Quem formou a perda</div>
    ${detTabela('Insumo', perdas.map(r=>({rot:esc(r.ing),
        sub:`real ${fmtNum(r.consumoReal,2)} ${esc(r.unidade||'')} × esperado ${fmtNum(r.esperado,2)}`, val:r.impacto})), fmtBRL, 'Perda', 20)}`};
};
DETALHES['an-variacao'] = () => { const c = _detCtx.an; if (!c) return null;
  const perdas = c.semFuro.filter(r=>r.impacto>0.005).sort((a,b)=>b.impacto-a.impacto);
  const sobras = c.semFuro.filter(r=>r.impacto<-0.005).sort((a,b)=>a.impacto-b.impacto);
  const somaSobra = sobras.reduce((s,r)=>s+Math.abs(r.impacto),0);
  return {titulo:'Variação líquida — perdeu de um, sobrou de outro', corpo:`
    <div class="kpi-total">${c.variacaoTotal>=0?'+':'−'} ${fmtBRL(Math.abs(c.variacaoTotal))} <span>${detJanelaAn(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>A conta:</strong> ${fmtBRL(c.perdaBrutaTotal)} de perda menos ${fmtBRL(somaSobra)} de sobra = <strong>${c.variacaoTotal>=0?'+':'−'} ${fmtBRL(Math.abs(c.variacaoTotal))}</strong>.
      <ul class="mb-0 mt-1"><li>Positivo = gastou mais do que a ficha manda. Negativo = gastou menos.</li>
      <li>Sobra grande num insumo junto com perda grande em outro costuma ser <strong>troca na ficha</strong> ou insumo lançado com o nome errado — vale conferir antes de comemorar.</li></ul></div>
    <div class="row g-3"><div class="col-md-6"><div class="fw-semibold small mb-1 text-danger">Saiu mais que a ficha (perda)</div>
      ${detTabela('Insumo', perdas.map(r=>({rot:esc(r.ing), val:r.impacto})), fmtBRL, 'Perda', 12)}</div>
      <div class="col-md-6"><div class="fw-semibold small mb-1 text-primary">Saiu menos que a ficha (sobra)</div>
      ${detTabela('Insumo', sobras.map(r=>({rot:esc(r.ing), val:Math.abs(r.impacto)})), fmtBRL, 'Sobra', 12)}</div></div>`};
};
DETALHES['an-furos'] = () => { const c = _detCtx.an; if (!c) return null;
  const furos = c.resultado.filter(r=>r.impossivel).sort((a,b)=>Math.abs(b.impacto)-Math.abs(a.impacto));
  return {titulo:'Furos — o estoque cresceu sem entrada', corpo:`
    <div class="kpi-total">${fmtNum(c.nFuros,0)} <span>insumo(s) · ${detJanelaAn(c)}</span></div>
    <div class="kpi-explica mb-3"><strong>O que é:</strong> a contagem final ficou <strong>maior</strong> do que tudo que entrou (inicial + compras ± transferências). Não existe estoque que nasce sozinho, então é dado faltando.
      <ul class="mb-0 mt-1"><li>Quase sempre: <strong>compra ou transferência não lançada</strong>, ou número digitado errado na contagem.</li>
      <li>Furo NÃO entra na perda nem na variação — de propósito, para não virar "economia" fantasma.</li></ul></div>
    <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
      <th>Insumo</th><th class="text-end">Sobrou além do que entrou</th><th>Qual contagem revisar</th></tr></thead>
      <tbody>${furos.map(r=>`<tr><td>${esc(r.ing)}</td>
        <td class="text-end">${fmtNum(-r.consumoReal,2)} ${esc(r.unidade||'')}<br><span class="text-muted" style="font-size:11px">≈ ${fmtBRL(Math.abs(r.impacto))}</span></td>
        <td class="small">${(r.culpas&&r.culpas.length) ? r.culpas.map(x=>`<strong>${fmtDate(x.de)} → ${fmtDate(x.ate)}</strong>`).join(' e ')
          : '<span class="text-muted">não deu para isolar — confira as contagens das pontas</span>'}</td></tr>`).join('')}</tbody></table>`};
};

DETALHES['dash-criticos'] = () => { const c = _detCtx.dash; if (!c) return null;
  const cob = (d, lim) => d===null||d===undefined ? '<span class="text-muted">—</span>'
    : `<span class="${d < lim*0.4 ? 'div-critica' : (d < lim ? 'div-atencao' : '')}">${d>=60?'60+':fmtNum(d,1)} dias</span>`;
  const porLoja = {}; for (const x of c.criticos) porLoja[x.loja] = (porLoja[x.loja]||0)+1;
  return {titulo:'Itens críticos — o que acaba primeiro', corpo:`
    <div class="kpi-total">${fmtNum(c.criticos.length,0)} <span>insumo(s) abaixo do limite · ${c.loja?(LOJA_LABEL[c.loja]||c.loja):'todas as lojas'}</span></div>
    <div class="kpi-explica mb-3"><strong>A regra:</strong> o estoque estimado de hoje dividido pelo consumo previsto para os próximos dias, projetando o padrão de cada <strong>dia da semana</strong> (sábado gasta mais que segunda).
      <ul class="mb-0 mt-1"><li>Duas leituras: <strong>pela média</strong> (gramas por pizza que você realmente gasta) e <strong>pela ficha</strong> (o que a receita manda). Alerta se qualquer uma furar.</li>
      <li>A diferença entre elas é o desperdício embutido.</li>
      <li>Ajuste quais insumos alertam e em quantos dias no botão de engrenagem do painel de alertas.</li></ul></div>
    ${Object.keys(porLoja).length ? `<div class="fw-semibold small mb-1">Por loja</div>
      ${detTabela('Loja', Object.entries(porLoja).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({rot:detBadgeLoja(k), val:v})), v=>fmtNum(v,0), 'Itens')}` : ''}
    <div class="fw-semibold small mb-1 mt-2">Lista completa</div>
    ${c.criticos.length ? `<table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
        <th>Loja</th><th>Insumo</th><th class="text-end">Estoque hoje</th><th class="text-end">Pela média</th><th class="text-end">Pela ficha</th></tr></thead>
      <tbody>${c.criticos.map(x=>`<tr><td>${detBadgeLoja(x.loja)}</td>
        <td>${esc(x.ing)}<br><span class="text-muted" style="font-size:11px">alerta abaixo de ${x.lim||7} dias</span></td>
        <td class="text-end">${fmtNum(x.total,2)} ${esc(x.un||'')}</td>
        <td class="text-end">${cob(x.diasMedia, x.lim||7)}</td><td class="text-end">${cob(x.diasFicha, x.lim||7)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="text-success"><i class="fas fa-check-circle me-1"></i>Nenhum item crítico — estoque saudável.</div>'}`};
};

function abrirKpi(tipo){
  if (typeof bootstrap==='undefined'){ toast('Recarregue a página com internet.','warning'); return; }
  const c=_kpiCtx; if(!c) return;
  const periodo = `${fmtDate(c.ini)} a ${fmtDate(c.fim)} · ${c.lojaSel?(LOJA_LABEL[c.lojaSel]||c.lojaSel):'todas as lojas'}`;
  const selo = it => it.furo ? ' <span class="badge bg-danger">furo</span>' : (it.suspeito ? ' <span class="badge bg-warning text-dark">revisar</span>' : '');
  let titulo='', corpo='';

  if (tipo==='fat'){
    titulo='Faturamento — de onde vem';
    const formas=Object.entries(c.ff.porForma||{}).filter(([,v])=>v>0.005).sort((a,b)=>b[1]-a[1]);
    corpo = `
      <div class="kpi-total">${fmtBRL(c.fat)} <span>${periodo}</span></div>
      <div class="kpi-explica mb-3"><strong>A conta:</strong> soma de tudo que ENTROU como pagamento de venda, forma a forma.
        <ul class="mb-0"><li>Venda cancelada não entra (cancelada não vira pagamento).</li>
        <li>99Food entra pelo <strong>repasse</strong> (o líquido que cai na conta), não pelo valor de cardápio.</li>
        <li>Cartão e dinheiro entram no valor cheio — a taxa de maquininha não é descontada aqui.</li>
        <li>É o MESMO número da aba <strong>Pagamentos</strong> no mesmo período (fonte única).</li></ul></div>
      ${c.semFormas ? '<div class="alert alert-warning py-2 small">As formas de pagamento não carregaram — este valor veio da base de pedidos (fallback). Abra pelo atalho no PC para o número oficial.</div>' : `
      <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Forma de pagamento</th><th class="text-end">Recebido</th><th class="text-end">% do total</th></tr></thead>
        <tbody>${formas.map(([f,v])=>`<tr><td>${esc(f)}</td><td class="text-end">${fmtBRL(v)}</td><td class="text-end">${fmtNum(v/c.fat*100,1)}%</td></tr>`).join('')}</tbody>
        <tfoot><tr class="fw-bold"><td>Total</td><td class="text-end">${fmtBRL(c.fat)}</td><td class="text-end">100%</td></tfoot></table>`}
      <div class="small text-muted">Para corrigir um dia (colar o CONTROLE CAIXA), use Pagamentos → corrigir valores.</div>`;
  }

  else if (tipo==='ticket'){
    titulo='Ticket médio — a conta';
    const canais=Object.entries(c.canalPed||{}).sort((a,b)=>b[1].pedidos-a[1].pedidos);
    corpo = `
      <div class="kpi-total">${fmtBRL(c.ticket)} <span>${periodo}</span></div>
      <div class="kpi-explica mb-3"><strong>A conta:</strong> faturamento ÷ nº de pedidos →
        <strong>${fmtBRL(c.fat)} ÷ ${fmtNum(c.pedidos,0)} pedidos = ${fmtBRL(c.ticket)}</strong>
        <ul class="mb-0 mt-1"><li>Só pedidos de <strong>Balcão, Entrega própria e 99Food</strong> (JANTA e consumo interno ficam de fora).</li>
        <li>Ticket sobe com: mais pizzas por pedido, bebida junto, sabores premium. Cai com: promoções agressivas (ex.: calabresa R$9,90 no 99).</li></ul></div>
      <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Canal</th><th class="text-end">Pedidos</th><th class="text-end">% dos pedidos</th></tr></thead>
        <tbody>${canais.map(([cn,d])=>`<tr><td>${esc(cn)}</td><td class="text-end">${fmtNum(d.pedidos,0)}</td><td class="text-end">${fmtNum(d.pedidos/Math.max(c.pedidos,1)*100,1)}%</td></tr>`).join('')}</tbody>
        <tfoot><tr class="fw-bold"><td>Total</td><td class="text-end">${fmtNum(c.pedidos,0)}</td><td class="text-end">100%</td></tfoot></table>
      <div class="small text-muted">O ticket por canal exato não é mostrado porque o faturamento oficial é por forma de pagamento (não por canal); a divisão por canal dos pedidos é proporção.</div>`;
  }

  else if (tipo==='cmvesp'){
    titulo = 'CMV esperado do mês (ficha) — a composição';
    const itens = (c.espItensPeriodo||[]).filter(it=>it.esp>0.005).sort((a,b)=>b.esp-a.esp);
    const tot = c.cmvEsperado||0;
    const MAXL=22, top=itens.slice(0,MAXL), resto=itens.slice(MAXL);
    const restoVal = resto.reduce((s,x)=>s+x.esp,0);
    const linha = it => `<tr><td>${esc(it.ing)}</td>
        <td class="text-end">${fmtNum(it.q, it.q<10?2:1)}</td>
        <td class="text-end">${fmtBRL(it.esp)}</td>
        <td class="text-end">${fmtNum(it.esp/Math.max(tot,0.01)*100,1)}%</td></tr>`;
    corpo = `
      <div class="kpi-total">${fmtBRL(tot)} <span>${periodo}</span></div>
      <div class="kpi-explica mb-2"><strong>A conta:</strong> para cada pizza vendida NO MÊS, os <strong>gramas da ficha</strong> × preço pago, + a massa + <strong>1 caixa por pizza</strong>. É o esperado do PERÍODO filtrado (pizzas do mês × ficha) — <strong>independe de contagem</strong>, dá pra comparar mês a mês.
        <ul class="mb-0 mt-1">
        <li><strong>Bebidas ficam fora</strong> (revenda, não insumo).</li>
        <li>Combos, "2 sabores", pizza do dia e JANTA <strong>não têm ficha</strong> → não entram.</li>
        <li>Para ver <strong>desperdício</strong> (real × esperado), use o card CMV real ou Estoque &amp; CMV — lá a conta é na janela das contagens.</li>
        </ul></div>
      <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
        <th>Insumo</th><th class="text-end">Consumo esperado</th><th class="text-end">R$</th><th class="text-end">% do CMV</th></tr></thead>
        <tbody>${top.map(linha).join('')}
        ${resto.length?`<tr class="text-muted"><td>+ ${resto.length} insumos menores</td><td></td><td class="text-end">${fmtBRL(restoVal)}</td><td class="text-end">${fmtNum(restoVal/Math.max(tot,0.01)*100,1)}%</td></tr>`:''}</tbody>
        <tfoot><tr class="fw-bold"><td>Total do mês</td><td></td><td class="text-end">${fmtBRL(tot)}</td><td class="text-end">100%</td></tr></tfoot></table>`;
  }

  else if (tipo==='cmvreal'){
    const ehReal = tipo==='cmvreal';
    titulo = ehReal ? 'CMV real (inventário) — insumo por insumo' : 'CMV esperado (ficha) — a composição';
    if (!c.cmvInventario || !c.cmvInv){
      corpo = `<div class="kpi-total">${fmtBRL(ehReal?c.cmv:c.cmvEsperado)} <span>${periodo}</span></div>
        <div class="kpi-explica">Nenhuma loja tem 2 contagens utilizáveis no período, então este número é uma <strong>estimativa pela ficha técnica</strong> (pizzas que saíram × ficha + massa + caixa, ao preço pago; bebidas fora). Faça contagens para ver o detalhe insumo por insumo.</div>`;
    } else {
      const inv=c.cmvInv;
      const itens=kpiAgregaItens(inv).filter(it=>ehReal ? (it.real>0.005||it.furo) : it.esp>0.005);
      itens.sort((a,b)=> ehReal ? b.real-a.real : b.esp-a.esp);
      const totTab = ehReal ? inv.real : inv.esperado;
      const MAXL=22, top=itens.slice(0,MAXL), resto=itens.slice(MAXL);
      const restoVal = resto.reduce((s,x)=>s+(ehReal?x.real:x.esp),0);
      const linha = it => {
        const v = ehReal?it.real:it.esp, q = ehReal?it.qReal:it.qEsp, outro = ehReal?it.esp:it.real;
        const dif = it.furo ? null : (it.real-it.esp);
        return `<tr><td>${esc(it.ing)}${selo(it)}</td>
          <td class="text-end">${it.furo&&ehReal?'—':fmtNum(q,q<10?2:1)+' '+esc((it.unidade||'').toLowerCase())}</td>
          <td class="text-end">${it.furo&&ehReal?'—':fmtBRL(v)}</td>
          <td class="text-end">${it.furo&&ehReal?'—':fmtNum(v/Math.max(totTab,0.01)*100,1)+'%'}</td>
          <td class="text-end ${dif==null?'':(dif>0.005?'text-danger':(dif<-0.005?'text-success':''))}">${dif==null?'—':(dif>=0?'+':'−')+fmtBRL(Math.abs(dif))}</td></tr>`;
      };
      corpo = `
        <div class="kpi-total">${fmtBRL(ehReal?c.cmv:c.cmvEsperado)} <span>${periodo}</span></div>
        <div class="kpi-explica mb-2"><strong>A conta:</strong> ${ehReal
          ? 'para cada insumo, <strong>estoque inicial + compras ± transferências − estoque final</strong> = o que realmente saiu, × o preço que você pagou. Janela = entre as contagens de cada loja.'
          : 'para cada pizza que saiu, os <strong>gramas da ficha técnica</strong> × preço pago, + a receita da massa + <strong>1 caixa por pizza</strong> — na MESMA janela do CMV real.'}
          <ul class="mb-0 mt-1">
          <li><strong>Bebidas ficam fora</strong> dos dois CMVs (revenda, não insumo).</li>
          <li><strong>Combos, "2 sabores", pizza do dia e JANTA não têm ficha</strong> → o esperado NÃO conta os ingredientes deles, mas o estoque real sente. Parte da diferença real × esperado é isso, não desperdício.</li>
          ${ehReal?'<li>Consumo negativo (furo) fica fora da soma e bloqueia o fechamento.</li>':''}
          </ul></div>
        <div class="small text-muted mb-2"><i class="fas fa-calendar-days me-1"></i>${kpiJanelasTxt(inv)}${inv.estimadoFora>0.005&&ehReal?` · + ${fmtBRL(inv.estimadoFora)} estimados por ficha nos dias sem contagem`:''}</div>
        <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr>
          <th>Insumo</th><th class="text-end">${ehReal?'Consumo real':'Consumo esperado'}</th><th class="text-end">R$</th><th class="text-end">% do CMV</th><th class="text-end">real − esperado</th></tr></thead>
          <tbody>${top.map(linha).join('')}
          ${resto.length?`<tr class="text-muted"><td>+ ${resto.length} insumos menores</td><td></td><td class="text-end">${fmtBRL(restoVal)}</td><td class="text-end">${fmtNum(restoVal/Math.max(totTab,0.01)*100,1)}%</td><td></td></tr>`:''}</tbody>
          <tfoot><tr class="fw-bold"><td>Total na janela</td><td></td><td class="text-end">${fmtBRL(totTab)}</td><td class="text-end">100%</td>
            <td class="text-end ${inv.variacao>0?'text-danger':'text-success'}">${(inv.variacao>=0?'+':'−')+fmtBRL(Math.abs(inv.variacao))}</td></tr></tfoot></table>
        <div class="small text-muted">Coluna "real − esperado": <span class="text-danger">vermelho</span> = saiu MAIS do que a ficha manda (desperdício/gramatura/combo); <span class="text-success">verde</span> = saiu menos. Detalhe completo em Estoque &amp; CMV → Divergências.</div>`;
    }
  }

  else if (tipo==='pizzas'){
    titulo='Pizzas vendidas — a regra e a divisão';
    const canais=Object.entries(c.pizzasCanal||{}).sort((a,b)=>b[1]-a[1]);
    const lojas=Object.entries(c.pizzasLoja||{}).sort((a,b)=>b[1]-a[1]);
    corpo = `
      <div class="kpi-total">${fmtNum(c.pizzasPeriodo,0)} <span>pizzas-equivalentes · ${periodo}</span></div>
      <div class="kpi-explica mb-3"><strong>A regra:</strong> inteira e premium contam <strong>1</strong>; meia conta <strong>0,5</strong> (duas meias = 1 inteira).
        <ul class="mb-0 mt-1"><li>NÃO entram: combos, "2 sabores", pizza do dia, JANTA, compra de funcionário e vendas canceladas.</li>
        <li>${c.pedidos?`Dá <strong>${fmtNum(c.pizzasPeriodo/Math.max(c.pedidos,1),2)} pizzas por pedido</strong>.`:''} Base: SKU do TOTEM (mesma regra nas 3 lojas).</li></ul></div>
      <div class="row g-3"><div class="col-md-6">
        <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Canal</th><th class="text-end">Pizzas</th><th class="text-end">%</th></tr></thead>
        <tbody>${canais.map(([cn,v])=>`<tr><td>${esc(cn)}</td><td class="text-end">${fmtNum(v,0)}</td><td class="text-end">${fmtNum(v/Math.max(c.pizzasPeriodo,1)*100,1)}%</td></tr>`).join('')}</tbody></table>
      </div><div class="col-md-6">
        <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Loja</th><th class="text-end">Pizzas</th><th class="text-end">%</th></tr></thead>
        <tbody>${lojas.map(([lj,v])=>`<tr><td>${esc(LOJA_LABEL[lj]||lj)}</td><td class="text-end">${fmtNum(v,0)}</td><td class="text-end">${fmtNum(v/Math.max(c.pizzasPeriodo,1)*100,1)}%</td></tr>`).join('')}</tbody></table>
      </div></div>`;
  }

  else if (tipo==='clientes'){
    titulo='Clientes novos — de onde vem';
    const lojas=Object.entries(c.cliNovosLoja||{}).sort((a,b)=>b[1]-a[1]);
    corpo = c.cliNovos==null
      ? `<div class="kpi-explica">Os dados de clientes não carregaram — ${dicaAtualizarTotem()}.</div>`
      : `
      <div class="kpi-total">${fmtNum(c.cliNovos,0)} <span>${periodo}</span></div>
      <div class="kpi-explica mb-3"><strong>A conta:</strong> clientes cujo <strong>primeiro pedido de todos os tempos</strong> caiu dentro do período, pelo cadastro do canal próprio (balcão/entrega).
        <ul class="mb-0 mt-1"><li>99Food NÃO entra (não tem cadastro próprio — o cliente é da 99).</li>
        <li>Detalhe completo (retorno, RFM) na aba <strong>Clientes</strong>.</li></ul></div>
      <table class="table table-sm tbl-zebra mb-1"><thead class="table-light"><tr><th>Loja</th><th class="text-end">Clientes novos</th></tr></thead>
        <tbody>${lojas.map(([lj,v])=>`<tr><td>${esc(LOJA_LABEL[lj]||lj)}</td><td class="text-end">${fmtNum(v,0)}</td></tr>`).join('')}</tbody>
        <tfoot><tr class="fw-bold"><td>Total</td><td class="text-end">${fmtNum(c.cliNovos,0)}</td></tr></tfoot></table>`;
  }

  document.getElementById('kpiModalTitle').innerHTML = `<i class="fas fa-magnifying-glass-chart me-2 text-primary"></i>${titulo}`;
  document.getElementById('kpiModalBody').innerHTML = corpo;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('kpiModal')).show();
}
function cfValorInput(el) {
  const v = parseValorBR(el.value);
  setDRECusto(cfMes(), el.dataset.cfValor, v);
  renderCustosFixos();
}
function addCustoFixo() {
  const nome = nomeSeguro(document.getElementById('cf-novo-nome').value||'').trim();
  const tipo = document.getElementById('cf-novo-tipo').value==='exato' ? 'exato' : 'variavel';
  const loja = document.getElementById('cf-novo-loja').value || '';
  const grupo = document.getElementById('cf-novo-grupo').value || grupoPorNome(nome);
  const v = parseValorBR(document.getElementById('cf-novo-valor').value);
  if (!nome) { toast('Dê um nome ao gasto (ex.: Aluguel Buritis).','warning'); return; }
  // trava anti-duplicidade: já existe um gasto com mesmo nome (normalizado) + mesma loja? atualiza em vez de duplicar
  const jaTem = getCFCad().find(it => chaveCF(it.nome,it.loja)===chaveCF(nome,loja));
  if (jaTem) {
    if (v>0) setDRECusto(cfMes(), jaTem.id, +v.toFixed(2));
    document.getElementById('cf-novo-nome').value=''; document.getElementById('cf-novo-valor').value='';
    renderCustosFixos();
    toast(`"${nome}" já existia — atualizei o valor do mês em vez de duplicar.`,'info');
    return;
  }
  const id = 'cf_' + nome.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') + '_' + Date.now().toString(36);
  const cad = [...getCFCad(), {id, nome, tipo, loja, grupo, natureza:naturezaPadrao(nome,grupo), padrao: (tipo==='exato' && v>0) ? v : 0}];
  setCFCad(cad);
  if (tipo==='variavel' && v>0) setDRECusto(cfMes(), id, v);
  document.getElementById('cf-novo-nome').value=''; document.getElementById('cf-novo-valor').value='';
  renderCustosFixos();
  toast(`"${nome}" cadastrado em ${grupo}.`,'success');
}

// ---- Empréstimos entre lojas (movimento de caixa; não entra no resultado) ----
function addEmprestimo(){
  const origem=document.getElementById('cf-emp-origem').value, destino=document.getElementById('cf-emp-destino').value;
  const valor=parseValorBR(document.getElementById('cf-emp-valor').value); const data=document.getElementById('cf-emp-data').value||today();
  if (origem===destino){ toast('As lojas têm que ser diferentes.','warning'); return; }
  if (isNaN(valor)||valor<=0){ toast('Informe o valor emprestado.','warning'); return; }
  setEmprestimos([...getEmprestimos(), {id:'emp_'+Date.now().toString(36), data, origem, destino, valor:+valor.toFixed(2), quitado:false}]);
  document.getElementById('cf-emp-valor').value='';
  renderEmprestimosCF();
  toast(`Empréstimo ${LOJA_LABEL[origem]}→${LOJA_LABEL[destino]} de ${fmtBRL(valor)} lançado.`,'success');
}
function toggleQuitarEmp(id){ setEmprestimos(getEmprestimos().map(e=>e.id===id?{...e,quitado:!e.quitado}:e)); renderEmprestimosCF(); }
function removerEmp(id){ if(!confirm('Remover este empréstimo?'))return; setEmprestimos(getEmprestimos().filter(e=>e.id!==id)); renderEmprestimosCF(); }
function renderEmprestimosCF(){
  const host=document.getElementById('cf-emprestimos'); if(!host) return;
  const {porLoja}=emprestimosAberto();
  const todos=getEmprestimos().slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));
  if (!todos.length){ host.innerHTML=`<div class="card"><div class="card-body text-center py-4 text-muted"><i class="fas fa-right-left fa-2x mb-2 d-block opacity-25"></i>Nenhum empréstimo entre lojas lançado.<div class="small mt-1">Quando houver, ele ficará aqui — separado do resultado operacional.</div></div></div>`; return; }
  const saldos=LOJAS_ATIVAS().map(l=>({l,v:porLoja[l]||0}));
  const cards=`<div class="row g-2 mb-3">${saldos.map(({l,v})=>`<div class="col-md-4"><div class="card h-100 cf-loan-balance ${v>0?'credito':v<0?'debito':''}"><div class="card-body py-3"><div class="small text-muted">${LOJA_LABEL[l]||l}</div><div class="fs-5 fw-bold ${v>0?'text-success':v<0?'text-danger':''}" style="font-family:Fraunces">${v>0?'+ ':v<0?'− ':''}${fmtBRL(Math.abs(v))}</div><div class="small text-muted">${v>0?'tem a receber':v<0?'tem a pagar':'sem saldo aberto'}</div></div></div></div>`).join('')}</div>`;
  host.innerHTML=cards+`<div class="alert alert-light border small"><i class="fas fa-circle-info me-1"></i><strong>Empréstimo não é custo.</strong> Ele altera o caixa de quem empresta e de quem recebe, mas não reduz o EBITDA nem o lucro.</div><div class="card"><div class="card-header d-flex justify-content-between align-items-center flex-wrap">
    <span><i class="fas fa-right-left me-1"></i>Movimentações entre lojas</span>
    <span class="small text-muted">${todos.filter(e=>!e.quitado).length} em aberto · ${todos.filter(e=>e.quitado).length} quitado(s)</span></div>
    <div class="card-body p-0"><table class="table table-sm mb-0 tbl-zebra"><thead class="table-light"><tr><th>Data</th><th>De → Para</th><th class="text-end">Valor</th><th>Status</th><th style="width:70px"></th></tr></thead><tbody>
    ${todos.map(e=>{const dias=e.data?Math.max(0,Math.floor((new Date(today()+'T12:00:00')-new Date(e.data+'T12:00:00'))/86400000)):0;return `<tr class="${e.quitado?'text-muted':''}"><td>${fmtDate(e.data)}<div class="small text-muted">${dias} dia(s)</div></td><td>${LOJA_LABEL[e.origem]||e.origem} → <strong>${LOJA_LABEL[e.destino]||e.destino}</strong></td><td class="text-end">${fmtBRL(e.valor)}</td>
      <td>${e.quitado?'<span class="badge bg-secondary">Quitado</span>':`<span class="badge" style="background:var(--queijo);color:#000">Em aberto</span>${dias>30?'<div class="small text-danger mt-1">revisar prazo</div>':''}`}</td>
      <td class="text-end text-nowrap"><button class="btn btn-sm btn-outline-secondary py-0 px-1" onclick="toggleQuitarEmp('${e.id}')" title="${e.quitado?'Reabrir':'Marcar quitado'}"><i class="fas ${e.quitado?'fa-rotate-left':'fa-check'}"></i></button>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removerEmp('${e.id}')"><i class="fas fa-trash"></i></button></td></tr>`;}).join('')}
    </tbody></table></div></div>`;
}

// ---- Colar gastos em lote (planilha/Excel) ----
function abrirColarCustos(){ if(typeof bootstrap==='undefined'){toast('Recarregue a página com internet.','warning');return;} document.getElementById('cf-batch').value=''; document.getElementById('cf-batch-preview').innerHTML=''; renderCustosFixos(); bootstrap.Modal.getOrCreateInstance(document.getElementById('cfBatchModal')).show(); }
// Núcleo do "colar em lote": parseia, deduplica por chaveCF e detecta "parecidos".
// dryRun=true só CONTA (não grava nada) — serve para a prévia ao vivo enquanto o Gabriel digita.
function processarColarCustos(raw, tipo, dryRun){
  const mes=cfMes();
  const lojaMap={'planalto':'PLANALTO','buritis':'BURITIS','venda nova':'VENDA_NOVA','vendanova':'VENDA_NOVA','venda_nova':'VENDA_NOVA','rede':'','geral':'','rede/geral':''};
  const linhas=(raw||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean); let n=0, dup=0;
  const novos=[...getCFCad()]; const grupos=[...getDREGrupos()];
  const idx={}; for (const it of novos) idx[chaveCF(it.nome,it.loja)]=it.id;
  const criados=[];
  linhas.forEach((l,i)=>{
    const cols=l.split(/\t|\s{2,}/).map(c=>c.trim()).filter(c=>c!=='');
    if (cols.length<2) return;
    const nome=nomeSeguro(cols[0]); const valor=parseValorBR(cols[1]);
    if (!nome||isNaN(valor)) return;
    let loja='', grupo='';
    if (cols[2]!=null){ const k=cols[2].toLowerCase(); if (lojaMap[k]!==undefined) loja=lojaMap[k]; else grupo=cols[2]; }
    if (cols[3]) grupo=cols[3];
    if (!grupo) grupo=grupoPorNome(nome);
    if (!grupos.includes(grupo)) grupos.push(grupo);
    const chave=chaveCF(nome,loja);
    if (idx[chave]!=null){ if (!dryRun && valor>0) setDRECusto(mes, idx[chave], +valor.toFixed(2)); dup++; return; }
    const id='cf_'+nome.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')+'_'+Date.now().toString(36)+i;
    novos.push({id, nome, tipo, loja, grupo, natureza:naturezaPadrao(nome,grupo), padrao: tipo==='exato'?+valor.toFixed(2):0});
    idx[chave]=id;
    if (!dryRun && valor>0) setDRECusto(mes, id, +valor.toFixed(2));
    criados.push({id, nome, loja});
    n++;
  });
  // aviso de "parecido": item novo que compartilha palavra-chave com um gasto JÁ existente (mesma loja)
  // mas com nome diferente — provável duplicata que a chave exata não pega. Nunca junta sozinho.
  const parecidos=[];
  for (const c of criados){
    const tc=tokensCF(c.nome);
    const alvo=novos.find(it=> it.id!==c.id && (it.loja||'')===(c.loja||'') && !criados.some(x=>x.id===it.id)
      && [...tokensCF(it.nome)].some(t=>tc.has(t)));
    if (alvo) parecidos.push(`"${esc(c.nome)}" parece "${esc(alvo.nome)}"`);
  }
  if (!dryRun && (n||dup)){ setDREGrupos(grupos); setCFCad(novos); renderCustosFixos(); }
  return {n, dup, parecidos};
}
function _msgColar(r, dryRun){
  const {n,dup,parecidos}=r;
  if (!n && !dup) return '<span class="text-muted">Cole uma linha por gasto: <strong>Nome · Valor · Loja · Grupo</strong>.</span>';
  const aviso = parecidos.length
    ? `<div class="alert alert-warning py-1 px-2 small mt-2 mb-0"><i class="fas fa-triangle-exclamation me-1"></i><strong>${parecidos.length} pode(m) ser duplicata:</strong> ${parecidos.slice(0,4).join('; ')}${parecidos.length>4?'…':''}. ${dryRun?'Confira antes de lançar.':'Confira e, se for o mesmo, apague um.'}</div>`
    : '';
  return `<span class="text-success"><i class="fas fa-${dryRun?'eye':'check'} me-1"></i>${dryRun?'vou lançar':'lançado'}: <strong>${n} novo(s)</strong>${dup?` · <span class="text-muted">${dup} já existe(m) — só atualizo o valor</span>`:''}.</span>`+aviso;
}
// Modal antigo (mantido para compatibilidade)
function importarCustosLote(){
  const raw=document.getElementById('cf-batch').value||''; const tipo=document.getElementById('cf-batch-tipo').value==='exato'?'exato':'variavel';
  const r=processarColarCustos(raw, tipo, false);
  document.getElementById('cf-batch-preview').innerHTML=_msgColar(r,false);
  if (r.n||r.dup) toast(`${r.n} novo(s)${r.dup?`, ${r.dup} atualizado(s)`:''}.`,'success');
}
// Colar na PRÓPRIA PÁGINA (herói da entrada): prévia ao vivo enquanto digita + botão lançar
function previewColarPagina(){
  const raw=document.getElementById('cf-cole').value||''; const el=document.getElementById('cf-cole-preview'); if(!el) return;
  el.innerHTML = raw.trim() ? _msgColar(processarColarCustos(raw,'variavel',true), true) : '';
}
function colarCustosPagina(){
  const raw=document.getElementById('cf-cole').value||'';
  if(!raw.trim()){ toast('Cole os gastos primeiro.','warning'); return; }
  const r=processarColarCustos(raw,'variavel',false);
  document.getElementById('cf-cole-preview').innerHTML=_msgColar(r,false);
  if (r.n||r.dup){ toast(`${r.n} novo(s)${r.dup?`, ${r.dup} atualizado(s)`:''}.`,'success'); document.getElementById('cf-cole').value=''; }
}
function cfTab(btn, pane){
  document.querySelectorAll('#page-custosfixos .cf-tab').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('cf-pane-cole').classList.toggle('d-none', pane!=='cole');
  document.getElementById('cf-pane-add').classList.toggle('d-none', pane!=='add');
}

// ---- Gerenciar os grandes grupos do DRE ----
function abrirGerenciarGrupos(){ if(typeof bootstrap==='undefined'){toast('Recarregue a página com internet.','warning');return;} renderGruposModal(); bootstrap.Modal.getOrCreateInstance(document.getElementById('cfGruposModal')).show(); }
function renderGruposModal(){
  const host=document.getElementById('cf-grupos-lista'); const cad=getCFCad();
  host.innerHTML=getDREGrupos().map((g,i)=>{ const n=cad.filter(it=>(it.grupo||'Outros')===g).length;
    return `<div class="input-group input-group-sm mb-1">
      <input type="text" class="form-control" value="${esc(g)}" onchange="renomearGrupo(${i},this.value)">
      <span class="input-group-text">${n} gasto(s)</span>
      <button class="btn btn-outline-danger" onclick="removerGrupo(${i})" title="Remover (gastos vão p/ Outros)"><i class="fas fa-trash"></i></button>
    </div>`; }).join('');
}
function addGrupoDRE(){ const el=document.getElementById('cf-grupo-novo'); const nome=(el.value||'').trim(); if(!nome)return; setDREGrupos([...getDREGrupos(), nome]); el.value=''; renderGruposModal(); popularGrupoSelect(document.getElementById('cf-novo-grupo')); }
function renomearGrupo(i, novo){ novo=(novo||'').trim(); const gs=getDREGrupos(); const antigo=gs[i]; if(!novo||novo===antigo){ renderGruposModal(); return; }
  gs[i]=novo; setDREGrupos(gs);
  setCFCad(getCFCad().map(it=> (it.grupo||'Outros')===antigo?{...it,grupo:novo}:it));
  renderGruposModal(); renderCustosFixos(); }
function removerGrupo(i){ const gs=getDREGrupos(); if(gs.length<=1){toast('Deixe ao menos um grupo.','warning');return;}
  const g=gs[i]; if(!confirm(`Remover o grupo "${g}"? Os gastos dele vão para "Outros".`))return;
  setCFCad(getCFCad().map(it=> (it.grupo||'Outros')===g?{...it,grupo:'Outros'}:it));
  const rest=gs.filter((x,idx)=>idx!==i); if(!rest.includes('Outros')) rest.push('Outros');
  setDREGrupos(rest);
  renderGruposModal(); renderCustosFixos(); popularGrupoSelect(document.getElementById('cf-novo-grupo')); }
function removerCustoFixo(id) {
  const it = getCFCad().find(x=>x.id===id); if (!it) return;
  if (!confirm(`Remover "${it.nome}" do cadastro?\n\nOs valores já lançados nos meses ficam guardados, mas param de somar no DRE.`)) return;
  setCFCad(getCFCad().filter(x=>x.id!==id));
  renderCustosFixos();
}
function copiarCustosMesAnterior() {
  const mes = cfMes();
  const d = new Date(parseInt(mes.slice(0,4),10), parseInt(mes.slice(5,7),10)-2, 1);
  const mesAnt = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  const de = getDRECustos(mesAnt), atual = getDRECustos(mes);
  let n=0;
  for (const [id,v] of Object.entries(de)) if (atual[id]==null && v>0) { setDRECusto(mes, id, v); n++; }
  renderCustosFixos();
  toast(n ? `${n} valor(es) copiados de ${MES_ABREV[d.getMonth()]}/${String(d.getFullYear()).slice(2)}.` : 'Nada a copiar (mês anterior vazio ou tudo já preenchido).', n?'success':'info');
}

// Um repasse 99 ou uma correção de pagamento muda o faturamento em VÁRIAS telas (Dashboard,
// Painel do CEO, Comparativo e Pagamentos). Todas leem a mesma camada (localStorage) na hora de
// renderizar, então basta re-renderizar a tela aberta — as demais já pegam o valor novo ao abrir.
// Páginas seguras de re-renderizar sozinhas: são de LEITURA (nenhuma tem digitação em curso).
// Contagem/Compras/Transferências ficam FORA de propósito — re-render apagaria o que está sendo
// digitado. "Pizzas por Dia" e "Estoque & CMV" entraram em 30/07: elas leem o store `vendas`, que
// a importação do TOTEM acabou de mexer, e antes ficavam mostrando dado velho até o F5.
const PAGINAS_AUTO_RENDER = ['dashboard','ceo','bench','pagamentos','pagcategorias',
                             'clientes','menu','pizzasdia','painel','analise','contagens'];
function atualizarTelasFinanceiras() {
  if (PAGINAS_AUTO_RENDER.includes(currentPage) && PAGE_ACTIONS[currentPage]) {
    try { PAGE_ACTIONS[currentPage](); } catch (e) { console.warn('re-render ' + currentPage, e); }
  }
}

// Joga fora os arquivos do TOTEM guardados em MEMÓRIA (pedidos/pagamentos/clientes).
// Sem isto, o app só rebusca na nuvem depois de um F5 — e o robô, que atualiza a nuvem
// de hora em hora, "não aparecia" para quem deixa o app aberto (bug do celular, jul/2026).
// Chamado pelo Nuvem.observarOverlays() ao voltar para o app, ANTES de re-renderizar.
function limparCacheTotem() { _ceoData = null; _pagData = null; _cliData = null; }

// Chip da sidebar: quem está logado + SINAL DE VIDA DO ROBÔ ("dados do TOTEM: há X").
// Pedido do Gabriel (16/07): a hora da última atualização vale mais que o número da versão —
// é o que responde "meu celular está vendo dado velho?" sem precisar de ninguém.
// Verde ≤ 2h (robô saudável) · âmbar ≤ 6h (atrasado) · vermelho > 6h (robô parado, investigar).
function textoDesdeAgora(d) {
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  // O robô roda de hora em hora. Limites em MINUTOS (usar horas arredondadas escondia
  // um robô morto há 6h como "atrasado" — bug pego no teste de 16/07):
  //   até 2h = normal (cabe 1 rodada atrasada) · até 4h = atrasado · acima = parado
  const cor = min <= 120 ? 'ok' : (min <= 240 ? 'alerta' : 'parado');
  if (min < 2)  return {txt:'agora mesmo', cor};
  if (min < 60) return {txt:'há ' + min + ' min', cor};
  const h = Math.floor(min / 60);
  return {txt:'há ' + h + 'h' + (min % 60 ? ' ' + (min % 60) + 'min' : ''), cor};
}

// Botão ⚡ da sidebar: manda o robô do TOTEM rodar AGORA (só dono). O pedido vai ao
// banco, que aciona o GitHub com o token do cofre — a chave nunca chega ao navegador.
// Leva ~2 min; enquanto isso o ⚡ vira ampulheta e o chip se atualiza sozinho no fim.
let _roboOcupado = false;
async function atualizarTotemAgora(ev) {
  if (ev) ev.preventDefault();
  if (_roboOcupado) return;
  const link = document.querySelector('.nuvem-run');
  try {
    _roboOcupado = true;
    if (link) link.innerHTML = '<i class="fas fa-hourglass-half"></i>';
    await Nuvem.dispararRobo();
    toast('Robô do TOTEM acionado! Os dados chegam em cerca de 2 minutos.', 'success');
    // confere daqui a 2min30 e re-renderiza sozinho quando o dado novo chegar
    setTimeout(async () => {
      limparCacheTotem();
      await atualizarChipNuvem();
      try { atualizarTelasFinanceiras(); } catch (e) {}
      _roboOcupado = false;
    }, 150000);
  } catch (e) {
    toast('Não consegui acionar o robô: ' + esc(e.message), 'error');
    _roboOcupado = false;
    if (link) link.innerHTML = '<i class="fas fa-bolt"></i>';
  }
}

async function atualizarChipNuvem() {
  const chip = document.getElementById('nuvem-status');
  if (!chip || !window.Nuvem || !Nuvem.ativa()) return;
  const PAPEL_LABEL = {dono:'Dono', operacao:'Operação', leitura:'Leitura'};
  const p = Nuvem.papel();
  let linha2 = '<span class="nuvem-versao">versão ' + esc(APP_VERSION) + '</span>';
  try {
    const dt = await Nuvem.ultimaAtualizacaoTotem();
    if (dt) {
      const s = textoDesdeAgora(dt);
      linha2 = '<span class="nuvem-totem ' + s.cor + '" title="Quando o robô trouxe os dados do TOTEM pela última vez. '
             + 'Ele roda de hora em hora durante o expediente (18h–0h) + 1x de manhã.">'
             + (s.cor === 'parado' ? '<i class="fas fa-triangle-exclamation me-1"></i>' : '<i class="fas fa-rotate me-1"></i>')
             + 'TOTEM: ' + esc(s.txt) + '</span>'
             + (p === 'dono' ? ' <a class="nuvem-run" href="#" onclick="atualizarTotemAgora(event)"'
                 + ' title="Atualizar AGORA: manda o robô buscar os dados do TOTEM (~2 min)"><i class="fas fa-bolt"></i></a>' : '')
             + ' <span class="nuvem-versao">· v' + esc(APP_VERSION) + '</span>';
    }
  } catch (e) { /* sem rede: fica só a versão */ }
  chip.innerHTML = '<span class="badge text-bg-success"><i class="fas fa-cloud me-1"></i>Nuvem</span> '
    + esc(Nuvem.usuarioEmail() || '')
    + (p && p !== 'dono' ? ' <span class="badge text-bg-secondary">' + esc(PAPEL_LABEL[p] || p) + '</span>' : '')
    + '<br>' + linha2;
}
// "1.234,56" → 1234.56 ; "980,00" → 980 ; "1050.30" → 1050.30 ; tira "R$" e espaços
function parseValorBR(s) {
  s = String(s==null?'':s).trim().replace(/r\$/i,'').replace(/\s/g,'');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g,'').replace(',','.');   // formato brasileiro
  return parseFloat(s);
}

function abrirRepasse99() {
  if (typeof bootstrap === 'undefined') { toast('Recarregue a página (com internet) para abrir a janela.','warning'); return; }
  document.getElementById('r99-texto').value = '';
  document.getElementById('r99-preview').innerHTML = '';
  renderRepasse99Resumo();
  renderRepasse99Faltando();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('repasse99Modal')).show();
}

function importarRepasse99() {
  const loja = document.getElementById('r99-loja').value;
  const txt = document.getElementById('r99-texto').value || '';
  const linhas = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const prev = document.getElementById('r99-preview');
  if (!linhas.length) { prev.innerHTML = '<span class="text-danger">Cole a lista primeiro.</span>'; return; }
  const map = {...getRepasse99Manual()};
  let ok = 0; const erros = [];
  for (const ln of linhas) {
    const toks = ln.split(/[\t;]+|\s+/).filter(Boolean);
    if (toks.length < 2) { erros.push(ln); continue; }
    const dataISO = parseDataFlex(toks[0]);
    const valor = parseValorBR(toks[toks.length-1]);
    if (!dataISO || isNaN(valor) || valor < 0) { erros.push(ln); continue; }
    map[loja+'|'+dataISO] = valor;
    ok++;
  }
  setRepasse99Manual(map);
  let msg = `<span class="text-success"><i class="fas fa-check me-1"></i>${ok} lançamento(s) salvos para ${LOJA_LABEL[loja]}.</span>`;
  if (erros.length) msg += `<div class="text-danger mt-1">${erros.length} linha(s) não entendidas (ignoradas): <span class="font-monospace">${erros.slice(0,3).map(esc).join(' | ')}${erros.length>3?'…':''}</span></div>`;
  prev.innerHTML = msg;
  if (ok) document.getElementById('r99-texto').value = '';
  renderRepasse99Resumo();
  renderRepasse99Faltando();
  atualizarTelasFinanceiras();
  if (ok) toast(`${ok} repasse(s) da 99 lançados.`, 'success');
}

function renderRepasse99Resumo() {
  const host = document.getElementById('r99-resumo');
  if (!host) return;
  const map = getRepasse99Manual();
  const porLoja = {};
  for (const [k,v] of Object.entries(map)) { const [lj,d] = k.split('|'); (porLoja[lj] = porLoja[lj] || []).push({d, v}); }
  if (!Object.keys(porLoja).length) { host.innerHTML = '<div class="text-muted small">Nenhum repasse lançado ainda.</div>'; return; }
  let html = '<table class="table table-sm align-middle mb-2"><thead class="table-light"><tr><th>Loja</th><th class="text-end">Dias</th><th class="text-end">Soma</th><th></th></tr></thead><tbody>';
  for (const lj of ['PLANALTO','BURITIS','VENDA_NOVA']) {
    if (!porLoja[lj]) continue;
    const soma = porLoja[lj].reduce((s,x)=>s+x.v,0);
    html += `<tr><td><span class="badge ${LOJA_BADGE[lj]}">${LOJA_LABEL[lj]}</span></td><td class="text-end">${porLoja[lj].length}</td><td class="text-end">${fmtBRL(soma)}</td>` +
      `<td class="text-end"><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="limparRepasse99Loja('${lj}')" title="Apagar os lançamentos desta loja"><i class="fas fa-trash"></i></button></td></tr>`;
  }
  html += '</tbody></table>';
  const sel = document.getElementById('r99-loja')?.value;
  if (sel && porLoja[sel]) {
    const linhas = porLoja[sel].sort((a,b)=>a.d.localeCompare(b.d)).map(x=>
      `<tr><td>${fmtDate(x.d)}</td><td class="text-end">${fmtBRL(x.v)}</td><td class="text-end"><button class="btn btn-sm btn-outline-secondary py-0 px-1" onclick="removerRepasse99('${sel}','${x.d}')" title="Remover este dia"><i class="fas fa-xmark"></i></button></td></tr>`).join('');
    html += `<div class="small text-muted mb-1">Detalhe — ${LOJA_LABEL[sel]}:</div><div style="max-height:180px;overflow:auto"><table class="table table-sm mb-0"><tbody>${linhas}</tbody></table></div>`;
  }
  host.innerHTML = html;
}

function limparRepasse99Loja(loja) {
  if (!confirm(`Apagar TODOS os repasses lançados da ${LOJA_LABEL[loja]}?`)) return;
  const map = {...getRepasse99Manual()};
  for (const k of Object.keys(map)) if (k.startsWith(loja+'|')) delete map[k];
  setRepasse99Manual(map);
  renderRepasse99Resumo();
  atualizarTelasFinanceiras();
  toast('Lançamentos removidos.','info');
}

function removerRepasse99(loja, dataISO) {
  const map = {...getRepasse99Manual()};
  delete map[loja+'|'+dataISO];
  setRepasse99Manual(map);
  renderRepasse99Resumo();
  renderRepasse99Faltando();
  atualizarTelasFinanceiras();
}

// Lista os dias com venda na 99 (do resumo do TOTEM) que AINDA não têm repasse real
// lançado (nem manual, nem da planilha) → são os que hoje entram pela estimativa.
let _r99FaltamCache = [];
async function renderRepasse99Faltando() {
  const host = document.getElementById('r99-faltando');
  if (!host) return;
  const loja = document.getElementById('r99-loja').value;
  host.innerHTML = '<span class="text-muted small">Verificando…</span>';
  const ceo = await carregarCEO();
  if (!ceo || !Array.isArray(ceo.por_dia)) {
    _r99FaltamCache = [];
    host.innerHTML = `<div class="text-muted small">Os dias só aparecem com o resumo do TOTEM carregado — ${dicaAtualizarTotem()}. Sem isso, lance pelas datas que você tiver.</div>`;
    return;
  }
  const tem = new Set();
  for (const r of (ceo.repasse_99||[])) tem.add(r.loja+'|'+r.data);
  for (const k of Object.keys(getRepasse99Manual())) tem.add(k);
  const faltam = [];
  for (const r of ceo.por_dia) {
    if (r.loja!==loja || r.canal!=='99Food' || !(r.faturamento>0)) continue;
    if (tem.has(loja+'|'+r.data)) continue;
    faltam.push({data:r.data, bruto:r.faturamento});
  }
  faltam.sort((a,b)=>b.data.localeCompare(a.data));
  _r99FaltamCache = faltam.map(f=>f.data);
  if (!faltam.length) {
    host.innerHTML = `<div class="text-success small"><i class="fas fa-circle-check me-1"></i>Todos os dias com venda na 99 da ${LOJA_LABEL[loja]} já têm repasse lançado. 🎉</div>`;
    return;
  }
  const fator = FATOR_99[loja]||FATOR_99._default;
  let html = `<div class="small mb-1"><strong>${faltam.length} dia(s)</strong> da ${LOJA_LABEL[loja]} com venda na 99 e <strong>sem repasse real</strong> (hoje entram por estimativa de ${Math.round(fator*100)}%):</div>`;
  html += `<button class="btn btn-sm btn-outline-primary mb-2" onclick="preencherDatasFaltando()"><i class="fas fa-arrow-up me-1"></i>Jogar essas datas na caixa acima</button>`;
  html += '<div style="max-height:200px;overflow:auto"><table class="table table-sm mb-0"><thead class="table-light"><tr><th>Dia</th><th class="text-end">Bruto (99)</th><th class="text-end">Estimativa hoje</th></tr></thead><tbody>';
  for (const f of faltam) html += `<tr><td>${fmtDate(f.data)}</td><td class="text-end text-muted">${fmtBRL(f.bruto)}</td><td class="text-end text-muted">${fmtBRL(f.bruto*fator)}</td></tr>`;
  html += '</tbody></table></div>';
  host.innerHTML = html;
}

// Joga as datas faltantes na caixa de texto (uma por linha, com um TAB para o valor),
// em ordem cronológica — o usuário só escreve o valor ao lado de cada e clica em Lançar.
function preencherDatasFaltando() {
  if (!_r99FaltamCache.length) return;
  const ta = document.getElementById('r99-texto');
  ta.value = _r99FaltamCache.slice().sort().map(d=>fmtDate(d)+'\t').join('\n');
  ta.focus();
  toast('Datas na caixa. Escreva o valor ao lado de cada uma e clique em "Lançar lista".','info');
}

// Snapshot dos dados agregados do TOTEM (faturamento, clientes, bairros) p/ viajarem DENTRO do
// backup e o celular ver tudo sem os arquivos. NUNCA guarda PII (clientes_contatos fica de fora).
// 21/09 (fase 1 SaaS): NA NUVEM o snapshot não é mais guardado — a fonte é a tabela arquivos_totem,
// e 3,7 MB de cópia no localStorage (cota ~5 MB) falhavam em silêncio. A cópia velha é apagada.
// No modo local (só teste) continua como era.
function guardarSnapshotJSON(key, obj){
  try {
    if (window.Nuvem && Nuvem.ativa && Nuvem.ativa()) { localStorage.removeItem(key); return; }
    if(obj) localStorage.setItem(key, JSON.stringify(obj));
  } catch(e) { /* quota cheia: ignora */ }
}
function lerSnapshotJSON(key){ try { return JSON.parse(localStorage.getItem(key)) || null; } catch(e) { return null; } }

async function carregarCEO() {
  if (_ceoData) return _ceoData;
  // NUVEM primeiro: o arquivo sobe do PC pela ponte (arquivos_totem) — qualquer aparelho lê fresco.
  if (window.Nuvem && Nuvem.ativa()) {
    const nuv = await Nuvem.lerArquivo('pedidos_resumo.json').catch(()=>null);
    if (nuv) { _ceoData = nuv; guardarSnapshotJSON('ceo_snapshot_v1', nuv); return _ceoData; }
  }
  try {
    const resp = await fetch('pedidos_resumo.json', {cache:'no-store'});
    if (resp.ok) { _ceoData = await resp.json(); guardarSnapshotJSON('ceo_snapshot_v1', _ceoData); return _ceoData; }
  } catch (e) { /* file:// ou Netlify sem o arquivo */ }
  // Sem o arquivo (celular/Netlify): usa o snapshot que veio dentro do backup restaurado.
  _ceoData = lerSnapshotJSON('ceo_snapshot_v1');
  return _ceoData;
}

// ================================================================
//  FORMAS DE PAGAMENTO (vw_financeiro). Faturamento REAL recebido por forma;
//  cancelamentos à parte; CAMADA DE CORREÇÃO MANUAL por (loja|data|forma) — mesmo
//  padrão do repasse99: vive no localStorage, vence o valor do TOTEM, entra no backup.
//  Lê pagamentos_resumo.json (com snapshot p/ o celular ver via backup).
// ================================================================
// FASE 1: formas de pagamento saem do código e viram config por empresa (padrão = semente PPV).
const PAG_FORMAS_BASE = ['DINHEIRO','DEBITO','CREDITO','PIX QR CODE','PIX CHAVE','ONLINE APP','Outros'];
const PAG_LABEL_BASE = {DINHEIRO:'Dinheiro',DEBITO:'Débito',CREDITO:'Crédito','PIX QR CODE':'Pix QR','PIX CHAVE':'Pix Chave','ONLINE APP':'Online/App',Outros:'Outros'};
let PAG_FORMAS = PAG_FORMAS_BASE.slice();
let PAG_LABEL = {...PAG_LABEL_BASE};
const PAG_COR = {DINHEIRO:'#2e7d55',DEBITO:'#1a5276',CREDITO:'#7d3c98','PIX QR CODE':'#16a085','PIX CHAVE':'#0e6655','ONLINE APP':'#e67e22',Outros:'#95a5a6'};

// FASE 1 — "config é dado": aplica a config de VENDAS (canais + formas de pagamento) da empresa.
// Vive no overlay `personalizacoes` (já sincronizado por empresa). SEM config = padrão da marca,
// então o comportamento é BYTE-IDÊNTICO ao de hoje. Roda no boot (via aplicarPersonalizacoes) e a
// cada setPers(). Não toca no FATOR_99 (o repasse já tem override por loja) — isso vem com a tela.
function aplicarConfigVendas() {
  const p = (typeof getPers === 'function') ? getPers() : {};
  CANAIS_REAIS = (Array.isArray(p.canais) && p.canais.length) ? p.canais.slice() : CANAIS_BASE.slice();
  if (Array.isArray(p.formasPagamento) && p.formasPagamento.length) {
    PAG_FORMAS = p.formasPagamento.slice();
    PAG_LABEL = {};
    for (const f of PAG_FORMAS) PAG_LABEL[f] = (p.formasPagamentoLabel && p.formasPagamentoLabel[f]) || PAG_LABEL_BASE[f] || f;
  } else {
    PAG_FORMAS = PAG_FORMAS_BASE.slice();
    PAG_LABEL = {...PAG_LABEL_BASE};
  }
}
const SAIDA_COR = {Motoboy:'#c0392b','Freelancer Cozinha':'#8e44ad','Freelancer Atendimento':'#9b59b6',Fornecedor:'#2c3e50','Manutenção':'#16a085',Ajuste:'#7f8c8d',Outros:'#b0875a',Ignorar:'#95a5a6',Freelancer:'#8e44ad','Compras/Fornecedores':'#2c3e50'};
const PAG_SAIDA_MAX = 500;   // teto de linhas exibidas no detalhe (período "Tudo" pode ter milhares)
let _pagData = null, _pagCharts = [];

async function carregarPagamentos() {
  if (_pagData) return _pagData;
  if (window.Nuvem && Nuvem.ativa()) {
    const nuv = await Nuvem.lerArquivo('pagamentos_resumo.json').catch(()=>null);
    if (nuv) { _pagData = nuv; guardarSnapshotJSON('pag_snapshot_v1', nuv); return _pagData; }
  }
  try {
    const resp = await fetch('pagamentos_resumo.json', {cache:'no-store'});
    if (resp.ok) { _pagData = await resp.json(); guardarSnapshotJSON('pag_snapshot_v1', _pagData); return _pagData; }
  } catch(e) { /* file:// ou Netlify sem o arquivo */ }
  _pagData = lerSnapshotJSON('pag_snapshot_v1');
  return _pagData;
}

// Correção manual: 'LOJA|AAAA-MM-DD|FORMA' -> valor (R$). Passa na frente do TOTEM; entra no backup.
let _pagCorrCache = null;
function getPagCorrecao() {
  if (_pagCorrCache) return _pagCorrCache;
  try { _pagCorrCache = JSON.parse(localStorage.getItem('pagamentos_correcao_v1')) || {}; } catch(e) { _pagCorrCache = {}; }
  return _pagCorrCache;
}
function setPagCorrecao(obj) {
  _pagCorrCache = obj || {};
  localStorage.setItem('pagamentos_correcao_v1', JSON.stringify(_pagCorrCache));
}

// FONTE ÚNICA do faturamento oficial = SOMA DAS FORMAS DE PAGAMENTO (o que ENTROU; só vendas, o
// extrator já tira cancelamento/ajuste/avulso), com a camada de correção (CONTROLE CAIXA) por cima.
// Mesma conta da aba Pagamentos → Dashboard/CEO/Pagamentos mostram o MESMO número no mesmo período.
// Devolve total, por-dia (data→R$), por-forma e a parcela 99Food (forma ONLINE APP).
function faturamentoFormas(pagData, loja, ini, fim) {
  const res = { total:0, porDia:{}, porForma:{}, v99:0, temDados:false };
  if (!pagData || !Array.isArray(pagData.por_dia)) return res;
  res.temDados = true;
  const dini = ini || '0000-00-00', dfim = fim || '9999-99-99';
  const noFiltro = (lj,dt) => (!loja || lj===loja) && dt>=dini && dt<=dfim;
  const eff = {};
  for (const r of pagData.por_dia) { if (!noFiltro(r.loja, r.data)) continue; eff[r.loja+'|'+r.data+'|'+r.forma] = r.valor; }
  const corr = getPagCorrecao();
  for (const k in corr) { const p=k.split('|'); if (!noFiltro(p[0],p[1])) continue; eff[k]=corr[k]; }
  for (const k in eff) {
    const p=k.split('|'), dt=p[1], forma=p[2]||'Outros', v=eff[k];
    res.total += v; res.porDia[dt]=(res.porDia[dt]||0)+v; res.porForma[forma]=(res.porForma[forma]||0)+v;
    if (forma==='ONLINE APP') res.v99 += v;
  }
  return res;
}

function pagQuick(dias, atualizar=true) {
  const i = document.getElementById('pag-ini'), f = document.getElementById('pag-fim');
  if (!dias) { i.value=''; f.value=''; }
  else { f.value = today(); const d = new Date(); d.setDate(d.getDate()-dias); i.value = dataLocalISO(d); }
  if (atualizar) renderPagamentos();
}

// ---- Corrigir categorias das sangrias: reclassifica saídas do caixa por FUNÇÃO p/ o DRE ----
let _sugRegra = null;
async function renderPagCategorias(){
  const data = await carregarPagamentos();
  const vazio=document.getElementById('pcat-vazio'), cont=document.getElementById('pcat-conteudo');
  if (!data || !Array.isArray(data.sangrias)){ vazio.classList.remove('d-none'); cont.classList.add('d-none'); return; }
  vazio.classList.add('d-none'); cont.classList.remove('d-none');
  const loja=document.getElementById('pcat-loja').value;
  const per=parseInt(document.getElementById('pcat-per').value,10)||0;
  let ini='0000-00-00'; if (per>0){ const d=new Date(); d.setDate(d.getDate()-per); ini=dataLocalISO(d); }
  const sangrias=data.sangrias.filter(s=>(!loja||s.loja===loja) && s.data>=ini).slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));
  const selRegra=document.getElementById('pcat-regra-cat'); if (selRegra && !selRegra.options.length) selRegra.innerHTML=SANGRIA_CATS.map(c=>`<option>${c}</option>`).join('');
  const catSel = s => { const cat=categoriaSangria(s), k=sangKey(s);
    return `<select class="form-select form-select-sm" onchange="setSangCategoria('${encodeURIComponent(k)}',this.value)">${SANGRIA_CATS.map(c=>`<option${c===cat?' selected':''}>${c}</option>`).join('')}</select>`; };
  const teto = modoLeveCelular()?150:600;
  document.getElementById('pcat-tbody').innerHTML = sangrias.length
    ? sangrias.slice(0,teto).map(s=>{ const cat=categoriaSangria(s);
        return `<tr class="${cat==='Ignorar'?'text-muted':''}"><td class="text-nowrap">${fmtDate(s.data)}</td><td>${LOJA_LABEL[s.loja]||s.loja}</td><td>${esc(s.descricao||'—')}</td><td class="text-end">${fmtBRL(s.valor)}</td><td class="small text-muted">${esc(s.plano||'—')}</td><td>${catSel(s)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="6" class="text-center text-muted py-4">Nenhuma sangria no período.</td></tr>';
  if (sangrias.length>teto) document.getElementById('pcat-tbody').insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="text-center text-muted small py-2">mostrando as ${teto} mais recentes de ${sangrias.length}</td></tr>`);
  // total por função (o que vai pro DRE)
  const porCat={}; let tot=0; for (const s of sangrias){ const c=categoriaSangria(s); porCat[c]=(porCat[c]||0)+(s.valor||0); if(c!=='Ignorar') tot+=(s.valor||0); }
  document.getElementById('pcat-portipo').innerHTML = SANGRIA_CATS.filter(c=>porCat[c]).map(c=>
    `<tr class="${c==='Ignorar'?'text-muted':''}"><td>${c}${c==='Ignorar'?' <span class="small">(fora do DRE)</span>':''}</td><td class="text-end">${fmtBRL(porCat[c])}</td></tr>`).join('')
    + `<tr class="fw-bold table-light"><td>Total no DRE</td><td class="text-end text-danger">− ${fmtBRL(tot)}</td></tr>`
    + (porCat['Ignorar']?`<tr><td colspan="2" class="small text-muted py-2"><i class="fas fa-circle-info me-1"></i><strong>Ignorar</strong> = fora do DRE. Fornecedor pago em dinheiro e ajuste de caixa entram aqui por padrão (o fornecedor já está no CMV pela aba Compras). Reclassifique p/ <strong>Fornecedor</strong> só os que você NÃO lançou em Compras.</td></tr>`:'');
  document.getElementById('pcat-resumo').textContent = `${sangrias.length} saída(s) · ${fmtBRL(tot)} no DRE`;
  renderRegrasSang();
  sugerirRegraSang(sangrias);
}
function renderRegrasSang(){
  const host=document.getElementById('pcat-regras'); const rs=getSangRegras();
  host.innerHTML = rs.length ? rs.map((r,i)=>`<div class="d-flex align-items-center gap-1 mb-1 small">
    <span class="badge bg-light text-dark border">contém "<strong>${esc(r.contem)}</strong>" → ${esc(r.categoria)}</span>
    <button class="btn btn-sm btn-link text-danger p-0" onclick="removerRegraSang(${i})"><i class="fas fa-times"></i></button></div>`).join('')
    : '<div class="small text-muted">Nenhuma regra ainda.</div>';
}
function addRegraSang(){ const txt=(document.getElementById('pcat-regra-txt').value||'').trim(); const cat=document.getElementById('pcat-regra-cat').value;
  if (!txt){ toast('Escreva o texto que a descrição deve conter.','warning'); return; }
  setSangRegras([...getSangRegras(), {contem:txt, categoria:cat}]); document.getElementById('pcat-regra-txt').value=''; renderPagCategorias(); toast('Regra criada.','success'); }
function removerRegraSang(i){ setSangRegras(getSangRegras().filter((x,idx)=>idx!==i)); renderPagCategorias(); }
function setSangCategoria(kEnc, cat){ const k=decodeURIComponent(kEnc); const corr=getSangCorr(); corr[k]=cat; setSangCorr(corr); renderPagCategorias(); }
function aplicarSugestaoRegra(){ if(!_sugRegra)return; setSangRegras([...getSangRegras(), _sugRegra]); _sugRegra=null; renderPagCategorias(); toast('Regra criada.','success'); }
// Sugere criar uma regra quando a MESMA descrição foi corrigida ≥3x manualmente p/ a mesma categoria.
function sugerirRegraSang(sangrias){
  const host=document.getElementById('pcat-sugestao'); host.innerHTML=''; _sugRegra=null;
  const corr=getSangCorr(), regras=getSangRegras(); const cont={};
  for (const s of sangrias){ const k=sangKey(s); if(!corr[k])continue; const d=(s.descricao||'').toLowerCase().trim(); if(!d)continue;
    cont[d]=cont[d]||{}; cont[d][corr[k]]=(cont[d][corr[k]]||0)+1; }
  for (const [d,cats] of Object.entries(cont)){
    const [cat,n]=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];
    if (n>=3 && !regras.some(r=>d.includes(String(r.contem).toLowerCase()))){
      _sugRegra={contem:d, categoria:cat};
      host.innerHTML=`<div class="alert alert-info d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="fas fa-lightbulb me-1"></i>Você já classificou <strong>"${esc(d)}"</strong> como <strong>${esc(cat)}</strong> ${n} vezes. Quer uma regra automática?</span>
        <button class="btn btn-sm btn-primary" onclick="aplicarSugestaoRegra()">Criar regra</button></div>`;
      break;
    }
  }
}

async function renderPagamentos() {
  const data = await carregarPagamentos();
  const vazio = document.getElementById('pag-vazio'), cont = document.getElementById('pag-conteudo');
  const iniEl = document.getElementById('pag-ini');
  if (iniEl && !iniEl.dataset.iniciado) { iniEl.dataset.iniciado='1'; pagQuick(30,false); }
  if (!data || !Array.isArray(data.por_dia)) {
    _pagCharts.forEach(c=>c.destroy()); _pagCharts=[];
    vazio.classList.remove('d-none'); cont.classList.add('d-none'); return;
  }
  vazio.classList.add('d-none'); cont.classList.remove('d-none');

  const loja = document.getElementById('pag-loja').value;
  const ini = document.getElementById('pag-ini').value || '0000-00-00';
  const fim = document.getElementById('pag-fim').value || '9999-99-99';
  const noFiltro = (lj,dt) => (!loja || lj===loja) && dt>=ini && dt<=fim;

  // Faturamento (total + por forma) vem da FONTE ÚNICA faturamentoFormas — a mesma do Dashboard/CEO,
  // então os três não têm como divergir. Aqui só conto à parte quantos dias/formas foram corrigidos à mão.
  const ff = faturamentoFormas(data, loja, ini, fim);
  const porForma = ff.porForma, total = ff.total;
  let nCorr = 0;
  for (const k in getPagCorrecao()) { const [lj,dt] = k.split('|'); if (noFiltro(lj,dt)) nCorr++; }

  let cancVal = 0, cancN = 0; const cancPorLoja = {};
  for (const c of (data.cancelamentos||[])) {
    if (!noFiltro(c.loja, c.data)) continue;
    cancVal += c.valor; cancN += c.n;
    cancPorLoja[c.loja] = (cancPorLoja[c.loja]||0) + c.valor;
  }

  // Entradas avulsas (CD='C' sem venda) — não entram no faturamento; mostradas p/ transparência
  let avulTotal = 0;
  for (const a of (data.entradas_avulsas||[])) { if (noFiltro(a.loja, a.data)) avulTotal += a.valor; }
  const avulEl = document.getElementById('pag-avulso-nota');
  if (avulEl) avulEl.innerHTML = avulTotal>0
    ? `<i class="fas fa-circle-plus me-1 text-secondary"></i>Além das vendas, entraram <strong>${fmtBRL(avulTotal)}</strong> em <strong>lançamentos avulsos</strong> (ajustes, pix na chave, depósitos) — fora do faturamento de propósito.`
    : '';

  // Sangrias / saídas de caixa (CD='D') no período
  const saidas = (data.sangrias||[]).filter(s=>noFiltro(s.loja, s.data));
  let saidaTotal = 0; const porCat = {};
  for (const s of saidas) { saidaTotal += s.valor; const cat = categoriaSangria(s); porCat[cat] = (porCat[cat]||0) + s.valor; }

  // Contexto do drill-down: os MESMOS dados que a tela acabou de usar (ver `_detCtx`).
  _detCtx.pag = {data, loja, ini, fim, ff, saidas, saidaTotal, porCat, cancN, cancVal};

  document.getElementById('pag-kpis').innerHTML = `
    <div class="col-6 col-md-3"><div class="stat-card h-100" ${detAttr('pag-entrou','Ver por forma, por loja e por dia da semana')}><div class="lbl"><i class="fas fa-sack-dollar me-1 text-success"></i>Entrou (recebido)</div>
      <div class="val">${fmtBRL(total)}</div><div class="lbl">todas as formas</div></div></div>
    <div class="col-6 col-md-3"><div class="stat-card h-100" ${detAttr('pag-saiu','Ver por categoria, por loja e quem mais recebeu')}><div class="lbl"><i class="fas fa-money-bill-transfer me-1 text-danger"></i>Saiu do caixa</div>
      <div class="val">${fmtBRL(saidaTotal)}</div><div class="lbl">sangrias / despesas</div></div></div>
    <div class="col-6 col-md-3"><div class="stat-card h-100" ${detAttr('pag-cancel','Ver por loja e os dias com mais cancelamento')}><div class="lbl"><i class="fas fa-calendar-xmark me-1"></i>Vendas canceladas</div>
      <div class="val">${cancN}</div><div class="lbl">${fmtBRL(cancVal)}</div></div></div>
    <div class="col-6 col-md-3"><div class="stat-card h-100" ${detAttr('pag-corr','Ver quais dias você corrigiu')}><div class="lbl"><i class="fas fa-pen me-1"></i>Corrigidos à mão</div>
      <div class="val ${nCorr?'text-warning':''}">${nCorr}</div><div class="lbl">no período</div></div></div>`;

  const ordem = PAG_FORMAS.filter(f=>porForma[f]!=null).concat(Object.keys(porForma).filter(f=>!PAG_FORMAS.includes(f)));
  const linhas = ordem.map(f=>{
    const v = porForma[f]||0, pct = total>0 ? v/total*100 : 0;
    const at = `class="det-linha" role="button" tabindex="0" title="Ver ${esc(PAG_LABEL[f]||f)} por loja e por dia"`
      + ` onclick="abrirDetalhe('pag-forma:${argJS(f)}')"`
      + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirDetalhe('pag-forma:${argJS(f)}');}"`;
    return `<tr ${at}><td><span class="d-inline-block rounded-circle me-1" style="width:10px;height:10px;background:${PAG_COR[f]||'#95a5a6'}"></span>${esc(PAG_LABEL[f]||f)}</td><td class="text-end">${fmtBRL(v)}</td><td class="text-end">${pct.toFixed(1)}%</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="text-center text-muted py-3">Sem pagamentos no período.</td></tr>';
  document.getElementById('pag-mix-tbody').innerHTML = linhas + (total>0?`<tr class="fw-bold border-top"><td>Total</td><td class="text-end">${fmtBRL(total)}</td><td class="text-end">100%</td></tr>`:'');

  _pagCharts.forEach(c=>c.destroy()); _pagCharts=[];
  if (typeof Chart !== 'undefined' && total>0) {
    const labels = ordem.filter(f=>porForma[f]>0);
    _pagCharts.push(new Chart(document.getElementById('pag-mix-chart'), {
      type:'doughnut',
      data:{labels:labels.map(f=>PAG_LABEL[f]||f), datasets:[{data:labels.map(f=>porForma[f]), backgroundColor:labels.map(f=>PAG_COR[f]||'#95a5a6')}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:11}}}}}
    }));
  }

  // Reconciliação (a conta fechando, DENTRO do próprio caixa): o que foi lançado nas vendas =
  // o que entrou (recebido) + o que foi cancelado. Tudo da mesma fonte (vw_financeiro), então bate exato.
  const brutoLancado = total + cancVal;
  const reconHtml = `
    <div class="d-flex flex-wrap align-items-center gap-3 mb-3 pb-2 border-bottom">
      <div><div class="small text-muted">Vendas lançadas (bruto)</div><div class="fw-bold">${fmtBRL(brutoLancado)}</div></div>
      <div class="text-muted fw-bold">=</div>
      <div><div class="small text-muted"><i class="fas fa-sack-dollar me-1 text-success"></i>Recebido (entrou)</div><div class="fw-bold text-success">${fmtBRL(total)}</div></div>
      <div class="text-muted fw-bold">+</div>
      <div><div class="small text-muted"><i class="fas fa-calendar-xmark me-1 text-danger"></i>Canceladas</div><div class="fw-bold text-danger">${fmtBRL(cancVal)}${cancN?` · ${cancN}`:''}</div></div>
      <div class="small text-muted ms-auto" style="max-width:280px">A conta fecha dentro do próprio caixa: o que foi lançado, menos o cancelado, é exatamente o que entrou.</div>
    </div>`;
  document.getElementById('pag-cancel').innerHTML = reconHtml + (Object.keys(cancPorLoja).length
    ? `<div class="row g-3">` + ['PLANALTO','BURITIS','VENDA_NOVA'].filter(l=>cancPorLoja[l]).map(l=>
        `<div class="col-md-4"><div class="d-flex justify-content-between align-items-center"><span class="badge ${LOJA_BADGE[l]}">${LOJA_LABEL[l]}</span><strong>${fmtBRL(cancPorLoja[l])}</strong></div></div>`).join('')
      + `</div><div class="small text-muted mt-2">Vendas lançadas e depois canceladas no TOTEM — não entram no faturamento real acima.</div>`
    : '<div class="text-success py-2"><i class="fas fa-check-circle me-1"></i>Nenhuma venda cancelada no período.</div>');

  // Sangrias: resumo por categoria + detalhe (cada lançamento)
  const catOrdem = SANGRIA_CATS.filter(c=>porCat[c]!=null).concat(Object.keys(porCat).filter(c=>!SANGRIA_CATS.includes(c)));
  document.getElementById('pag-saida-resumo').innerHTML = saidaTotal>0
    ? `<div class="row g-2">` + catOrdem.map(c=>{
        const v=porCat[c]||0, pct=saidaTotal>0?v/saidaTotal*100:0;
        return `<div class="col-6 col-md"><div class="border rounded p-2 h-100" ${detAttr('pag-cat:'+c, 'Ver '+c+' por loja e por descrição')}><div class="small text-muted"><span class="d-inline-block rounded-circle me-1" style="width:9px;height:9px;background:${SAIDA_COR[c]||'#b0875a'}"></span>${esc(c)}</div><div class="fw-bold">${fmtBRL(v)}</div><div class="small text-muted">${pct.toFixed(1)}%</div></div></div>`;
      }).join('') + `<div class="col-6 col-md"><div class="border rounded p-2 h-100 bg-light"><div class="small text-muted">Total saídas</div><div class="fw-bold">${fmtBRL(saidaTotal)}</div><div class="small text-muted">100%</div></div></div></div>`
    : '<div class="text-success"><i class="fas fa-check-circle me-1"></i>Sem saídas de caixa no período.</div>';

  const det = saidas.slice().sort((a,b)=> b.data.localeCompare(a.data) || b.valor-a.valor);
  const tetoSaidas = modoLeveCelular() ? 120 : PAG_SAIDA_MAX;   // celular: lista menor = rolagem fluida
  const mostra = det.slice(0, tetoSaidas);
  document.getElementById('pag-saida-tbody').innerHTML = mostra.length
    ? mostra.map(s=>{ const cat=categoriaSangria(s); return `<tr><td class="text-nowrap">${fmtDate(s.data)}</td><td><span class="badge ${LOJA_BADGE[s.loja]||''}">${LOJA_LABEL[s.loja]||s.loja}</span></td>`+
        `<td class="text-nowrap"><span class="d-inline-block rounded-circle me-1" style="width:9px;height:9px;background:${SAIDA_COR[cat]||'#b0875a'}"></span>${esc(cat)}</td>`+
        `<td>${esc(s.descricao||'—')}</td><td class="text-muted text-nowrap">${esc(s.forma)}</td><td class="text-end">${fmtBRL(s.valor)}</td></tr>`; }).join('')
    : '<tr><td colspan="6" class="text-center text-muted py-3">Sem saídas de caixa no período.</td></tr>';
  document.getElementById('pag-saida-nota').innerHTML = det.length>tetoSaidas
    ? `Mostrando os <strong>${tetoSaidas}</strong> lançamentos mais recentes de <strong>${det.length}</strong> no período (o total acima considera todos). Diminua o período para ver a lista completa.`
    : `${det.length} lançamento(s) no período.`;

  // Acertos de fechamento de caixa (reclassificação entre formas — não é venda nem despesa)
  let acEnt = 0, acSai = 0;
  for (const a of (data.acertos||[])) { if (noFiltro(a.loja, a.data)) { acEnt += a.entrada; acSai += a.saida; } }
  const acEl = document.getElementById('pag-acertos');
  if (acEl) acEl.innerHTML = (acEnt || acSai)
    ? `<div class="d-flex gap-4 flex-wrap">
         <div><span class="text-muted small">Entrou (ajuste)</span><div class="fw-bold">${fmtBRL(acEnt)}</div></div>
         <div><span class="text-muted small">Saiu (ajuste)</span><div class="fw-bold">${fmtBRL(acSai)}</div></div>
         <div><span class="text-muted small">Líquido</span><div class="fw-bold ${(acEnt-acSai)<0?'text-danger':'text-success'}">${fmtBRL(acEnt-acSai)}</div></div>
       </div>
       <div class="small text-muted mt-2">No fechamento, o operador corrige a forma de pagamento (ex.: lançou como crédito, era pix) — <strong>tira de uma forma e põe em outra</strong>, e acerta centavos. Mexe pouco no total; serve pra <strong>bater o caixa</strong>, não é gasto. Por isso ficou fora das sangrias.</div>`
    : '<div class="text-muted small">Nenhum acerto de fechamento no período.</div>';

  // Compras de funcionário (forma "Compra Funcionário") — nome + produtos + valor
  const cf = (data.compra_funcionario||[]).filter(c=>noFiltro(c.loja, c.data)).sort((a,b)=>b.data.localeCompare(a.data));
  const cfTotal = cf.reduce((s,c)=>s+c.valor, 0);
  const cfEl = document.getElementById('pag-compfunc');
  if (cfEl) cfEl.innerHTML = cf.length
    ? `<div class="table-responsive" style="max-height:360px;overflow:auto">
         <table class="table table-sm table-hover mb-0 align-middle">
           <thead class="table-light" style="position:sticky;top:0;z-index:1"><tr><th>Dia</th><th>Loja</th><th>Funcionário</th><th>Produtos</th><th class="text-end">Valor</th></tr></thead>
           <tbody>${cf.slice(0,300).map(c=>`<tr><td class="text-nowrap">${fmtDate(c.data)}</td><td><span class="badge ${LOJA_BADGE[c.loja]||''}">${LOJA_LABEL[c.loja]||c.loja}</span></td><td class="text-nowrap">${esc(c.nome||'—')}</td><td class="small">${esc(c.produtos||'—')}</td><td class="text-end">${fmtBRL(c.valor)}</td></tr>`).join('')}
           <tr class="fw-bold border-top"><td colspan="4">Total — ${cf.length} compra(s)</td><td class="text-end">${fmtBRL(cfTotal)}</td></tr></tbody>
         </table></div>`
    : '<div class="text-muted small">Nenhuma compra de funcionário no período.</div>';

  renderDescontos(data, loja, ini, fim);
}

// ===== DESCONTOS — do cardápio ao caixa (06/08/2026) =====================================
// FONTE ÚNICA do número de desconto. Vem do bloco `descontos` do pagamentos_resumo.json
// (loja × dia × canal: `bruto` = preço de cardápio + taxa, `pago` = o que entrou no caixa).
// Nenhuma tela refaz esta conta — quem precisar de desconto chama ISTO.
//
// Por que DOIS grupos e não uma lista só: são perdas de naturezas diferentes.
//  · 99Food  → a plataforma decide. MEDIDO: o valor que o TOTEM registra como recebido da 99 já é
//    LÍQUIDO (bate 89–101% com o depósito real no banco em 90 dias), logo a diferença cardápio→caixa
//    soma PROMOÇÃO + COMISSÃO e o TOTEM não separa as duas. Por isso o app diz "diferença", nunca
//    "desconto" puro — decisão do Gabriel em 06/08/2026.
//  · Loja    → alguém digitou. Exato, pequeno e auditável.
// 'Outros' (JANTA, consumo interno com meia pizza a R$ 0) fica FORA: apareceria como desconto de 100%.
function descontosPeriodo(pagData, loja, ini, fim) {
  const vazio = {tem:false, g99:null, gLoja:null, porLoja:{}, porDia:{}};
  if (!pagData || !Array.isArray(pagData.descontos)) return vazio;
  const zero = () => ({bruto:0, pago:0, pedidos:0, comDesc:0});
  const g99 = zero(), gLoja = zero(), porLoja = {}, porDia = {};
  for (const r of pagData.descontos) {
    if (loja && r.loja !== loja) continue;
    if (r.data < ini || r.data > fim) continue;
    if (!CANAIS_REAIS.includes(r.canal)) continue;              // JANTA/Outros fora
    const eh99 = r.canal === '99Food';
    for (const alvo of [eh99 ? g99 : gLoja,
                        (porLoja[r.loja] = porLoja[r.loja] || {g99:zero(), gLoja:zero()})[eh99?'g99':'gLoja'],
                        (porDia[r.data] = porDia[r.data] || {g99:zero(), gLoja:zero()})[eh99?'g99':'gLoja']]) {
      alvo.bruto += r.bruto; alvo.pago += r.pago;
      alvo.pedidos += r.pedidos; alvo.comDesc += (r.com_desconto||0);
    }
  }
  const dif = g => { g.dif = g.bruto - g.pago; g.pct = g.bruto > 0 ? g.dif/g.bruto*100 : 0; return g; };
  Object.values(porLoja).forEach(p => { dif(p.g99); dif(p.gLoja); });
  Object.values(porDia).forEach(p  => { dif(p.g99); dif(p.gLoja); });
  return {tem: g99.bruto > 0 || gLoja.bruto > 0, g99: dif(g99), gLoja: dif(gLoja), porLoja, porDia};
}

function renderDescontos(pagData, loja, ini, fim) {
  const el = document.getElementById('pag-descontos'); if (!el) return;
  const d = descontosPeriodo(pagData, loja, ini, fim);
  if (!d.tem) {
    // O bloco `descontos` nasceu em 06/08/2026: um arquivo do TOTEM anterior a isso não o tem.
    el.innerHTML = Array.isArray(pagData && pagData.descontos)
      ? '<div class="text-muted small">Sem pedidos no período para comparar cardápio × caixa.</div>'
      : `<div class="dsc-nota">Os descontos aparecem na próxima atualização do TOTEM — ${dicaAtualizarTotem()}.</div>`;
    return;
  }
  const difTotal = d.g99.dif + d.gLoja.dif, brutoTotal = d.g99.bruto + d.gLoja.bruto;
  const pctTotal = brutoTotal > 0 ? difTotal/brutoTotal*100 : 0;

  // Uma régua: largura total = cardápio; trecho cheio = caixa; resto = a diferença.
  const regua = (g, classe) => {
    const pgt = g.bruto > 0 ? Math.max(0, Math.min(100, g.pago/g.bruto*100)) : 100;
    return `<div class="dsc-regua" role="img" aria-label="Do cardápio ao caixa: ${fmtNum(pgt,0)}% chegou">
      <span class="dsc-caixa" style="width:${pgt}%"></span><span class="${classe}" style="width:${100-pgt}%"></span></div>`;
  };
  const linha = (g, cfg) => `
    <div class="dsc-linha dsc-click" role="button" tabindex="0"
         onclick="abrirDetalhe('${cfg.kpi}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirDetalhe('${cfg.kpi}');}">
      <div class="d-flex justify-content-between align-items-baseline flex-wrap gap-2">
        <span class="dsc-eyebrow">${cfg.titulo}</span><span class="dsc-fonte">${cfg.fonte}</span>
      </div>
      ${regua(g, cfg.classe)}
      <div class="d-flex justify-content-between align-items-baseline flex-wrap gap-2">
        <div><span class="dsc-val">${fmtBRL(g.dif)}</span>
          <span class="text-muted small ms-1">de ${fmtBRL(g.bruto)} em cardápio · ${fmtNum(g.pct,1)}%</span></div>
        <span class="text-muted small">${fmtNum(g.comDesc,0)} de ${fmtNum(g.pedidos,0)} pedidos · ver detalhe <i class="fas fa-arrow-right ms-1"></i></span>
      </div>
      <div class="dsc-nota mt-2">${cfg.nota}</div>
    </div>`;

  el.innerHTML = `
    <div class="dsc-hero mb-3">
      <div class="dsc-eyebrow">Não chegou ao caixa · no período</div>
      <div class="dsc-val">${fmtBRL(difTotal)}</div>
      <!-- Só o DENOMINADOR deste bloco. Não repetir aqui "o caixa recebeu X": faturamento tem
           dono (faturamentoFormas, o KPI "Entrou" acima) e dois donos para o mesmo número é
           exatamente como as telas passam a divergir. -->
      <div class="text-muted small">${fmtNum(pctTotal,1)}% de ${fmtBRL(brutoTotal)} em preço de cardápio</div>
    </div>
    ${linha(d.g99, {kpi:'desc99', titulo:'99Food', fonte:'a plataforma decide', classe:'dsc-dif-99',
      nota:'<span class="dsc-marca dsc-dif-99"></span>Hachurado porque <strong>não é uma coisa só</strong>: a promoção que a 99 aplica e a comissão dela vêm somadas. O TOTEM grava apenas o valor final que a 99 credita — conferido contra o depósito no banco — então não dá para separar as duas aqui.'})}
    ${linha(d.gLoja, {kpi:'descloja', titulo:'Loja', fonte:'alguém digitou no pedido', classe:'dsc-dif-loja',
      nota:'<span class="dsc-marca dsc-dif-loja"></span>Desconto dado no balcão ou na entrega própria. Valor <strong>exato</strong>: é a diferença entre o que o pedido somava e o que foi cobrado.'})}`;
}

// ----- Correção manual de um valor (modal) -----
function abrirPagCorrecao() {
  if (typeof bootstrap === 'undefined') { toast('Recarregue a página (com internet) para abrir a janela.','warning'); return; }
  document.getElementById('pc-loja').value = document.getElementById('pag-loja').value || currentLoja;
  if (!document.getElementById('pc-data').value) document.getElementById('pc-data').value = today();
  const anoEl = document.getElementById('pc-mtx-ano'); if (anoEl && !anoEl.dataset.set) { anoEl.value = today().slice(0,4); anoEl.dataset.set='1'; }
  const mtxEl = document.getElementById('pc-mtx'); if (mtxEl) mtxEl.value = '';
  const mtxPrev = document.getElementById('pc-mtx-preview'); if (mtxPrev) mtxPrev.innerHTML = '';
  document.getElementById('pc-preview').innerHTML = '';
  atualizarAvisoPagCorrecao();
  renderPagCorrecaoLista();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('pagCorrecaoModal')).show();
}

// Mostra, p/ comparar, o valor que o TOTEM tem hoje no (loja,data,forma) escolhido.
async function atualizarAvisoPagCorrecao() {
  const host = document.getElementById('pc-aviso'); if (!host) return;
  const lj=document.getElementById('pc-loja').value, dt=document.getElementById('pc-data').value, fm=document.getElementById('pc-forma').value;
  const data = await carregarPagamentos();
  let atual = null;
  if (data && Array.isArray(data.por_dia) && dt) {
    const r = data.por_dia.find(x=>x.loja===lj && x.data===dt && x.forma===fm);
    atual = r ? r.valor : 0;
  }
  const corr = getPagCorrecao()[lj+'|'+dt+'|'+fm];
  host.innerHTML = dt ? `Hoje o TOTEM registra <strong>${atual!=null?fmtBRL(atual):'—'}</strong> nesse dia/forma.` + (corr!=null?` Sua correção atual: <strong class="text-warning">${fmtBRL(corr)}</strong>.`:'') : '';
}

function salvarPagCorrecao() {
  const lj=document.getElementById('pc-loja').value, dt=document.getElementById('pc-data').value, fm=document.getElementById('pc-forma').value;
  const v = parseValorBR(document.getElementById('pc-valor').value);
  const prev = document.getElementById('pc-preview');
  if (!dt) { prev.innerHTML = '<span class="text-danger">Escolha o dia.</span>'; return; }
  if (isNaN(v) || v < 0) { prev.innerHTML = '<span class="text-danger">Valor inválido — use número (ex.: 1.234,56).</span>'; return; }
  const map = {...getPagCorrecao()};
  map[lj+'|'+dt+'|'+fm] = v;
  setPagCorrecao(map);
  document.getElementById('pc-valor').value = '';
  prev.innerHTML = `<span class="text-success"><i class="fas fa-check me-1"></i>Correção salva: ${LOJA_LABEL[lj]} · ${fmtDate(dt)} · ${PAG_LABEL[fm]||fm} = ${fmtBRL(v)}.</span>`;
  renderPagCorrecaoLista();
  atualizarAvisoPagCorrecao();
  atualizarTelasFinanceiras();
  toast('Correção lançada.','success');
}

function removerPagCorrecao(key) {
  const map = {...getPagCorrecao()};
  delete map[key];
  setPagCorrecao(map);
  renderPagCorrecaoLista();
  atualizarAvisoPagCorrecao();
  atualizarTelasFinanceiras();
}

// Reconhece a forma de pagamento escrita à mão (sinônimos) → chave canônica do mapa.
function parseFormaPag(s) {
  const t = (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if (!t) return null;
  if (/DINHEIRO|ESPECIE/.test(t)) return 'DINHEIRO';
  if (/DEBITO/.test(t)) return 'DEBITO';
  if (/CREDITO/.test(t)) return 'CREDITO';
  if (/QR/.test(t)) return 'PIX QR CODE';
  if (/CHAVE/.test(t)) return 'PIX CHAVE';
  if (/ONLINE|APP|99/.test(t)) return 'ONLINE APP';
  if (/PIX/.test(t)) return 'PIX QR CODE';   // "pix" genérico → QR
  if (/OUTRO/.test(t)) return 'Outros';
  return null;
}

// Importa uma lista colada (uma linha = DATA FORMA VALOR) p/ a camada de correção.
function importarPagCorrecao() {
  const loja = document.getElementById('pc-loja').value;
  const txt = document.getElementById('pc-bulk').value || '';
  const linhas = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const prev = document.getElementById('pc-bulk-preview');
  if (!linhas.length) { prev.innerHTML = '<span class="text-danger">Cole a lista primeiro.</span>'; return; }
  const map = {...getPagCorrecao()};
  let ok = 0; const erros = [];
  for (const ln of linhas) {
    // separado por TAB/; (colado do Excel) ou, senão, por espaços. NUNCA por vírgula (é decimal).
    let toks = ln.split(/[\t;]+/).map(x=>x.trim()).filter(Boolean);
    if (toks.length < 3) toks = ln.split(/\s+/);
    if (toks.length < 3) { erros.push(ln); continue; }
    const dataISO = parseDataFlex(toks[0]);
    const valor = parseValorBR(toks[toks.length-1]);
    const forma = parseFormaPag(toks.slice(1, toks.length-1).join(' '));
    if (!dataISO || !forma || isNaN(valor) || valor < 0) { erros.push(ln); continue; }
    map[loja+'|'+dataISO+'|'+forma] = valor;
    ok++;
  }
  setPagCorrecao(map);
  let msg = `<span class="text-success"><i class="fas fa-check me-1"></i>${ok} correção(ões) aplicada(s) para ${LOJA_LABEL[loja]}.</span>`;
  if (erros.length) msg += `<div class="text-danger mt-1">${erros.length} linha(s) não entendida(s) (ignoradas): <span class="font-monospace">${erros.slice(0,3).map(esc).join(' | ')}${erros.length>3?'…':''}</span></div>`;
  prev.innerHTML = msg;
  if (ok) document.getElementById('pc-bulk').value = '';
  renderPagCorrecaoLista();
  atualizarAvisoPagCorrecao();
  atualizarTelasFinanceiras();
  if (ok) toast(`${ok} correção(ões) lançada(s).`,'success');
}

// Importa a TABELA MENSAL colada do CONTROLE CAIXA: 1ª linha = cabeçalho (formas de pagamento; a 1ª
// célula é a coluna de datas), demais linhas = 1 dia cada (data + um valor por forma). Substitui o dia
// inteiro pelos valores da planilha (a soma das formas é o faturamento oficial). Loja = a selecionada.
function importarPagMatriz() {
  const loja = document.getElementById('pc-loja').value;
  const ano = parseInt(document.getElementById('pc-mtx-ano').value, 10);
  const txt = document.getElementById('pc-mtx').value || '';
  const prev = document.getElementById('pc-mtx-preview');
  const linhas = txt.split(/\r?\n/).filter(l=>l.trim());
  if (linhas.length < 2) { prev.innerHTML = '<span class="text-danger">Cole a tabela com o cabeçalho e pelo menos um dia.</span>'; return; }
  if (!ano || ano < 2000 || ano > 2100) { prev.innerHTML = '<span class="text-danger">Informe o ano (ex.: 2026).</span>'; return; }
  // TAB (colado do Excel); senão 2+ espaços ou ';'. NUNCA por vírgula/1 espaço (é decimal / "R$ 933,50").
  const split = l => l.includes('\t') ? l.split('\t') : l.split(/ {2,}|;/);
  // Cabeçalho: coluna 0 é a data; as demais viram forma canônica via parseFormaPag.
  const head = split(linhas[0]).map(x=>x.trim());
  const formaCol = head.map((h,i)=> i===0 ? null : parseFormaPag(h));
  const formasOk = formaCol.filter(Boolean);
  if (!formasOk.length) { prev.innerHTML = '<span class="text-danger">Não reconheci as formas no cabeçalho. Ele deve ter Débito, Crédito, Dinheiro, Pix qr, Pix chave e/ou 99 food.</span>'; return; }
  const naoRecon = head.map((h,i)=> (i>0 && !formaCol[i] && h) ? h : null).filter(Boolean);
  const map = {...getPagCorrecao()};
  let nDias=0, nVal=0; const erros=[];
  for (let r=1;r<linhas.length;r++){
    const cels = split(linhas[r]);
    const dtxt = (cels[0]||'').trim();
    const mdd = dtxt.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
    let dataISO=null;
    if (mdd) { const dd=mdd[1].padStart(2,'0'), mm=mdd[2].padStart(2,'0'); let yy=mdd[3]?parseInt(mdd[3],10):ano; if(yy<100)yy+=2000; dataISO=`${yy}-${mm}-${dd}`; }
    else dataISO = parseDataFlex(dtxt);
    if (!dataISO) { if (dtxt) erros.push(linhas[r]); continue; }
    let algum=false;
    for (let i=1;i<cels.length;i++){
      const forma = formaCol[i]; if (!forma) continue;
      const limpo = String(cels[i]==null?'':cels[i]).replace(/r\$/i,'').replace(/\s/g,'');
      if (limpo==='') continue;              // célula vazia → não mexe no dia/forma
      const v = (limpo==='-') ? 0 : parseValorBR(cels[i]);   // "R$ -" do CONTROLE CAIXA = zero
      if (isNaN(v) || v<0) continue;
      map[loja+'|'+dataISO+'|'+forma] = v;
      nVal++; algum=true;
    }
    if (algum) nDias++;
  }
  setPagCorrecao(map);
  let msg = `<span class="text-success"><i class="fas fa-check me-1"></i><strong>${nDias}</strong> dia(s) e <strong>${nVal}</strong> valor(es) importados para ${LOJA_LABEL[loja]} — formas: ${[...new Set(formasOk)].map(f=>PAG_LABEL[f]||f).join(', ')}.</span>`;
  if (naoRecon.length) msg += `<div class="text-muted mt-1">Colunas ignoradas (não são forma de pagamento): <span class="font-monospace">${naoRecon.map(esc).join(', ')}</span>.</div>`;
  if (erros.length) msg += `<div class="text-danger mt-1">${erros.length} linha(s) sem data válida (ignoradas): <span class="font-monospace">${erros.slice(0,2).map(esc).join(' | ')}${erros.length>2?'…':''}</span></div>`;
  prev.innerHTML = msg;
  if (nDias) {
    document.getElementById('pc-mtx').value='';
    renderPagCorrecaoLista();
    atualizarAvisoPagCorrecao();
    atualizarTelasFinanceiras();
    toast(`${nDias} dia(s) do CONTROLE CAIXA importados.`,'success');
  }
}

function renderPagCorrecaoLista() {
  const host = document.getElementById('pc-lista'); if (!host) return;
  const map = getPagCorrecao();
  const keys = Object.keys(map).sort();
  if (!keys.length) { host.innerHTML = '<div class="text-muted small">Nenhuma correção lançada ainda.</div>'; return; }
  let html = '<div style="max-height:220px;overflow:auto"><table class="table table-sm mb-0 align-middle"><thead class="table-light"><tr><th>Loja</th><th>Dia</th><th>Forma</th><th class="text-end">Valor</th><th></th></tr></thead><tbody>';
  for (const k of keys) {
    const [lj,dt,fm] = k.split('|');
    html += `<tr><td><span class="badge ${LOJA_BADGE[lj]||''}">${LOJA_LABEL[lj]||lj}</span></td><td>${fmtDate(dt)}</td><td>${esc(PAG_LABEL[fm]||fm)}</td><td class="text-end">${fmtBRL(map[k])}</td>`+
      `<td class="text-end"><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removerPagCorrecao('${argJS(k)}')" title="Remover esta correção"><i class="fas fa-trash"></i></button></td></tr>`;
  }
  html += '</tbody></table></div>';
  host.innerHTML = html;
}

// Navegação do CEO por modos de análise: uma decisão por tela, sem rolagem de relatório infinito.
let _ceoCapAtiva='ceo-cap1';
function ceoSetCap(id, levarAoTopo=true) {
  const cont=document.getElementById('ceo-conteudo'); if(!cont)return;
  _ceoCapAtiva=id||'ceo-cap1'; cont.classList.add('ceo-tabs-ready');
  cont.querySelectorAll('.ceo-cap').forEach(el=>el.classList.toggle('active',el.id===_ceoCapAtiva));
  cont.querySelectorAll('.ceo-nav a').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+_ceoCapAtiva));
  if(levarAoTopo){const nav=cont.querySelector('.ceo-nav');if(nav)nav.scrollIntoView({behavior:'auto',block:'nearest'});}
}
function ceoNavGo(ev, id) {
  if (ev) ev.preventDefault();
  ceoSetCap(id);
}
function ceoToggleDreGrupo(grupo, botao) {
  const linhas=document.querySelectorAll(`[data-dre-group="${grupo}"]`);
  const abrir=!botao.classList.contains('open'); botao.classList.toggle('open',abrir);
  linhas.forEach(el=>el.classList.toggle('open',abrir));
}
function ceoQuick(dias, atualizar=true) {
  const iniEl = document.getElementById('ceo-ini'), fimEl = document.getElementById('ceo-fim');
  if (!dias) { iniEl.value=''; fimEl.value=''; }
  else { fimEl.value = today(); const d = new Date(); d.setDate(d.getDate()-dias); iniEl.value = dataLocalISO(d); }
  if (atualizar) renderCEO();
}

async function renderCEO() {   // serializa chamadas concorrentes (evita conflito de canvas)
  if (_ceoBusy) { _ceoPending = true; return; }
  _ceoBusy = true;
  try { do { _ceoPending = false; await _renderCEOImpl(); } while (_ceoPending); }
  finally { _ceoBusy = false; }
}

async function _renderCEOImpl() {
  const iniEl = document.getElementById('ceo-ini');
  popularSelMeses('ceo-mes');
  if (!iniEl.dataset.iniciado) {   // 1ª abertura: mês corrente inteiro (pedido do Gabriel — análise MENSAL)
    iniEl.dataset.iniciado='1';
    const {ini, fim} = limitesDoMes(today().slice(0,7));
    iniEl.value = ini; document.getElementById('ceo-fim').value = fim;
  }

  const data = await carregarCEO();
  const vazio = document.getElementById('ceo-vazio'), cont = document.getElementById('ceo-conteudo');
  if (!data) { _ceoCharts.forEach(c=>c.destroy()); _ceoCharts=[]; vazio.classList.remove('d-none'); cont.classList.add('d-none'); return; }
  vazio.classList.add('d-none'); cont.classList.remove('d-none'); cont.classList.remove('ceo-tabs-ready');

  const lojaSel = document.getElementById('ceo-loja').value;
  const ini = document.getElementById('ceo-ini').value, fim = document.getElementById('ceo-fim').value;
  const rows = data.por_dia.filter(r => (!lojaSel||r.loja===lojaSel) && (!ini||r.data>=ini) && (!fim||r.data<=fim));

  // Proporção por canal vem dos PEDIDOS (vw_pedidos), SÓ dos canais reais (Balcão/Entrega própria/99Food);
  // "Outros" (JANTA e afins) fica de fora, como o Gabriel pediu. O faturamento em si NÃO sai daqui.
  let pedidos=0, taxa=0; const canalPed={};   // canalPed[c] = {pedidos, fatPed}; fatPed = base pedidos, só p/ proporção
  for (const r of rows) {
    if (!CANAIS_REAIS.includes(r.canal)) continue;
    pedidos += r.pedidos; taxa += r.taxa;
    const c = canalPed[r.canal] = canalPed[r.canal] || {pedidos:0, fatPed:0};
    c.pedidos += r.pedidos; c.fatPed += r.faturamento;
  }

  // FATURAMENTO OFICIAL = soma das FORMAS DE PAGAMENTO (o que entrou), fonte única = aba Pagamentos.
  // Cancelada não entra (não vira pagamento). 99Food = parcela "Online/App" (repasse).
  const pag = await carregarPagamentos();
  const ff = faturamentoFormas(pag, lojaSel, ini, fim);
  const semFormas = !ff.temDados;   // sem pagamentos_resumo.json (celular sem snapshot) → fallback p/ pedidos
  let fat, porDia, v99;
  if (semFormas) {
    const repasse99 = repasseEfetivo(data.repasse_99);
    fat=0; porDia={}; v99=0;
    for (const r of rows) {
      if (!CANAIS_REAIS.includes(r.canal)) continue;
      let fn;
      if (r.canal==='99Food'){ const real=repasse99[r.loja+'|'+r.data]; fn = real!=null?real:r.faturamento*(FATOR_99[r.loja]||FATOR_99._default); v99+=fn; }
      else fn=r.faturamento;
      fat+=fn; porDia[r.data]=(porDia[r.data]||0)+fn;
    }
  } else { fat=ff.total; porDia=ff.porDia; v99=ff.v99; }
  const dow=[0,0,0,0,0,0,0];
  for (const dt in porDia) dow[new Date(dt+'T00:00:00').getDay()] += porDia[dt];

  // Valor por canal p/ rosca/tabela: 99Food = parcela real das formas (ONLINE APP); o restante do
  // faturamento (cartão+dinheiro+pix) é rateado entre Balcão e Entrega própria pela proporção dos pedidos.
  const vNon99 = Math.max(fat - v99, 0);
  const balcaoPed = (canalPed['Balcao']&&canalPed['Balcao'].fatPed)||0;
  const entregaPed = (canalPed['Entrega propria']&&canalPed['Entrega propria'].fatPed)||0;
  const shareBalcao = (balcaoPed+entregaPed)>0 ? balcaoPed/(balcaoPed+entregaPed) : (balcaoPed?1:0);
  const canal = {
    'Balcao': {pedidos:(canalPed['Balcao']&&canalPed['Balcao'].pedidos)||0, fat: vNon99*shareBalcao},
    'Entrega propria': {pedidos:(canalPed['Entrega propria']&&canalPed['Entrega propria'].pedidos)||0, fat: vNon99*(1-shareBalcao)},
    '99Food': {pedidos:(canalPed['99Food']&&canalPed['99Food'].pedidos)||0, fat: v99},
  };

  const ticket = pedidos ? fat/pedidos : 0;
  // Clientes novos no período (canal próprio, com cadastro) — mesmo dado da página Clientes.
  let cliNovos = null; const cliNovosLoja = {};
  try {
    const cliData = await carregarClientes();
    if (cliData && cliData.lojas) {
      cliNovos = 0;
      for (const lj of (lojaSel?[lojaSel]:LOJAS_ATIVAS())) {
        const nd = cliData.lojas[lj] && cliData.lojas[lj].novos_dia; if (!nd) continue;
        for (const dt in nd) if ((!ini||dt>=ini) && (!fim||dt<=fim)) { cliNovos += nd[dt]; cliNovosLoja[lj]=(cliNovosLoja[lj]||0)+nd[dt]; }
      }
    }
  } catch(e) { cliNovos = null; }
  // CMV: prioriza o REAL por INVENTÁRIO (motor de Divergências: contagens + compras ± transferências),
  // e já traz o ESPERADO (ficha) e o DESPERDÍCIO (real − esperado). Sem 2 contagens cercando o período,
  // cai no estimado por ficha (rotulado como estimativa) e não há desperdício a mostrar.
  const lojasCeo = lojaSel ? [lojaSel] : LOJAS_ATIVAS();
  const cmvInv = await cmvCeoInventario(lojasCeo, ini, fim);
  const cmvInventario = cmvInv.ok;
  // CMV TOTAL do período = real coberto pelas contagens + estimativa por ficha dos dias sem cobertura.
  const cmv = cmvInventario ? (cmvInv.real + cmvInv.estimadoFora) : await cmvPeriodoCEO(lojaSel, ini, fim);
  // DOIS esperados: (a) NA JANELA das contagens — base da VARIAÇÃO/desperdício (comparável ao real, ao centavo);
  // (b) DO PERÍODO filtrado (pizzas do mês × ficha) — comparável mês a mês, INDEPENDE de contagem. O card usa (b).
  const cmvEspJanela = cmvInventario ? cmvInv.esperado : cmv;
  const cmvEsperado = cmvInventario ? await cmvPeriodoCEO(lojaSel, ini, fim) : cmv;
  const espItensPeriodo = cmvInventario ? await cmvPeriodoCEOItens(lojaSel, ini, fim) : [];
  const variacaoLiq = cmvInventario ? cmvInv.variacao : 0;   // = cmvInv.real − cmvInv.esperado NA JANELA (ao centavo)
  const perdaBruta = cmvInventario ? cmvInv.perdaBruta : 0;  // só perdas (sobras não abatem)
  const margem = fat - cmv, margemPct = fat ? margem/fat*100 : 0;
  const cmvPct = fat ? cmv/fat*100 : 0;          // CMV total como % do faturamento
  const cmvEspPct = fat ? cmvEsperado/fat*100 : 0;
  // Pizzas vendidas (pizzas-equivalentes por prefixo SKU), SÓ dos canais reais (fora JANTA/Outros).
  let pizzasPeriodo = 0; const pizzasCanal = {}, pizzasLoja = {};
  for (const r of (data.pizzas_canal||[])) {
    if ((lojaSel&&r.loja!==lojaSel)||(ini&&r.data<ini)||(fim&&r.data>fim)) continue;
    if (!CANAIS_REAIS.includes(r.canal)) continue;
    pizzasPeriodo += r.pizzas;
    pizzasCanal[r.canal] = (pizzasCanal[r.canal]||0) + r.pizzas;
    pizzasLoja[r.loja]  = (pizzasLoja[r.loja]||0)  + r.pizzas;
  }
  _ceoCharts.forEach(c=>c.destroy()); _ceoCharts=[];   // todos os awaits feitos → seguro recriar

  // KPIs (com tooltip explicando o cálculo de cada número — passar o mouse)
  const card = (icon,cor,val,lbl,sub,tip,tipo) => `<div class="col-6 col-lg-2"><div class="stat-card h-100 text-center${tipo?' kpi-card':''}"${tipo?` role="button" tabindex="0" onclick="abrirKpi('${tipo}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirKpi('${tipo}');}"`:''}${tip?` title="${esc(tip)}"`:''}>
      <div class="text-${cor} mb-1"><i class="fas ${icon} fa-lg"></i></div>
      <div class="fs-4 fw-bold">${val}</div><div class="small text-muted">${lbl}</div>
      ${sub?`<div class="small text-muted">${sub}</div>`:''}
      ${tipo?'<div class="kpi-more small mt-1">ver detalhe <i class="fas fa-arrow-right"></i></div>':''}</div></div>`;
  // Ícone + cor (nunca só cor): quem não distingue verde de vermelho lê o status pela FORMA.
  const STATUS_CHIP = {
    fechado:  '<span class="badge bg-success"><i class="fas fa-circle-check me-1"></i>Fechado</span>',
    parcial:  '<span class="badge bg-warning text-dark"><i class="fas fa-circle-half-stroke me-1"></i>Parcial</span>',
    bloqueado:'<span class="badge bg-danger"><i class="fas fa-triangle-exclamation me-1"></i>Bloqueado</span>',
  };
  const cmvLbl = cmvInventario ? 'CMV real (inventário)' : 'CMV (estimativa por ficha)';
  const cmvSub = cmvInventario
    ? `<strong>${fmtNum(cmvPct,1)}%</strong> da receita · ${fmtNum(cmvInv.cobertura*100,0)}% coberto por contagem · ${STATUS_CHIP[cmvInv.status]||''}`
    : (fat ? `<strong>${fmtNum(cmvPct,1)}% da receita</strong> · estimado` : 'estimado');
  const cmvTip = cmvInventario
    ? 'CMV REAL (inventário) = consumo medido pelas contagens (inicial + compras ± transferências − final) × preço pago, na janela entre contagens; dias do período fora da janela entram como estimativa por ficha (mostrados no DRE). VARIAÇÃO LÍQUIDA = CMV real − CMV esperado (sobra abate perda). PERDA BRUTA = só as perdas (sobra NÃO abate). Consumo negativo é FURO: fica fora das somas e bloqueia o fechamento.'
    : 'CMV ESTIMADO (nenhuma loja tem janela de contagens utilizável no período): pizzas que saíram × ficha, ao preço pago, sem bebidas. Faça contagens para ver o CMV REAL, a variação líquida e a perda bruta.';
  document.getElementById('ceo-kpis').innerHTML = '';
  document.getElementById('ceo-kpis-secundarios').innerHTML = '';
  // Contexto do drill-down dos KPIs (o modal lê daqui — sem recalcular nada)
  _kpiCtx = { ini, fim, lojaSel, fat, ff, semFormas, ticket, pedidos, canalPed,
              cmv, cmvEsperado, cmvEspJanela, espItensPeriodo, cmvPct, cmvEspPct, cmvInventario,
              cmvInv: cmvInventario ? cmvInv : null,
              pizzasPeriodo, pizzasCanal, pizzasLoja, cliNovos, cliNovosLoja };
  const obsTxt = semFormas
    ? `Faturamento em <strong>modo pedidos</strong> (as Formas de Pagamento não carregaram — ${dicaAtualizarTotem()}). A 99Food entra pelo repasse lançado ou por fator estimado.`
    : 'Faturamento = <strong>soma das formas de pagamento</strong> (o mesmo número da aba Pagamentos; venda cancelada não entra). A <strong>99Food</strong> entra pelo valor de "Online/App" (repasse) — cole o <strong>CONTROLE CAIXA</strong> em Pagamentos → Corrigir para deixar exato. <strong>Balcão × Entrega própria</strong> são rateados pela proporção dos pedidos.';
  document.getElementById('ceo-obs').innerHTML = `
    <details class="ceo-como">
      <summary style="cursor:pointer"><i class="fas fa-circle-question me-1"></i>Como cada número é calculado <span class="text-muted">(toque para abrir)</span></summary>
      <ul class="mt-2 mb-2 ps-3">
        <li><strong>Faturamento</strong> — soma das <strong>formas de pagamento</strong> (o que entrou no caixa/banco). Venda cancelada não entra. A 99Food entra pelo valor de "Online/App" (repasse). Mesmo número da aba Pagamentos.</li>
        <li><strong>Ticket médio</strong> — faturamento ÷ nº de pedidos (só Balcão, Entrega própria e 99Food; JANTA fica de fora).</li>
        <li><strong>CMV real (inventário)</strong> — consumo medido pelas contagens (<strong>inicial + compras ± transferências − final</strong>) × preço pago, na <strong>janela entre contagens</strong>; dias do período fora da janela entram como <em>estimativa por ficha</em> (linha própria no DRE, com % de cobertura). Bebidas ficam fora. <strong>Consumo negativo = furo</strong> (erro de contagem/compra): fica FORA das somas e <strong>bloqueia o fechamento</strong>.</li>
        <li><strong>Variação líquida</strong> — CMV real − CMV esperado (ficha), mesma janela e mesmos insumos: <strong>bate ao centavo</strong>. Sobras abatem perdas (pode ser negativa). <strong>Perda bruta</strong> — só a soma das perdas (sobra NÃO abate); é o "desperdício" da aba Estoque &amp; CMV.</li>
        <li><strong>Pizzas vendidas</strong> — pizzas-equivalentes (inteira/premium = 1; meia = 0,5). Não conta combos, 2 sabores, pizza do dia, JANTA nem compra de funcionário.</li>
      </ul>
      <div>${obsTxt}</div>
    </details>`;

  // ---- LEITURA EXECUTIVA: o que mudou vs o período ANTERIOR (mesmo tamanho, logo antes) ----
  // É o que distingue o CEO do Dashboard: aqui a página LÊ os dados e conta a história (o "por quê"
  // do movimento), em vez de só mostrar o número do período. Compara faturamento, ticket, margem
  // (CMV%), canal e loja com o período imediatamente anterior de igual duração.
  let leituraHtml = '';
  // Guarda o comparativo do período anterior para os CARTÕES (o delta no próprio KPI dá contexto que
  // número solto não dá). É preenchido aqui dentro e só lido lá embaixo — nenhuma conta a mais.
  let deltaPeriodo = null;
  const dIni = ini && new Date(ini+'T00:00:00'), dFim = fim && new Date(fim+'T00:00:00');
  if (!semFormas && dIni && dFim) {
    const nDias = Math.round((dFim-dIni)/86400000)+1;
    const prevFimD = new Date(dIni.getTime()-86400000), prevIniD = new Date(prevFimD.getTime()-(nDias-1)*86400000);
    const prevIni = dataLocalISO(prevIniD), prevFim = dataLocalISO(prevFimD);
    const ffPrev = faturamentoFormas(pag, lojaSel, prevIni, prevFim);
    const fatPrev = ffPrev.total;
    if (fatPrev > 0) {
      let pedPrev=0; const cPrevPed={};
      for (const r of data.por_dia) {
        if ((lojaSel&&r.loja!==lojaSel)||r.data<prevIni||r.data>prevFim||!CANAIS_REAIS.includes(r.canal)) continue;
        pedPrev += r.pedidos; (cPrevPed[r.canal]=cPrevPed[r.canal]||{f:0}).f += r.faturamento;
      }
      const v99P = ffPrev.v99, vN99P = Math.max(fatPrev-v99P,0);
      const bP=(cPrevPed['Balcao']||{}).f||0, eP=(cPrevPed['Entrega propria']||{}).f||0;
      const shBP=(bP+eP)>0?bP/(bP+eP):(bP?1:0);
      const canalPrev={'Balcao':vN99P*shBP,'Entrega propria':vN99P*(1-shBP),'99Food':v99P};
      const ticketPrev = pedPrev? fatPrev/pedPrev : 0;
      const cmvInvPrev = await cmvCeoInventario(lojasCeo, prevIni, prevFim);
      const cmvPrev = cmvInvPrev.ok ? (cmvInvPrev.real + cmvInvPrev.estimadoFora) : await cmvPeriodoCEO(lojaSel, prevIni, prevFim);
      const cmvPctPrev = fatPrev? cmvPrev/fatPrev*100 : 0;
      const cmvComparavel = cmvInventario === cmvInvPrev.ok;   // só compara CMV% se os 2 períodos usam o mesmo método
      deltaPeriodo = {fatPrev, ticketPrev, cmvPctPrev, cmvComparavel, prevIni, prevFim};

      const vpct = (c,p)=> p>0 ? (c-p)/p*100 : null;
      const seta = up => up ? '<i class="fas fa-arrow-trend-up text-success me-1"></i>' : '<i class="fas fa-arrow-trend-down text-danger me-1"></i>';
      const items = [];
      const vFat = vpct(fat, fatPrev);
      items.push(`${seta(vFat>=0)}<strong>Faturamento ${vFat>=0?'subiu':'caiu'} ${fmtNum(Math.abs(vFat),1)}%</strong> — ${fmtBRL(fatPrev)} → <strong>${fmtBRL(fat)}</strong>.`);
      const vTk = vpct(ticket, ticketPrev);
      if (vTk!==null && Math.abs(vTk)>=1.5) items.push(`${seta(vTk>=0)}Ticket médio ${vTk>=0?'subiu':'caiu'} ${fmtNum(Math.abs(vTk),1)}% (${fmtBRL(ticketPrev)} → ${fmtBRL(ticket)}) — cada pedido está deixando ${vTk>=0?'mais':'menos'}.`);
      const dCmv = cmvPct - cmvPctPrev;
      if (cmvComparavel && Math.abs(dCmv)>=0.8) items.push(`${seta(dCmv<=0)}CMV foi de ${fmtNum(cmvPctPrev,1)}% para <strong>${fmtNum(cmvPct,1)}%</strong> da receita — ${dCmv>0?'<strong>margem apertando</strong> (insumo pesando mais em cada venda)':'margem melhorando'}.`);
      let cMove=null; for (const c of CANAIS_REAIS){ const dd=((canal[c]&&canal[c].fat)||0)-(canalPrev[c]||0); if(!cMove||Math.abs(dd)>Math.abs(cMove.d)) cMove={c,d:dd,prev:canalPrev[c]||0,now:(canal[c]&&canal[c].fat)||0}; }
      if (cMove && Math.abs(cMove.d)>=Math.max(fat*0.01,1)) items.push(`${seta(cMove.d>=0)}O canal que mais ${cMove.d>=0?'puxou':'travou'} foi <strong>${CEO_CANAL_LABEL[cMove.c]}</strong> (${fmtBRL(cMove.prev)} → ${fmtBRL(cMove.now)}).`);
      if (!lojaSel) {
        let lMove=null;
        for (const lj of LOJAS_ATIVAS()) {
          const now=faturamentoFormas(pag,lj,ini,fim).total, prev=faturamentoFormas(pag,lj,prevIni,prevFim).total, dd=now-prev;
          if (prev<=0&&now<=0) continue;
          if (!lMove||Math.abs(dd)>Math.abs(lMove.d)) lMove={lj,d:dd,prev,now};
        }
        if (lMove) items.push(`${seta(lMove.d>=0)}Entre as lojas, <strong>${LOJA_LABEL[lMove.lj]}</strong> foi a que mais ${lMove.d>=0?'cresceu':'caiu'} (${fmtBRL(lMove.prev)} → ${fmtBRL(lMove.now)}).`);
      }
      leituraHtml = `
        <div class="card border-0" style="background:var(--massa,#FBF5E9)">
          <div class="card-body py-3">
            <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
              <span class="fs-6"><i class="fas fa-brain text-primary me-1"></i><strong>Leitura executiva</strong></span>
              <span class="text-muted small">o que mudou vs. o período anterior (${fmtDate(prevIni)}–${fmtDate(prevFim)}, mesma duração)</span>
            </div>
            <ul class="mb-0" style="list-style:none;padding-left:0;line-height:1.9">${items.map(t=>`<li>${t}</li>`).join('')}</ul>
          </div>
        </div>`;
    }
  }
  document.getElementById('ceo-leitura').innerHTML = leituraHtml;

  // ============ DRE na ESTRUTURA DO GABRIEL (planilha FECHAMENTO): Receita − CMV − Bebidas − Pessoal
  // − Fixos − Variáveis − Imposto − Royalties = EBITDA; − Empréstimo − Retirada de capital = Lucro.
  // CMV e Bebidas por CONSUMO (estoque = valor agregado → mostra comprado × sobrou × consumiu). Freela e
  // motoboy do TOTEM entram DENTRO de Pessoal. Pró-labore em Pessoal; empréstimo/retirada abaixo da linha.
  const dreMes = (fim||today()).slice(0,7);
  const cf = dreCustosTotal(dreMes, lojaSel);
  const sang = sangriasDRE(pag, lojaSel, ini, fim);
  const sangTot = sang.total, custoFixoTot = cf.total, cfFixoTot = cf.natFixo, cfVarTot = cf.natVar;
  const pctFat = v => fat>0 ? `<span class="text-muted small"> · ${fmtNum(v/fat*100,1)}%</span>` : '';
  // As sangrias do TOTEM viram sub-linhas das categorias do Gabriel (motoboy/freela → Pessoal; resto → Variáveis)
  const SANG_TO_CAT = {'Motoboy':'Pessoal','Freelancer Cozinha':'Pessoal','Freelancer Atendimento':'Pessoal','Manutenção':'Variáveis','Outros':'Variáveis'};
  const catManual = {}; for (const it of cf.itens) (catManual[it.grupo]=catManual[it.grupo]||[]).push(it);
  const catSang = {}; for (const [k,v] of Object.entries(sang.porCat)) { const c=SANG_TO_CAT[k]||'Variáveis'; (catSang[c]=catSang[c]||[]).push([k,v]); }
  const catTotal = c => (catManual[c]||[]).reduce((s,x)=>s+x.valor,0) + (catSang[c]||[]).reduce((s,[,v])=>s+v,0);
  const cmvTotal = cmvInventario ? (cmvInv.real + cmvInv.estimadoFora) : cmv;
  const bebTotal = cmvInventario ? cmvInv.bebReal : 0;
  const pesTotal=catTotal('Pessoal'), fixTotal=catTotal('Fixos'), varTotal=catTotal('Variáveis'), impTotal=catTotal('Imposto'), royTotal=catTotal('Royalties');
  const ebitda = fat - cmvTotal - bebTotal - pesTotal - fixTotal - varTotal - impTotal - royTotal;
  const empTotal=catTotal('Empréstimo'), retTotal=catTotal('Retirada de capital');
  const lucro = ebitda - empTotal - retTotal, lucroPct = fat?lucro/fat*100:0;
  // Um CEO precisa saber se o número está pronto para decisão. Ausência de custo não pode parecer lucro.
  const cadFechamento=getCFCad().filter(it=>!lojaSel || (it.loja||'')===lojaSel);
  const resumoFechamento=cfResumoEscopo(dreMes,cadFechamento);
  const custosCompletos=resumoFechamento.esperados>0 && resumoFechamento.pct===100;
  const inventarioConfiavel=cmvInventario && cmvInv.status!=='bloqueado';
  const semMovimento=fat<=0 && pedidos<=0;
  const resultadoProvisorio=semMovimento || semFormas || !custosCompletos || !inventarioConfiavel;
  const resultadoLabel=resultadoProvisorio?'RESULTADO PROVISÓRIO':(lucro>=0?'LUCRO':'PREJUÍZO');
  const statusMotivos=[];
  if(semMovimento)statusMotivos.push('sem vendas no período');
  if(semFormas)statusMotivos.push('formas de pagamento não carregadas');
  if(!custosCompletos)statusMotivos.push(resumoFechamento.esperados?`${resumoFechamento.esperados-resumoFechamento.preenchidos} custo(s) sem valor`:'nenhum custo cadastrado para o escopo');
  if(!inventarioConfiavel)statusMotivos.push(cmvInventario?'inventário bloqueado por furos':'CMV estimado, sem janela de contagens');
  document.getElementById('ceo-status').innerHTML=`<div class="ceo-status-bar ${resultadoProvisorio?'':'ok'}"><div><div class="ceo-status-title"><i class="fas ${resultadoProvisorio?'fa-clock text-warning':'fa-circle-check text-success'} me-1"></i>${resultadoProvisorio?'Fechamento em andamento':'Fechamento pronto para decisão'}</div><div class="ceo-status-meta">${resultadoProvisorio?statusMotivos.join(' · '):'Receita, estoque e custos conferidos para o período.'}</div></div><button class="btn btn-sm btn-outline-secondary" onclick="ceoSetCap('ceo-cap2')">Ver DRE</button></div>`;
  // Delta vs. o período anterior DENTRO do cartão: "um número isolado vale pouco sem contexto".
  // Lê o que a leitura executiva já calculou (deltaPeriodo) — nenhuma conta nova, nenhuma fonte nova.
  const chipDelta=(dif,unidade,bomSeCai)=>{
    if(dif==null||!isFinite(dif))return '';
    const bom=bomSeCai?dif<=0:dif>=0;
    return `<div class="kpi-delta ${bom?'up':'down'}"><i class="fas fa-arrow-${dif>=0?'up':'down'}"></i>${dif>=0?'+':'−'}${fmtNum(Math.abs(dif),1)}${unidade} vs. período anterior</div>`;
  };
  const dFat = (deltaPeriodo&&deltaPeriodo.fatPrev>0) ? (fat-deltaPeriodo.fatPrev)/deltaPeriodo.fatPrev*100 : null;
  const dCmvPP = (deltaPeriodo&&deltaPeriodo.cmvComparavel) ? cmvPct-deltaPeriodo.cmvPctPrev : null;   // pontos percentuais
  const kpiPrincipal=(icon,label,value,context,tipo,classe='',delta='')=>`<div class="col-md-4"><div class="card h-100 ceo-kpi-primary ${classe} ${tipo?'kpi-card':''}" ${tipo?`role="button" tabindex="0" onclick="abrirKpi('${tipo}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirKpi('${tipo}');}"`:''}><div class="card-body"><div class="kpi-label"><i class="fas ${icon} me-1"></i>${label}</div><div class="kpi-value">${value}</div><div class="kpi-context">${context}</div>${delta}</div></div></div>`;
  document.getElementById('ceo-kpis').innerHTML=
    kpiPrincipal('fa-scale-balanced',resultadoLabel,fmtBRL(lucro),`${fmtNum(lucroPct,1)}% da receita · depois de operação e itens abaixo da linha`,null,resultadoProvisorio?'':'result-ok')+
    kpiPrincipal('fa-sack-dollar','Faturamento',fmtBRL(fat),semFormas?'base de pedidos — validar pagamentos':'soma das formas de pagamento','fat','',chipDelta(dFat,'%',false))+
    kpiPrincipal('fa-basket-shopping',cmvLbl,fmtBRL(cmv),cmvSub,'cmvreal',cmvInventario&&cmvInv.status==='bloqueado'?'result-alert':'',chipDelta(dCmvPP,' p.p.',true));
  // Faixa secundária: mesma linguagem de clique dos cartões — e operável por teclado (Enter/Espaço).
  const itemSec=(tipo,v,l)=>`<div class="ceo-secondary-item" role="button" tabindex="0" onclick="abrirKpi('${tipo}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();abrirKpi('${tipo}');}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  document.getElementById('ceo-kpis-secundarios').innerHTML=
    itemSec('ticket',fmtBRL(ticket),`Ticket médio · ${fmtNum(pedidos,0)} pedidos`)+
    itemSec('pizzas',fmtNum(pizzasPeriodo,0),`Pizzas vendidas · ${pedidos?fmtNum(pizzasPeriodo/Math.max(pedidos,1),2):'—'} por pedido`)+
    itemSec('clientes',cliNovos!=null?fmtNum(cliNovos,0):'—','Clientes novos · canal próprio');
  const prio=[];
  if(!custosCompletos)prio.push({e:'Fechamento',t:resumoFechamento.esperados?`Completar ${resumoFechamento.esperados-resumoFechamento.preenchidos} custo(s)`:'Cadastrar custos deste escopo',c:'Sem isso, lucro e comparação mensal permanecem provisórios.',a:`showPage('custosfixos');cfSetView('lancamentos')`});
  if(cmvInventario&&cmvInv.furos)prio.push({e:'Estoque',t:`Resolver ${cmvInv.furos} furo(s)`,c:'O consumo negativo foi excluído e bloqueia a confiança do CMV.',a:`showPage('painel')`});
  if(fat>0&&cmvPct>35)prio.push({e:'Margem',t:`CMV em ${fmtNum(cmvPct,1)}%`,c:'Revise insumos, desperdício e fichas com maior impacto.',a:`ceoSetCap('ceo-cap2')`});
  const {abertos:empPend}=emprestimosAberto();
  if(empPend.length)prio.push({e:'Caixa',t:`${empPend.length} empréstimo(s) em aberto`,c:'Acompanhe prazo e saldo por loja; não misture com despesa.',a:`showPage('custosfixos');cfSetView('emprestimos')`});
  if(!prio.length)prio.push({e:'Decisão',t:'Fechamento sem bloqueios',c:'Use o DRE e o planejamento para escolher a próxima alavanca.',a:`ceoSetCap('ceo-cap2')`});
  document.getElementById('ceo-prioridades').innerHTML=`<div class="d-flex justify-content-between align-items-end mb-2"><div><h6 class="mb-0">Prioridades do CEO</h6><div class="small text-muted">ações que mudam decisão — não apenas números para observar</div></div></div><div class="ceo-action-grid">${prio.slice(0,3).map(p=>`<div class="ceo-action" role="button" tabindex="0" onclick="${p.a}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${p.a}}"><div class="eyebrow">${p.e}</div><div class="title">${p.t}</div><div class="copy">${p.c} <i class="fas fa-arrow-right ms-1"></i></div></div>`).join('')}</div>`;
  // compat p/ cascata / saúde (o ponto de equilíbrio usa ebitda+cfFixoTot). `margem` já existe acima.
  const resultado = lucro, resultadoPct = lucroPct;
  const mesLbl = fim ? (MES_ABREV[parseInt(fim.slice(5,7),10)-1]+'/'+fim.slice(2,4)) : 'atual';

  const linhaGasto = (nome, val, auto, grupo) => `<tr class="dre-detail" data-dre-group="${grupo}"><td class="ps-4 small" style="border:0">${esc(nome)}${auto?' <span class="dre-totem">TOTEM</span>':''}</td><td class="text-end small text-danger" style="border:0">− ${fmtBRL(val)}</td></tr>`;
  const catBloco = (c, icon) => {
    const tot = catTotal(c); const linhas=[...(catManual[c]||[])].sort((a,b)=>b.valor-a.valor).map(it=>[it.nome,it.valor,false])
      .concat([...(catSang[c]||[])].sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,v,true]));
    if (!linhas.length) return '';
    const chave='g'+getDREGrupos().indexOf(c);
    return `<tr class="dre-cat"><td><button type="button" class="dre-group-toggle" onclick="ceoToggleDreGrupo('${chave}',this)"><span class="chev">›</span><i class="fas ${icon} me-2 text-muted"></i>${c} <span class="small text-muted fw-normal">${linhas.length} item(ns)</span></button></td><td class="text-end fw-semibold text-danger">− ${fmtBRL(tot)}${pctFat(tot)}</td></tr>${linhas.map(([n,v,a])=>linhaGasto(n,v,a,chave)).join('')}`;
  };
  // CMV/Bebidas por consumo, com comprado × estoque × consumido
  const cmvNota = cmvInventario ? (() => {
    const comprado=cmvInv.insComprado, consumido=cmvInv.real, estoque=comprado-consumido;
    return `<tr><td class="ps-4 small text-muted" style="border:0">comprei ${fmtBRL(comprado)} · ${estoque>=0?'sobrou em estoque':'tirei do estoque'} <strong>${fmtBRL(Math.abs(estoque))}</strong> · consumi ${fmtBRL(consumido)}${cmvInv.estimadoFora>0.005?` · +${fmtBRL(cmvInv.estimadoFora)} estimado nos dias sem contagem`:''}</td><td style="border:0"></td></tr>
      <tr><td class="ps-4 small text-muted" style="border:0">vs ficha na janela ${fmtBRL(cmvEspJanela)} → variação <strong class="${variacaoLiq>0?'text-danger':'text-success'}">${variacaoLiq>=0?'+':'−'} ${fmtBRL(Math.abs(variacaoLiq))}</strong> · perda ${fmtBRL(perdaBruta)}${cmvInv.furos?` · <span class="text-danger">${cmvInv.furos} furo(s)</span>`:''}</td><td style="border:0"></td></tr>`;
  })() : `<tr><td class="ps-4 small text-muted" style="border:0">estimativa por ficha (sem contagens no período)</td><td style="border:0"></td></tr>`;
  const bebNota = (cmvInventario && cmvInv.bebComprado>0.005) ?
    `<tr><td class="ps-4 small text-muted" style="border:0">comprei ${fmtBRL(cmvInv.bebComprado)} · sobrou ${fmtBRL(cmvInv.bebComprado-bebTotal)} · consumi ${fmtBRL(bebTotal)}</td><td style="border:0"></td></tr>` : '';
  const dreEditar = `<div class="p-2 border-top"><button class="btn btn-sm btn-outline-secondary" onclick="showPage('custosfixos'); const s=document.getElementById('cf-mes'); if(s){ s.value='${dreMes}'; document.getElementById('cf-loja').value='${lojaSel||'*'}'; renderCustosFixos(); }"><i class="fas fa-pen me-1"></i>Lançar / editar custos</button>${custoFixoTot===0?'<span class="text-muted small ms-2">você ainda não lançou os custos do banco deste mês</span>':''}</div>`;
  // Empréstimos entre lojas EM ABERTO — memo (movimento de caixa, não entra no resultado)
  const {porLoja:empLoja} = emprestimosAberto();
  const empAbertos = getEmprestimos().filter(e=>!e.quitado && (!lojaSel || e.origem===lojaSel || e.destino===lojaSel));
  const empMemoHtml = empAbertos.length ? `
    <div class="card mt-2" style="border-color:var(--queijo)">
      <div class="card-header py-2" style="background:rgba(231,165,43,.12)"><i class="fas fa-right-left me-1"></i><strong>Entre lojas — em aberto</strong>
        <span class="text-muted small">movimento de caixa; NÃO entra no resultado acima</span></div>
      <div class="card-body p-0"><table class="table table-sm mb-0"><tbody>
        ${empAbertos.map(e=>`<tr><td>${fmtDate(e.data)} · ${LOJA_LABEL[e.origem]||e.origem} → <strong>${LOJA_LABEL[e.destino]||e.destino}</strong></td><td class="text-end">${fmtBRL(e.valor)}</td></tr>`).join('')}
        ${lojaSel?`<tr class="fw-bold table-light"><td>Saldo de ${LOJA_LABEL[lojaSel]||lojaSel}</td><td class="text-end ${(empLoja[lojaSel]||0)>=0?'text-success':'text-danger'}">${(empLoja[lojaSel]||0)>=0?'+':'−'} ${fmtBRL(Math.abs(empLoja[lojaSel]||0))} ${(empLoja[lojaSel]||0)>=0?'a receber':'a pagar'}</td></tr>`:''}
      </tbody></table></div></div>` : '';
  document.getElementById('ceo-dre').innerHTML = `
    <div class="card">
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap">
        <span><i class="fas fa-file-invoice-dollar me-1 text-primary"></i><strong>DRE — ${lojaSel?LOJA_LABEL[lojaSel]:'rede (todas as lojas)'} · ${mesLbl}</strong>
          ${cmvInventario?STATUS_CHIP[cmvInv.status]||'':'<span class="badge bg-secondary">Estimado</span>'}</span>
        <span class="small ${resultadoProvisorio?'text-warning':(lucro>=0?'text-success':'text-danger')} fw-bold">${resultadoLabel} ${fmtBRL(Math.abs(lucro))} · ${fmtNum(Math.abs(lucroPct),1)}%</span>
      </div>
      <div class="card-body p-0">
        <table class="table mb-0 align-middle dre-tbl">
          <tbody>
            <tr class="dre-receita"><td><strong>Receita</strong> <span class="text-muted small">(formas de pagamento)</span></td><td class="text-end fw-bold" style="width:210px">${fmtBRL(fat)}</td></tr>
            <tr class="dre-cat"><td><i class="fas fa-basket-shopping me-2 text-muted"></i>CMV — insumos <span class="text-muted small fw-normal">(consumo)</span></td><td class="text-end fw-semibold text-danger">− ${fmtBRL(cmvTotal)}${pctFat(cmvTotal)}</td></tr>
            ${cmvNota}
            <tr class="dre-cat"><td><i class="fas fa-bottle-water me-2 text-muted"></i>Bebidas <span class="text-muted small fw-normal">(consumo)</span></td><td class="text-end fw-semibold text-danger">− ${fmtBRL(bebTotal)}${pctFat(bebTotal)}</td></tr>
            ${bebNota}
            ${catBloco('Pessoal','fa-users')}
            ${catBloco('Fixos','fa-building')}
            ${catBloco('Variáveis','fa-chart-line')}
            ${catBloco('Imposto','fa-file-invoice-dollar')}
            ${catBloco('Royalties','fa-crown')}
            <tr class="dre-ebitda"><td>= EBITDA <span class="text-muted small fw-normal">(resultado operacional)</span></td><td class="text-end ${ebitda>=0?'text-success':'text-danger'}">${fmtBRL(ebitda)}${pctFat(ebitda)}</td></tr>
            ${empTotal>0.005?`<tr><td class="text-muted">(−) Pagamento de empréstimo <span class="small">(abaixo da linha)</span></td><td class="text-end text-danger">− ${fmtBRL(empTotal)}</td></tr>`:''}
            ${retTotal>0.005?`<tr><td class="text-muted">(−) Retirada de capital dos sócios</td><td class="text-end text-danger">− ${fmtBRL(retTotal)}</td></tr>`:''}
            <tr class="${resultadoProvisorio?'dre-provisorio':'dre-lucro'}"><td>= ${resultadoProvisorio?'Resultado provisório':'Lucro do período'}${resultadoProvisorio?' <span class="small fw-normal">· faltam dados para fechar</span>':''}</td><td class="text-end ${resultadoProvisorio?'':(lucro>=0?'text-success':'text-danger')}">${fmtBRL(lucro)}${pctFat(lucro)}</td></tr>
          </tbody>
        </table>
      </div>
      ${dreEditar}
      <div class="card-footer small text-muted"><i class="fas fa-circle-info me-1"></i>
        <strong>CMV e Bebidas</strong> = o que SAIU do estoque (consumo); estoque parado é valor agregado, não custo. <span class="dre-totem">TOTEM</span> = freela e motoboy vêm do caixa (sangrias). <strong>Empréstimo e retirada</strong> ficam abaixo do EBITDA (não são operação). Status: Fechado/Parcial/Bloqueado conforme cobertura das contagens.</div>
    </div>
    ${empMemoHtml}`;

  // ---- PONTO DE EQUILÍBRIO — o GABRIEL escolhe o que "cresce com a venda" (08/07). Buckets de custo;
  // margem de contribuição = receita − custos marcados como variáveis; equilíbrio = fixos ÷ margem %.
  const bkFreela = (sang.porCat['Freelancer Cozinha']||0)+(sang.porCat['Freelancer Atendimento']||0);
  const bkMotoboy = (sang.porCat['Motoboy']||0);
  const bkSangOutros = (sang.porCat['Outros']||0)+(sang.porCat['Manutenção']||0);
  _beCtx = { fat, ini, fim, buckets: [
    {k:'CMV',lbl:'CMV — insumos',val:cmvTotal},
    {k:'Bebidas',lbl:'Bebidas',val:bebTotal},
    {k:'Freela',lbl:'Freelancers',val:bkFreela},
    {k:'Motoboy',lbl:'Motoboy',val:bkMotoboy},
    {k:'Imposto',lbl:'Simples (imposto)',val:impTotal},
    {k:'Royalties',lbl:'Royalties',val:royTotal},
    {k:'Salarios',lbl:'Salários + pró-labore',val:Math.max(pesTotal-bkFreela-bkMotoboy,0)},
    {k:'Fixos',lbl:'Fixos (aluguel, energia…)',val:fixTotal},
    {k:'VarLista',lbl:'Variáveis (marketing, cartão…)',val:Math.max(varTotal-bkSangOutros,0)},
    {k:'SangOutros',lbl:'Outros do caixa',val:bkSangOutros},
  ].filter(b=>b.val>0.005) };
  renderBE();
  // Simulação de CMV: guarda a base (não muda com o %) e monta o card interativo. cfFixo = fixos do equilíbrio.
  const _beFixNow = _beCtx.buckets.filter(b=>!getBEVar().has(b.k)).reduce((s,b)=>s+b.val,0);
  _simBase = { fat, cmvReal: cmvTotal, cfFixo: _beFixNow,
               custoNaoCmv: bebTotal+pesTotal+fixTotal+varTotal+impTotal+royTotal, // operacionais, sem CMV
               belowLine: empTotal+retTotal,
               espPct: (fat>0 ? cmvEsperado/fat*100 : null) };
  _simPct = null;
  renderSimCMV();

  // Faturamento por canal (rosca + tabela) — só canais com movimento
  const canaisOrd = CEO_CANAIS.filter(c=>canal[c] && (canal[c].fat>0 || canal[c].pedidos>0));
  _ceoCharts.push(new Chart(document.getElementById('ceo-canal-chart'), {
    type:'doughnut', data:{ labels: canaisOrd.map(c=>CEO_CANAL_LABEL[c]),
      datasets:[{data: canaisOrd.map(c=>Math.round(canal[c].fat)), backgroundColor: canaisOrd.map(c=>CEO_CANAL_COR[c])}] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:'bottom', labels:{boxWidth:12, font:{size:11}}},
        tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${fmtBRL(ctx.parsed)}`}}}}
  }));
  document.getElementById('ceo-canal-tbody').innerHTML = canaisOrd.map(c=>{
    const pct = fat ? canal[c].fat/fat*100 : 0;
    return `<tr><td><span class="badge" style="background:${CEO_CANAL_COR[c]}">${CEO_CANAL_LABEL[c]}</span></td>
      <td class="text-end">${fmtNum(canal[c].pedidos,0)}</td><td class="text-end">${fmtBRL(canal[c].fat)}</td>
      <td class="text-end fw-semibold">${fmtNum(pct,1)}%</td></tr>`;
  }).join('');

  // Faturamento por FORMA DE PAGAMENTO (mesma soma das formas do faturamento; 99Food = Online/App).
  const formaData = ff.temDados ? ff.porForma : {};
  const formasOrd = PAG_FORMAS.filter(f=>formaData[f]!=null).concat(Object.keys(formaData).filter(f=>!PAG_FORMAS.includes(f)));
  const formasComValor = formasOrd.filter(f=>formaData[f]>0);
  if (typeof Chart!=='undefined' && formasComValor.length) {
    _ceoCharts.push(new Chart(document.getElementById('ceo-forma-chart'), {
      type:'doughnut', data:{ labels: formasComValor.map(f=>PAG_LABEL[f]||f),
        datasets:[{data: formasComValor.map(f=>Math.round(formaData[f])), backgroundColor: formasComValor.map(f=>PAG_COR[f]||'#95a5a6')}] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{position:'bottom', labels:{boxWidth:12, font:{size:11}}},
          tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${fmtBRL(ctx.parsed)}`}}}}
    }));
  }
  document.getElementById('ceo-forma-tbody').innerHTML = formasOrd.length
    ? formasOrd.map(f=>{
        const v=formaData[f]||0, pc=fat?v/fat*100:0;
        return `<tr><td><span class="d-inline-block rounded-circle me-1" style="width:10px;height:10px;background:${PAG_COR[f]||'#95a5a6'}"></span>${esc(PAG_LABEL[f]||f)}</td><td class="text-end">${fmtBRL(v)}</td><td class="text-end fw-semibold">${fmtNum(pc,1)}%</td></tr>`;
      }).join('')
    : `<tr><td colspan="3" class="text-center text-muted py-2">${semFormas?'Abra pelo atalho p/ ver as formas de pagamento.':'Sem dados no período.'}</td></tr>`;

  // MARGEM POR CANAL: rateia o CMV total por pizzas-equivalentes de cada canal.
  // ---- CASCATA DO DRE (waterfall): cada degrau = uma fatia do dinheiro do mês ----
  // Referência clássica de análise de DRE: receita desce custo a custo até o resultado.
  {
    let run = fat;
    const passos = [{lbl:'Receita', faixa:[0, fat], cor:'#26334D'}];
    const addPasso = (lbl, v) => { if (v>0.005) { passos.push({lbl, faixa:[run-v, run], cor:'#922b21', gasto:v}); run-=v; } };
    addPasso('CMV', cmvTotal);
    addPasso('Bebidas', bebTotal);
    addPasso('Pessoal', pesTotal);
    addPasso('Fixos', fixTotal);
    addPasso('Variáveis', varTotal);
    addPasso('Imposto+Royalties', impTotal+royTotal);
    addPasso('Empréstimo/Retirada', empTotal+retTotal);
    passos.push({lbl:'Lucro', faixa: run>=0?[0,run]:[run,0], cor: run>=0?'#145a32':'#b02a1f'});
    _ceoCharts.push(new Chart(document.getElementById('ceo-cascata-chart'), {
      type:'bar',
      data:{ labels: passos.map(p=>[p.lbl, (p.gasto!=null?'− ':'')+fmtBRL(Math.abs(p.gasto!=null?p.gasto:(p.faixa[1]||p.faixa[0])))]),
        datasets:[{ data: passos.map(p=>p.faixa.map(Math.round)), backgroundColor: passos.map(p=>p.cor),
                    borderRadius:4, borderSkipped:false, barPercentage:.72 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false},
          tooltip:{callbacks:{label:ctx=>{ const p=passos[ctx.dataIndex];
            return p.gasto!=null ? ` ${p.lbl}: − ${fmtBRL(p.gasto)} · sobra ${fmtBRL(p.faixa[0])}` : ` ${p.lbl}: ${fmtBRL(p.faixa[1]||p.faixa[0])}`; }}} },
        scales:{ x:{grid:{display:false}, ticks:{font:{size:11}}},
                 y:{ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}} } }
    }));
  }
  // ---- SAÚDE DO MÊS: onde você está × faixa saudável (benchmarks de pizzaria) ----
  {
    const pesPct = fat ? pesTotal/fat*100 : 0;         // Pessoal já inclui folha+pró-labore+freela/motoboy
    const bebPct = fat ? bebTotal/fat*100 : 0;
    const primePct = cmvPct + bebPct + pesPct;          // prime cost = CMV + bebidas + equipe
    // medidor: barra 0–maxPct com a faixa saudável sombreada e o pino onde você está
    const medidor = (lbl, val, faixaIni, faixaFim, maxPct, obs) => {
      const st = val<=faixaFim ? 'ok' : (val<=faixaFim+5 ? 'aten' : 'ruim');
      const cor = {ok:'#145a32', aten:'#8a6d00', ruim:'#b02a1f'}[st];
      const pin = Math.min(val/maxPct*100, 99);
      return `<div class="sd-item">
        <div class="d-flex justify-content-between align-items-baseline">
          <span class="small">${lbl}</span><strong style="color:${cor};font-variant-numeric:tabular-nums">${fmtNum(val,1)}%</strong></div>
        <div class="sd-bar"><div class="sd-zone" style="left:${faixaIni/maxPct*100}%;width:${(faixaFim-faixaIni)/maxPct*100}%"></div>
          <div class="sd-pin" style="left:${pin}%;background:${cor}"></div></div>
        <div class="small text-muted">${obs}</div></div>`;
    };
    const resTxt = resultado>=0
      ? `<strong class="text-success">${fmtBRL(resultado)}</strong> <span class="text-muted small">(${fmtNum(resultadoPct,1)}% da receita ficou com você)</span>`
      : `<strong class="text-danger">${fmtBRL(resultado)}</strong> <span class="text-muted small">(o mês consumiu ${fmtNum(Math.abs(resultadoPct),1)}% da receita)</span>`;
    // top insumos do CMV (responde "CMV pouco detalhado" direto no painel)
    let topCmv='';
    if (cmvInventario) {
      const its = kpiAgregaItens(cmvInv).filter(i=>i.real>0.005).sort((a,b)=>b.real-a.real).slice(0,5);
      const tot = Math.max(cmvInv.real, 0.01);
      topCmv = `<hr class="my-2"><div class="small text-muted text-uppercase mb-1" style="letter-spacing:.05em">O que pesa no CMV</div>
        ${its.map(i=>`<div class="d-flex align-items-center gap-2 mb-1">
          <span class="small text-truncate" style="width:110px">${esc(i.ing)}</span>
          <div class="sd-mini flex-grow-1"><div style="width:${i.real/tot*100}%"></div></div>
          <span class="small text-muted text-nowrap" style="font-variant-numeric:tabular-nums">${fmtBRL(i.real)} · ${fmtNum(i.real/tot*100,0)}%</span></div>`).join('')}
        <button class="btn btn-sm btn-link p-0 small" onclick="abrirKpi('cmvreal')">ver todos os insumos <i class="fas fa-arrow-right"></i></button>`;
    }
    document.getElementById('ceo-saude').innerHTML =
        medidor('CMV (insumos)', cmvPct, 28, 32, 60, 'faixa saudável: 28–32% da receita')
      + medidor('Equipe (folha + pró-labore + caixa)', pesPct, 25, 30, 60, 'faixa de pizzaria: 25–30%')
      + medidor('Prime cost (CMV + equipe)', primePct, 0, 60, 100, 'o nº 1 de restaurante: manter ATÉ 60%')
      + `<div class="mt-2 pt-2" style="border-top:1px solid var(--crosta)"><span class="small">Resultado do mês:</span> ${resTxt}</div>`
      + topCmv;
  }

  // Faturamento por dia / semana / mês (linha) — granularidade escolhida (item 8)
  const granC = (document.getElementById('ceo-gran')||{}).value || 'dia';
  const porBaldeC = agruparSerie(porDia, granC);
  const dias = Object.keys(porBaldeC).sort();
  _ceoCharts.push(new Chart(document.getElementById('ceo-dia-chart'), {
    type:'line', data:{ labels: dias.map(d=>rotuloGran(d, granC)),
      datasets:[{label:'Faturamento', data: dias.map(d=>Math.round(porBaldeC[d])),
        borderColor:'#1a5276', backgroundColor:'rgba(26,82,118,.12)', fill:true, tension:.3, pointRadius: dias.length>60?0:2}] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:ctx=>fmtBRL(ctx.parsed.y)}}},
      scales:{ x:{ticks:{maxRotation:0, autoSkip:true, maxTicksLimit:12}},
               y:{beginAtZero:true, ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}}}}
  }));

  // Peso de cada dia da semana (% da receita no período)
  const DIASF=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const maxDow = Math.max(...dow);
  _ceoCharts.push(new Chart(document.getElementById('ceo-dow-chart'), {
    type:'bar', data:{ labels: DIASF,
      datasets:[{label:'% receita', data: dow.map(v=>fat?Math.round(v/fat*1000)/10:0),
        backgroundColor: dow.map(v=>v===maxDow&&v>0?'#922b21':'#1a5276'), borderRadius:4}] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:ctx=>ctx.parsed.y+'% da receita'}}},
      scales:{y:{beginAtZero:true, ticks:{callback:v=>v+'%'}}}}
  }));

  // Pedidos por hora (heatmap fixo: últimos 120 dias)
  const hrows = data.heatmap.filter(r=>!lojaSel||r.loja===lojaSel);
  const porHora={};
  for (const r of hrows) porHora[r.hora]=(porHora[r.hora]||0)+r.pedidos;
  const horas = Object.keys(porHora).map(Number).sort((a,b)=>a-b);
  const maxHora = Math.max(...horas.map(h=>porHora[h]), 0);
  _ceoCharts.push(new Chart(document.getElementById('ceo-hora-chart'), {
    type:'bar', data:{ labels: horas.map(h=>String(h).padStart(2,'0')+'h'),
      datasets:[{label:'Pedidos', data: horas.map(h=>porHora[h]),
        backgroundColor: horas.map(h=>porHora[h]===maxHora?'#922b21':'#e67e22'), borderRadius:3}] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}
  }));

  // Destaques automáticos — concretos e acionáveis (a partir dos números já calculados)
  // (O aviso da 99Food foi removido a pedido do Gabriel — jun/2026.)
  const DIASF2=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  let melhorDow=0, piorDow=0;
  for (let i=1;i<7;i++){ if(dow[i]>dow[melhorDow]) melhorDow=i; if(dow[i]<dow[piorDow]) piorDow=i; }
  const picoH = horas.length ? horas.reduce((mx,h)=>porHora[h]>porHora[mx]?h:mx, horas[0]) : null;
  const al=[];
  if (fat>0) al.push(`<i class="fas fa-calendar-star text-primary me-1"></i>Seu dia mais forte é <strong>${DIASF2[melhorDow]}</strong> (${fmtBRL(dow[melhorDow])}, ${Math.round(dow[melhorDow]/fat*100)}% da receita); o mais fraco é <strong>${DIASF2[piorDow]}</strong> (${Math.round(dow[piorDow]/fat*100)}%). Foque equipe e promoções nos dias fortes.`);
  if (fat>0) al.push(`<i class="fas fa-chart-pie text-success me-1"></i>A cada <strong>R$ 100</strong> vendidos sobram <strong>${fmtBRL(margemPct)}</strong> depois dos insumos (margem de contribuição) — antes de aluguel, salários e taxas.`);
  if (picoH!=null) al.push(`<i class="fas fa-clock text-danger me-1"></i>O pico de pedidos é às <strong>${String(picoH).padStart(2,'0')}h</strong>. Deixe forno e entregadores prontos entre ${String(Math.max(picoH-1,0)).padStart(2,'0')}h e ${String((picoH+1)%24).padStart(2,'0')}h.`);
  document.getElementById('ceo-alertas').innerHTML =
    `<div class="alert alert-light border mb-0"><div class="fw-bold mb-1"><i class="fas fa-lightbulb me-1 text-warning"></i>Destaques</div>${al.map(a=>`<div class="small mb-1">${a}</div>`).join('')}</div>`;
  requestAnimationFrame(()=>ceoSetCap(_ceoCapAtiva,false));
}

// ================================================================
//  COMPARATIVO ENTRE LOJAS (benchmark). Reusa pedidos_resumo + clientes_resumo + CMV do app.
// ================================================================
const BN_LOJAS=LOJAS_ATIVAS();
let _bnCharts=[], _bnBusy=false, _bnPending=false;
function bnQuick(dias, atualizar=true){
  const i=document.getElementById('bn-ini'), f=document.getElementById('bn-fim');
  if(!dias){i.value='';f.value='';} else {f.value=today();const d=new Date();d.setDate(d.getDate()-dias);i.value=dataLocalISO(d);}
  if(atualizar) renderBench();
}
async function renderBench(){
  if(_bnBusy){_bnPending=true;return;} _bnBusy=true;
  try{ do{_bnPending=false; await _renderBenchImpl();}while(_bnPending);} finally{_bnBusy=false;}
}
async function _renderBenchImpl(){
  const iniEl=document.getElementById('bn-ini');
  if(!iniEl.dataset.iniciado){iniEl.dataset.iniciado='1'; bnQuick(90,false);}
  const ceo=await carregarCEO(), cli=await carregarClientes();
  const vazio=document.getElementById('bn-vazio'), cont=document.getElementById('bn-conteudo');
  _bnCharts.forEach(c=>c.destroy()); _bnCharts=[];
  if(!ceo){ vazio.classList.remove('d-none'); cont.classList.add('d-none'); return; }
  vazio.classList.add('d-none'); cont.classList.remove('d-none');
  const ini=document.getElementById('bn-ini').value, fim=document.getElementById('bn-fim').value;

  const [vendasAll, comprasAll] = await Promise.all([DB.getAll('vendas'), DB.getAll('compras')]);  // 1x, não 3x
  // FATURAMENTO OFICIAL = soma das formas de pagamento — mesma fonte do CEO/Dashboard/Pagamentos
  // (repontado em jul/2026; antes saía da base de pedidos e o MESMO período dava números diferentes
  // entre CEO e Comparativo). Fallback: sem pagamentos_resumo.json, volta ao modo pedidos + repasse/fator.
  const pag = await carregarPagamentos().catch(()=>null);
  const temFormas = !!(pag && Array.isArray(pag.por_dia));
  const repasse99 = repasseEfetivo(ceo.repasse_99);
  // CMV por loja: MESMO motor do CEO (inventário entre contagens + estimativa por ficha nos dias
  // sem cobertura). Sem início/fim ("Tudo") ou sem janela de contagens, cai na estimativa por ficha.
  const cmvLoja = {}, cmvMetodo = {};
  for (const lj of BN_LOJAS) {
    let cmv = null, metodo = 'ficha';
    if (ini && fim) {
      const inv = await cmvCeoInventario([lj], ini, fim);
      if (inv.ok) { cmv = inv.real + inv.estimadoFora; metodo = 'inventario'; }
    }
    if (cmv === null) {
      const vLj = vendasAll.filter(v=>v.loja===lj && (!ini||v.data_fim>=ini) && (!fim||v.data_inicio<=fim));
      cmv = 0;
      if (vLj.length) { const cons = calcConsumoPeriodo(vLj); for (const [ing,qt] of Object.entries(cons)) cmv += qt*custoAtualIng(ing, comprasAll, lj); }
    }
    cmvLoja[lj] = cmv; cmvMetodo[lj] = metodo;
  }
  const dados={};
  for(const lj of BN_LOJAS){
    let ped=0,fat=0,proprio=0; const diasSet=new Set();
    for(const r of ceo.por_dia){
      if(r.loja!==lj) continue;
      if(ini&&r.data<ini)continue; if(fim&&r.data>fim)continue;
      if(!CANAIS_REAIS.includes(r.canal)) continue;   // JANTA/"Outros" fora — mesma regra do CEO
      let fn;
      if(r.canal==='99Food'){ const real=repasse99[lj+'|'+r.data]; fn = real!=null?real:r.faturamento*(FATOR_99[lj]||FATOR_99._default); }
      else fn=r.faturamento;
      ped+=r.pedidos; fat+=fn; if(r.canal!=='99Food') proprio+=fn; diasSet.add(r.data);
    }
    let nDias=diasSet.size;
    if (temFormas) {   // formas disponíveis → faturamento oficial; 99Food = Online/App (repasse real)
      const ffLj = faturamentoFormas(pag, lj, ini, fim);
      if (ffLj.temDados) { fat = ffLj.total; proprio = Math.max(fat - ffLj.v99, 0); nDias = Object.keys(ffLj.porDia).length || nDias; }
    }
    let pz=0; for(const r of (ceo.pizzas_canal||[])){ if(r.loja!==lj)continue; if(ini&&r.data<ini)continue; if(fim&&r.data>fim)continue; if(!CANAIS_REAIS.includes(r.canal))continue; pz+=r.pizzas; }
    const cmv=cmvLoja[lj];
    const ci=(cli&&cli.lojas&&cli.lojas[lj]&&cli.lojas[lj].resumo)||{};
    const coh=(cli&&cli.lojas&&cli.lojas[lj]&&cli.lojas[lj].cohort)||{};
    let r1s=0,r1n=0; for(const cd of Object.values(coh)){ if(cd.tam>=20 && cd.off && cd.off['1']!=null){ r1s+=cd.off['1']/cd.tam; r1n++; } }
    dados[lj]={ped, fat, pz, fatDia: nDias?fat/nDias:0, ticket:ped?fat/ped:0, pctProprio:fat?proprio/fat*100:0, cmv,
      margem:fat-cmv, margemPct:fat?(fat-cmv)/fat*100:0,
      clientes:ci.clientes||0, ativos:ci.ativos_60d||0, dormentes:ci.dormentes_180d||0,
      retM1: r1n? r1s/r1n*100 : null};
  }

  const METRICS=[
    {k:'fat', label:'Faturamento líquido', fmt:fmtBRL, best:'max'},
    {k:'fatDia', label:'Faturamento por dia', fmt:fmtBRL, best:'max'},
    {k:'ped', label:'Pedidos', fmt:v=>fmtNum(v,0), best:'max'},
    {k:'pz', label:'Pizzas vendidas', fmt:v=>fmtNum(Math.round(v),0), best:'max'},
    {k:'ticket', label:'Ticket médio', fmt:fmtBRL, best:'max'},
    {k:'pctProprio', label:'% no canal próprio', fmt:v=>fmtNum(v,0)+'%', best:'max'},
    {k:'cmv', label:'CMV (insumos)', fmt:fmtBRL, best:'min'},
    {k:'margem', label:'Margem de contribuição', fmt:fmtBRL, best:'max'},
    {k:'margemPct', label:'Margem %', fmt:v=>fmtNum(v,1)+'%', best:'max'},
    {k:'clientes', label:'Clientes alcançáveis', fmt:v=>fmtNum(v,0), best:'max'},
    {k:'ativos', label:'Ativos (60 dias)', fmt:v=>fmtNum(v,0), best:'max'},
    {k:'dormentes', label:'Dormentes (180+ dias)', fmt:v=>fmtNum(v,0), best:'min'},
    {k:'retM1', label:'Retenção mês seguinte', fmt:v=>v==null?'—':fmtNum(v,0)+'%', best:'max'},
  ];
  let h='<thead class="table-light"><tr><th class="text-start">Métrica</th>'+BN_LOJAS.map(l=>`<th>${LOJA_LABEL[l]}</th>`).join('')+'</tr></thead><tbody>';
  for(const m of METRICS){
    const vals=BN_LOJAS.map(l=>dados[l][m.k]);
    const validos=vals.filter(v=>v!=null);
    const best = validos.length ? (m.best==='max'?Math.max(...validos):Math.min(...validos)) : null;
    h+=`<tr><td class="text-start fw-semibold">${m.label}</td>`+BN_LOJAS.map((l,idx)=>{
      const v=vals[idx]; const isBest = v!=null && best!=null && v===best && validos.length>1;
      return `<td class="${isBest?'fw-bold text-success':''}">${m.fmt(v)}</td>`;
    }).join('')+'</tr>';
  }
  document.getElementById('bn-table').innerHTML=h+'</tbody>';
  const elMet = document.getElementById('bn-metodo');
  if (elMet) elMet.innerHTML = `<i class="fas fa-circle-info me-1"></i>Faturamento ${temFormas
    ? '= <strong>soma das formas de pagamento</strong> (mesmo número do Painel do CEO e da aba Pagamentos; 99Food pelo repasse Online/App)'
    : `em modo pedidos (as formas de pagamento não carregaram — ${dicaAtualizarTotem()})`}
    · CMV: ${BN_LOJAS.map(l=>`${LOJA_LABEL[l]} ${cmvMetodo[l]==='inventario'?'<strong>inventário</strong> (contagens)':'estimado por ficha'}`).join(' · ')}.`;

  // Placar: quantas métricas cada loja lidera
  const wins={BURITIS:0,PLANALTO:0,VENDA_NOVA:0};
  for(const m of METRICS){
    const vals=BN_LOJAS.map(l=>dados[l][m.k]); const validos=vals.filter(v=>v!=null);
    if(validos.length<2) continue;
    const best = m.best==='max'?Math.max(...validos):Math.min(...validos);
    BN_LOJAS.forEach((l,i)=>{ if(vals[i]!=null && vals[i]===best) wins[l]++; });
  }
  const maxWins=Math.max(...BN_LOJAS.map(l=>wins[l]));
  const CORES_LOJA = LOJA_COR;   // fonte única: cadastro de lojas
  document.getElementById('bn-resumo').innerHTML = BN_LOJAS.map(l=>{
    const lider = wins[l]===maxWins && maxWins>0;
    return `<div class="col-md-4"><div class="card h-100 ${lider?'border-success border-2':''}"><div class="card-body text-center py-3">
      <span class="badge ${LOJA_BADGE[l]} mb-2">${LOJA_LABEL[l]}</span>
      <div class="fs-3 fw-bold" style="color:${CORES_LOJA[l]}">${wins[l]}<span class="fs-6 text-muted fw-normal">/${METRICS.length}</span></div>
      <div class="small text-muted">métricas em 1º lugar${lider?' <span class="text-success fw-semibold">· líder</span>':''}</div>
    </div></div></div>`;
  }).join('');

  _bnCharts.push(new Chart(document.getElementById('bn-fat-chart'),{type:'bar',
    data:{labels:BN_LOJAS.map(l=>LOJA_LABEL[l]), datasets:[{data:BN_LOJAS.map(l=>Math.round(dados[l].fat)), backgroundColor:BN_LOJAS.map(l=>CORES_LOJA[l]), borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>fmtBRL(ctx.parsed.y)}}},scales:{y:{beginAtZero:true,ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}}}}}));
  _bnCharts.push(new Chart(document.getElementById('bn-marg-chart'),{type:'bar',
    data:{labels:BN_LOJAS.map(l=>LOJA_LABEL[l]), datasets:[{data:BN_LOJAS.map(l=>Math.round(dados[l].margemPct*10)/10), backgroundColor:BN_LOJAS.map(l=>CORES_LOJA[l]), borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.parsed.y+'%'}}},scales:{y:{beginAtZero:true,ticks:{callback:v=>v+'%'}}}}}));
}

// ================================================================
//  ENGENHARIA DE CARDÁPIO (popularidade × margem por pizza). Margem = preço de
//  catálogo (vlvenda, via pedidos_resumo.json) − custo de ingrediente (ficha × preço pago).
// ================================================================
const ME_QUAD = {
  estrela: {label:'⭐ Estrela',            cor:'#1e8449', acao:'vende muito + margem alta — destaque e proteja'},
  cavalo:  {label:'🐴 Cavalo de batalha',  cor:'#2e86c1', acao:'vende muito + margem baixa — repreçar/baixar custo'},
  quebra:  {label:'❓ Quebra-cabeça',       cor:'#e67e22', acao:'margem alta + vende pouco — promova/destaque'},
  abacaxi: {label:'🍍 Abacaxi',            cor:'#922b21', acao:'pouco + pouco lucrativo — revisar ou cortar'},
};
let _meChart = null, _meBusy = false, _mePending = false;

async function renderMenu() {   // serializa (evita conflito de canvas)
  if (_meBusy) { _mePending = true; return; }
  _meBusy = true;
  try { do { _mePending = false; await _renderMenuImpl(); } while (_mePending); }
  finally { _meBusy = false; }
}

function meQuick(dias, atualizar=true) {
  const i=document.getElementById('me-ini'), f=document.getElementById('me-fim');
  if (!dias) { i.value=''; f.value=''; } else { f.value=today(); const d=new Date(); d.setDate(d.getDate()-dias); i.value=dataLocalISO(d); }
  if (atualizar) renderMenu();
}

// Custo de ingrediente de 1 pizza inteira de um sabor (ficha + massa), a preço mais recente.
function custoPizzaFicha(ficha, compras, loja) {
  // Mesma conta da custoFichaSabor (ingredientes + massa + caixa), trocando só a função de
  // preço pelo "preço atual" (compra mais recente). Era uma segunda cópia da conta — unificado
  // em jul/2026 para não existirem dois custos de pizza por ficha no app.
  const r = custoFichaSabor(ficha, ing => custoAtualIng(ing, compras, loja));
  return r ? r.custo : 0;
}

async function _renderMenuImpl() {
  const iniEl=document.getElementById('me-ini');
  if (!iniEl.dataset.iniciado) { iniEl.dataset.iniciado='1'; meQuick(90,false); }
  const ceo = await carregarCEO();
  const precos = (ceo && ceo.precos) || {};
  const vazio=document.getElementById('me-vazio'), cont=document.getElementById('me-conteudo');
  if (_meChart) { _meChart.destroy(); _meChart=null; }
  if (!Object.keys(precos).length) { vazio.classList.remove('d-none'); cont.classList.add('d-none'); return; }
  vazio.classList.add('d-none'); cont.classList.remove('d-none');

  const lojaSel=document.getElementById('me-loja').value;
  const ini=document.getElementById('me-ini').value, fim=document.getElementById('me-fim').value;
  const lojas = lojaSel?[lojaSel]:LOJAS_ATIVAS();
  const [vendas, compras] = await Promise.all([DB.getAll('vendas'), DB.getAll('compras')]);

  // Por sabor: pizzas-equivalentes (popularidade) + PREÇO MÉDIO REAL DE VENDA.
  // O preço vem do que foi REALMENTE vendido no período (preço de catálogo do SKU vendido),
  // ponderado pelas vendas — assim um sabor vendido como normal (R$28) e premium (R$49,90)
  // reflete a mistura real, em vez de pegar o 1º preço que aparecer (gerava outlier de margem).
  // preço/pizza-equivalente = Σ(preço_sku × qtde) ÷ Σ(fator × qtde).
  const units={}, rev={}, eqPriced={};
  for (const v of vendas) {
    if (!lojas.includes(v.loja)) continue;
    if (ini && v.data_fim<ini) continue;
    if (fim && v.data_inicio>fim) continue;
    for (const it of (v.itens||[])) {
      const m=resolverMap(it); if (!m || !['MEIA','INTEIRA','PREMIUM'].includes(m.categoria) || !m.nome_ficha) continue;
      const eq = it.qtde*(m.fator_consumo||1);
      units[m.nome_ficha]=(units[m.nome_ficha]||0)+eq;
      // preço só das INTEIRAS/PREMIUM (a "meia premium" no TOTEM custa igual à inteira → dividir por 0,5 inflaria)
      const p = (it.sku!=null && m.categoria!=='MEIA') ? precos[it.sku] : null;
      if (p>0) { rev[m.nome_ficha]=(rev[m.nome_ficha]||0)+p*it.qtde; eqPriced[m.nome_ficha]=(eqPriced[m.nome_ficha]||0)+it.qtde; }
    }
  }

  const custoLoja = lojaSel || null;
  let totalUnits=0; for (const f in units) totalUnits+=units[f];
  const itens=[];
  for (const ficha in units) {
    const preco = eqPriced[ficha]>0 ? rev[ficha]/eqPriced[ficha] : 0;
    if (!(preco>0)) continue;                                     // sem preço de venda no período → fora
    const custo=custoPizzaFicha(ficha, compras, custoLoja);
    if (!(custo>0)) continue;                                     // sem ficha/custo (Dogão/Fini) → fora
    itens.push({ficha, units:units[ficha], preco, custo, margem:preco-custo, margemPct:preco?(preco-custo)/preco*100:0, pop:totalUnits?units[ficha]/totalUnits*100:0});
  }
  if (!itens.length) {
    document.getElementById('me-leg').innerHTML='';
    document.getElementById('me-tbody').innerHTML='<tr><td colspan="6" class="text-center text-muted py-4">Sem sabores com preço de venda e ficha no período.</td></tr>';
    document.getElementById('me-obs').textContent=''; document.getElementById('me-obs2').textContent=''; return;
  }
  const N=itens.length, popTh=(100/N)*0.7;
  const _ms=itens.map(i=>i.margem).sort((a,b)=>a-b);
  const margTh=_ms[Math.floor(N/2)];   // mediana da margem (robusta às premium que distorcem a média)
  for (const i of itens) { const hp=i.pop>=popTh, hm=i.margem>=margTh; i.quad = hp&&hm?'estrela':hp&&!hm?'cavalo':!hp&&hm?'quebra':'abacaxi'; }

  // Mapa (scatter) por quadrante
  const quads=['estrela','cavalo','quebra','abacaxi'];
  _meChart=new Chart(document.getElementById('me-scatter'), {type:'scatter',
    data:{datasets:quads.map(q=>({label:ME_QUAD[q].label,
      data:itens.filter(i=>i.quad===q).map(i=>({x:Math.round(i.pop*100)/100, y:Math.round(i.margem*100)/100, ficha:i.ficha, units:Math.round(i.units)})),
      backgroundColor:ME_QUAD[q].cor, pointRadius:6, pointHoverRadius:9}))},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:10}}},
        tooltip:{callbacks:{label:ctx=>`${ctx.raw.ficha}: ${ctx.raw.units} un · margem ${fmtBRL(ctx.raw.y)} · ${ctx.raw.x}% das vendas`}}},
      scales:{x:{title:{display:true,text:'Popularidade (% das vendas)'},beginAtZero:true},
              y:{title:{display:true,text:'Margem por pizza (R$)'}}}}
  });

  // Tabela por quadrante
  const ordQuad={estrela:0,cavalo:1,quebra:2,abacaxi:3};
  itens.sort((a,b)=> ordQuad[a.quad]-ordQuad[b.quad] || b.units-a.units);
  document.getElementById('me-tbody').innerHTML=itens.map(i=>
    `<tr><td>${esc(i.ficha)}</td><td class="text-end">${fmtNum(Math.round(i.units),0)}</td>
     <td class="text-end text-muted">${fmtBRL(i.preco)}</td>
     <td class="text-end ${i.margem<0?'text-danger':''}">${fmtBRL(i.margem)}</td>
     <td class="text-end ${i.margem<0?'text-danger':'text-muted'}">${fmtNum(i.margemPct,0)}%</td>
     <td><span class="badge" style="background:${ME_QUAD[i.quad].cor}">${ME_QUAD[i.quad].label}</span></td></tr>`).join('');

  document.getElementById('me-leg').innerHTML=quads.map(q=>{
    const n=itens.filter(i=>i.quad===q).length;
    return `<div class="col-6 col-lg-3"><div class="stat-card h-100 text-center py-2">
      <div class="fw-bold" style="color:${ME_QUAD[q].cor}">${ME_QUAD[q].label}</div>
      <div class="small text-muted">${n} sabores · ${ME_QUAD[q].acao}</div></div></div>`;
  }).join('');
  document.getElementById('me-obs').innerHTML=`<i class="fas fa-circle-info me-1"></i>Margem por pizza = <strong>preço médio de venda − custo de ingrediente</strong>. O <strong>preço médio</strong> é o que de fato foi cobrado no período (mistura normal e premium pelo que vendeu), e o custo é a ficha + massa + caixa ao preço mais recente pago. ${itens.length} sabores. Quadrantes: popularidade vs 70% da média; margem vs mediana.`;
  document.getElementById('me-obs2').innerHTML=`<i class="fas fa-triangle-exclamation me-1 text-warning"></i>Sabores Premium (R$49,90) aparecem com margem maior em R$, mas a ficha pode estar incompleta (custo subestimado). Use a coluna <strong>%</strong> para comparar sabores de preços diferentes. Dogão/Fini ficam de fora (sem ficha).`;
}

// ================================================================
//  CLIENTES & REMARKETING (CEO > Clientes). Lê clientes_resumo.json (agregado)
//  e, sob demanda, clientes_contatos.json (PII, só local) para exportar listas.
// ================================================================
const CLI_SEG = [
  {k:'Campeoes',       label:'Campeões',         cor:'#1e8449', acao:'Recompense / trate como VIP — seus melhores'},
  {k:'Fieis',          label:'Fiéis',            cor:'#2e86c1', acao:'Mantenha perto com ofertas exclusivas'},
  {k:'Novos/recentes', label:'Novos / recentes', cor:'#8e44ad', acao:'Incentive a 2ª compra (cupom de boas-vindas)'},
  {k:'Em risco',       label:'Em risco',         cor:'#e67e22', acao:'URGENTE: cupom de volta — eram bons e estão sumindo'},
  {k:'Ocasionais',     label:'Ocasionais',       cor:'#7f8c8d', acao:'Empurre frequência (combo, fidelidade)'},
  {k:'Hibernando',     label:'Hibernando',       cor:'#d4ac0d', acao:'Reative com oferta forte'},
  {k:'Perdidos',       label:'Perdidos',         cor:'#922b21', acao:'Campanha de reativação em massa (maior pool)'},
];
let _cliData=null, _cliContatos=null, _cliCharts=[], _cliBusy=false, _cliPending=false;

async function carregarClientes() {
  if (_cliData) return _cliData;
  if (window.Nuvem && Nuvem.ativa()) {
    const nuv = await Nuvem.lerArquivo('clientes_resumo.json').catch(()=>null);
    if (nuv) { _cliData = nuv; guardarSnapshotJSON('cli_snapshot_v1', nuv); return _cliData; }
  }
  try { const r = await fetch('clientes_resumo.json',{cache:'no-store'}); if(r.ok){ _cliData = await r.json(); guardarSnapshotJSON('cli_snapshot_v1', _cliData); return _cliData; } }
  catch(e) { /* file:// ou Netlify sem o arquivo */ }
  // Sem o arquivo (celular/Netlify): usa o snapshot agregado que veio no backup (sem PII).
  _cliData = lerSnapshotJSON('cli_snapshot_v1');
  return _cliData;
}

async function renderClientes() {   // serializa (evita conflito de canvas)
  if (_cliBusy) { _cliPending=true; return; }
  _cliBusy=true;
  try { do { _cliPending=false; await _renderClientesImpl(); } while (_cliPending); }
  finally { _cliBusy=false; }
}

async function _renderClientesImpl() {
  const data = await carregarClientes();
  const vazio=document.getElementById('cli-vazio'), cont=document.getElementById('cli-conteudo');
  _cliCharts.forEach(c=>c.destroy()); _cliCharts=[];
  if (!data) { vazio.classList.remove('d-none'); cont.classList.add('d-none'); return; }
  vazio.classList.add('d-none'); cont.classList.remove('d-none');

  const lojaSel = document.getElementById('cli-loja').value;
  let segmentos, recencia, novos, novosDia, bairros, resumo;
  if (lojaSel) { const d=data.lojas[lojaSel]||{}; segmentos=d.segmentos||{}; recencia=d.recencia||{}; novos=d.novos_mes||{}; novosDia=d.novos_dia||{}; bairros=d.bairros||{}; resumo=d.resumo||{clientes:0,ativos_60d:0,dormentes_180d:0,pedidos:0,valor:0}; }
  else { segmentos=data.rede.segmentos; recencia=data.rede.recencia; novos=data.rede.novos_mes; novosDia=data.rede.novos_dia||{}; bairros=data.rede.bairros;
    resumo={clientes:0,ativos_60d:0,dormentes_180d:0,pedidos:0,valor:0};
    for (const lj of Object.values(data.lojas)) for (const k in resumo) resumo[k]+=(lj.resumo[k]||0); }

  // KPIs
  const card=(icon,cor,val,lbl,sub)=>`<div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
      <div class="text-${cor} mb-1"><i class="fas ${icon} fa-lg"></i></div>
      <div class="fs-4 fw-bold">${val}</div><div class="small text-muted">${lbl}</div>
      ${sub?`<div class="small text-muted">${sub}</div>`:''}</div></div>`;
  const pctAtivos = resumo.clientes ? Math.round(resumo.ativos_60d/resumo.clientes*100) : 0;
  document.getElementById('cli-kpis').innerHTML =
      card('fa-users','primary', fmtNum(resumo.clientes,0), 'Clientes alcançáveis', 'canal próprio c/ cadastro')
    + card('fa-bolt','success', fmtNum(resumo.ativos_60d,0), 'Ativos (60 dias)', `${pctAtivos}% da base`)
    + card('fa-bed','danger', fmtNum(resumo.dormentes_180d,0), 'Dormentes (180+ dias)', 'pool de reativação')
    + card('fa-coins','info', fmtBRL(resumo.valor), 'Valor (vida toda)', `${fmtNum(resumo.pedidos,0)} pedidos`);

  // Tabela de segmentos + exportar
  const totalSeg = Object.values(segmentos).reduce((s,v)=>s+v.clientes,0) || 1;
  document.getElementById('cli-seg-tbody').innerHTML = CLI_SEG.filter(s=>segmentos[s.k]).map(s=>{
    const v=segmentos[s.k], pct=Math.round(v.clientes/totalSeg*100);
    return `<tr><td><span class="badge" style="background:${s.cor}">${s.label}</span></td>
      <td class="text-end fw-semibold">${fmtNum(v.clientes,0)} <span class="text-muted small">(${pct}%)</span></td>
      <td class="text-end">${fmtBRL(v.valor)}</td><td class="small">${s.acao}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="exportarContatos('${argJS(s.k)}')"><i class="fas fa-download me-1"></i>Exportar</button></td></tr>`;
  }).join('');

  const segsOrd = CLI_SEG.filter(s=>segmentos[s.k]);
  _cliCharts.push(new Chart(document.getElementById('cli-seg-chart'), {type:'doughnut',
    data:{labels:segsOrd.map(s=>s.label), datasets:[{data:segsOrd.map(s=>segmentos[s.k].clientes), backgroundColor:segsOrd.map(s=>s.cor)}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:10}}}}}}));

  const RECORD=['0-30d','31-60d','61-120d','121-240d','240d+'];
  const recOrd=RECORD.filter(r=>recencia[r]!=null);
  _cliCharts.push(new Chart(document.getElementById('cli-rec-chart'), {type:'bar',
    data:{labels:recOrd, datasets:[{data:recOrd.map(r=>recencia[r]||0), backgroundColor:recOrd.map(r=>r==='240d+'?'#922b21':r==='0-30d'?'#1e8449':'#e67e22'), borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));

  // Novos clientes por dia / semana / mês (item 8). Usa novos_dia quando disponível.
  const granCli = (document.getElementById('cli-gran')||{}).value || 'mes';
  const temDia = novosDia && Object.keys(novosDia).length;
  const fonteN = temDia ? agruparSerie(novosDia, granCli) : (novos||{});
  const rotGN = temDia ? granCli : 'mes';
  const limN = granCli==='dia'?30 : granCli==='semana'?16 : 12;
  const chavesN = Object.keys(fonteN).sort().slice(-limN);
  _cliCharts.push(new Chart(document.getElementById('cli-novos-chart'), {type:'line',
    data:{labels:chavesN.map(k=>rotuloGran(k, rotGN)), datasets:[{data:chavesN.map(k=>fonteN[k]||0), borderColor:'#8e44ad', backgroundColor:'rgba(142,68,173,.12)', fill:true, tension:.3, pointRadius:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));

  const bord=Object.entries(bairros).sort((a,b)=>b[1].pedidos-a[1].pedidos).slice(0,10);
  _cliCharts.push(new Chart(document.getElementById('cli-bairro-chart'), {type:'bar',
    data:{labels:bord.map(b=>b[0]), datasets:[{data:bord.map(b=>b[1].pedidos), backgroundColor:'#1a5276', borderRadius:3}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true}}}}));

  // Cohort de retenção (triângulo): de cada safra de 1º pedido, % ativa em cada mês seguinte
  const cohort = lojaSel ? (data.lojas[lojaSel]?.cohort||{}) : (data.rede.cohort||{});
  const cohMeses = Object.keys(cohort).sort().slice(-12);
  const MAXOFF = 6;
  const nowYM = (()=>{ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); })();
  const addYM = (ym,n)=>{ let [y,mo]=ym.split('-').map(Number); mo+=n; y+=Math.floor((mo-1)/12); mo=((mo-1)%12)+1; return y+'-'+String(mo).padStart(2,'0'); };
  const ctable = document.getElementById('cli-cohort-table');
  if (cohMeses.length) {
    let h = '<thead class="table-light"><tr><th>Safra</th><th>Clientes</th>'+Array.from({length:MAXOFF+1},(_,i)=>`<th>M${i}</th>`).join('')+'</tr></thead><tbody>';
    for (const m of cohMeses) {
      const cd=cohort[m], tam=cd.tam||0;
      let cells='';
      for (let off=0; off<=MAXOFF; off++) {
        if (addYM(m,off) > nowYM) { cells += '<td class="text-muted">·</td>'; continue; }
        const n = (cd.off && cd.off[String(off)]) || 0;
        const pct = tam ? Math.round(n/tam*100) : 0;
        const rgb = pct>50 ? '30,132,73' : pct>=20 ? '230,126,34' : '146,43,33';
        const bg = off===0 ? 'transparent' : `rgba(${rgb},${Math.max(0.1, Math.min(0.85, pct/100))})`;
        cells += `<td style="background:${bg}">${pct}%</td>`;
      }
      h += `<tr><td class="fw-semibold">${m}</td><td>${fmtNum(tam,0)}</td>${cells}</tr>`;
    }
    ctable.innerHTML = h + '</tbody>';
  } else { ctable.innerHTML = '<tbody><tr><td class="text-muted p-3">Sem dados de safra suficientes.</td></tr></tbody>'; }

  document.getElementById('cli-obs').innerHTML='<i class="fas fa-shield-halved me-1"></i>Os contatos são dos <strong>seus próprios clientes</strong> (canal próprio). Boa prática (LGPD): use para reativar quem já comprou e ofereça descadastro. A lista de contatos fica <strong>só na sua máquina</strong> (não vai para o site público).';

  // Novos clientes por período (filtro livre) — usa novos_dia do extrator
  const clnIni=document.getElementById('cln-ini');
  if (!clnIni.dataset.iniciado) { clnIni.dataset.iniciado='1'; clnQuick(30,false); }
  renderNovosClientes();
}

function clnQuick(dias, atualizar=true) {
  const i=document.getElementById('cln-ini'), f=document.getElementById('cln-fim');
  if (!dias) { i.value=''; f.value=''; } else { f.value=today(); const d=new Date(); d.setDate(d.getDate()-dias); i.value=dataLocalISO(d); }
  if (atualizar) renderNovosClientes();
}

async function renderNovosClientes() {
  const data = await carregarClientes(); if (!data) return;
  const lojaSel = document.getElementById('cli-loja').value;
  const nd = lojaSel ? ((data.lojas[lojaSel]||{}).novos_dia||{}) : (data.rede.novos_dia||{});
  const ini=document.getElementById('cln-ini').value, fim=document.getElementById('cln-fim').value;
  let total=0; for (const [d,n] of Object.entries(nd)) if ((!ini||d>=ini)&&(!fim||d<=fim)) total+=n;
  document.getElementById('cln-num').textContent = fmtNum(total,0);
  document.getElementById('cln-lbl').textContent = (ini||fim)
    ? `novos de ${ini?fmtDate(ini):'início'} a ${fim?fmtDate(fim):'hoje'}`
    : 'novos (todo o histórico)';
}

async function exportarContatos(seg) {
  try {
    if (!_cliContatos) {
      const r = await fetch('clientes_contatos.json',{cache:'no-store'});
      // A lista com nome/telefone/e-mail (clientes_contatos.json) NUNCA sobe para a nuvem, de propósito
      // (dado pessoal de cliente). Na nuvem, a exportação é pelo próprio TOTEM.
      if (!r.ok) { toast((window.Nuvem && Nuvem.ativa()) ? 'Os contatos dos clientes (nome e telefone) não ficam na nuvem, de propósito. Para a lista, exporte pelo TOTEM.' : 'Lista de contatos indisponível neste computador.','info'); return; }
      _cliContatos = (await r.json()).contatos || [];
    }
    const lojaSel = document.getElementById('cli-loja').value;
    const lista = _cliContatos.filter(c=>c.segmento===seg && (!lojaSel||c.loja===lojaSel)).sort((a,b)=>b.valor-a.valor);
    if (!lista.length) { toast('Nenhum contato neste segmento.','info'); return; }
    const esc=s=>`"${String(s??'').replace(/"/g,'""')}"`;
    const linhas=[['Nome','Telefone','Email','Bairro','Loja','Pedidos','Valor','Ultimo pedido','Dias sem pedir'].join(';')];
    for (const c of lista) linhas.push([esc(c.nome),esc(c.telefone),esc(c.email),esc(c.bairro),esc(c.loja),c.pedidos,String(c.valor).replace('.',','),c.ultimo,c.recencia].join(';'));
    const blob=new Blob(['﻿'+linhas.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=`contatos_${seg.replace(/[^a-zA-Z]/g,'')}_${lojaSel||'todas'}.csv`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    toast(`${lista.length} contato(s) exportado(s) — ${seg}.`,'success');
  } catch(e) { toast('Erro ao exportar contatos: '+e.message,'error'); }
}

// ================================================================
//  PIZZAS POR DIA  (visão diária — Lote 2). Não toca em custo/divergência.
// ================================================================
const DIAS_SEM_ABREV = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
function diaDaSemana(iso) { return DIAS_SEM_ABREV[new Date(iso+'T00:00:00').getDay()]; }

// Filtro "Ontem" reutilizável: põe ini=fim=ontem nos campos de data e re-renderiza.
// (Gabriel pediu várias vezes ver o dia anterior.) Ontem = dia fechado (hoje pode estar parcial).
function filtroOntem(iniId, fimId, render) {
  const d = new Date(); d.setDate(d.getDate()-1); const y = dataLocalISO(d);
  const i = document.getElementById(iniId), f = document.getElementById(fimId);
  if (i) i.value = y; if (f) f.value = y;
  if (typeof render === 'function') render();
}

let _pdChart = null;
function pdQuick(dias, atualizar=true) {
  const iniEl = document.getElementById('pd-ini'), fimEl = document.getElementById('pd-fim');
  if (!dias) { iniEl.value=''; fimEl.value=''; }
  else {
    fimEl.value = today();
    const d = new Date(); d.setDate(d.getDate()-dias);
    iniEl.value = dataLocalISO(d);
  }
  if (atualizar) renderPizzasDia();
}

// --- Granularidade temporal (item 8): agrupa uma data ISO num balde dia/semana/mês ---
// Reutilizado pelos gráficos de séries no tempo (Pizzas por Dia, Painel do CEO, Clientes).
const MES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
function chaveGran(iso, gran) {
  if (!iso) return iso;
  if (gran==='mes') return iso.slice(0,7);                 // AAAA-MM
  if (gran==='semana') {                                   // segunda-feira da semana
    const d = new Date(iso+'T00:00:00');
    const dow = (d.getDay()+6)%7;                          // 0 = segunda
    d.setDate(d.getDate()-dow);
    return dataLocalISO(d);
  }
  return iso;                                              // dia
}
function rotuloGran(chave, gran) {
  if (!chave) return '';
  if (gran==='mes') { const [a,m]=chave.split('-'); return MES_ABREV[(+m)-1]+'/'+a.slice(2); }
  if (gran==='semana') return 'sem '+fmtDate(chave).slice(0,5);
  return fmtDate(chave).slice(0,5);
}
// Agrupa um mapa {dataISO: valor} (ou {dataISO: {sub:valor}}) em baldes por granularidade.
function agruparSerie(porData, gran) {
  const out = {};
  for (const [iso, val] of Object.entries(porData)) {
    const k = chaveGran(iso, gran);
    if (val && typeof val === 'object') {
      out[k] = out[k] || {};
      for (const [sub, v] of Object.entries(val)) out[k][sub] = (out[k][sub]||0) + v;
    } else {
      out[k] = (out[k]||0) + val;
    }
  }
  return out;
}

async function renderPizzasDia() {
  const iniEl = document.getElementById('pd-ini');
  if (!iniEl.dataset.iniciado) { iniEl.dataset.iniciado='1'; pdQuick(30,false); }

  const lojaSel = document.getElementById('pd-loja').value;
  const ini = document.getElementById('pd-ini').value;
  const fim = document.getElementById('pd-fim').value;
  const lojas = lojaSel ? [lojaSel] : LOJAS_ATIVAS();
  const todas = !lojaSel;
  const CORES_LOJA = LOJA_COR;   // fonte única: cadastro de lojas

  // Só o período na tela (31/07/2026): esta aba usa o store `vendas` apenas para SABOR e BEBIDA;
  // a contagem de pizzas vem do resumo do TOTEM. Baixar 4 anos para listar os sabores de 60 dias
  // era o que travava o celular. O recorte da chamada é o mesmo do filtro `noPeriodo` abaixo.
  const vendas = DB.vendasPeriodo ? await DB.vendasPeriodo(ini, fim) : await DB.getAll('vendas');
  const noPeriodo = v => lojas.includes(v.loja) && (!ini || v.data_fim>=ini) && (!fim || v.data_fim<=fim);
  // Só registros de UM dia (data_inicio===data_fim, vindos do TOTEM) entram na visão por-dia.
  const diarias = vendas.filter(v => v.data_inicio===v.data_fim && noPeriodo(v));
  const periodicas = vendas.filter(v => v.data_inicio!==v.data_fim && lojas.includes(v.loja)
        && (!ini || v.data_fim>=ini) && (!fim || v.data_inicio<=fim));

  const vazio = document.getElementById('pd-vazio');
  const conteudo = document.getElementById('pd-conteudo');
  const info = document.getElementById('pd-info');
  if (_pdChart) { _pdChart.destroy(); _pdChart=null; }

  // FONTE ÚNICA DA CONTAGEM DE PIZZAS (30/07/2026): `pizzas_canal` do pedidos_resumo.json —
  // exatamente a mesma base do Dashboard e do Painel do CEO. Antes esta tela contava pelo store
  // `vendas`, que depende da importação ter rodado; quando ela falhava, o Dashboard mostrava as
  // pizzas de ontem e AQUI dizia "sem dados" — o mesmo número com duas respostas.
  // O store `vendas` continua servindo SABORES e BEBIDAS (o pizzas_canal não tem esse detalhe).
  const ceoPd = await carregarCEO();
  const canalPd = (ceoPd && Array.isArray(ceoPd.pizzas_canal) && ceoPd.pizzas_canal.length)
                  ? ceoPd.pizzas_canal : null;

  // dia -> {loja -> pizzas};  dia -> bebidas
  const porDia = {}, bebDia = {};
  if (canalPd) {
    for (const r of canalPd) {
      if (!lojas.includes(r.loja) || !CANAIS_REAIS.includes(r.canal)) continue;   // JANTA fora (consumo interno)
      if ((ini && r.data < ini) || (fim && r.data > fim)) continue;
      (porDia[r.data] = porDia[r.data] || {})[r.loja] = (porDia[r.data][r.loja]||0) + r.pizzas;
    }
  } else {
    for (const v of diarias) {
      const d = v.data_fim;
      (porDia[d] = porDia[d] || {})[v.loja] = (porDia[d][v.loja]||0) + contarPizzas(v.itens);
    }
  }
  for (const v of diarias) bebDia[v.data_fim] = (bebDia[v.data_fim]||0) + contarBebidas(v.itens);

  if (!Object.keys(porDia).length) {
    vazio.classList.remove('d-none'); conteudo.classList.add('d-none');
    info.innerHTML = periodicas.length
      ? `<i class="fas fa-info-circle me-1"></i>Há ${periodicas.length} importação(ões) de período (não-diárias) neste filtro — elas não aparecem na visão por dia.` : '';
    return;
  }
  vazio.classList.add('d-none'); conteudo.classList.remove('d-none');

  const dias = Object.keys(porDia).sort();                 // crescente p/ o gráfico
  const totalDia = d => lojas.reduce((s,l)=>s+(porDia[d][l]||0),0);
  const r1 = x => Math.round(x*10)/10;

  const totalPizzas = dias.reduce((s,d)=>s+totalDia(d),0);
  const media = totalPizzas / dias.length;
  let melhor = dias[0]; for (const d of dias) if (totalDia(d)>totalDia(melhor)) melhor=d;

  // Cards
  const card = (icon,cor,val,lbl) => `<div class="col-6 col-lg-3"><div class="card h-100"><div class="card-body text-center">
      <div class="text-${cor} mb-1"><i class="fas ${icon} fa-lg"></i></div>
      <div class="fs-4 fw-bold">${val}</div><div class="small text-muted">${lbl}</div></div></div></div>`;
  document.getElementById('pd-cards').innerHTML =
      card('fa-pizza-slice','danger', fmtPizzas(r1(totalPizzas)), 'Pizzas no período')
    + card('fa-calculator','primary', fmtPizzas(r1(media)), 'Média por dia')
    + card('fa-trophy','warning', fmtPizzas(r1(totalDia(melhor))), `Melhor dia (${fmtDate(melhor).slice(0,5)} ${diaDaSemana(melhor)})`)
    + card('fa-calendar-check','success', dias.length, 'Dias com venda');

  // Gráfico (empilhado por loja quando "Todas") — agrupado por dia / semana / mês (item 8)
  const gran = (document.getElementById('pd-gran')||{}).value || 'dia';
  const porBalde = agruparSerie(porDia, gran);
  const baldes = Object.keys(porBalde).sort();
  const totalBalde = k => lojas.reduce((s,l)=>s+(porBalde[k][l]||0),0);
  const labelBalde = k => gran==='dia' ? `${fmtDate(k).slice(0,5)} ${diaDaSemana(k)}` : rotuloGran(k,gran);
  const datasets = todas
    ? lojas.map(l=>({label:LOJA_LABEL[l], data:baldes.map(k=>r1(porBalde[k][l]||0)),
        backgroundColor:CORES_LOJA[l], stack:'s', borderRadius:3}))
    : [{label:'Pizzas', data:baldes.map(k=>r1(totalBalde(k))),
        backgroundColor:CORES_LOJA[lojaSel]||'#922b21', borderRadius:3}];
  _pdChart = new Chart(document.getElementById('pd-chart'), {
    type:'bar',
    data:{ labels: baldes.map(labelBalde), datasets },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:todas, position:'bottom'},
        tooltip:{callbacks:{footer: items=> todas ? 'Total: '+fmtPizzas(r1(items.reduce((s,i)=>s+i.parsed.y,0))) : ''}}},
      scales:{ x:{stacked:todas, ticks:{maxRotation:90,minRotation:45,autoSkip:true}},
               y:{stacked:todas, beginAtZero:true, title:{display:true,text:'pizzas'}} } }
  });

  // Tabela (mais recente primeiro)
  document.getElementById('pd-thead').innerHTML = todas
    ? `<th>Data</th><th>Dia</th>`+lojas.map(l=>`<th class="text-end">${LOJA_LABEL[l]}</th>`).join('')+`<th class="text-end">Total</th><th class="text-end">Bebidas</th>`
    : `<th>Data</th><th>Dia</th><th class="text-end">Pizzas</th><th class="text-end">Bebidas</th>`;
  document.getElementById('pd-tbody').innerHTML = dias.slice().reverse().map(d=>{
    const cols = todas
      ? lojas.map(l=>`<td class="text-end">${porDia[d][l]?fmtPizzas(r1(porDia[d][l])):'<span class="text-muted">–</span>'}</td>`).join('')
        + `<td class="text-end fw-bold">${fmtPizzas(r1(totalDia(d)))}</td>`
      : `<td class="text-end fw-bold">${fmtPizzas(r1(totalDia(d)))}</td>`;
    return `<tr><td>${fmtDate(d)}</td><td class="text-muted">${diaDaSemana(d)}</td>${cols}<td class="text-end text-muted">${bebDia[d]?fmtPizzas(r1(bebDia[d])):'–'}</td></tr>`;
  }).join('');

  // Pizzas por SABOR + REFRIGERANTES (agregado no período, das mesmas vendas diárias)
  const saborQ = {}, bebQ = {};
  for (const v of diarias) {
    for (const it of (v.itens||[])) {
      const m = resolverMap(it);
      if (!m || m.ignorar_no_consumo || m.categoria==='AGRUPADOR') continue;
      if (['MEIA','INTEIRA','PREMIUM'].includes(m.categoria)) {
        const nome = nomeSaborMix(m, it) || ('CÓD '+it.codigo);
        saborQ[nome] = (saborQ[nome]||0) + (m.fator_consumo||1)*it.qtde;
      } else if (m.categoria==='BEBIDA') {
        const b = m.bebida_estoque || it.produto || ('CÓD '+it.codigo);
        bebQ[b] = (bebQ[b]||0) + it.qtde;
      }
    }
  }
  const sabOrd = Object.entries(saborQ).sort((a,b)=>b[1]-a[1]);
  const totSab = sabOrd.reduce((s,x)=>s+x[1],0);
  document.getElementById('pd-sabores-tbody').innerHTML = sabOrd.length
    ? sabOrd.map(([nome,q],i)=>`<tr><td class="text-muted">${i+1}</td><td>${esc(nome)}</td><td class="text-end fw-semibold">${fmtPizzas(r1(q))}</td><td class="text-end text-muted">${totSab?fmtNum(q/totSab*100,1):0}%</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-muted py-3">Sem sabores reconhecidos no período.</td></tr>';
  const bebOrd = Object.entries(bebQ).sort((a,b)=>b[1]-a[1]);
  document.getElementById('pd-bebidas-tbody').innerHTML = bebOrd.length
    ? bebOrd.map(([nome,q])=>`<tr><td>${esc(nome)}</td><td class="text-end fw-semibold">${fmtNum(q,0)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="text-center text-muted py-3">Sem refrigerantes no período.</td></tr>';

  // Rodapé: de onde vieram os números, e aviso honesto quando sabor/bebida está atrás das pizzas
  // (as pizzas vêm do resumo do TOTEM; o detalhe por sabor depende do store `vendas`).
  const partes = [`${dias.length} dia(s) com venda no período.`];
  if (canalPd) {
    partes.push('Pizzas contadas pela mesma base do Dashboard e do Painel do CEO (canais reais — a JANTA fica de fora).');
    if (!sabOrd.length) partes.push('<span class="text-warning"><i class="fas fa-triangle-exclamation me-1"></i>O detalhe por sabor/bebida ainda não chegou para este período.</span>');
  }
  if (periodicas.length) partes.push(`${periodicas.length} importação(ões) de período (não-diárias) ficam de fora desta visão.`);
  info.innerHTML = partes.join(' ');
}

function pnQuick(dias, atualizar=true) {
  const iniEl = document.getElementById('pn-ini'), fimEl = document.getElementById('pn-fim');
  if (!dias) { iniEl.value=''; fimEl.value=''; }
  else {
    fimEl.value = today();
    const d = new Date(); d.setDate(d.getDate()-dias);
    iniEl.value = dataLocalISO(d);
  }
  if (atualizar) atualizarPainel();
}

function renderPainel() {
  const iniEl = document.getElementById('pn-ini');
  if (!iniEl.dataset.iniciado) { iniEl.dataset.iniciado='1'; pnQuick(30,false); }
  atualizarPainel();
}

let _pnPendente = false;
async function atualizarPainel() {
  if (_pnAtualizando) { _pnPendente = true; return; }
  _pnAtualizando = true;
  try {
    do { _pnPendente = false; await _atualizarPainelImpl(); } while (_pnPendente);
  } finally { _pnAtualizando = false; }
}

async function _atualizarPainelImpl() {
  const lojaSel = document.getElementById('pn-loja').value;
  const ini = document.getElementById('pn-ini').value;
  const fim = document.getElementById('pn-fim').value;
  const lojas = lojaSel ? [lojaSel] : LOJAS_ATIVAS();

  const [contagens, compras] = await Promise.all([DB.getAll('contagens'), DB.getAll('compras')]);
  // VELOCIDADE (22/09): com período escolhido, só as vendas desde o dia mais antigo que esta tela usa —
  // o início do período ou a contagem que abre a janela de cada loja (a MESMA regra do laço abaixo).
  // Todo filtro daqui já cortava nesses dias; sem período ("tudo"), continua lendo o histórico inteiro.
  let desdeVendas = ini || null;
  if (ini) for (const loja of lojas) {
    const cts = contagens.filter(c=>c.loja===loja).sort((a,b)=>a.data.localeCompare(b.data));
    if (cts.length < 2) continue;
    const effIni = [...cts].reverse().find(c=>c.data<=ini)?.data || cts[0].data;
    if (effIni < desdeVendas) desdeVendas = effIni;
  }
  const vendas = (desdeVendas && DB.vendasPeriodo) ? await DB.vendasPeriodo(desdeVendas, null) : await DB.getAll('vendas');
  const ceo = await carregarCEO().catch(()=>null);   // régua única das pizzas (pizzasDoResumo)

  const vendasF = vendas.filter(v => lojas.includes(v.loja)
    && (!fim || v.data_inicio <= fim) && (!ini || v.data_fim >= ini));
  const comprasF = compras.filter(c => lojas.includes(c.loja)
    && (!ini || c.data >= ini) && (!fim || c.data <= fim));

  _pnCharts.forEach(c=>c.destroy()); _pnCharts=[];

  if (!vendasF.length && !comprasF.length) {
    document.getElementById('pn-conteudo').classList.add('d-none');
    document.getElementById('pn-vazio').classList.remove('d-none');
    document.getElementById('pn-periodos-info').classList.add('d-none');
    return;
  }
  document.getElementById('pn-vazio').classList.add('d-none');
  document.getElementById('pn-conteudo').classList.remove('d-none');

  // ---------- 1. Mix de sabores (só popularidade + custo de ingredientes; receita do CSV é ignorada) ----------
  const mix = {};
  let pizzasTotal = 0;
  for (const v of vendasF) {
    for (const it of (v.itens||[])) {
      const m = resolverMap(it);
      if (!m || !['MEIA','INTEIRA','PREMIUM'].includes(m.categoria)) continue;
      const sabor = nomeSaborMix(m, it);
      const pz = it.qtde*(m.fator_consumo||1);
      if (!mix[sabor]) mix[sabor] = {sabor, nomeFicha:m.nome_ficha||'', pizzas:0, premium:false};
      mix[sabor].pizzas += pz;
      if (m.categoria==='PREMIUM') mix[sabor].premium = true;
      pizzasTotal += pz;
    }
  }
  const sabores = Object.values(mix).filter(s=>s.pizzas>0).sort((a,b)=>b.pizzas-a.pizzas);
  let custoIncompleto = false, custoMixTotal = 0;
  for (const s of sabores) {
    const cf = s.nomeFicha ? custoFichaSabor(s.nomeFicha, ing => custoPagoIng(ing, ini, fim, compras, lojaSel)) : null;
    s.custo = cf ? cf.custo : null;            // custo de ingredientes de 1 pizza inteira deste sabor
    s.custoCompleto = cf ? cf.completo : true;
    s.custoTotal = s.custo!==null ? s.custo * s.pizzas : null;  // pizzas já vem em equivalentes (meia=0,5)
    if (cf && !cf.completo) custoIncompleto = true;
    if (s.custoTotal!==null) custoMixTotal += s.custoTotal;
  }

  // ---------- 2. CMV real, desperdício e gramatura (entre contagens) ----------
  const porIng = {};
  const pizzasIng = {};   // por ingrediente: nº de pizzas (equiv.) cuja ficha leva aquele ingrediente
  const statsLoja = {};
  const avisos = [];
  const periodosEfetivos = [];
  let pizzasJanela = 0, pizzasJanelaOk = true, temJanela = false;

  for (const loja of lojas) {
    // pizzas = régua única no PERÍODO filtrado (coluna "Pizzas"); pizzasJanela = régua única na JANELA
    // das contagens (denominador do CMV/pizza — o CMV é da janela, então as pizzas também).
    const st = {pizzas:pizzasDoResumo(ceo, [loja], ini, fim), pizzasJanela:null, comprasRS:0, cmv:null, esperado:null, variacao:null, desperdicio:null, furos:0, estoque:0};
    statsLoja[loja] = st;
    st.comprasRS = comprasF.filter(c=>c.loja===loja).reduce((s,c)=>s+(c.valor_total||0),0);
    const ctsLoja = contagens.filter(c=>c.loja===loja).sort((a,b)=>a.data.localeCompare(b.data));
    if (ctsLoja.length) st.estoque = valorEstoqueContagem(ctsLoja[ctsLoja.length-1], compras);

    if (ctsLoja.length < 2) {
      avisos.push(`${LOJA_LABEL[loja]}: precisa de pelo menos 2 contagens salvas para calcular CMV real, desperdício e gramatura.`);
      continue;
    }
    const effIni = ini ? ([...ctsLoja].reverse().find(c=>c.data<=ini)?.data || ctsLoja[0].data) : ctsLoja[0].data;
    const effFim = fim ? (ctsLoja.find(c=>c.data>=fim)?.data || ctsLoja[ctsLoja.length-1].data) : ctsLoja[ctsLoja.length-1].data;
    if (effFim <= effIni) {
      avisos.push(`${LOJA_LABEL[loja]}: não há duas contagens (início e fim) cobrindo o período escolhido.`);
      continue;
    }
    const d = await calcDivergencias(loja, effIni, effFim);
    temJanela = true;
    periodosEfetivos.push(`${LOJA_LABEL[loja]}: contagens de ${fmtDate(effIni)} a ${fmtDate(effFim)}`);
    let cmvLoja = 0, espLoja = 0, despLoja = 0, furosLoja = 0;
    for (const r of d.resultado) {
      const k = normIng(r.ing);
      if (!porIng[k]) porIng[k] = {ing:r.ing, unidade:r.unidade, real:0, esperado:0, impacto:0, custo:r.custo};
      porIng[k].real += r.consumoReal;
      porIng[k].esperado += r.esperado;
      porIng[k].impacto += r.impacto;
      // MESMA regra do CEO (auditoria 02/07): furo (consumo negativo) fica FORA dos KPIs —
      // erro de contagem não pode abater CMV nem virar "economia". Continua na tabela, flagrado.
      if (r.impossivel) { furosLoja++; continue; }
      cmvLoja  += r.consumoReal*r.custo;
      espLoja  += r.esperado*r.custo;
      if (r.impacto>0) despLoja += r.impacto;   // PERDA BRUTA: só perdas, sobra não abate
    }
    st.cmv = cmvLoja; st.esperado = espLoja; st.variacao = cmvLoja - espLoja;
    st.desperdicio = despLoja; st.furos = furosLoja;
    if (furosLoja) avisos.push(`${LOJA_LABEL[loja]}: ${furosLoja} insumo(s) com consumo NEGATIVO (contagem/compra errada) — ficaram fora do CMV/perda; confira em Divergências.`);
    // Vendas dentro da MESMA janela de consumo que o calcDivergencias usou
    // (ajustada pelo momento das contagens). Tem que ser idêntica, senão o
    // numerador (consumo esperado) e o denominador (nº de pizzas) ficam em
    // janelas diferentes e a gramatura por pizza sai errada.
    const vsJanela = vendasDaJanela(vendas, loja, d);
    st.pizzasJanela = pizzasDaJanela(ceo, loja, d);   // régua única, mesmos dias da janela
    if (st.pizzasJanela==null) pizzasJanelaOk = false; else pizzasJanela += st.pizzasJanela;
    // Para cada ingrediente, conta quantas pizzas (equiv.) realmente o levam na ficha
    for (const v of vsJanela) for (const it of (v.itens||[])) {
      const m = resolverMap(it);
      if (!m || !['MEIA','INTEIRA','PREMIUM'].includes(m.categoria) || !m.nome_ficha) continue;
      const ficha = FICHA_TECNICA[m.nome_ficha];
      if (!ficha) continue;
      const pz = it.qtde*(m.fator_consumo||1);
      for (const ing of Object.keys(ficha._ingredientes)) {
        const k = normIng(ing);
        pizzasIng[k] = (pizzasIng[k]||0) + pz;
      }
    }
  }

  const cmvTotal = Object.values(statsLoja).reduce((s,x)=>s+(x.cmv||0),0);
  const espTotal = Object.values(statsLoja).reduce((s,x)=>s+(x.esperado||0),0);
  const varTotal = cmvTotal - espTotal;   // variação líquida = real − esperado (ao centavo)
  const despTotal = Object.values(statsLoja).reduce((s,x)=>s+(x.desperdicio||0),0);
  const comprasTotal = comprasF.reduce((s,c)=>s+(c.valor_total||0),0);
  const despPct = (temJanela && cmvTotal>0) ? despTotal/cmvTotal*100 : null;
  const custoPorPizza = (temJanela && pizzasJanelaOk && pizzasJanela>0) ? cmvTotal/pizzasJanela : null;
  const pizzasPeriodo = pizzasDoResumo(ceo, lojas, ini, fim);   // KPI "Pizzas vendidas" = régua única

  // ---------- 3. Avisos e período efetivo ----------
  document.getElementById('pn-avisos').innerHTML = avisos.length
    ? `<div class="alert alert-warning py-2 small"><i class="fas fa-triangle-exclamation me-1"></i>${avisos.join('<br>')}</div>` : '';
  const infoEl = document.getElementById('pn-periodos-info');
  if (periodosEfetivos.length) {
    infoEl.classList.remove('d-none');
    infoEl.innerHTML = `<i class="fas fa-calendar-check me-1"></i>CMV real, desperdício e gramatura calculados entre contagens — ${periodosEfetivos.join(' · ')}`;
  } else infoEl.classList.add('d-none');

  // ---------- 4. KPIs (tudo baseado em consumo × custo; receita do CSV é ignorada) ----------
  const estoqueTotal = Object.values(statsLoja).reduce((s,x)=>s+(x.estoque||0),0);
  document.getElementById('pn-kpis').innerHTML = `
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-pizza-slice me-1"></i>Pizzas vendidas</div>
      <div class="val fs-4">${pizzasPeriodo!=null?fmtNum(pizzasPeriodo,0):'—'}</div>
      <div class="lbl">${pizzasPeriodo!=null?'no período filtrado (TOTEM)':'resumo do TOTEM não carregou'}</div></div></div>
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-truck me-1"></i>Compras</div>
      <div class="val fs-5">${comprasTotal?fmtBRL(comprasTotal):'R$ 0,00'}</div>
      <div class="lbl">no período filtrado</div></div></div>
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-fire-burner me-1"></i>CMV real (ingredientes)</div>
      <div class="val fs-5">${temJanela?fmtBRL(cmvTotal):'—'}</div>
      <div class="lbl">${temJanela?'consumo × custo, entre contagens':'precisa de 2 contagens'}</div></div></div>
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-tag me-1"></i>Custo de ingr./pizza</div>
      <div class="val fs-5">${custoPorPizza!==null?fmtBRL(custoPorPizza):'—'}</div>
      <div class="lbl">CMV real ÷ pizzas da janela</div></div></div>
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-trash-arrow-up me-1"></i>Perda bruta (desperdício)</div>
      <div class="val fs-5 ${despTotal>0?'text-danger':'text-success'}">${temJanela?fmtBRL(despTotal):'—'}</div>
      <div class="lbl">${temJanela?`variação líquida ${varTotal>=0?'+':'−'}${fmtBRL(Math.abs(varTotal))}`:'consumo acima da ficha'}</div></div></div>
    <div class="col-6 col-lg-2"><div class="stat-card h-100">
      <div class="lbl"><i class="fas fa-boxes-stacked me-1"></i>Valor em estoque</div>
      <div class="val fs-5">${estoqueTotal?fmtBRL(estoqueTotal):'—'}</div>
      <div class="lbl">última contagem × custo</div></div></div>`;

  // ---------- 5. Gráfico e tabela do mix ----------
  const topMix = sabores.slice(0,14);
  if (topMix.length) {
    _pnCharts.push(new Chart(pnCanvas('pn-mix-chart'), {
      type:'bar',
      data:{labels: topMix.map(s=>s.sabor + (s.premium?' ★':'')),
        datasets:[{label:'Pizzas', data: topMix.map(s=>Math.round(s.pizzas*10)/10),
          backgroundColor: topMix.map((s,i)=>PN_CORES[i%PN_CORES.length]), borderRadius:4}]},
      options:{indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false},
        tooltip:{callbacks:{label:ctx=>` ${fmtPizzas(ctx.parsed.x)} pizzas (${fmtPct(ctx.parsed.x/pizzasTotal*100)} do mix)`}}},
        scales:{x:{beginAtZero:true}}}
    }));
  }
  document.getElementById('pn-mix-tbody').innerHTML = sabores.map(s=>{
    const ast = (s.custo!==null && !s.custoCompleto) ? '<span title="Há ingrediente sem custo cadastrado — custo real é um pouco maior">*</span>' : '';
    return `<tr>
      <td class="fw-semibold">${esc(s.sabor)}${s.premium?' <span class="badge bg-warning text-dark">★</span>':''}${s.nomeFicha?'':' <span class="badge bg-secondary" title="Sem ficha técnica — conta como pizza, mas sem custo de ingredientes">s/ ficha</span>'}</td>
      <td class="text-end">${fmtPizzas(Math.round(s.pizzas*10)/10)}</td>
      <td class="text-end">${fmtPct(s.pizzas/pizzasTotal*100)}</td>
      <td class="text-end">${s.custo!==null?fmtBRL(s.custo)+ast:'—'}</td>
      <td class="text-end">${s.custoTotal!==null?fmtBRL(s.custoTotal):'—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="text-center text-muted py-3">Sem pizzas no período.</td></tr>';
  // Os sabores vêm das vendas importadas (o resumo do TOTEM não tem sabor). Se a soma deles não bater
  // com "Pizzas vendidas", a nota diz produto a produto o porquê — nunca um ajuste escondido.
  const notaMapa = (pizzasPeriodo!=null && Math.abs(pizzasTotal - pizzasPeriodo) >= 0.5) ? notaPizzasForaDoMapa(vendasF) : '';
  document.getElementById('pn-mix-nota').innerHTML =
    `Custo de ingredientes do mix no período: <strong>${fmtBRL(custoMixTotal)}</strong>. O <em>custo por pizza</em> vem da ficha técnica × custo médio cadastrado — não depende do preço de venda.` +
    (custoIncompleto ? ' Sabores com <strong>*</strong> têm algum ingrediente sem custo cadastrado.' : '') +
    (pizzasPeriodo!=null && Math.abs(pizzasTotal - pizzasPeriodo) >= 0.5
      ? ` Os sabores somam <strong>${fmtNum(pizzasTotal,0)}</strong> pizzas; o total do TOTEM é <strong>${fmtNum(pizzasPeriodo,0)}</strong>. ` +
        (notaMapa || 'Parte das vendas do período ainda não foi importada.')
      : '');

  // ---------- 6. Mussarela em foco ----------
  const mu = porIng['MUSSARELA'];
  const muCompras = comprasF.filter(c=>normIng(c.ingrediente)==='MUSSARELA');
  const muComprasRS = muCompras.reduce((s,c)=>s+(c.valor_total||0),0);
  const muComprasKG = muCompras.reduce((s,c)=>s+(c.quantidade_base||0),0);
  const muPizzas = pizzasIng['MUSSARELA'] || 0;
  const muCustoKg = custoPagoIng('MUSSARELA', ini, fim, compras, lojaSel); // preço pago no período (fallback: base)
  const muPrecoMedio = muComprasKG>0 ? muComprasRS/muComprasKG : null;
  // Card 5 (Compras): o texto pequeno agora mostra o PREÇO MÉDIO PAGO no período
  const comprasCard = muComprasRS>0 ? `
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Compras de mussarela</div><div class="val fs-5">${fmtBRL(muComprasRS)}</div>
        <div class="lbl">${muPrecoMedio!=null?fmtBRL(muPrecoMedio)+'/kg preço médio pago':'preço médio pago: —'}</div></div></div>` : '';
  let mussaHtml = '';
  if (mu && muPizzas>0) {
    const gReal = mu.real*1000/muPizzas, gTeo = mu.esperado*1000/muPizzas;
    const dif = gReal-gTeo;
    const cmvMussa = mu.real * muCustoKg;                  // KPI 6: custo da mussarela consumida (CMV)
    const rsPorPizza = muPizzas>0 ? cmvMussa/muPizzas : 0; // KPI 7: R$ de mussarela por pizza
    const pctCMV = cmvTotal>0 ? cmvMussa/cmvTotal*100 : null; // KPI 8: CMV mussarela ÷ CMV total
    mussaHtml += `
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Gramatura pela ficha</div><div class="val">${fmtNum(gTeo,0)} g</div><div class="lbl">por pizza que leva mussarela</div></div></div>
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Gramatura real</div><div class="val ${dif>10?'text-danger':dif<-10?'text-primary':'text-success'}">${fmtNum(gReal,0)} g</div>
        <div class="lbl">${dif>0?'+':''}${fmtNum(dif,0)} g por pizza vs ficha</div></div></div>
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Consumo no período</div><div class="val">${fmtNum(mu.real,1)} kg</div>
        <div class="lbl">esperado: ${fmtNum(mu.esperado,1)} kg</div></div></div>
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">${mu.impacto>0?'Perda':'Economia'} em R$</div>
        <div class="val ${mu.impacto>0?'text-danger':'text-success'}">${fmtBRL(Math.abs(mu.impacto))}</div>
        <div class="lbl">divergência × custo do kg</div></div></div>`;
    mussaHtml += comprasCard;  // KPI 5
    mussaHtml += `
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Custo da mussarela consumida</div><div class="val fs-5">${fmtBRL(cmvMussa)}</div>
        <div class="lbl">${fmtNum(mu.real,1)} kg × ${fmtBRL(muCustoKg)}/kg</div></div></div>
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">Mussarela por pizza</div><div class="val fs-5">${fmtBRL(rsPorPizza)}</div>
        <div class="lbl">por pizza que leva mussarela</div></div></div>
      <div class="col-6 col-lg-3"><div class="stat-card h-100 text-center">
        <div class="lbl">% no custo dos insumos</div><div class="val fs-5">${fmtPct(pctCMV)}</div>
        <div class="lbl">CMV mussarela ÷ CMV total</div></div></div>`;
  } else {
    mussaHtml += `<div class="col-12"><div class="alert alert-secondary py-2 small mb-0">
      Para medir a gramatura real de mussarela é preciso ter <strong>2 contagens</strong> (início e fim) e vendas TOTEM entre elas.</div></div>`;
    mussaHtml += comprasCard;
  }
  document.getElementById('pn-mussa').innerHTML = mussaHtml;
  document.getElementById('pn-mussa-nota').textContent =
    'A ficha técnica usa 130 g por pizza na maioria dos sabores (180–200 g nas premium e na mussarela). Diferença acima de ±10 g por pizza merece conversa com a cozinha.';

  // ---------- 7. Gramatura geral (g/pizza dividido pelas pizzas que LEVAM cada ingrediente) ----------
  const gramRows = Object.values(porIng)
    .filter(r=>r.unidade==='KG' && (pizzasIng[normIng(r.ing)]||0)>0)
    .map(r=>{
      const den = pizzasIng[normIng(r.ing)];
      return {...r, den, gT: r.esperado*1000/den, gR: r.real*1000/den};
    })
    .filter(r=>r.gT>=1 || r.gR>=1)  // ignora traços (orégano etc. com <1 g/pizza)
    .sort((a,b)=>b.impacto-a.impacto);
  const secGram = document.getElementById('pn-gram-secao');
  if (temJanela && gramRows.length) {
    secGram.classList.remove('d-none');
    const topGram = gramRows.filter(r=>r.gT>0).sort((a,b)=>b.gT-a.gT).slice(0,8);
    _pnCharts.push(new Chart(pnCanvas('pn-gram-chart'), {
      type:'bar',
      data:{labels: topGram.map(r=>r.ing),
        datasets:[
          {label:'Ficha (g/pizza)', data: topGram.map(r=>Math.round(r.gT)), backgroundColor:'rgba(26,82,118,.75)', borderRadius:3},
          {label:'Real (g/pizza)', data: topGram.map(r=>Math.round(r.gR)), backgroundColor:'rgba(146,43,33,.8)', borderRadius:3}
        ]},
      options:{indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{position:'bottom'},
        tooltip:{callbacks:{afterLabel:ctx=>` em ${fmtPizzas(Math.round(topGram[ctx.dataIndex].den))} pizzas`}}}, scales:{x:{beginAtZero:true}}}
    }));
    document.getElementById('pn-gram-tbody').innerHTML = gramRows.slice(0,20).map(r=>{
      const dif = r.gR-r.gT;
      const cls = r.impacto>100?'div-critica':r.impacto>30?'div-atencao':r.impacto<0?'text-primary':'div-ok';
      return `<tr>
        <td class="fw-semibold">${r.ing}<br><span class="text-muted small">${fmtPizzas(Math.round(r.den))} pizzas levam</span></td>
        <td class="text-end">${fmtNum(r.gT,0)} g</td>
        <td class="text-end">${fmtNum(r.gR,0)} g</td>
        <td class="text-end ${dif>0?'text-danger':'text-primary'}">${dif>0?'+':''}${fmtNum(dif,0)} g</td>
        <td class="text-end">${fmtNum(r.real,1)} kg</td>
        <td class="text-end fw-bold ${cls}">${r.impacto>0?'▲':'▼'} ${fmtBRL(Math.abs(r.impacto))}</td>
      </tr>`;
    }).join('');
  } else {
    secGram.classList.add('d-none');
  }

  // ---------- 8. Compras ----------
  const secCompras = document.getElementById('pn-compras-secao');
  if (comprasF.length) {
    secCompras.classList.remove('d-none');
    // por ingrediente
    const porIngCp = {};
    for (const c of comprasF) { const k=normIng(c.ingrediente); porIngCp[k]=(porIngCp[k]||0)+(c.valor_total||0); }
    const topCpIng = Object.entries(porIngCp).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
    const top8 = topCpIng.slice(0,8);
    const outros = topCpIng.slice(8).reduce((s,[,v])=>s+v,0);
    if (outros>0) top8.push(['OUTROS', outros]);
    _pnCharts.push(new Chart(pnCanvas('pn-cp-ing'), {
      type:'doughnut',
      data:{labels: top8.map(x=>x[0]), datasets:[{data: top8.map(x=>x[1]), backgroundColor: top8.map((x,i)=>PN_CORES[i%PN_CORES.length])}]},
      options:{plugins:{legend:{position:'bottom', labels:{boxWidth:12, font:{size:10}}},
        tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${fmtBRL(ctx.parsed)}`}}}}
    }));
    // por fornecedor
    const porForn = {};
    for (const c of comprasF) { const f=(c.fornecedor||'').trim()||'Sem fornecedor'; porForn[f]=(porForn[f]||0)+(c.valor_total||0); }
    const topForn = Object.entries(porForn).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
    _pnCharts.push(new Chart(pnCanvas('pn-cp-forn'), {
      type:'bar',
      data:{labels: topForn.map(x=>x[0].length>18?x[0].slice(0,18)+'…':x[0]),
        datasets:[{data: topForn.map(x=>x[1]), backgroundColor:'#1a5276', borderRadius:4}]},
      options:{indexAxis:'y', plugins:{legend:{display:false},
        tooltip:{callbacks:{label:ctx=>` ${fmtBRL(ctx.parsed.x)}`}}},
        scales:{x:{ticks:{callback:v=>'R$'+Math.round(v)}}}}
    }));
    // por semana
    const porSem = {};
    for (const c of comprasF) {
      const d = new Date(c.data+'T00:00:00'); d.setDate(d.getDate()-((d.getDay()+6)%7));
      const k = dataLocalISO(d);
      porSem[k] = (porSem[k]||0)+(c.valor_total||0);
    }
    const sems = Object.keys(porSem).sort();
    _pnCharts.push(new Chart(pnCanvas('pn-cp-sem'), {
      type:'line',
      data:{labels: sems.map(s=>fmtDate(s).slice(0,5)),
        datasets:[{label:'Compras R$', data: sems.map(s=>porSem[s]), borderColor:'#922b21',
          backgroundColor:'rgba(146,43,33,.15)', fill:true, tension:.25, pointRadius:3}]},
      options:{plugins:{legend:{display:false}, tooltip:{callbacks:{label:ctx=>` ${fmtBRL(ctx.parsed.y)}`}}},
        scales:{y:{beginAtZero:true, ticks:{callback:v=>'R$'+Math.round(v)}}}}
    }));
    // preço pago × referência
    const precoIng = {};
    for (const c of comprasF) {
      if (!(c.valor_total>0) || !(c.quantidade_base>0)) continue;
      const k = normIng(c.ingrediente);
      if (!precoIng[k]) precoIng[k] = {ing:c.ingrediente, qtd:0, valor:0, un:c.unidade_base};
      precoIng[k].qtd += c.quantidade_base; precoIng[k].valor += c.valor_total;
    }
    const precoRows = Object.values(precoIng).sort((a,b)=>b.valor-a.valor).slice(0,15);
    document.getElementById('pn-preco-tbody').innerHTML = precoRows.map(r=>{
      const pago = r.valor/r.qtd;
      const ref = getCustoIng(r.ing);
      const dif = ref>0 ? (pago-ref)/ref*100 : null;
      const cls = dif===null?'' : dif>5?'div-critica' : dif<-5?'div-ok' : 'text-muted';
      return `<tr>
        <td class="fw-semibold">${esc(r.ing)}</td>
        <td class="text-end">${fmtNum(r.qtd,1)} ${r.un}</td>
        <td class="text-end">${fmtBRL(r.valor)}</td>
        <td class="text-end">${fmtBRL(pago)}/${r.un.toLowerCase()}</td>
        <td class="text-end">${ref>0?fmtBRL(ref)+'/'+r.un.toLowerCase():'—'}</td>
        <td class="text-end fw-semibold ${cls}">${dif===null?'—':(dif>0?'+':'')+fmtPct(dif)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="text-center text-muted py-3">Nenhuma compra com valor no período.</td></tr>';
  } else {
    secCompras.classList.add('d-none');
  }

  // ---------- 9. Comparativo entre lojas ----------
  const lojasCard = document.getElementById('pn-lojas-card');
  if (!lojaSel) {
    lojasCard.classList.remove('d-none');
    document.getElementById('pn-lojas-tbody').innerHTML = lojas.map(l=>{
      const st = statsLoja[l];
      return `<tr>
        <td><span class="badge ${LOJA_BADGE[l]}">${LOJA_LABEL[l]}</span></td>
        <td class="text-end">${st.pizzas!=null?fmtNum(st.pizzas,0):'—'}</td>
        <td class="text-end">${st.comprasRS?fmtBRL(st.comprasRS):'—'}</td>
        <td class="text-end">${st.cmv!==null?fmtBRL(st.cmv):'—'}</td>
        <td class="text-end">${st.cmv!==null&&st.pizzasJanela>0?fmtBRL(st.cmv/st.pizzasJanela):'—'}</td>
        <td class="text-end ${st.desperdicio>0?'text-danger':''}">${st.desperdicio!==null?fmtBRL(st.desperdicio):'—'}</td>
        <td class="text-end">${st.estoque?fmtBRL(st.estoque):'—'}</td>
      </tr>`;
    }).join('');
  } else {
    lojasCard.classList.add('d-none');
  }
}

