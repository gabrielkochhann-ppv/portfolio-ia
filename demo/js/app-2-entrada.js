// ================================================================
// 6. DASHBOARD
// ================================================================
let _dashCharts = [];

// Valor do estoque de uma contagem. Se receber `compras`, avalia pelo PREÇO PAGO
// (compra mais próxima da data da contagem); sem `compras`, usa o preço-base.
function valorEstoqueContagem(ct, compras) {
  if (!ct) return 0;
  let v = 0;
  for (const [ing,val] of Object.entries(ct.ingredientes||{})) {
    const custo = compras ? custoPagoIng(ing, ct.data, ct.data, compras, ct.loja) : getCustoIng(ing);
    v += (val.total||0)*custo;
  }
  return v;
}

// ================================================================
//  CMV do CEO — DEFINIÇÕES OFICIAIS (auditoria mestre 02/07/2026, aceite do Gabriel):
//  Para a MESMA loja e MESMA janela de contagens (motor calcDivergencias, o mesmo da aba Estoque&CMV):
//    CMV REAL        = Σ consumo_real × custo pago   (só insumos SEM furo; bebidas fora)
//    CMV ESPERADO    = Σ consumo_esperado × custo    (MESMOS insumos e MESMA janela → comparável)
//    VARIAÇÃO LÍQUIDA = CMV real − CMV esperado      (bate ao centavo por construção; sobra abate perda)
//    PERDA BRUTA     = Σ max(impacto, 0)             (só as perdas; sobras NÃO abatem)
//    FURO            = insumo com consumo real NEGATIVO (fisicamente impossível: contagem/compra errada).
//                      Furo NÃO entra em nenhuma soma (não pode "melhorar" o CMV) e BLOQUEIA o fechamento.
//  JANELA MENSAL: a ponta inicial é a última contagem ≤ início do período, senão a PRIMEIRA contagem
//  dentro dele; a ponta final é a primeira contagem ≥ fim, senão a ÚLTIMA dentro dele (o que existir).
//  Dias do período FORA da janela entram como ESTIMATIVA por ficha (estimadoFora), mostrados à parte
//  com % de cobertura. Status: 'fechado' (100% coberto, sem furo) · 'parcial' (cobertura incompleta
//  ou loja sem janela) · 'bloqueado' (tem furo).
// `dados` (opcional): mesmos stores injetados de calcDivergencias — repassado ao motor e às estimativas.
async function cmvCeoInventario(lojasArr, ini, fim, dados) {
  const res = { real:0, esperado:0, variacao:0, perdaBruta:0, estimadoFora:0, furos:0, furosValor:0,
                insComprado:0, bebReal:0, bebComprado:0,
                diasPeriodo:0, diasCobertos:0, cobertura:0, status:'sem', ok:false,
                lojasOk:[], lojasSem:[], porLoja:{} };
  if (!ini || !fim) { res.lojasSem = lojasArr.slice(); return res; }
  const contagens = dados ? (dados.contagens||[]) : await DB.getAll('contagens');
  const dias = (a,b) => Math.round((new Date(b+'T00:00:00') - new Date(a+'T00:00:00'))/86400000) + 1;
  res.diasPeriodo = dias(ini, fim) * lojasArr.length;
  const statusLojas = [];
  for (const loja of lojasArr) {
    // Loja SEM janela de contagens: o CMV dela entra por ESTIMATIVA (ficha) do período INTEIRO — assim o
    // CMV da rede continua comparável com a receita da rede toda (auditoria P1), e o status vira Parcial.
    const semJanela = async () => { res.lojasSem.push(loja); res.estimadoFora += await cmvPeriodoCEO(loja, ini, fim, dados); };
    const cts = contagens.filter(c=>c.loja===loja).sort((a,b)=>a.data.localeCompare(b.data));
    // pontas da janela: contagem que cerca o período; senão a melhor DENTRO dele
    const effIni = [...cts].reverse().find(c=>c.data<=ini)?.data || cts.find(c=>c.data>=ini && c.data<fim)?.data;
    const effFim = cts.find(c=>c.data>=fim)?.data || [...cts].reverse().find(c=>c.data<=fim && effIni && c.data>effIni)?.data;
    if (!effIni || !effFim || effFim <= effIni) { await semJanela(); continue; }
    let d; try { d = await calcDivergencias(loja, effIni, effFim, dados); } catch(e) { await semJanela(); continue; }
    if (!d.temInicial || !d.temFinal || d.janelaVazia) { await semJanela(); continue; }

    let real=0, esp=0, perda=0, furos=0, furosValor=0, insComprado=0, bebReal=0, bebComprado=0; const itens=[];
    for (const r of d.resultado) {
      insComprado += (r.comprasTotal||0)*r.custo;   // valor COMPRADO de insumo no mês (mesmo se contagem furou)
      if (r.impossivel) { furos++; furosValor += Math.abs(r.consumoReal)*r.custo;
        itens.push({ing:r.ing, unidade:r.unidade, custo:r.custo, qReal:r.consumoReal, qEsp:r.esperado, real:0, esp:0, furo:true, suspeito:false});
        continue; }
      real  += r.consumoReal*r.custo;
      esp   += r.esperado*r.custo;
      perda += Math.max(r.impacto, 0);
      itens.push({ing:r.ing, unidade:r.unidade, custo:r.custo, qReal:r.consumoReal, qEsp:r.esperado,
                  real:r.consumoReal*r.custo, esp:r.esperado*r.custo, furo:false, suspeito:!!r.suspeito});
    }
    for (const b of (d.resultadoBebidas||[])) {   // BEBIDAS: mesma conta de consumo, custo próprio
      bebComprado += (b.comprasTotal||0)*b.custo;
      if (!b.impossivel) bebReal += b.consumoReal*b.custo;
    }
    // cobertura do PERÍODO pedido pela janela de consumo [janIni..janFim]
    const cIni = d.janIni > ini ? d.janIni : ini;
    const cFim = d.janFim < fim ? d.janFim : fim;
    const diasCob = cFim >= cIni ? dias(cIni, cFim) : 0;
    // dias sem cobertura → estimativa por ficha (mesmo escopo: sem bebidas)
    let estFora = 0;
    if (d.janIni > ini)  estFora += await cmvPeriodoCEO(loja, ini, addDiasISO(d.janIni, -1), dados);
    if (d.janFim < fim)  estFora += await cmvPeriodoCEO(loja, addDiasISO(d.janFim, 1), fim, dados);

    const stLoja = furos>0 ? 'bloqueado' : (diasCob >= dias(ini,fim) ? 'fechado' : 'parcial');
    statusLojas.push(stLoja);
    res.real+=real; res.esperado+=esp; res.perdaBruta+=perda; res.furos+=furos; res.furosValor+=furosValor;
    res.estimadoFora+=estFora; res.diasCobertos+=diasCob;
    res.insComprado+=insComprado; res.bebReal+=bebReal; res.bebComprado+=bebComprado;
    res.porLoja[loja] = {real, esperado:esp, variacao:real-esp, perdaBruta:perda, furos, furosValor,
                         estimadoFora:estFora, de:d.ctInicialData, ate:d.ctFinalData,
                         janIni:d.janIni, janFim:d.janFim, diasCobertos:diasCob, status:stLoja,
                         coberturaVendas:d.coberturaVendas, itens};
    res.lojasOk.push(loja); res.ok = true;
  }
  res.variacao = res.real - res.esperado;
  res.cobertura = res.diasPeriodo>0 ? res.diasCobertos/res.diasPeriodo : 0;
  res.status = !res.ok ? 'sem'
    : statusLojas.includes('bloqueado') ? 'bloqueado'
    : (res.lojasSem.length || statusLojas.includes('parcial')) ? 'parcial' : 'fechado';
  return res;
}

// Soma o consumo (em unidade-base) de um conjunto de importações TOTEM
function calcConsumoPeriodo(vendasArr) {
  const cons = {};
  for (const venda of vendasArr) {
    for (const item of (venda.itens||[])) {
      const map = resolverMap(item);
      if (!map || map.ignorar_no_consumo || map.categoria==='AGRUPADOR') continue;
      if (map.categoria==='ADICIONAL') {
        const ing = normIng(map.adicional_ingrediente);
        cons[ing] = (cons[ing]||0) + (ingEmUnidade(ing) ? map.porcao_gramas : map.porcao_gramas/1000)*item.qtde;
      } else if (['MEIA','INTEIRA','PREMIUM'].includes(map.categoria)) {
        const ficha = FICHA_TECNICA[map.nome_ficha];
        if (!ficha) continue;
        for (const [ing,g] of Object.entries(ficha._ingredientes)) {
          const n = normIng(ing);
          if (MASSA_SET.has(n)) continue; // insumos da massa entram pela receita da massa
          const emUn = ['OVO','CAIXA'].includes(n);
          cons[n] = (cons[n]||0) + (emUn?g:g/1000)*map.fator_consumo*item.qtde;
        }
        addConsumoMassa(cons, map.fator_consumo*item.qtde);
        addConsumoEmbalagem(cons, map.categoria, map.fator_consumo*item.qtde, item.sku);
      } else if (map.categoria==='BEBIDA') {
        const b = norm(map.bebida_estoque);
        cons[b] = (cons[b]||0) + item.qtde;
      }
    }
  }
  return cons;
}

function pizzasDeVenda(v) { return contarPizzas(v.itens); }

// Vendas TOTEM que caem na janela de consumo devolvida por calcDivergencias — MESMO filtro de
// sobreposição que o motor usa internamente (vendasLoja). Todo denominador "pizzas da janela"
// (custo de ingrediente/pizza do Painel, do Comparativo Lojas etc.) tem que sair daqui, senão
// a mesma janela dá custo/pizza diferente em telas diferentes (bug corrigido em jul/2026).
function vendasDaJanela(vendas, loja, d) {
  if (!d || d.janelaVazia) return [];
  return vendas.filter(v => v.loja===loja && v.data_fim >= d.janIni && v.data_inicio <= d.janFim);
}

// PIZZAS VENDIDAS — A RÉGUA ÚNICA (decisão do Gabriel, 18/08 e 21/09/2026: "nada que mostre número
// de pizzas pode ser aproximado; o app diz o MESMO número em todas as abas"). Fonte = resumo do TOTEM
// (`pizzas_canal` do pedidos_resumo.json), só os CANAIS_REAIS (JANTA = consumo interno, fora),
// inteira = 1, meia = 0,5. É o número da Visão, do Painel do CEO e do Pizzas por dia, e é o
// DENOMINADOR de todo "por pizza" (custo de ingrediente/pizza etc.).
// NÃO recontar pizzas pelas vendas importadas (`contarPizzas`): elas servem para SABOR (o resumo não
// tem sabor), mas um produto sem sabor cadastrado some da contagem delas — medido 21/09: 59 de 126
// dias-loja diferentes, todos por 5 produtos novos sem mapeamento (ver `pizzasForaDoMapa`).
// Devolve null quando o resumo não carregou: a tela mostra "—", nunca uma estimativa.
function pizzasDoResumo(ceo, lojas, ini, fim) {
  if (!ceo || !Array.isArray(ceo.pizzas_canal)) return null;
  let t = 0;
  for (const r of ceo.pizzas_canal) {
    if (!lojas.includes(r.loja) || !CANAIS_REAIS.includes(r.canal)) continue;
    if ((ini && r.data < ini) || (fim && r.data > fim)) continue;
    t += r.pizzas || 0;
  }
  return t;
}
// Pizzas na janela de consumo do motor (janIni..janFim de calcDivergencias) — os MESMOS dias de
// `vendasDaJanela`, contados pela régua única.
function pizzasDaJanela(ceo, loja, d) {
  if (!d || d.janelaVazia) return 0;
  return pizzasDoResumo(ceo, [loja], d.janIni, d.janFim);
}
// Conciliação entre as duas contagens: produtos que o TOTEM conta como pizza pelo código (PI/PR/PPI
// = 1, PM/PPM = 0,5 — a regra do robô) mas que o app não sabe o sabor (sem mapeamento → ficam fora do
// consumo esperado e dos sabores), e o contrário (mapeados como pizza, mas o resumo não conta).
// Explica, produto a produto, por que a soma dos sabores difere do total de pizzas.
function pizzasForaDoMapa(vendasArr) {
  const semSabor = {}, foraDoResumo = {};
  for (const v of (vendasArr||[])) for (const it of (v.itens||[])) {
    const pre = categoriaPorPrefixoSku(it.sku);
    const pzPre = pre==='MEIA' ? 0.5 : (pre==='INTEIRA' || pre==='PREMIUM') ? 1 : 0;
    const m = resolverMap(it);
    const ehPizzaMapa = !!(m && ['MEIA','INTEIRA','PREMIUM'].includes(m.categoria));
    const nome = it.produto || it.sku || '?';
    if (pzPre && !ehPizzaMapa) { const s = semSabor[nome] = semSabor[nome] || {produto:nome, sku:it.sku, pizzas:0}; s.pizzas += it.qtde*pzPre; }
    else if (!pzPre && ehPizzaMapa) { const s = foraDoResumo[nome] = foraDoResumo[nome] || {produto:nome, sku:it.sku, pizzas:0}; s.pizzas += it.qtde*(m.fator_consumo||1); }
  }
  const ord = o => Object.values(o).sort((a,b)=>b.pizzas-a.pizzas);
  return { semSabor: ord(semSabor), foraDoResumo: ord(foraDoResumo) };
}
// Frase curta da conciliação (vazia quando as duas contagens batem).
function notaPizzasForaDoMapa(vendasArr) {
  const {semSabor, foraDoResumo} = pizzasForaDoMapa(vendasArr);
  const lista = arr => arr.slice(0,4).map(x=>`${esc(x.produto)} (${fmtPizzas(x.pizzas)})`).join(', ') + (arr.length>4 ? ` e mais ${arr.length-4}` : '');
  const partes = [];
  if (semSabor.length) partes.push(`<strong>Sem sabor cadastrado</strong> em Mapear produtos (entram no total, mas não nos sabores nem no consumo esperado): ${lista(semSabor)}.`);
  if (foraDoResumo.length) partes.push(`<strong>Contam como pizza aqui, mas não no resumo do TOTEM</strong> (código fora do padrão PI/PM/PPI/PPM): ${lista(foraDoResumo)}.`);
  return partes.join(' ');
}

// Conta os dias REALMENTE cobertos por um conjunto de importações de venda,
// unindo intervalos sobrepostos para não contar o mesmo dia duas vezes.
// É o denominador honesto do consumo/dia (substitui o "÷28 fixo" antigo).
function diasCobertosVendas(vendasArr) {
  const diaMs = 86400000;
  const dias = (a,b)=>Math.round((new Date(b+'T00:00:00') - new Date(a+'T00:00:00'))/diaMs) + 1;
  const ivs = (vendasArr||[])
    .filter(v => v.data_inicio && v.data_fim && v.data_fim >= v.data_inicio)
    .map(v => [v.data_inicio, v.data_fim])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  if (!ivs.length) return 0;
  let total = 0, curIni = ivs[0][0], curFim = ivs[0][1];
  for (let i=1; i<ivs.length; i++) {
    const [ini,fim] = ivs[i];
    if (ini <= curFim) { if (fim > curFim) curFim = fim; }   // sobrepõe → estende
    else { total += dias(curIni,curFim); curIni = ini; curFim = fim; } // separado → fecha bloco
  }
  total += dias(curIni,curFim);
  return total;
}

// Seleciona as vendas da janela de análise escolhida pelo usuário (N dias até a venda
// mais recente; janelaDias<=0 = usar tudo). Devolve {vendasJanela, refDate, corteISO}.
function vendasNaJanela(vendasLoja, janelaDias) {
  if (!vendasLoja.length) return {vendasJanela:[], refDate:null, corteISO:null};
  const refDate = vendasLoja.map(v=>v.data_fim).sort().pop();
  if (!janelaDias || janelaDias <= 0) return {vendasJanela:vendasLoja.slice(), refDate, corteISO:null};
  const corte = new Date(refDate+'T00:00:00'); corte.setDate(corte.getDate() - (janelaDias-1));
  const corteISO = dataLocalISO(corte);
  return {vendasJanela: vendasLoja.filter(v=>v.data_fim>=corteISO && v.data_fim<=refDate), refDate, corteISO};
}

function diasDesde(iso) {
  if (!iso) return null;
  return Math.floor((new Date(today()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);
}

// "Hospedado" = app aberto num servidor de verdade (Netlify), não no PC.
// No PC o uso normal é duplo-clique (protocol file:); o preview do Claude roda em localhost.
// Só o celular via Netlify é http(s) com domínio externo. Lá o app é SÓ CONSULTA (restaura
// backup pra ver os números) → lembrar de "fazer backup" não faz sentido e vira ruído.
function appHospedado() {
  return (location.protocol === 'http:' || location.protocol === 'https:')
      && !['localhost','127.0.0.1',''].includes(location.hostname);
}
// "Modo leve": celular (tela pequena/touch) ou aberto pela Netlify — corta animações e listas gigantes.
function modoLeveCelular() {
  return appHospedado() || (window.matchMedia && matchMedia('(max-width: 820px), (pointer:coarse)').matches);
}

// Preenche um seletor de mês (últimos 12 meses) uma única vez; default = mês corrente.
// Usado no Dashboard (#dash-mes), no Painel do CEO (#ceo-mes) e em Custos Fixos (#cf-mes).
function popularSelMeses(selId) {
  const sel = document.getElementById(selId); if (!sel || sel.options.length) return;
  const base = new Date(today()+'T00:00:00');
  for (let i=0;i<12;i++) {
    const d = new Date(base.getFullYear(), base.getMonth()-i, 1);
    const ym = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    const o = document.createElement('option');
    o.value = ym; o.textContent = MES_ABREV[d.getMonth()]+'/'+String(d.getFullYear()).slice(2);
    sel.appendChild(o);
  }
  sel.value = today().slice(0,7);
}
function popularDashMeses(){ popularSelMeses('dash-mes'); }
// Devolve {ini, fim} do mês 'AAAA-MM' (fim = hoje se for o mês corrente; senão o último dia do mês).
function limitesDoMes(ym) {
  const hoje = today();
  const ultDia = new Date(parseInt(ym.slice(0,4),10), parseInt(ym.slice(5,7),10), 0).getDate();
  return { ini: ym+'-01', fim: (ym===hoje.slice(0,7)) ? hoje : ym+'-'+String(ultDia).padStart(2,'0') };
}
function ceoMesChange() {
  const ym = document.getElementById('ceo-mes').value; if (!ym) return;
  const {ini, fim} = limitesDoMes(ym);
  document.getElementById('ceo-ini').value = ini;
  document.getElementById('ceo-fim').value = fim;
  renderCEO();
}

async function renderDashboard() {
  const [contagens, compras, transf] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);
  // VELOCIDADE (22/09): esta é a PRIMEIRA tela do app e baixava a tabela de vendas inteira (desde 2022)
  // a cada abertura. Agora só desde o dia mais antigo que alguma conta daqui usa: o início do mês
  // escolhido, os últimos 56 dias (ritmo por dia da semana dos críticos) e a 1ª contagem (gramatura
  // real entre contagens e consumo desde a última contagem). Todo filtro abaixo já cortava nesses dias,
  // então os números são os mesmos. O mês é lido do seletor aqui só para isso (o resto segue abaixo).
  const _mesVendas = (document.getElementById('dash-mes')||{}).value || today().slice(0,7);
  const _d56 = dataLocalISO((d=>{ d.setDate(d.getDate()-56); return d; })(new Date()));
  const _desdeVendas = [_mesVendas + '-01', _d56, ...contagens.map(c=>c.data).filter(Boolean)].sort()[0];
  let vendas = DB.vendasPeriodo ? await DB.vendasPeriodo(_desdeVendas, null) : await DB.getAll('vendas');

  // Filtro de loja do hero (padrão = todas). Como quase tudo itera sobre `lojas`, restringir esse
  // conjunto já filtra KPIs, cards por loja, críticos, estoque e gráficos por loja de uma vez.
  const lojaFiltro = (document.getElementById('dash-loja')||{}).value || '';
  const lojas = lojaFiltro ? [lojaFiltro] : LOJAS_ATIVAS();
  // Janela móvel de 30 dias — usada nas métricas OPERACIONAIS (dias de estoque, capital parado),
  // onde um ritmo de consumo estável importa mais que o recorte do mês.
  const corte30 = new Date(); corte30.setDate(corte30.getDate()-30);
  const dt30 = dataLocalISO(corte30);
  // Mês escolhido no seletor do hero (padrão = mês corrente). Os KPIs de TRANSAÇÃO (faturamento,
  // compras, pizzas, média/dia) e os gráficos "este mês" seguem esse mês; o valor em estoque e os
  // alertas de cobertura continuam SEMPRE no atual (ver [[estoque = situação de hoje]]).
  popularDashMeses();
  const hojeISO = today();
  const dmSel = document.getElementById('dash-mes');
  const mesSel = (dmSel && dmSel.value) || hojeISO.slice(0,7);
  const dtMes = mesSel + '-01';
  if (dtMes < _desdeVendas && DB.vendasPeriodo) vendas = await DB.vendasPeriodo(dtMes, null);   // seletor mudou no meio: relê do mês certo
  // fim do intervalo: hoje se for o mês corrente; senão o último dia do mês escolhido.
  const ultDiaDoMes = new Date(parseInt(mesSel.slice(0,4),10), parseInt(mesSel.slice(5,7),10), 0).getDate();
  const fimMes = (mesSel === hojeISO.slice(0,7)) ? hojeISO : (mesSel + '-' + String(ultDiaDoMes).padStart(2,'0'));
  const labelMes = (() => { const [a,m]=mesSel.split('-'); return MES_ABREV[parseInt(m,10)-1]+'/'+a.slice(2); })();

  // Estado vazio: boas-vindas + passo a passo
  if (!contagens.length && !vendas.length && !compras.length) {
    _dashCharts.forEach(c=>c.destroy()); _dashCharts=[];
    document.getElementById('dash-content').innerHTML = `
      <div class="card"><div class="card-body text-center py-5">
        <i class="fas fa-pizza-slice fa-3x mb-3" style="color:var(--cor)"></i>
        <h5>Bem-vindo ao seu controle de estoque!</h5>
        <p class="text-muted">Para começar, siga estes passos:</p>
        <div class="row g-3 justify-content-center mt-2">
          <div class="col-md-3"><div class="stat-card h-100"><div class="val fs-4">1</div><div class="lbl">Faça a <strong>Contagem</strong> inicial de cada loja</div></div></div>
          <div class="col-md-3"><div class="stat-card h-100"><div class="val fs-4">2</div><div class="lbl">Importe o CSV de <strong>Vendas TOTEM</strong></div></div></div>
          <div class="col-md-3"><div class="stat-card h-100"><div class="val fs-4">3</div><div class="lbl">Registre as <strong>Compras</strong> (XML da nota ou planilha)</div></div></div>
          <div class="col-md-3"><div class="stat-card h-100"><div class="val fs-4">4</div><div class="lbl">Rode a análise de <strong>Divergências</strong></div></div></div>
        </div>
        <button class="btn btn-primary mt-4" onclick="showPage('contagem')"><i class="fas fa-clipboard-list me-1"></i>Começar pela Contagem</button>
      </div></div>`;
    return;
  }

  // Indicadores por loja
  const info = {};
  let valorRede = 0, compras30 = 0, pizzas30 = 0;
  const criticos = [];

  for (const loja of lojas) {
    const cts = contagens.filter(x=>x.loja===loja).sort((a,b)=>b.data.localeCompare(a.data));
    const ct = cts[0];
    const valor = valorEstoqueContagem(ct, compras);
    valorRede += valor;
    const cpr30 = compras.filter(x=>x.loja===loja && x.data>=dtMes && x.data<=fimMes).reduce((s,x)=>s+(x.valor_total||0),0);
    compras30 += cpr30;
    const vds = vendas.filter(x=>x.loja===loja);
    const pz30 = vds.filter(v=>v.data_fim>=dtMes && v.data_fim<=fimMes).reduce((s,v)=>s+pizzasDeVenda(v),0);
    pizzas30 += pz30;

    // Itens críticos: estoque ATUAL estimado ÷ consumo médio diário. O estoque atual =
    // última contagem + compras/transferências lançadas DEPOIS dela − o que foi vendido desde então.
    // Assim, quando o Gabriel lança as compras da semana, o alerta se atualiza (some o que já repôs).
    if (ct) {
      // Estoque ATUAL estimado = última contagem + compras/transf. lançadas DEPOIS − vendido desde então.
      // A contagem "antes da noite" (abertura) NÃO inclui as vendas daquele dia → elas ainda
      // precisam ser descontadas do estoque contado. A "fim da noite" (fechamento) já as inclui.
      // Mesmo critério para compras/transferências lançadas no dia da contagem. (default = antes)
      const contagemFim = (ct.momento === 'fim');
      const apos = d => contagemFim ? d > ct.data : d >= ct.data;
      const consApos = calcConsumoPeriodo(vds.filter(v=>apos(v.data_fim)));                     // vendido desde a contagem
      const compApos = {};   // compras lançadas desde a contagem (já em unidade-base)
      for (const c of compras) if (c.loja===loja && apos(c.data)) {
        const k = normIng(c.ingrediente); compApos[k] = (compApos[k]||0) + (c.quantidade_base||0);
      }
      const transfApos = {}; // transferências desde a contagem (entradas − saídas)
      for (const t of transf) if (apos(t.data)) {
        const k = normIng(t.ingrediente);
        if (t.loja_destino===loja) transfApos[k] = (transfApos[k]||0) + (t.quantidade||0);
        if (t.loja_origem===loja)  transfApos[k] = (transfApos[k]||0) - (t.quantidade||0);
      }

      // Padrão de venda por DIA DA SEMANA (sáb vende ~2x uma segunda): pizzas médias por dia-da-semana
      // dos últimos 56 dias. As DUAS coberturas projetam os próximos dias por ESSE mesmo padrão — assim a
      // diferença entre elas passa a ser SÓ o gap real×ficha (o desperdício), não um artefato de calendário.
      const d56 = dataLocalISO((d=>{ d.setDate(d.getDate()-56); return d; })(new Date()));
      const vdsDia = vds.filter(v => v.data_inicio===v.data_fim && v.data_fim>=d56);   // só registros de 1 dia (TOTEM)
      const grpDow = [[],[],[],[],[],[],[]]; const diasDow = [0,1,2,3,4,5,6].map(()=>new Set());
      const pzDow = [0,0,0,0,0,0,0];
      for (const v of vdsDia) { const w = new Date(v.data_fim+'T00:00:00').getDay(); grpDow[w].push(v); diasDow[w].add(v.data_fim); pzDow[w]+=pizzasDeVenda(v); }
      const pzPorDow = pzDow.map((s,w)=> diasDow[w].size ? s/diasDow[w].size : 0);   // pizzas médias naquele dia-da-semana

      // COBERTURA PELA FICHA (teórica): consumo médio por dia-da-semana pela ficha (já embute pizzas × gramatura da ficha).
      const avgDow = grpDow.map((g,w)=>{ const cons = calcConsumoPeriodo(g); const nd = diasDow[w].size||1; const m={}; for (const k in cons) m[k]=cons[k]/nd; return m; });
      const temFicha = avgDow.some(m => Object.keys(m).length);

      // COBERTURA PELA MÉDIA (real): gramas/pizza REAIS (acúmulo de TODAS as janelas entre contagens) × pizzas do
      // dia-da-semana. gramas/pizza real = Σ consumo real medido ÷ Σ pizzas dessas janelas (captura o desperdício real).
      const ctsAsc = cts.slice().sort((a,b)=>a.data.localeCompare(b.data));
      let gramaPP = null;
      if (ctsAsc.length >= 2) {
        const tot = {}; let pzTot = 0; const add = (k,v)=> tot[k] = (tot[k]||0) + v;
        for (let idx=1; idx<ctsAsc.length; idx++) {
          const E = ctsAsc[idx-1], L = ctsAsc[idx];
          const dias = (new Date(L.data+'T00:00:00') - new Date(E.data+'T00:00:00'))/86400000;
          if (dias<=0 || dias>45) continue;                                   // ignora janelas absurdas
          let pz = 0; for (const v of vds) if (v.data_fim>E.data && v.data_fim<=L.data) pz += pizzasDeVenda(v);
          if (pz<=0) continue;                                                // sem vendas na janela → não dá p/ ratear por pizza
          pzTot += pz;
          for (const [ing,v] of Object.entries(E.ingredientes||{})) add(normIng(ing),  (v.total||0));   // inicial
          for (const [ing,v] of Object.entries(L.ingredientes||{})) add(normIng(ing), -(v.total||0));   // final
          for (const c of compras) if (c.loja===loja && c.data>E.data && c.data<=L.data) add(normIng(c.ingrediente), (c.quantidade_base||0));
          for (const t of transf) if (t.data>E.data && t.data<=L.data) { const k=normIng(t.ingrediente); if(t.loja_destino===loja) add(k,(t.quantidade||0)); if(t.loja_origem===loja) add(k,-(t.quantidade||0)); }
        }
        if (pzTot>0) { gramaPP = {}; for (const k in tot) gramaPP[k] = Math.max(tot[k],0)/pzTot; }   // furo (negativo) não vira crédito
      }

      // Projeta os próximos 60 dias começando HOJE (as vendas de hoje ainda não saíram do estoque),
      // subtraindo o consumo do respectivo dia-da-semana. Mesma mecânica p/ as duas coberturas.
      const coberturaDias = (consFn, estoque)=>{
        let semana=0; for (let w=0;w<7;w++) semana += consFn(w);
        if (semana<=0) return null;                          // sem consumo previsto → não crítico
        let rem=estoque, dias=0; const hoje=new Date(today()+'T00:00:00');
        for (let i=0;i<=60;i++){ const w=new Date(hoje.getTime()+i*86400000).getDay(); const c=consFn(w);
          if (c<=0){ dias+=1; continue; }
          if (rem - c >= 0){ rem-=c; dias+=1; } else { dias += rem/c; rem=0; break; } }
        return dias;
      };

      for (const [ing,val] of Object.entries(ct.ingredientes||{})) {
        if (!alertaAtivoInsumo(ing)) continue;          // insumo desligado do alerta pelo usuário
        const k = normIng(ing), kn = norm(ing);
        const estoque = Math.max((val.total||0) + (compApos[k]||0) + (transfApos[k]||0) - (consApos[k]||consApos[kn]||0), 0);
        const diasMedia = gramaPP ? coberturaDias(w => (gramaPP[k]||gramaPP[kn]||0) * pzPorDow[w], estoque) : null;
        const diasFicha = temFicha ? coberturaDias(w => (avgDow[w][k]||avgDow[w][kn]||0), estoque) : null;
        if (diasMedia===null && diasFicha===null) continue;   // sem como estimar o consumo → não alerta
        const lim = alertaDiasInsumo(ing);            // dias de cobertura mínimos p/ este insumo
        const critMedia = diasMedia!==null && diasMedia < lim;
        const critFicha = diasFicha!==null && diasFicha < lim;
        if (critMedia || critFicha) {                 // alerta se QUALQUER uma das coberturas furar o limite
          const dias = Math.min(diasMedia!==null?diasMedia:Infinity, diasFicha!==null?diasFicha:Infinity);
          criticos.push({loja, ing, diasMedia, diasFicha, dias, lim, total:estoque, contado:(val.total||0), dataCt:ct.data, un:val.unidade});
        }
      }
    }

    info[loja] = {ct, valor, cpr30, pz30,
      ultimoTotem: vds.slice().sort((a,b)=>b.data_fim.localeCompare(a.data_fim))[0]};
  }
  criticos.sort((a,b)=>a.dias-b.dias);

  // Pizzas do ÚLTIMO DIA (granularidade diária vem do pedidos_resumo.json — TOTEM).
  // Gabriel quer acompanhar o dia anterior. Usa a maior data disponível (último dia com vendas).
  const ceoDash = await carregarCEO();
  let pzUltDia = 0, ultDiaData = null; const pzUltPorLoja = {};
  if (ceoDash && Array.isArray(ceoDash.pizzas_canal) && ceoDash.pizzas_canal.length) {
    // CANAIS REAIS também no ÚLTIMO DIA (corrigido 30/07/2026). O total do mês, logo abaixo, já
    // filtrava por CANAIS_REAIS, mas o do dia somava TUDO — inclusive a JANTA (consumo interno,
    // meia pizza a R$ 0). Resultado: "Pizzas vendidas" do dia vinha inflada e não batia nem com o
    // número do mês na mesma tela, nem com a aba Pizzas por Dia.
    const canalReal = ceoDash.pizzas_canal.filter(r => CANAIS_REAIS.includes(r.canal));
    ultDiaData = canalReal.reduce((m,r)=> r.data>m ? r.data : m, '');   // último dia é igual p/ todas as lojas
    for (const r of canalReal) if (r.data===ultDiaData && lojas.includes(r.loja)) {
      pzUltDia += r.pizzas; pzUltPorLoja[r.loja] = (pzUltPorLoja[r.loja]||0) + r.pizzas;
    }
    // Pizzas do MÊS pela MESMA base do Painel do CEO (pizzas_canal do TOTEM, só canais reais) → os dois
    // painéis batem. Sem os JSONs (celular), fica o pz30 do store de vendas já calculado acima.
    const pzMes = {}; let pzMesTot = 0;
    for (const r of ceoDash.pizzas_canal) {
      if (r.data < dtMes || r.data > fimMes || !CANAIS_REAIS.includes(r.canal) || !lojas.includes(r.loja)) continue;
      pzMes[r.loja] = (pzMes[r.loja]||0) + r.pizzas; pzMesTot += r.pizzas;
    }
    for (const loja of lojas) info[loja].pz30 = pzMes[loja] || 0;
    pizzas30 = pzMesTot;
  }

  // Cards por loja
  const lojaCards = lojas.map(loja=>{
    const i = info[loja];
    const dCt = i.ct ? diasDesde(i.ct.data) : null;
    const ctBadge = dCt===null ? '<span class="text-danger">nunca</span>'
      : dCt>7 ? `<span class="text-danger fw-bold">${fmtDate(i.ct.data)} (há ${dCt}d!)</span>`
      : `${fmtDate(i.ct.data)} <span class="text-muted">(há ${dCt}d)</span>`;
    return `
    <div class="col-md-4">
      <div class="card h-100">
        <div class="card-header d-flex justify-content-between align-items-center">
          <span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span>
          <span class="fw-bold" style="color:var(--cor)">${fmtBRL(i.valor||0)==='—'?'R$ 0,00':fmtBRL(i.valor)}</span>
        </div>
        <div class="card-body py-2">
          <table class="table table-sm table-borderless mb-2 small">
            <tr><td class="text-muted">Última contagem</td><td class="text-end">${ctBadge}</td></tr>
            <tr><td class="text-muted">Último TOTEM</td><td class="text-end">${i.ultimoTotem?fmtDate(i.ultimoTotem.data_fim):'—'}</td></tr>
            <tr><td class="text-muted">Compras (${labelMes})</td><td class="text-end">${fmtBRL(i.cpr30)}</td></tr>
            <tr><td class="text-muted">Pizzas (${labelMes})</td><td class="text-end">${i.pz30?i.pz30.toFixed(0):'—'}</td></tr>
            <tr><td class="text-muted">Pizzas (último dia${ultDiaData?' · '+fmtDate(ultDiaData).slice(0,5):''})</td><td class="text-end fw-semibold">${pzUltPorLoja[loja]!=null?Math.round(pzUltPorLoja[loja]):'—'}</td></tr>
          </table>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-primary flex-fill" onclick="setLoja('${loja}');showPage('contagem')">Contagem</button>
            <button class="btn btn-sm btn-outline-secondary flex-fill" onclick="setLoja('${loja}');showPage('analise')">Analisar</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Alertas de estoque crítico
  const cobCell = (d, lim) => d===null ? '<span class="text-muted">—</span>'
    : `<span class="${d < lim*0.4 ? 'div-critica' : (d < lim ? 'div-atencao' : '')}">${d>=60?'60+':d.toFixed(1)} dias</span>`;
  const alertasHtml = criticos.length ? criticos.slice(0,10).map(c=>`
    <tr>
      <td><span class="badge ${LOJA_BADGE[c.loja]}">${LOJA_LABEL[c.loja]}</span></td>
      <td class="fw-semibold">${esc(c.ing)}<br><span class="text-muted fw-normal" style="font-size:11px">alerta &lt; ${c.lim||7}d</span></td>
      <td class="text-end">${fmtNum(c.contado,2)} ${c.un||''}<br><span class="text-muted" style="font-size:11px">${c.dataCt?fmtDate(c.dataCt).slice(0,5):''}</span></td>
      <td class="text-end">${fmtNum(c.total,2)} ${c.un||''}</td>
      <td class="text-end">${cobCell(c.diasMedia, c.lim||7)}</td>
      <td class="text-end">${cobCell(c.diasFicha, c.lim||7)}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="text-center text-success py-3"><i class="fas fa-check-circle me-1"></i>Nenhum item crítico — estoque saudável!</td></tr>';

  // Lembrete de backup: os dados vivem só no IndexedDB deste navegador
  const ultimoBk = localStorage.getItem('ultimo_backup_em');
  const diasBk = ultimoBk ? Math.floor((Date.now() - new Date(ultimoBk).getTime())/86400000) : null;
  const bannerBk = ((diasBk === null || diasBk > 7) && !appHospedado()) ? `
    <div class="alert alert-warning d-flex justify-content-between align-items-center flex-wrap gap-2 py-2 mb-3">
      <span><i class="fas fa-floppy-disk me-1"></i><strong>Backup:</strong>
        ${diasBk===null ? 'você ainda não baixou nenhum backup' : 'o último backup foi há '+diasBk+' dias'}.
        Os dados ficam só neste navegador — um backup por semana evita sustos.</span>
      <button class="btn btn-sm btn-warning" onclick="showPage('backup')"><i class="fas fa-download me-1"></i>Fazer backup agora</button>
    </div>` : '';

  // --- RESUMO DE ONTEM + faturamento médio/dia do mês (TOTEM via pedidos_resumo.json) ---
  // 99Food entra pelo repasse REAL quando lançado; senão pelo fator estimado (mesma regra do Painel do CEO).
  // Faturamento OFICIAL = soma das formas de pagamento (fonte única, = aba Pagamentos e Painel do CEO).
  const pagDash = await carregarPagamentos();
  const ffMes = faturamentoFormas(pagDash, lojaFiltro||null, dtMes, fimMes);
  let fatOntem = 0, fatMes = 0, ultDataFatMes = null;
  if (ffMes.temDados) {
    fatMes = ffMes.total;
    for (const dt in ffMes.porDia) if (!ultDataFatMes || dt>ultDataFatMes) ultDataFatMes = dt;
    fatOntem = ultDiaData ? faturamentoFormas(pagDash, lojaFiltro||null, ultDiaData, ultDiaData).total : 0;
  } else {
    // Fallback (sem as Formas de Pagamento carregadas): pedidos, 99Food pelo repasse/fator (modo antigo).
    const repasse99 = repasseEfetivo(ceoDash&&ceoDash.repasse_99);
    const net99 = r => r.canal==='99Food'
      ? (repasse99[r.loja+'|'+r.data] != null ? repasse99[r.loja+'|'+r.data] : r.faturamento*(FATOR_99[r.loja]||FATOR_99._default))
      : r.faturamento;
    if (ceoDash && Array.isArray(ceoDash.por_dia)) for (const r of ceoDash.por_dia) {
      if (r.canal==='Outros' || !lojas.includes(r.loja)) continue;   // JANTA/Outros e lojas fora do filtro
      if (ultDiaData && r.data===ultDiaData) fatOntem += net99(r);
      if (r.data >= dtMes && r.data <= fimMes) { fatMes += net99(r); if (!ultDataFatMes || r.data>ultDataFatMes) ultDataFatMes = r.data; }
    }
  }
  const diasCorridosMes = ultDataFatMes ? parseInt(ultDataFatMes.slice(8,10),10) : parseInt(fimMes.slice(8,10),10);
  const fatMediaDia = diasCorridosMes>0 ? fatMes/diasCorridosMes : 0;

  // Variação vs MÊS PASSADO — comparação JUSTA: mesmo recorte de dias (do dia 1 até o dia que estamos
  // no mês atual), pra não dar falso alarme no começo do mês. Só com as formas carregadas (mesma base).
  const diaCorte = parseInt(fimMes.slice(8,10),10);
  let varMesPct = null, fatMesAnt = 0;
  if (ffMes.temDados) {
    const [ay, am] = mesSel.split('-').map(Number);
    const dPrev = new Date(ay, am-2, 1);                       // mês anterior ao selecionado
    const mesAntISO = dPrev.getFullYear()+'-'+String(dPrev.getMonth()+1).padStart(2,'0');
    const ultDiaMesAnt = new Date(dPrev.getFullYear(), dPrev.getMonth()+1, 0).getDate();
    const diaCorteAnt = Math.min(diaCorte, ultDiaMesAnt);      // fev não tem dia 30/31
    fatMesAnt = faturamentoFormas(pagDash, lojaFiltro||null, mesAntISO+'-01', mesAntISO+'-'+String(diaCorteAnt).padStart(2,'0')).total;
    if (fatMesAnt > 0) varMesPct = (fatMes - fatMesAnt) / fatMesAnt * 100;
  }

  // Sabor campeão de ontem: registros DIÁRIOS do TOTEM (data_inicio===data_fim) já no IndexedDB.
  let saborTopNome = null, saborTopQtd = 0;
  if (ultDiaData) {
    const saborQtd = {};
    for (const v of vendas) {
      if (v.data_inicio!==ultDiaData || v.data_fim!==ultDiaData) continue;
      for (const it of (v.itens||[])) {
        const map = resolverMap(it);
        if (!map || !['MEIA','INTEIRA','PREMIUM'].includes(map.categoria)) continue;
        const nome = map.nome_ficha || it.produto; if (!nome) continue;
        saborQtd[nome] = (saborQtd[nome]||0) + (map.fator_consumo||1)*(it.qtde||0);
      }
    }
    const top = Object.entries(saborQtd).sort((a,b)=>b[1]-a[1])[0];
    if (top) { saborTopNome = top[0]; saborTopQtd = top[1]; }
  }

  // Clientes novos de ontem (canal próprio com cadastro) — clientes_resumo.json. Por loja + total.
  let cliNovosOntem = null; const cliNovosPorLoja = {};
  if (ultDiaData) {
    const cli = await carregarClientes();
    if (cli && cli.lojas) { cliNovosOntem = 0; for (const loja of lojas) { const nd = cli.lojas[loja] && cli.lojas[loja].novos_dia; const n = (nd && nd[ultDiaData]!=null) ? nd[ultDiaData] : 0; cliNovosPorLoja[loja] = n; cliNovosOntem += n; } }
  }

  // Vendas canceladas de ontem (vw_financeiro via pagamentos_resumo.json) — pedido do Gabriel.
  let cancOntemN = 0, cancOntemVal = 0;
  if (ultDiaData) {
    const pag = await carregarPagamentos();
    if (pag && Array.isArray(pag.cancelamentos)) for (const c of pag.cancelamentos) {
      if (c.data===ultDiaData && lojas.includes(c.loja)) { cancOntemN += c.n; cancOntemVal += c.valor; }
    }
  }

  const cockpit = [];
  for (const c of criticos.slice(0,4))
    cockpit.push({sev: c.dias < (c.lim||7)*0.4 ?'danger':'warning', icon:'fa-fire',
      txt:`<strong>${LOJA_LABEL[c.loja]}:</strong> ${esc(c.ing)} acaba em ${c.dias.toFixed(1)} dia(s)`,
      acao:`setLoja('${c.loja}');showPage('comprassemana')`, btn:'Comprar'});
  for (const loja of lojas) {
    const ct = info[loja].ct; const d = ct ? diasDesde(ct.data) : null;
    if (d===null) cockpit.push({sev:'warning', icon:'fa-clipboard-list', txt:`<strong>${LOJA_LABEL[loja]}:</strong> nunca contou o estoque`, acao:`setLoja('${loja}');showPage('contagem')`, btn:'Contar'});
    else if (d>10) cockpit.push({sev:'warning', icon:'fa-clipboard-list', txt:`<strong>${LOJA_LABEL[loja]}:</strong> última contagem há ${d} dias`, acao:`setLoja('${loja}');showPage('contagem')`, btn:'Contar'});
  }
  const semCustoGrave = insumosSemCusto(compras).filter(f=>!f.temCompra).length;
  if (semCustoGrave) cockpit.push({sev:'warning', icon:'fa-tag', txt:`${semCustoGrave} insumo(s) sem custo nem compra → entram como R$ 0`, acao:`showPage('diagnostico')`, btn:'Ver'});
  if ((diasBk===null || diasBk>7) && !appHospedado()) cockpit.push({sev:'warning', icon:'fa-floppy-disk', txt: diasBk===null?'Nenhum backup feito ainda':`Último backup há ${diasBk} dias`, acao:`showPage('backup')`, btn:'Backup'});

  cockpit.sort((a,b)=> (a.sev==='danger'?0:1) - (b.sev==='danger'?0:1));   // vermelhos (danger) primeiro
  const cockpitItems = cockpit.length ? cockpit.map(a=>`
    <div class="d-flex align-items-center gap-2 py-2 border-bottom">
      <span class="badge bg-${a.sev} ${a.sev==='warning'?'text-dark':''}" style="width:28px"><i class="fas ${a.icon}"></i></span>
      <span class="flex-fill small">${a.txt}</span>
      <button class="btn btn-sm btn-outline-secondary" onclick="${a.acao}">${a.btn}</button>
    </div>`).join('')
    : '<div class="text-success py-3 text-center"><i class="fas fa-check-circle me-1"></i>Nada urgente agora — tudo sob controle.</div>';

  // Resumo do dia (destaque): faturamento, pizzas por loja, sabor campeão, clientes novos.
  // O dia mostrado é o ÚLTIMO com movimento no TOTEM (normalmente ontem, mas não sempre —
  // por isso a data anda COLADA no título, e o dia da semana fica no selo à direita.)
  const pzPorLojaStr = lojas.map(l=>`${LOJA_LABEL[l]} <strong>${pzUltPorLoja[l]!=null?Math.round(pzUltPorLoja[l]):0}</strong>`).join(' · ');
  const resumoOntemHtml = ultDiaData ? `
    <div class="card h-100 resumo-ontem">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span><i class="fas fa-sun me-1"></i>Resumo do dia · <strong>${fmtDate(ultDiaData)}</strong></span>
        <span class="badge" style="background:var(--cor)">${diaDaSemanaLongo(ultDiaData)}</span>
      </div>
      <div class="card-body">
        <div class="row g-3">
          <div class="col-6">
            <div class="lbl"><i class="fas fa-sack-dollar me-1"></i>Faturamento (rede)</div>
            <div class="val">${fmtBRL(fatOntem)}</div>
            <div class="lbl">líquido · 99Food já no repasse</div>
          </div>
          <div class="col-6">
            <div class="lbl"><i class="fas fa-pizza-slice me-1"></i>Pizzas vendidas</div>
            <div class="val">${Math.round(pzUltDia)}</div>
            <div class="lbl">${pzPorLojaStr}</div>
          </div>
          <div class="col-6">
            <div class="lbl"><i class="fas fa-trophy me-1"></i>Sabor campeão</div>
            <div class="val" style="font-size:21px;line-height:1.15">${saborTopNome?esc(saborTopNome):'—'}</div>
            <div class="lbl">${saborTopNome?Math.round(saborTopQtd)+' pizzas no dia':'sem dados de sabor'}</div>
          </div>
          <div class="col-6">
            <div class="lbl"><i class="fas fa-user-plus me-1"></i>Clientes novos</div>
            <div class="val">${cliNovosOntem!=null?cliNovosOntem:'—'}</div>
            <div class="lbl">${cliNovosOntem!=null ? lojas.map(l=>`${LOJA_LABEL[l]} ${cliNovosPorLoja[l]||0}`).join(' · ') : 'canal próprio (com cadastro)'}</div>
          </div>
        </div>
        <div class="mt-2 pt-2 border-top small d-flex justify-content-between align-items-center">
          <span class="text-muted"><i class="fas fa-calendar-xmark me-1 text-warning"></i>Vendas canceladas no dia</span>
          <span>${cancOntemN>0 ? `<strong>${cancOntemN}</strong> · ${fmtBRL(cancOntemVal)}` : '<span class="text-success">nenhuma</span>'}</span>
        </div>
      </div>
    </div>` : `
    <div class="card h-100"><div class="card-body d-flex flex-column align-items-center justify-content-center text-center text-muted py-4">
      <i class="fas fa-sun fa-2x mb-2" style="color:var(--dourado)"></i>
      <div>${textoSemTotem('O resumo do dia')}</div>
    </div></div>`;

  const cockpitHtml = `
    <div class="row g-3 mb-3">
      <div class="col-lg-7">${resumoOntemHtml}</div>
      <div class="col-lg-5">
        <div class="card h-100">
          <div class="card-header"><i class="fas fa-bullseye me-1 text-danger"></i>O que exige sua atenção</div>
          <div class="card-body py-1" style="max-height:330px;overflow-y:auto">${cockpitItems}</div>
        </div>
      </div>
    </div>`;

  // Badge colorido de variação vs mês passado (mesmo recorte de dias) — no KPI de faturamento.
  const lojaLbl = lojaFiltro ? LOJA_LABEL[lojaFiltro] : 'todas as lojas';
  let varBadge;
  if (varMesPct !== null) {
    const up = varMesPct >= 0;
    varBadge = `<span class="badge ${up?'bg-success':'bg-danger'}"><i class="fas fa-arrow-${up?'up':'down'} me-1"></i>${up?'+':''}${fmtNum(varMesPct,1)}%</span> <span class="text-muted">vs. mês passado (até dia ${diaCorte})</span>`;
  } else if (ceoDash) {
    varBadge = fatMesAnt===0 && fatMes>0 ? '<span class="text-muted">sem base do mês passado p/ comparar</span>' : ('soma das formas · '+lojaLbl);
  } else varBadge = 'abra pelo atalho p/ ver';

  // Contexto do drill-down do Dashboard: exatamente os dados que os 6 KPIs acima usaram.
  _detCtx.dash = {pag:pagDash, ceo:ceoDash, loja:lojaFiltro, ini:dtMes, fim:fimMes, labelMes, lojas,
                  ff:ffMes, fatMes, fatMesAnt, varMesPct, diaCorte, diasCorridosMes, fatMediaDia,
                  compras, contagens, info, criticos, compras30, pizzas30, valorRede};

  document.getElementById('dash-content').innerHTML = bannerBk + `
    <div class="row row-cols-2 row-cols-md-3 g-3 mb-3">
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-fat','Ver por loja, por forma e a média por dia da semana')}>
        <div class="lbl"><i class="fas fa-sack-dollar me-1"></i>Faturamento total — ${labelMes}</div>
        <div class="val">${fatMes?fmtBRL(fatMes):(ceoDash?'R$ 0,00':'—')}</div>
        <div class="lbl">${varBadge}</div></div></div>
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-compras','Ver por loja, fornecedor e ingrediente')}>
        <div class="lbl"><i class="fas fa-truck me-1"></i>Compras — ${labelMes}</div>
        <div class="val">${compras30?fmtBRL(compras30):'R$ 0,00'}</div>
        <div class="lbl">${lojaLbl} · no mês</div></div></div>
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-pizzas','Ver por loja, por canal e por dia da semana')}>
        <div class="lbl"><i class="fas fa-pizza-slice me-1"></i>Pizzas vendidas — ${labelMes}</div>
        <div class="val">${fmtNum(pizzas30,0)}</div>
        <div class="lbl">via importações TOTEM</div></div></div>
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-estoque','Ver por loja e quais insumos seguram o valor')}>
        <div class="lbl"><i class="fas fa-boxes-stacked me-1"></i>Valor em estoque (rede)</div>
        <div class="val">${valorRede?fmtBRL(valorRede):'R$ 0,00'}</div>
        <div class="lbl">situação atual · não muda com o mês</div></div></div>
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-media','Ver a média de cada dia da semana')}>
        <div class="lbl"><i class="fas fa-calendar-day me-1"></i>Faturamento médio/dia — ${labelMes}</div>
        <div class="val">${fatMediaDia?fmtBRL(fatMediaDia):(ceoDash?'R$ 0,00':'—')}</div>
        <div class="lbl">${ceoDash?'faturamento do mês ÷ '+diasCorridosMes+' dias corridos':'abra pelo atalho p/ ver'}</div></div></div>
      <div class="col"><div class="stat-card h-100" ${detAttr('dash-criticos','Ver a lista completa de itens críticos')}>
        <div class="lbl"><i class="fas fa-triangle-exclamation me-1"></i>Itens críticos</div>
        <div class="val ${criticos.length?'text-danger':'text-success'}">${criticos.length}</div>
        <div class="lbl">cobertura (média ou ficha) abaixo do limite</div></div></div>
    </div>
    ${cockpitHtml}

    <div class="row g-3 mb-3">${lojaCards}</div>

    <div class="row g-3 mb-3">
      <div class="col-lg-4">
        <div class="card h-100">
          <div class="card-header"><i class="fas fa-chart-pie me-1"></i>Valor de estoque por loja</div>
          <div class="card-body d-flex align-items-center justify-content-center">
            <canvas id="dash-chart-estoque" style="max-height:260px"></canvas>
          </div>
        </div>
      </div>
      <div class="col-lg-8">
        <div class="card h-100">
          <div class="card-header"><i class="fas fa-chart-column me-1"></i>Pizzas por importação TOTEM (últimas 12)</div>
          <div class="card-body"><canvas id="dash-chart-vendas" style="max-height:260px"></canvas></div>
        </div>
      </div>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-lg-7">
        <div class="card h-100">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="fas fa-ranking-star me-1"></i>Top 5 sabores — este mês (${labelMes})</span>
            <a href="#" class="small" onclick="showPage('painel');return false">ver painel completo →</a>
          </div>
          <div class="card-body" id="dash-sabores-body"><canvas id="dash-chart-sabores" style="max-height:240px"></canvas></div>
        </div>
      </div>
      <div class="col-lg-5">
        <div class="card h-100">
          <div class="card-header"><i class="fas fa-cart-shopping me-1"></i>Compras por ingrediente — este mês (${labelMes})</div>
          <div class="card-body d-flex align-items-center justify-content-center" id="dash-compras-body"><canvas id="dash-chart-compras" style="max-height:240px"></canvas></div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-lg-5">
        <div class="card h-100">
          <div class="card-header text-danger d-flex justify-content-between align-items-center">
            <span><i class="fas fa-triangle-exclamation me-1"></i>Alertas — Estoque Crítico</span>
            <button class="btn btn-sm btn-outline-secondary py-0 px-1" onclick="abrirAlertasConfig()" title="Configurar quais insumos alertam e em quantos dias"><i class="fas fa-gear"></i></button>
          </div>
          <div class="card-body p-0" style="max-height:340px;overflow-y:auto">
            <table class="table table-sm mb-0">
              <thead class="sticky-header table-light"><tr><th>Loja</th><th>Ingrediente</th><th class="text-end">Estoque<br><span class="fw-normal text-muted" style="font-size:11px">(contado)</span></th><th class="text-end">Estoque<br><span class="fw-normal text-muted" style="font-size:11px">(estimado hoje)</span></th><th class="text-end cob-col">Cobertura<br><span class="fw-normal text-muted" style="font-size:11px">(pela média)</span></th><th class="text-end cob-col">Cobertura<br><span class="fw-normal text-muted" style="font-size:11px">(pela ficha)</span></th></tr></thead>
              <tbody>${alertasHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-lg-7">
        <div class="card h-100">
          <div class="card-header"><i class="fas fa-clock-rotate-left me-1"></i>Atividade Recente</div>
          <div class="card-body p-0" style="max-height:340px;overflow-y:auto">
            <table class="table table-sm mb-0">
              <thead class="sticky-header table-light"><tr><th>Data</th><th>Tipo</th><th>Loja</th><th>Detalhe</th></tr></thead>
              <tbody>${buildAtividadeRecente(contagens,vendas,compras)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  // Gráficos
  _dashCharts.forEach(c=>c.destroy()); _dashCharts=[];
  const CORES_LOJA = LOJA_COR;   // fonte única: cadastro de lojas

  _dashCharts.push(new Chart(document.getElementById('dash-chart-estoque'), {
    type:'doughnut',
    data:{
      labels: lojas.map(l=>LOJA_LABEL[l]),
      datasets:[{data: lojas.map(l=>info[l].valor||0), backgroundColor: lojas.map(l=>CORES_LOJA[l])}]
    },
    options:{plugins:{legend:{position:'bottom'},
      tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${fmtBRL(ctx.parsed)}`}}}}
  }));

  const vRec = vendas.slice().sort((a,b)=>a.data_fim.localeCompare(b.data_fim)).slice(-12);
  _dashCharts.push(new Chart(document.getElementById('dash-chart-vendas'), {
    type:'bar',
    data:{
      labels: vRec.map(v=>`${fmtDate(v.data_fim).slice(0,5)} ${LOJA_LABEL[v.loja]?.slice(0,3)||''}`),
      // régua única (resumo do TOTEM) nos dias de cada importação; sem o resumo, as vendas da importação
      datasets:[{label:'Pizzas', data: vRec.map(v=>{ const pz = pizzasDoResumo(ceoDash, [v.loja], v.data_inicio, v.data_fim); return pz!=null ? pz : pizzasDeVenda(v); }),
        backgroundColor: vRec.map(v=>CORES_LOJA[v.loja]||'#888'), borderRadius:4}]
    },
    options:{plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}
  }));

  // Top 5 sabores do mês corrente (todas as lojas)
  const mixDash = {};
  for (const v of vendas.filter(x=>x.data_fim>=dtMes && x.data_fim<=fimMes)) {
    for (const it of (v.itens||[])) {
      const m = resolverMap(it);
      if (!m || !['MEIA','INTEIRA','PREMIUM'].includes(m.categoria)) continue;
      const sabor = nomeSaborMix(m, it);
      mixDash[sabor] = (mixDash[sabor]||0) + it.qtde*(m.fator_consumo||1);
    }
  }
  const topSab = Object.entries(mixDash).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if (topSab.length) {
    _dashCharts.push(new Chart(pnCanvas('dash-chart-sabores'), {
      type:'bar',
      data:{labels: topSab.map(x=>x[0]),
        datasets:[{label:'Pizzas', data: topSab.map(x=>Math.round(x[1]*10)/10),
          backgroundColor:'#922b21', borderRadius:4}]},
      options:{indexAxis:'y', plugins:{legend:{display:false}}, scales:{x:{beginAtZero:true}}}
    }));
  } else {
    document.getElementById('dash-sabores-body').innerHTML = '<div class="text-center text-muted small py-4">Sem vendas neste mês.</div>';
  }

  // Compras por ingrediente — mês corrente (todas as lojas)
  const cpIng30 = {};
  for (const c of compras.filter(x=>x.data>=dtMes && x.data<=fimMes)) {
    const k = normIng(c.ingrediente);
    cpIng30[k] = (cpIng30[k]||0) + (c.valor_total||0);
  }
  const topCp = Object.entries(cpIng30).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const topCp7 = topCp.slice(0,7);
  const cpOutros = topCp.slice(7).reduce((s,[,v])=>s+v,0);
  if (cpOutros>0) topCp7.push(['OUTROS', cpOutros]);
  if (topCp7.length) {
    _dashCharts.push(new Chart(pnCanvas('dash-chart-compras'), {
      type:'doughnut',
      data:{labels: topCp7.map(x=>x[0]),
        datasets:[{data: topCp7.map(x=>x[1]),
          backgroundColor: topCp7.map((x,i)=>PN_CORES[i%PN_CORES.length])}]},
      options:{plugins:{legend:{position:'bottom', labels:{boxWidth:12, font:{size:10}}},
        tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${fmtBRL(ctx.parsed)}`}}}}
    }));
  } else {
    document.getElementById('dash-compras-body').innerHTML = '<div class="text-center text-muted small py-4">Sem compras neste mês.</div>';
  }
}

function buildAtividadeRecente(contagens, vendas, compras) {
  // Vendas TOTEM são importações automáticas → não poluem a atividade recente (pedido do Gabriel).
  const events = [
    ...contagens.map(c=>({data:c.data, tipo:'Contagem', loja:c.loja, det:`${Object.keys(c.ingredientes||{}).length} ingredientes`})),
    ...compras.map(c=>({data:c.data, tipo:'Compra', loja:c.loja, det:`${c.ingrediente}: ${fmtNum(c.quantidade_base,2)} ${c.unidade_base}`}))
  ].sort((a,b)=>b.data.localeCompare(a.data)).slice(0,20);
  if (!events.length) return '<tr><td colspan="4" class="text-center text-muted py-3">Nenhuma atividade ainda.</td></tr>';
  return events.map(e=>`
    <tr>
      <td>${fmtDate(e.data)}</td>
      <td>${e.tipo}</td>
      <td><span class="badge ${LOJA_BADGE[e.loja]}">${LOJA_LABEL[e.loja]||e.loja}</span></td>
      <td class="text-muted small">${esc(e.det)}</td>
    </tr>`).join('');
}

// ================================================================
// 7. CONTAGEM
// ================================================================
let _editContagemId = null;

function renderContagem() {
  document.getElementById('ct-loja-label').textContent = LOJA_LABEL[currentLoja];
  document.getElementById('ct-hist-loja').textContent = LOJA_LABEL[currentLoja];
  if (!_editContagemId) {
    document.getElementById('ct-data').value = today();
    document.getElementById('ct-momento').value = 'antes';
    buildContagemTable();
  }
  carregarInsumosExistentes(currentLoja).then(()=>atualizarFaltando());
  loadContagemHist();
}

// Insumos que EXISTEM em cada loja, derivados do PRÓPRIO histórico (zero configuração):
// um insumo "existe" se já apareceu com quantidade em alguma CONTAGEM da loja ou em alguma COMPRA dela.
// É o que faz premium ser cobrado só na Buritis e os refris exclusivos só na Venda Nova — a cobrança
// de "faltou contar" usa este conjunto; a tabela continua mostrando tudo (dá pra contar item novo).
let _ctExiste = {};   // loja -> Set de nomes normalizados
async function carregarInsumosExistentes(loja) {
  if (_ctExiste[loja]) return _ctExiste[loja];
  const s = new Set();
  const [contagens, compras] = await Promise.all([DB.getAll('contagens'), DB.getAll('compras')]);
  for (const c of contagens) if (c.loja===loja)
    for (const [ing,v] of Object.entries(c.ingredientes||{})) if ((v.total||0)>0) { s.add(norm(ing)); s.add(normIng(ing)); }
  for (const c of compras) if (c.loja===loja && c.ingrediente) { s.add(norm(c.ingrediente)); s.add(normIng(c.ingrediente)); }
  _ctExiste[loja] = s;
  return s;
}

async function loadContagemHist() {
  const compras = await DB.getAll('compras');
  const cts = (await DB.getAll('contagens'))
    .filter(c=>c.loja===currentLoja)
    .sort((a,b)=>b.data.localeCompare(a.data));
  const tbody = document.getElementById('ct-hist-tbody');
  if (!cts.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-2 small">Nenhuma contagem salva para esta loja.</td></tr>';
    return;
  }
  tbody.innerHTML = cts.map(c=>{
    const n = Object.keys(c.ingredientes||{}).length;
    const editando = c.id===_editContagemId;
    const mom = c.momento === 'fim'
      ? '<span class="badge bg-dark" title="Contagem feita no fim da noite — as vendas do dia já entraram">🌙 fechamento</span>'
      : '<span class="badge bg-info text-dark" title="Contagem feita antes da noite — as vendas do dia ainda não entraram">🌅 abertura</span>';
    return `<tr class="${editando?'table-warning':''}">
      <td class="fw-semibold">${fmtDate(c.data)} ${mom}${editando?' <span class="badge bg-warning text-dark">editando</span>':''}</td>
      <td class="text-end">${n}</td>
      <td class="text-end text-muted small">${fmtBRL(valorEstoqueContagem(c, compras))}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary py-0 px-1 me-1" onclick="editContagem(${c.id})" title="Editar"><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteContagem(${c.id})" title="Excluir"><i class="fas fa-trash"></i></button>
      </td></tr>`;
  }).join('');
}

async function editContagem(id) {
  const c = (await DB.getAll('contagens')).find(x=>x.id===id);
  if (!c) return;
  _editContagemId = id;
  document.getElementById('ct-data').value = c.data;
  document.getElementById('ct-momento').value = c.momento === 'fim' ? 'fim' : 'antes';
  const valores = {};
  for (const [ing,v] of Object.entries(c.ingredientes||{})) valores[ing] = {caixas:v.caixas, unidades:v.unidades};
  buildContagemTable(valores);
  // A base de comparação (_ctBase) carrega em segundo plano dentro de
  // buildContagemTable — sem esperar ela terminar, os avisos abaixo avaliam
  // com a base ainda vazia e nenhum insumo pré-preenchido acende alerta (só
  // depois que a pessoa mexe manualmente no campo, quando a base já chegou).
  // Mesmo conserto do importXLSX.
  await carregarBaseContagem();
  for (const n of Object.keys(valores)) updateTotalContagem(n);
  document.getElementById('ct-edit-badge').classList.remove('d-none');
  document.getElementById('ct-btn-cancelar').classList.remove('d-none');
  document.getElementById('ct-btn-salvar').innerHTML = '<i class="fas fa-save me-2"></i>Salvar alterações';
  loadContagemHist();
  document.getElementById('ct-data').scrollIntoView({block:'center'});
  toast(`Editando contagem de ${fmtDate(c.data)} — altere e salve.`, 'info');
}

function cancelarEdicaoContagem() {
  _editContagemId = null;
  document.getElementById('ct-edit-badge').classList.add('d-none');
  document.getElementById('ct-btn-cancelar').classList.add('d-none');
  document.getElementById('ct-btn-salvar').innerHTML = '<i class="fas fa-save me-2"></i>Salvar Contagem';
  document.getElementById('ct-data').value = today();
  document.getElementById('ct-momento').value = 'antes';
  buildContagemTable();
  loadContagemHist();
}

// Cancelar a contagem em ANDAMENTO (pedido do Gabriel): confirma e descarta tudo que foi
// digitado. Se estava editando uma contagem já salva, sai do modo edição SEM alterá-la
// (o registro no banco continua intacto — só o formulário limpa).
function cancelarContagem() {
  if (!confirm('Tem certeza que quer cancelar a contagem? Tudo que você digitou nesta contagem será apagado.')) return;
  if (_editContagemId) cancelarEdicaoContagem();
  else buildContagemTable();
  toast('Contagem cancelada.', 'info');
}

async function deleteContagem(id) {
  if (!confirm('Apagar esta contagem?')) return;
  await DB.delete('contagens', id);
  if (_editContagemId===id) cancelarEdicaoContagem();
  else loadContagemHist();
  toast('Contagem removida.','success');
}

// --- Itens por loja (melhoria 4): cada loja conta só o que usa ---
// Guarda em localStorage os ingredientes OCULTOS por loja (o resto aparece).
// Lista vazia = nada oculto = comportamento idêntico ao de antes.
const ING_OCULTOS_KEY = 'ingredientes_ocultos_v1';
function getIngOcultos() {
  try { return JSON.parse(localStorage.getItem(ING_OCULTOS_KEY)) || {}; } catch(e) { return {}; }
}
function setIngOcultos(obj) { localStorage.setItem(ING_OCULTOS_KEY, JSON.stringify(obj)); }

// --- Sabores por loja (Fase 3, 22/09/2026): cada loja liga/desliga os sabores da ficha da rede ---
// Guarda só os DESLIGADOS por loja ({LOJA: ['NOME_FICHA', ...]}), mesmo formato do ingredientes_ocultos
// (a fusão da nuvem já trata como conjunto). Sem config = tudo ligado = comportamento de antes.
// Só o dono altera: o campo NÃO está no OVERLAY_OPERACIONAL, então o banco barra os outros papéis.
// NÃO muda conta nenhuma: vendas de sabor desligado continuam contando no CMV (o dado manda).
const SABORES_LOJA_KEY = 'sabores_desligados_v1';
function getSaboresDesligados() {
  try { const o = JSON.parse(localStorage.getItem(SABORES_LOJA_KEY)); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch(e) { return {}; }
}
function setSaboresDesligados(obj) { localStorage.setItem(SABORES_LOJA_KEY, JSON.stringify(obj || {})); }
function saborLigado(loja, ficha) { return !((getSaboresDesligados()[loja] || []).includes(ficha)); }

// --- Alertas de estoque crítico configuráveis (item 4) ---
// Por insumo: se ENTRA no alerta (ativo) e em quantos dias de cobertura ele já deve ser
// alertado. Insumos com prazo de entrega maior (ex.: caixa de pizza) podem pedir mais dias.
// Sem config = padrão de 7 dias e ativo para todos (comportamento idêntico ao de antes).
const ALERTAS_KEY = 'alertas_config_v1';
const ALERTA_DIAS_PADRAO = 7;
let _alertasCache = null;
function getAlertasConfig() {
  if (_alertasCache) return _alertasCache;
  try { _alertasCache = JSON.parse(localStorage.getItem(ALERTAS_KEY)) || {}; } catch(e) { _alertasCache = {}; }
  return _alertasCache;
}
function setAlertasConfig(obj) { _alertasCache = obj||{}; localStorage.setItem(ALERTAS_KEY, JSON.stringify(_alertasCache)); }
function alertaDiasInsumo(ing) { const c = getAlertasConfig()[normIng(ing)]; return (c && c.dias>0) ? c.dias : ALERTA_DIAS_PADRAO; }
function alertaAtivoInsumo(ing) { const c = getAlertasConfig()[normIng(ing)]; return !(c && c.ativo===false); }

function abrirAlertasConfig() {
  if (typeof bootstrap === 'undefined') { toast('Recarregue a página (com internet) para abrir a janela.','warning'); return; }
  renderAlertasModal();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('alertas-modal')).show();
}
function renderAlertasModal() {
  const host = document.getElementById('alertas-lista');
  if (!host) return;
  // Usa a lista de contagem (já agrupada e inclui Caixa de Pizza, bebidas etc.), sem bebidas duplicadas.
  const grupos = INGREDIENTES_CONTAGEM_LISTA;
  host.innerHTML = grupos.map(gr=>`
    <div class="mb-2">
      <div class="fw-semibold small text-muted border-bottom mb-1">${esc(gr.g)}</div>
      <table class="table table-sm align-middle mb-0">
        <tbody>${gr.itens.map(it=>{
          const n = normIng(it.nome);
          const ativo = alertaAtivoInsumo(it.nome);
          const dias = alertaDiasInsumo(it.nome);
          return `<tr>
            <td style="width:55%">${esc(it.nome)}</td>
            <td class="text-center" style="width:20%">
              <div class="form-check form-switch d-inline-block">
                <input class="form-check-input" type="checkbox" data-alert-ativo="${n}" ${ativo?'checked':''} title="Entra no alerta?">
              </div>
            </td>
            <td class="text-end" style="width:25%">
              <div class="input-group input-group-sm" style="max-width:130px;margin-left:auto">
                <input type="number" class="form-control text-end" data-alert-dias="${n}" value="${dias}" min="1" step="1">
                <span class="input-group-text">dias</span>
              </div>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`).join('');
}
function salvarAlertasConfig() {
  const cfg = {};
  document.querySelectorAll('[data-alert-ativo]').forEach(el=>{
    const n = el.getAttribute('data-alert-ativo');
    const ativo = el.checked;
    const diasEl = document.querySelector(`[data-alert-dias="${n}"]`);
    const dias = Math.max(1, parseInt(diasEl?.value,10) || ALERTA_DIAS_PADRAO);
    // Só guarda o que FOGE do padrão (ligado + 7 dias) — mantém o backup enxuto.
    if (!ativo || dias !== ALERTA_DIAS_PADRAO) cfg[n] = {ativo, dias};
  });
  setAlertasConfig(cfg);
  bootstrap.Modal.getInstance(document.getElementById('alertas-modal'))?.hide();
  toast('Alertas configurados.','success');
  if (currentPage==='dashboard') renderDashboard();
}
function resetAlertasConfig() {
  setAlertasConfig({});
  renderAlertasModal();
  toast('Alertas voltaram ao padrão (ligados, 7 dias).','info');
}
function ingOcultoNaLoja(nome, loja) {
  const o = getIngOcultos()[loja] || [];
  return o.includes(norm(nome));
}
function abrirIngLojaModal() {
  document.getElementById('ct-il-loja').textContent = LOJA_LABEL[currentLoja];
  const ocultos = getIngOcultos()[currentLoja] || [];
  const isVN = currentLoja === 'VENDA_NOVA';
  let html = '';
  for (const grupo of INGREDIENTES_CONTAGEM_LISTA) {
    if (grupo.g === 'Bebidas (Venda Nova)' && !isVN) continue;
    html += `<div class="fw-bold small text-uppercase text-muted mt-3 mb-1">${esc(grupo.g)}</div><div class="row g-1">`;
    for (const item of grupo.itens) {
      const n = item.nome;
      const id = 'ct-il-' + n.replace(/[^a-zA-Z0-9]/g,'_');
      const checked = ocultos.includes(norm(n)) ? '' : 'checked';
      html += `<div class="col-md-4 col-6"><div class="form-check">
        <input class="form-check-input ct-il-chk" type="checkbox" data-ing="${esc(n)}" id="${id}" ${checked}>
        <label class="form-check-label small" for="${id}">${esc(n)}</label>
      </div></div>`;
    }
    html += `</div>`;
  }
  document.getElementById('ct-il-lista').innerHTML = html;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('ct-itens-modal')).show();
}
function ctIlMarcarTodos(val) {
  document.querySelectorAll('.ct-il-chk').forEach(c => c.checked = val);
}
function salvarIngLoja() {
  const ocultos = [];
  document.querySelectorAll('.ct-il-chk').forEach(c => { if (!c.checked) ocultos.push(norm(c.dataset.ing)); });
  const all = getIngOcultos();
  all[currentLoja] = ocultos;
  setIngOcultos(all);
  bootstrap.Modal.getInstance(document.getElementById('ct-itens-modal'))?.hide();
  if (!_editContagemId) buildContagemTable();
  toast(`Itens da loja ${LOJA_LABEL[currentLoja]} atualizados.`, 'success');
}

function buildContagemTable(valoresIniciais={}) {
  const tbody = document.getElementById('ct-tbody');
  let html = '';
  const isVN = currentLoja === 'VENDA_NOVA';
  // Ao editar uma contagem antiga, ingredientes CONTADOS sempre aparecem (mesmo se
  // ocultos hoje) para não perder o que já estava lançado — inclui o contado-zero.
  const temValor = (nome) => !!valoresIniciais[nome];

  const navChips = [];
  for (const grupo of INGREDIENTES_CONTAGEM_LISTA) {
    // Skip Bebidas VN se não for Venda Nova
    if (grupo.g === 'Bebidas (Venda Nova)' && !isVN) continue;

    const itensVisiveis = grupo.itens.filter(item => !ingOcultoNaLoja(item.nome, currentLoja) || temValor(item.nome));
    if (!itensVisiveis.length) continue;

    const gid = 'ctg-' + grupo.g.replace(/[^a-zA-Z0-9]/g,'_');
    navChips.push({gid, nome:grupo.g, n:itensVisiveis.length});
    html += `<div class="ct-grupo-cab" id="${gid}">
        <span class="ct-grupo-nome">${esc(grupo.g)}</span>
        <span class="ct-grupo-linha"></span>
        <span class="ct-grp-count" data-grp-count="${gid}">0/${itensVisiveis.length}</span>
      </div>`;
    for (const item of itensVisiveis) {
      const n = item.nome;
      const un = getUnidadeIngrediente(n);
      const lblCx = getLabelCaixas(n);
      const lblUn = getLabelUnidades(n);
      const iv = valoresIniciais[n];
      const contado = !!iv;
      const cxN = contado ? (Number(iv.caixas)||0) : 0;
      const unN = contado ? (Number(iv.unidades)||0) : 0;
      // 0 contado é 0: item contado com total 0 mostra um "0" visível no 1º campo para
      // a linha não parecer "em branco". Campo com valor > 0 mostra o número; senão vazio.
      const zerado = contado && cxN === 0 && unN === 0;
      const valCx = cxN > 0 ? cxN : (zerado ? 0 : '');
      const valUn = unN > 0 ? unN : '';
      const totalPrev = contado ? converterContagem(n, cxN, unN).total : '';
      const slug = n.replace(/[^a-zA-Z0-9]/g,'_');
      // O rótulo virou ELEMENTO ao lado do campo, não placeholder: placeholder some
      // no instante em que a pessoa digita, que é justamente quando ela precisa saber
      // se aquele campo é "caixas" ou "unidades soltas".
      html += `
      <div class="ct-item${contado?' ct-feita':''}" data-grp="${gid}" data-slug="${slug}">
        <div class="ct-nome">
          <div class="ct-nome-txt">${esc(n)}</div>
          <div class="ct-nome-sub" data-base="${esc(n)}"></div>
        </div>
        <div class="ct-campos">
          <label class="ct-campo">
            <span class="ct-campo-lbl">${esc(lblCx)}</span>
            <input type="number" inputmode="decimal" data-ing="${esc(n)}" data-campo="cx"
              placeholder="0" min="0" step="0.001" value="${valCx}"
              aria-label="${esc(n)} — ${esc(lblCx)}"
              oninput="updateTotalContagem('${argJS(n)}')">
          </label>
          <label class="ct-campo">
            <span class="ct-campo-lbl">${esc(lblUn)}</span>
            <input type="number" inputmode="decimal" data-ing="${esc(n)}" data-campo="un"
              placeholder="0" min="0" step="0.001" value="${valUn}"
              aria-label="${esc(n)} — ${esc(lblUn)}"
              oninput="updateTotalContagem('${argJS(n)}')">
          </label>
        </div>
        <div class="ct-total${contado?' tem':''}" id="ct-total-${slug}">${contado ? fmtNum(totalPrev||0,3)+`<span class="ct-un"> ${esc(un)}</span>` : '—'}</div>
      </div>`;
    }
  }
  tbody.innerHTML = html;
  // Chips de navegação por grupo (pular direto p/ Frios, Bebidas, Embalagens… — a lista é longa)
  const nav = document.getElementById('ct-nav-grupos');
  if (nav) nav.innerHTML = navChips.map(c=>
    `<button class="ct-chip" data-chip="${c.gid}" onclick="document.getElementById('${c.gid}').scrollIntoView({behavior:'smooth',block:'start'})">${esc(c.nome)} <span class="ct-chip-n" data-chip-n="${c.gid}">0/${c.n}</span></button>`).join('');
  atualizarContadoresGrupo();
  atualizarFaltando();
  pintarBaseContagem();          // "tinha X · gasta ~Y/dia" em cada faixa
  carregarBaseContagem();        // (re)carrega a base e repinta quando chegar
}

// Contador "contados/total" de cada grupo (no cabeçalho do grupo e no chip de navegação)
function atualizarContadoresGrupo() {
  const porGrp = {};
  let feitos = 0, total = 0;
  document.querySelectorAll('#ct-tbody .ct-item[data-grp]').forEach(el=>{
    const g = el.dataset.grp;
    porGrp[g] = porGrp[g] || {t:0, ok:0, alerta:false};
    porGrp[g].t++; total++;
    if (el.classList.contains('ct-feita')) { porGrp[g].ok++; feitos++; }
    if (el.classList.contains('ct-alertado') || el.classList.contains('ct-atencao')) porGrp[g].alerta = true;
  });
  for (const [g,v] of Object.entries(porGrp)) {
    const badge = document.querySelector(`[data-grp-count="${g}"]`);
    if (badge) { badge.textContent = `${v.ok}/${v.t}`; badge.classList.toggle('completo', v.ok===v.t); }
    const chipN = document.querySelector(`[data-chip-n="${g}"]`);
    if (chipN) chipN.textContent = `${v.ok}/${v.t}`;
    const chip = document.querySelector(`[data-chip="${g}"]`);
    if (chip) {
      // Grupo com alerta NÃO conta como completo: verde de "pronto" em cima de um
      // número que precisa de conferência é a pior mentira que a tela pode contar.
      chip.classList.toggle('completo', v.ok===v.t && !v.alerta);
      chip.classList.toggle('temalerta', v.alerta);
    }
  }
  const elF = document.getElementById('ct-prog-feitos');
  const elT = document.getElementById('ct-prog-total');
  const elB = document.getElementById('ct-prog-fill');
  if (elF) elF.textContent = feitos;
  if (elT) elT.textContent = total;
  if (elB) elB.style.width = (total ? (feitos/total)*100 : 0) + '%';
}

// Contadores/avisos com DEBOUNCE (correção celular jul/2026): cada tecla varria a tabela
// inteira (150+ insumos, centenas de querySelector) — o iPhone travava ao digitar. O total
// da LINHA continua instantâneo; a varredura pesada roda 0,3s após parar de digitar.
let _ctAvisosTimer = null;
function agendarAvisosContagem() {
  clearTimeout(_ctAvisosTimer);
  _ctAvisosTimer = setTimeout(() => { atualizarContadoresGrupo(); atualizarFaltando(); }, 300);
}

function updateTotalContagem(nome) {
  // CSS.escape: insumo com aspas/acento no nome quebrava o seletor e a linha parava de somar.
  const cxEl = document.querySelector(`[data-ing="${CSS.escape(nome)}"][data-campo="cx"]`);
  const unEl = document.querySelector(`[data-ing="${CSS.escape(nome)}"][data-campo="un"]`);
  if (!cxEl || !unEl) return;
  // "0 contado é 0": campo com 0 digitado conta (mostra o total, mesmo que 0); só os
  // DOIS campos em branco é que valem "não contado" (mostra "—").
  const cxRaw = (cxEl.value == null ? '' : String(cxEl.value)).trim();
  const unRaw = (unEl.value == null ? '' : String(unEl.value)).trim();
  const contado = cxRaw !== '' || unRaw !== '';
  const cx = parseFloat(cxRaw)||0;
  const un = parseFloat(unRaw)||0;
  const item = cxEl.closest('.ct-item');
  const elTot = document.getElementById('ct-total-'+nome.replace(/[^a-zA-Z0-9]/g,'_'));

  item?.querySelector('.ct-aviso')?.remove();
  // ct-revisar entra junto: é a marca que a janela de revisão deixa na linha. Se a
  // pessoa está mexendo neste campo, ela ESTÁ atendendo ao pedido — manter o
  // destaque depois de corrigido faria a tela mentir sobre o que ainda falta.
  item?.classList.remove('ct-alertado','ct-atencao','ct-grave','ct-revisar');
  elTot?.classList.remove('tem','excesso','baixo','furo','atencao');

  if (!contado) {
    if (elTot) elTot.innerHTML = '—';
    if (item) item.classList.remove('ct-feita');
    agendarAvisosContagem();
    return;
  }
  const r = converterContagem(nome, cx, un);
  if (elTot) elTot.innerHTML = fmtNum(r.total,3)+`<span class="ct-un"> ${esc(r.unidade)}</span>`;
  if (item) item.classList.add('ct-feita');

  // CONFERÊNCIA AO VIVO: o mesmo julgamento que roda ao salvar, só que agora
  // enquanto a pessoa digita — com o estoque ainda na frente dela. A janela ao
  // salvar continua existindo como rede de segurança para quem ignorar isto aqui.
  // Atendimento é controle simples (sem ficha/consumo): não gera alerta de furo/gasto.
  const av = ehAtendimento(nome) ? null : avaliarInsumo(nome, r.total);
  if (av && item && elTot) {
    elTot.classList.add(av.tipo);
    // "atenção" (15-29% num insumo de prioridade máxima) é um degrau abaixo de
    // "gasto excessivo"/"gasto baixo" — cor mais clara na linha, não a mesma
    // intensidade. Pedido do Gabriel: pra insumo que move muito volume (ex.
    // mussarela), 28% de desvio JÁ é preocupante — não pode parecer "sem alarme".
    item.classList.add(av.tipo === 'atencao' ? 'ct-atencao' : 'ct-alertado');
    if (av.grave) item.classList.add('ct-grave');
    const d = document.createElement('div');
    d.className = 'ct-aviso';
    d.innerHTML = `<span class="ct-selo">${esc(av.selo)}</span><span>${av.texto}</span>`;
    item.appendChild(d);
  } else if (elTot) {
    elTot.classList.add('tem');
  }
  agendarAvisosContagem();
}

// Lista os insumos ESPERADOS nesta loja (os que a tela mostra — premium já não aparecem em Venda Nova)
// que ainda estão SEM contagem (input em branco). Pedido do Gabriel: avisar por insumo, não "loja nunca contou".
// Vazios na tela, separados em: COBRADOS (o insumo existe nesta loja, pelo histórico) e IGNORADOS
// (nunca contado/comprado aqui — ex.: premium fora da Buritis, refri exclusivo fora da Venda Nova).
function insumosSemContagem() {
  const existe = _ctExiste[currentLoja];
  const temHistorico = existe && existe.size > 0;
  const faltam = [], ignorados = [];
  document.querySelectorAll('#ct-tbody input[data-campo="cx"]').forEach(cxEl=>{
    const n = cxEl.getAttribute('data-ing');
    const unEl = document.querySelector(`#ct-tbody [data-ing="${CSS.escape(n)}"][data-campo="un"]`);
    // Contado = QUALQUER campo com algo digitado (0 explícito conta). Só os dois em
    // branco é que "faltam contar".
    const cxRaw = (cxEl.value == null ? '' : String(cxEl.value)).trim();
    const unRaw = (unEl && unEl.value != null ? String(unEl.value) : '').trim();
    if (cxRaw !== '' || unRaw !== '') return;
    // sem histórico nenhum (loja nova) cobra tudo; com histórico, cobra só o que a loja usa
    if (!temHistorico || existe.has(norm(n)) || existe.has(normIng(n))) faltam.push(n);
    else ignorados.push(n);
  });
  return {faltam, ignorados};
}
function atualizarFaltando() {
  const host = document.getElementById('ct-faltando'); if (!host) return;
  const total = document.querySelectorAll('#ct-tbody input[data-campo="cx"]').length;
  if (!total) { host.innerHTML = ''; return; }
  const {faltam, ignorados} = insumosSemContagem();
  const notaIgn = ignorados.length
    ? `<div class="small text-muted mt-1"><i class="fas fa-circle-info me-1"></i>${ignorados.length} item(ns) não cobrados por nunca terem sido contados/comprados nesta loja (ex.: ${ignorados.slice(0,3).map(esc).join(', ')}${ignorados.length>3?'…':''}). Se a loja passou a usar algum, é só preencher.</div>`
    : '';
  if (!faltam.length) {
    host.innerHTML = `<div class="alert alert-success py-2 mb-0"><i class="fas fa-circle-check me-1"></i>Todos os <strong>${total-ignorados.length}</strong> insumos que a ${esc(LOJA_LABEL[currentLoja])} usa foram contados.${notaIgn}</div>`;
  } else {
    host.innerHTML = `<div class="alert alert-danger py-2 mb-0">
      <i class="fas fa-triangle-exclamation me-1"></i><strong>Faltam contar ${faltam.length} insumo(s)</strong> que a ${esc(LOJA_LABEL[currentLoja])} usa (pelo histórico de contagens/compras):
      <div class="mt-1">${faltam.map(n=>`<span class="badge bg-light text-danger border border-danger me-1 mb-1">${esc(n)}</span>`).join('')}</div>
      ${notaIgn}
    </div>`;
  }
}

// ================================================================
// CONFERÊNCIA NA HORA DE CONTAR — o erro morre onde nasce
// ================================================================
// O app já sabia apontar contagem impossível, mas só na tela de Divergências,
// dias depois, quando o insumo sumia do gráfico por "não fazer sentido". Quem
// descobria era o Gabriel, não quem contou — e aí já não dava para descer na
// cozinha e conferir a caixa. Aqui a MESMA régua roda ANTES de salvar, para quem
// está com o estoque na mão.
//
// Duas perguntas, nesta ordem:
//   1. O estoque AUMENTOU sem entrada? (consumo negativo) → impossível, é erro.
//   2. O consumo foge do ritmo desta loja? (3× a mediana histórica) → revisar.
// O 3× é a MESMA régua que o motor usa para tirar um insumo do gráfico de
// impacto (`suspeito`, em calcDivergencias). Critério único de propósito: a
// Contagem e a tela de Divergências nunca podem discordar sobre o que é absurdo.

// Entradas líquidas de um insumo entre duas contagens (compra + veio − foi).
// Convenção de borda: entra o que aconteceu DEPOIS da contagem anterior, até o
// dia da nova (inclusive). É aproximação de aviso, não número de CMV — o motor
// (calcDivergencias) continua sendo a fonte única para o número.
function entradasEntreContagens(ing, loja, de, ate, compras, transferencias) {
  const dentro = d => d > de && d <= ate;
  let e = 0;
  for (const c of compras)
    if (c.loja===loja && c.ingrediente===ing && dentro(c.data)) e += parseFloat(c.quantidade_base)||0;
  for (const t of transferencias) {
    if (t.ingrediente !== ing || !dentro(t.data)) continue;
    if (t.loja_destino===loja) e += parseFloat(t.quantidade)||0;
    if (t.loja_origem ===loja) e -= parseFloat(t.quantidade)||0;
  }
  return e;
}

// Ritmo normal de consumo por dia, por insumo, nesta loja: percorre os pares de
// contagens consecutivas do histórico e tira a MEDIANA de (consumo ÷ dias).
// Mediana, e não média, porque a média seria envenenada justamente pelos erros
// de digitação que estamos tentando pegar.
function ritmoConsumoPorDia(loja, contagensOrdenadas, compras, transferencias) {
  const amostras = {};
  for (let i=1; i<contagensOrdenadas.length; i++) {
    const a = contagensOrdenadas[i-1], b = contagensOrdenadas[i];
    const dias = Math.max(1, Math.round((new Date(b.data) - new Date(a.data))/86400000));
    if (dias > 45) continue;                     // buraco no histórico não é ritmo
    for (const [ing, val] of Object.entries(b.ingredientes||{})) {
      const ini = a.ingredientes?.[ing]?.total;
      if (ini == null) continue;
      const consumo = ini + entradasEntreContagens(ing, loja, a.data, b.data, compras, transferencias) - (val.total||0);
      if (consumo > 0) (amostras[ing] ||= []).push(consumo/dias);
    }
  }
  const ritmo = {};
  for (const [ing, arr] of Object.entries(amostras)) {
    if (arr.length < 2) continue;                // 1 amostra não é ritmo
    arr.sort((x,y)=>x-y);
    const m = Math.floor(arr.length/2);
    ritmo[ing] = arr.length%2 ? arr[m] : (arr[m-1]+arr[m])/2;
  }
  return ritmo;
}

// A BASE DE COMPARAÇÃO da tela de Contagem, carregada uma vez ao abrir/mudar de loja.
// Existe para que a conferência ao vivo (a cada tecla) não vá ao banco — quem digita
// não pode esperar rede a cada dígito.
let _ctBase = null;   // {dataAnterior, anterior:{ing:{total,unidade}}, entradas:{ing:n}, ritmo:{ing:n}, dias}

async function carregarBaseContagem() {
  const data = document.getElementById('ct-data')?.value || today();
  const loja = currentLoja;
  const [contagens, compras, transferencias] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);
  if (loja !== currentLoja) return;              // trocou de loja no meio: descarta
  const daLoja = contagens
    .filter(c => c.loja===loja && c.data < data && c.id !== _editContagemId)
    .sort((a,b)=>a.data.localeCompare(b.data));
  const anterior = daLoja[daLoja.length-1];
  if (!anterior) { _ctBase = null; pintarBaseContagem(); return; }

  const entradas = {};
  for (const ing of Object.keys(anterior.ingredientes||{}))
    entradas[ing] = entradasEntreContagens(ing, loja, anterior.data, data, compras, transferencias);

  _ctBase = {
    dataAnterior: anterior.data,
    anterior: anterior.ingredientes || {},
    entradas,
    ritmo: ritmoConsumoPorDia(loja, daLoja, compras, transferencias),
    dias: Math.max(1, Math.round((new Date(data) - new Date(anterior.data))/86400000))
  };
  pintarBaseContagem();
}

// Escreve "tinha X · gasta ~Y/dia" embaixo do nome de cada insumo. É a informação que
// transforma a contagem de digitação cega em conferência: a pessoa vê o que esperar.
function pintarBaseContagem() {
  document.querySelectorAll('#ct-tbody .ct-nome-sub').forEach(el => {
    const ing = el.dataset.base;
    const b = _ctBase, ant = b && b.anterior[ing];
    if (!ant) { el.textContent = ''; return; }
    const un = ant.unidade || '';
    const r = b.ritmo[ing];
    el.innerHTML = `tinha <b>${fmtNum(ant.total,3)} ${esc(un)}</b>`
      + (r ? ` · gasta ~${fmtNum(r,2)}/dia` : '');
  });
}

// ⭐ A REGRA — FONTE ÚNICA. Usada pela conferência AO VIVO (updateTotalContagem) e pela
// conferência AO SALVAR (conferirContagem). Se um dia mudar o critério, muda aqui e nos
// dois lugares muda junto — telas que discordam sobre o que é absurdo é pior que não avisar.
function avaliarInsumo(ing, total, base) {
  const b = base || _ctBase;
  if (!b) return null;
  const ant = b.anterior[ing];
  if (!ant || ant.total == null) return null;    // não estava na contagem anterior
  const ini = ant.total, un = ant.unidade || '';
  const ent = b.entradas[ing] || 0;
  const consumo = ini + ent - (total||0);

  if (consumo < -0.01) {
    return {ing, tipo:'furo', grave:true, selo:'Furo', agora:total, anterior:ini, unidade:un,
      texto:`O estoque <strong>subiu</strong> de ${fmtNum(ini,3)} para ${fmtNum(total,3)} ${esc(un)}`
           + (ent>0 ? ` mesmo com ${fmtNum(ent,3)} ${esc(un)} de entrada` : ' sem nenhuma entrada registrada')
           + `. Ou a contagem está errada, ou falta lançar uma compra.`};
  }
  // Gasto excessivo e gasto baixo demais são separados de propósito: pedem providências
  // DIFERENTES. Excesso pode ser desperdício real na cozinha; gasto baixo demais é quase
  // sempre caixa contada como unidade solta.
  const porDia = consumo/b.dias, normal = b.ritmo[ing];
  if (normal && normal > 0 && porDia > 0) {
    if (porDia/normal >= 3) {
      return {ing, tipo:'excesso', grave:false, selo:'Gasto excessivo', agora:total, anterior:ini, unidade:un,
        texto:`Saíram <strong>${fmtNum(consumo,3)} ${esc(un)}</strong> em ${b.dias} dia(s) — ${fmtNum(porDia/normal,1)}× o que esta loja costuma gastar `
             + `(${fmtNum(normal,3)} ${esc(un)}/dia). Confira a unidade antes de tratar como perda.`};
    }
    if (normal/porDia >= 3) {
      return {ing, tipo:'baixo', grave:false, selo:'Gasto baixo demais', agora:total, anterior:ini, unidade:un,
        texto:`Saíram só <strong>${fmtNum(consumo,3)} ${esc(un)}</strong> em ${b.dias} dia(s), contra ${fmtNum(normal,3)} ${esc(un)}/dia de costume. `
             + `Quase sempre é caixa contada como unidade solta.`};
    }
  }
  return null;
}

// Devolve a lista de insumos que merecem uma segunda olhada ANTES de salvar.
// Recarrega a base (a data pode ter mudado desde que a tela abriu) e aplica a MESMA regra.
async function conferirContagem(data, ingredientes) {
  await carregarBaseContagem();
  if (!_ctBase) return [];                       // 1ª contagem da loja: nada a comparar
  const achados = [];
  for (const [ing, val] of Object.entries(ingredientes)) {
    if (ehAtendimento(ing)) continue;   // atendimento não entra na conferência de divergência
    const av = avaliarInsumo(ing, val.total);
    if (av) achados.push(av);
  }
  return achados;
}

// Monta e abre a janela de revisão. Devolve true se o Gabriel/atendente confirmou
// que quer salvar assim mesmo. Marca também as linhas na tabela, para a pessoa
// achar o insumo sem procurar.
function pedirRevisaoContagem(achados) {
  document.querySelectorAll('#ct-tbody .ct-revisar').forEach(el=>el.classList.remove('ct-revisar'));
  achados.forEach(a => {
    const inp = document.querySelector(`#ct-tbody [data-ing="${CSS.escape(a.ing)}"][data-campo="cx"]`);
    inp?.closest('.ct-item')?.classList.add('ct-revisar');
  });
  const corpo = document.getElementById('ct-revisao-corpo');
  corpo.innerHTML = achados.map(a => `
    <div class="ct-rev-item ${a.tipo==='furo'?'is-furo':'is-ritmo'}">
      <div class="ct-rev-ing">${esc(a.ing)}
        <span class="badge ${a.tipo==='furo'?'text-bg-danger':'text-bg-warning'} ms-1">${esc(a.selo||a.tipo)}</span>
      </div>
      <div class="ct-rev-txt">${a.texto}</div>
      <div class="ct-rev-num">Contagem anterior <strong>${fmtNum(a.anterior,3)}</strong> → agora <strong>${fmtNum(a.agora,3)}</strong> ${esc(a.unidade)}</div>
    </div>`).join('');
  document.getElementById('ct-revisao-resumo').textContent =
    `${achados.length} insumo(s) precisam de conferência antes de salvar.`;

  return new Promise(resolve => {
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('ct-revisao-modal'));
    _ctRevisaoResolve = resolve;
    modal.show();
  });
}
let _ctRevisaoResolve = null;
function ctRevisaoResponder(salvarAssimMesmo) {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('ct-revisao-modal')).hide();
  if (_ctRevisaoResolve) { _ctRevisaoResolve(salvarAssimMesmo); _ctRevisaoResolve = null; }
}

// Porta pública: os DOIS botões da tela (cabeçalho e rodapé) entram por aqui.
// A trava impede que o segundo clique crie uma contagem gêmea.
async function salvarContagem() {
  return travarGravacao('contagem', _salvarContagemImpl, '[onclick*="salvarContagem"]');
}

async function _salvarContagemImpl() {
  const data = document.getElementById('ct-data').value;
  if (!data) { toast('Selecione a data da contagem!','error'); return; }
  const momento = document.getElementById('ct-momento').value === 'fim' ? 'fim' : 'antes';

  const ingredientes = {};
  let count = 0;

  for (const grupo of INGREDIENTES_CONTAGEM_LISTA) {
    for (const item of grupo.itens) {
      const n = item.nome;
      const cxEl = document.querySelector(`[data-ing="${CSS.escape(n)}"][data-campo="cx"]`);
      const unEl = document.querySelector(`[data-ing="${CSS.escape(n)}"][data-campo="un"]`);
      if (!cxEl) continue;
      // "0 contado é 0, não é 'em branco'": o item entra se QUALQUER campo tiver algo
      // digitado (inclui o 0). Só quando os DOIS estão vazios é que não foi contado.
      const cxRaw = (cxEl.value == null ? '' : String(cxEl.value)).trim();
      const unRaw = (unEl && unEl.value != null ? String(unEl.value) : '').trim();
      if (cxRaw === '' && unRaw === '') continue;
      const cx = parseFloat(cxRaw)||0;
      const un = parseFloat(unRaw)||0;
      const r = converterContagem(n, cx, un);
      ingredientes[n] = {caixas:cx, unidades:un, total:r.total, unidade:r.unidade};
      count++;
    }
  }

  if (count === 0) { toast('Nenhum ingrediente preenchido!','warning'); return; }

  // CONFERÊNCIA ANTES DE SALVAR: número que não fecha com a contagem anterior é
  // barrado aqui, com quem contou ainda na frente do estoque. Vem primeiro que o
  // aviso de "faltam insumos" porque errar o número é pior que deixar de contar.
  const achados = await conferirContagem(data, ingredientes);
  if (achados.length && !(await pedirRevisaoContagem(achados))) return;

  // Aviso FORTE de insumo sem contagem (só os que a LOJA USA, pelo histórico) — pedido do Gabriel.
  const {faltam} = insumosSemContagem();
  if (faltam.length && !confirm(`Faltam contar ${faltam.length} insumo(s) que a ${LOJA_LABEL[currentLoja]} usa:\n\n${faltam.join(', ')}\n\nSem eles, o CMV e o valor de estoque ficam furados.\n\nSalvar mesmo assim?`)) return;

  // Evita contagem duplicada na mesma data (o certo é editar a existente)
  if (!_editContagemId) {
    const jaExiste = (await DB.getAll('contagens')).find(c=>c.loja===currentLoja && c.data===data);
    if (jaExiste && !confirm(`Já existe uma contagem de ${LOJA_LABEL[currentLoja]} em ${fmtDate(data)}.\n\nO ideal é EDITAR a existente (botão de lápis no histórico acima). Salvar mesmo assim cria uma SEGUNDA contagem na mesma data.\n\nContinuar?`)) return;
  }

  if (_editContagemId) {
    await DB.put('contagens', {id:_editContagemId, loja:currentLoja, data, momento, ingredientes, created_at:new Date().toISOString()});
    toast(`Contagem de ${LOJA_LABEL[currentLoja]} (${fmtDate(data)}) atualizada — ${count} ingredientes!`, 'success');
    cancelarEdicaoContagem();
  } else {
    await DB.add('contagens', {loja:currentLoja, data, momento, ingredientes, created_at:new Date().toISOString()});
    toast(`Contagem de ${LOJA_LABEL[currentLoja]} (${fmtDate(data)}) salva — ${count} ingredientes!`, 'success');
    buildContagemTable();
    loadContagemHist();
  }
  _ctExiste = {};   // item novo contado passa a "existir" na loja
}

async function importXLSX(input) {
  const file = input.files[0];
  if (!file) return;
  try {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, {type:'array'});

  // O modelo de contagem tem uma aba por loja (BURITIS/PLANALTO/VENDA NOVA).
  // Lê a aba da loja ATIVA; se não achar, usa a primeira.
  const alvo = norm(LOJA_LABEL[currentLoja]);
  const sheetName = wb.SheetNames.find(s => norm(s) === alvo) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});

  const valores = {};
  const cru = {};   // ingrediente reconhecido -> {cxRaw, unRaw} (para o rateio provolone/parmesão)
  // "0 contado é 0, não é 'em branco'": uma célula com 0 EXPLÍCITO significa estoque
  // zero (contei e não tem); só a célula VAZIA é "não contei". Por isso separamos
  // "tem número" (inclui o 0) de "vira número" (0 quando vazio).
  const temNum = (v) => {
    if (v === '' || v === null || v === undefined) return false;
    const s = String(v).trim();
    return s !== '' && !isNaN(parseFloat(s.replace(',','.')));
  };
  const num = (v) => parseFloat(String(v==null?'':v).replace(',','.')) || 0;
  // Tenta reconhecer um ingrediente numa trinca (nome, contagem1, contagem2).
  const tentar = (nomeRaw, cxRaw, unRaw) => {
    const nome = String(nomeRaw||'').trim();
    if (!nome) return;
    const mapeado = TODOS_INGREDIENTES.find(n=>norm(n)===normIng(nome)) || matchIngrediente(nome);
    if (!mapeado) return;
    // Contou se QUALQUER das duas células tem número (0 explícito conta). As duas
    // vazias = não contei = fica fora (não vira {0,0} nem entra na tabela).
    if (!temNum(cxRaw) && !temNum(unRaw)) return;
    cru[mapeado] = {cxRaw, unRaw};
    valores[mapeado] = {caixas:num(cxRaw), unidades:num(unRaw)};
  };
  // O modelo do Gabriel tem 2 blocos lado a lado: estoque (A|B|C) à esquerda e
  // atendimento+REFRIGERANTES (D|E|F) à direita. Lê os dois — só entra o que for
  // ingrediente reconhecido (material de atendimento é ignorado).
  for (const row of rows) {
    tentar(row[0], row[1], row[2]);  // bloco estoque: nome | caixas/fardos | unidades soltas
    tentar(row[3], row[4], row[5]);  // bloco direito: nome | fardos | unidades soltas (refrigerantes)
  }

  // PROVOLONE + PARMESÃO são ralados JUNTOS: a coluna da direita (aberto/ralado) é
  // UMA só — contada uma vez, vale pelos dois. Cada queijo recebe METADE dela; os kg
  // FECHADOS (coluna da esquerda) continuam por queijo. O valor compartilhado vem da
  // linha do provolone (é onde a célula mesclada C8:C9 do modelo deposita o número) e
  // cai na do parmesão só se a do provolone vier vazia.
  const provKey = TODOS_INGREDIENTES.find(n=>normIng(n)==='PROVOLONE');
  const parmKey = TODOS_INGREDIENTES.find(n=>normIng(n)==='PARMESAO');
  if (provKey && parmKey) {
    const gProv = cru[provKey] && cru[provKey].unRaw;
    const gParm = cru[parmKey] && cru[parmKey].unRaw;
    const ralado = temNum(gProv) ? num(gProv) : (temNum(gParm) ? num(gParm) : null);
    if (ralado !== null) {
      const metade = ralado / 2;
      valores[provKey] = {caixas: cru[provKey] ? num(cru[provKey].cxRaw) : 0, unidades: metade};
      valores[parmKey] = {caixas: cru[parmKey] ? num(cru[parmKey].cxRaw) : 0, unidades: metade};
    }
  }

  if (Object.keys(valores).length === 0) {
    toast('Não foi possível reconhecer ingredientes no arquivo. Verifique o formato.', 'warning');
    return;
  }

  buildContagemTable(valores);
  // A base de comparação (_ctBase) é carregada em segundo plano por buildContagemTable —
  // sem esperar ela terminar, updateTotalContagem avalia os itens importados com a base
  // ainda vazia/desatualizada e nenhum alerta dispara (nem um Furo grave). Espera aqui.
  await carregarBaseContagem();
  // Update totals
  for (const n of Object.keys(valores)) {
    updateTotalContagem(n);
  }
  const nBeb = Object.keys(valores).filter(n=>REFRIG_LOOKUP[norm(n)]).length;
  toast(`${Object.keys(valores).length} ingredientes importados (aba ${esc(sheetName)})${nBeb?` — inclui ${nBeb} refrigerantes`:''}!`, 'success');
  } catch(e) {
    console.error(e);
    toast('Não foi possível ler o arquivo: '+esc(e.message), 'error');
  } finally {
    input.value = '';
  }
}

// ================================================================
// 8. VENDAS TOTEM
// ================================================================
let _vendasParsed = null;

function parseBRNum(s) {
  return parseFloat(String(s||'0').replace(/\./g,'').replace(',','.')) || 0;
}

// Detecta em qual coluna está cada campo, lendo a linha de cabeçalho.
// Buritis/Planalto: Código=8, Produto=9. Venda Nova: Código=4, Produto=7. Valor/Qtde/SubTotal variam.
function detectarColunas(lines) {
  const cols = {cod:8, prod:9, valor:10, qtd:11}; // padrão
  for (const line of lines) {
    const f = line.split(';').map(x=>norm(x||''));
    const ci = f.findIndex(x=>x.startsWith('CODIGO'));
    const pi = f.findIndex(x=>x==='PRODUTO');
    const qi = f.findIndex(x=>x==='QTDE' || x==='QTD' || x==='QUANTIDADE');
    const vi = f.findIndex(x=>x.startsWith('VALOR'));
    if (ci>=0 && pi>=0) {
      cols.cod=ci; cols.prod=pi;
      if (qi>=0) cols.qtd=qi;
      if (vi>=0) cols.valor=vi;
      break;
    }
  }
  return cols;
}

// Aplica o mapeamento por código a uma lista de itens crus [{codigo,produto,qtde,valor}].
// Reutilizado pelo CSV manual (parseTOTEM) E pela importação automática via API do TOTEM (JSON).
// É o "cérebro" único: lookupMapeamento + ignorar_no_consumo + lista de não-mapeados.
function mapearItens(raw) {
  const items = [];
  const unmapped = [];
  for (const it of (raw || [])) {
    const codigo = parseInt(it.codigo);
    if (isNaN(codigo) || codigo <= 0) continue;
    const produto = String(it.produto || '').trim();
    if (!produto) continue;
    const qtde = (typeof it.qtde === 'number') ? it.qtde : parseBRNum(it.qtde);
    const valor = (typeof it.valor === 'number') ? it.valor : parseBRNum(it.valor);
    if (qtde <= 0) continue;
    // sku estruturado (PI007...) quando vem da API; ausente no CSV antigo/histórico
    const sku = (it.sku!=null && String(it.sku).trim()) ? String(it.sku).trim() : null;

    const map = resolverMap({codigo, sku});
    if (map && map.ignorar_no_consumo) continue;
    items.push({codigo, sku, produto, qtde, valor, map: map||null});
    if (!map) unmapped.push({codigo, sku, produto, qtde});
  }
  return {items, unmapped};
}

function parseTOTEM(csvText) {
  const lines = csvText.split(/\r?\n/);
  const c = detectarColunas(lines);
  const minCols = Math.max(c.cod, c.prod, c.qtd) + 1;
  const raw = [];
  for (const line of lines) {
    const f = line.split(';');
    if (f.length < minCols) continue;
    raw.push({codigo: f[c.cod]?.trim(), produto: f[c.prod]?.trim(), qtde: f[c.qtd], valor: f[c.valor]});
  }
  return mapearItens(raw);
}

// Importa vendas vindas da API do TOTEM (vendas_totem.json): 1 registro por loja por DIA.
// Idempotente: cada registro é marcado origem 'totem-api' e SUBSTITUI o mesmo loja+dia
// (apaga o anterior antes de gravar) — rodar de novo nunca conta em dobro.
// Importações manuais por CSV (sem origem) NUNCA são tocadas.
//
// ⚠️ EM LOTE DE PROPÓSITO (corrigido 30/07/2026). A versão anterior fazia `await DB.delete` +
// `await DB.add` DENTRO do laço: com 180 registros (60 dias × 3 lojas) davam ~360 idas à rede,
// sequenciais. Na nuvem/celular isso levava minutos e quase nunca terminava — e, como o arquivo
// vem AGRUPADO POR LOJA (Planalto, Buritis, Venda Nova), quem morria no meio sempre deixava as
// ÚLTIMAS lojas sem os dias novos. Sintoma real: em 29/07 só o Planalto tinha pizzas na aba
// "Pizzas por Dia" (o Dashboard mostrava as 3 porque lê outra fonte). Agora são ~3 requisições:
// 1 leitura de chaves + 1 delete em lote + 1 insert em lote.
async function importarVendasJSON(obj, opts) {
  const silencioso = !!(opts && opts.silencioso);
  if (!obj || obj.fonte !== 'totem-api' || !Array.isArray(obj.registros)) {
    if (!silencioso) toast('Arquivo do TOTEM inválido.', 'error');
    return {ok:false, dias:0, lojas:0};
  }

  // Só as chaves (id/loja/data/origem) — não baixa o `itens` de milhares de dias só p/ comparar.
  const chaves = DB.chavesVendas ? await DB.chavesVendas() : await DB.getAll('vendas');
  const idsPorDia = {};                                  // 'LOJA|AAAA-MM-DD' -> [ids a substituir]
  for (const v of chaves) {
    if (v.origem !== 'totem-api' || v.data_inicio !== v.data_fim) continue;
    (idsPorDia[v.loja + '|' + v.data_fim] = idsPorDia[v.loja + '|' + v.data_fim] || []).push(v.id);
  }

  // Monta tudo em memória primeiro. Ordem: dia mais NOVO primeiro e lojas intercaladas — se algum
  // dia uma interrupção voltar a acontecer, ela custa os dias VELHOS (que já estão no banco),
  // nunca o dia de ontem de uma loja só.
  const agora = new Date().toISOString();
  const novos = [], apagar = [], lojasSet = new Set();
  const regs = obj.registros
    .filter(r => r && LOJA_LABEL[r.loja] && r.data)
    .sort((a, b) => b.data.localeCompare(a.data) || a.loja.localeCompare(b.loja));
  for (const reg of regs) {
    const {items, unmapped} = mapearItens(reg.itens);
    const ids = idsPorDia[reg.loja + '|' + reg.data];
    if (ids) apagar.push(...ids);
    novos.push({
      loja: reg.loja, data_inicio: reg.data, data_fim: reg.data,
      itens: items, unmapped, filename: `TOTEM ${reg.data}`,
      origem: 'totem-api', created_at: agora
    });
    lojasSet.add(reg.loja);
  }
  if (!novos.length) return {ok:true, dias:0, lojas:0};

  // Apaga o que será substituído e grava tudo de uma vez. Se falhar no meio, o marcador de
  // assinatura NÃO é gravado pelo chamador → a próxima abertura reimporta o arquivo inteiro.
  if (DB.deleteMuitos) await DB.deleteMuitos('vendas', apagar);
  else for (const id of apagar) await DB.delete('vendas', id);
  if (DB.addLote) await DB.addLote('vendas', novos);
  else for (const row of novos) await DB.add('vendas', row);

  if (!silencioso) toast(`TOTEM: ${novos.length} dia(s) de venda atualizados.`, 'success');
  return {ok:true, dias: novos.length, lojas: lojasSet.size};
}

// Busca o vendas_totem.json ao abrir o app. Servido por http (servidor local) → importa sozinho.
// Em file:// (duplo-clique) a busca não acha e o app segue normal — sem quebrar nada.
// NUVEM: o arquivo vem da tabela arquivos_totem (subido pela ponte no PC) e a importação roda em
// SEGUNDO PLANO (não trava a abertura — a 1ª importação faz muitas escritas pela rede). A assinatura
// vive num MARCADOR NA NUVEM, compartilhado: o 1º aparelho que abrir importa; os outros pulam.
async function atualizarDoTotem() {
  if (window.Nuvem && Nuvem.ativa()) { _atualizarDoTotemNuvem(); return; }
  try {
    const resp = await fetch('vendas_totem.json', {cache: 'no-store'});
    if (!resp.ok) return;
    const obj = await resp.json();
    // Otimização: se o conteúdo é idêntico ao último importado, pula (abre instantâneo).
    const sig = obj.assinatura || (obj.gerado_em + '|' + (obj.registros?.length || 0));
    if (localStorage.getItem('totem_import_sig') === sig) return;
    const r = await importarVendasJSON(obj, {silencioso: true});
    if (r.ok) localStorage.setItem('totem_import_sig', sig);
    if (r.ok && r.dias) toast(`Vendas do TOTEM atualizadas: ${r.dias} dia(s).`, 'success');
  } catch (e) { /* file:// ou arquivo ausente: segue normal */ }
}

// Importação em segundo plano na nuvem. O ERRO AQUI ERA MUDO (só console.warn): quando a
// importação não terminava, o app seguia mostrando dado velho sem dizer nada, e só se percebia
// dias depois olhando uma tela específica. Agora falha avisa, e o sucesso re-renderiza a tela.
let _totemImportando = false;
async function _atualizarDoTotemNuvem() {
  if (_totemImportando) return;             // 2 chamadas juntas (boot + volta pro app) duplicariam tudo
  _totemImportando = true;
  try {
    const obj = await Nuvem.lerArquivo('vendas_totem.json');
    if (!obj || !obj.registros) return;   // robô ainda não rodou — segue com o que está no banco
    const sig = obj.assinatura || (obj.gerado_em + '|' + (obj.registros?.length || 0));
    if (await Nuvem.lerMarcador('totem_import_sig') === sig) return;   // outro aparelho já importou
    const r = await importarVendasJSON(obj, {silencioso: true});
    if (r.ok) {
      await Nuvem.gravarMarcador('totem_import_sig', sig);   // só marca depois de gravar TUDO
      if (r.dias) {
        toast(`Vendas do TOTEM atualizadas: ${r.dias} dia(s) em ${r.lojas} loja(s).`, 'success');
        if (typeof atualizarTelasFinanceiras === 'function') atualizarTelasFinanceiras();
      }
    }
  } catch (e) {
    console.warn('TOTEM→nuvem:', e);
    try { toast('Não consegui atualizar as vendas do TOTEM: ' + esc(e.message) + ' — os números por dia podem estar atrasados.', 'warning'); } catch (e2) {}
  } finally { _totemImportando = false; }
}

function dropCSV(e) {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) { processCSVFile(file); }
}

function loadCSV(input) {
  const file = input.files[0];
  if (file) processCSVFile(file);
}

// Tenta adivinhar o período pelo nome do arquivo (ex.: "PLANALTO 07 06 - 10 06.csv")
function sugerirPeriodoDoNome(nome) {
  const m = String(nome||'').match(/(\d{1,2})[\s._\/-]+(\d{1,2})\s*(?:a|à|-|–)\s*(\d{1,2})[\s._\/-]+(\d{1,2})/);
  if (!m) return null;
  const d1=+m[1], m1=+m[2], d2=+m[3], m2=+m[4];
  if (!d1||!d2||!m1||!m2||d1>31||d2>31||m1>12||m2>12) return null;
  const ano = new Date().getFullYear();
  const pad = x=>String(x).padStart(2,'0');
  const ini = `${ano}-${pad(m1)}-${pad(d1)}`, fim = `${ano}-${pad(m2)}-${pad(d2)}`;
  return fim >= ini ? {ini, fim} : null;
}

function processCSVFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result; // já lido como windows-1252 (encoding do TOTEM)
    const parsed = parseTOTEM(text);

    if (!parsed.items.length) {
      toast('Nenhum produto reconhecido neste arquivo. Confira se é o CSV exportado do TOTEM (CF Sistemas).','error');
      _vendasParsed = null;
      document.getElementById('vd-preview').classList.add('d-none');
      return;
    }
    _vendasParsed = {items: parsed.items, unmapped: parsed.unmapped, filename: file.name};

    // Se as datas estão vazias, sugere o período pelo nome do arquivo
    const iniEl = document.getElementById('vd-inicio'), fimEl = document.getElementById('vd-fim');
    if (!iniEl.value && !fimEl.value) {
      const sug = sugerirPeriodoDoNome(file.name);
      if (sug) { iniEl.value = sug.ini; fimEl.value = sug.fim; toast('Período sugerido pelo nome do arquivo — confira as datas antes de salvar.','info'); }
    }

    const totalPizzas = contarPizzas(parsed.items);
    const totalBebidas = contarBebidas(parsed.items);
    const totalItens = parsed.items.length;

    document.getElementById('vd-info').innerHTML =
      `<strong>${esc(file.name)}</strong> — ${totalItens} produtos | <strong>${fmtPizzas(totalPizzas)} pizzas</strong> (só sabores) | ${fmtPizzas(totalBebidas)} bebidas`;

    if (parsed.unmapped.length) {
      document.getElementById('vd-unmapped').classList.remove('d-none');
      document.getElementById('vd-unmapped').innerHTML =
        `<i class="fas fa-exclamation-triangle me-1"></i><strong>${parsed.unmapped.length} produto(s) não reconhecido(s)</strong> — `+
        `<a href="#" onclick="showPage('mapeamentos');return false" class="alert-link">clique aqui para ensinar o sistema</a>:<br>`+
        parsed.unmapped.map(u=>`Cód ${u.codigo}: ${esc(u.produto)} (${u.qtde}x)`).join('<br>');
    } else {
      document.getElementById('vd-unmapped').classList.add('d-none');
    }

    document.getElementById('vd-preview').classList.remove('d-none');
    document.getElementById('vd-dropzone').innerHTML = `<i class="fas fa-check-circle fa-2x text-success mb-2"></i><div class="text-success fw-bold">${esc(file.name)}</div><small class="text-muted">Arquivo carregado</small>`;
  };
  reader.readAsText(file, 'windows-1252');
}

// Porta pública. A trava existe porque esta função tem a MESMA assinatura do bug medido em
// 25/08/2026 nas Compras: a checagem de período repetido faz um `DB.getAll` (em modo nuvem,
// uma ida à rede inteira) e só DEPOIS grava. O segundo clique atravessa essa janela antes de
// o primeiro fechar, e período de venda gravado duas vezes conta as vendas EM DOBRO em todas
// as análises (CMV, faturamento, pizzas por dia). Trava por CHAVE, não só no botão.
async function salvarVendas() {
  return travarGravacao('vendas', _salvarVendasImpl, '[onclick*="salvarVendas"]');
}

async function _salvarVendasImpl() {
  if (!_vendasParsed) { toast('Carregue um CSV primeiro!','warning'); return; }
  const inicio = document.getElementById('vd-inicio').value;
  const fim = document.getElementById('vd-fim').value;
  if (!inicio||!fim) { toast('Preencha o período (data início e fim)!','error'); return; }
  if (fim < inicio) { toast('A data fim deve ser maior ou igual à data início!','error'); return; }

  const loja = currentLoja;
  // Período repetido ou cruzado conta as vendas EM DOBRO nas análises — avisa antes
  const existentes = (await DB.getAll('vendas')).filter(v=>v.loja===loja);
  const igual = existentes.find(v=>v.data_inicio===inicio && v.data_fim===fim);
  if (igual && !confirm(`Já existe uma importação de ${LOJA_LABEL[loja]} com este mesmo período (${fmtDate(inicio)} a ${fmtDate(fim)}).\n\nImportar de novo vai contar as vendas EM DOBRO nas análises.\n\nSalvar mesmo assim?`)) return;
  const cruzada = !igual && existentes.find(v=>v.data_inicio<=fim && v.data_fim>=inicio);
  if (cruzada && !confirm(`Atenção: este período cruza com outra importação de ${LOJA_LABEL[loja]} (${fmtDate(cruzada.data_inicio)} a ${fmtDate(cruzada.data_fim)}).\n\nDias repetidos contam vendas em dobro nas análises.\n\nSalvar mesmo assim?`)) return;

  await DB.add('vendas', {
    loja, data_inicio:inicio, data_fim:fim,
    itens: _vendasParsed.items,
    unmapped: _vendasParsed.unmapped,
    filename: _vendasParsed.filename,
    created_at: new Date().toISOString()
  });

  toast(`Vendas de ${LOJA_LABEL[loja]} (${fmtDate(inicio)}–${fmtDate(fim)}) salvas!`, 'success');
  _vendasParsed = null;
  document.getElementById('vd-inicio').value = '';
  document.getElementById('vd-fim').value = '';
  document.getElementById('vd-preview').classList.add('d-none');
  document.getElementById('vd-dropzone').innerHTML = `<i class="fas fa-file-csv fa-2x mb-2"></i><div>Clique ou arraste o CSV aqui</div><small>Exportação padrão CF Sistemas / TOTEM</small>`;
  renderVendasHist();
}

async function renderVendasHist() {
  const todas = (await DB.getAll('vendas')).sort((a,b)=>b.data_fim.localeCompare(a.data_fim));
  const tbody = document.getElementById('vd-hist-tbody');
  if (!todas.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Nenhuma importação.</td></tr>';
    return;
  }
  // Lista limitada (o histórico tem MILHARES de importações diárias — renderizar tudo travava,
  // principalmente no celular). Os CÁLCULOS usam sempre o banco inteiro; aqui é só a listagem.
  const teto = modoLeveCelular() ? 120 : 400;
  const vendas = todas.slice(0, teto);
  const nota = todas.length > teto
    ? `<tr><td colspan="5" class="text-center text-muted small py-2">Mostrando as <strong>${teto}</strong> importações mais recentes de <strong>${todas.length}</strong> — as demais continuam valendo nos cálculos.</td></tr>` : '';
  // Pizzas = régua única (resumo do TOTEM nos dias da importação), o mesmo número das outras abas.
  // Se os sabores reconhecidos da importação somarem outra coisa, o número fica marcado e o título diz
  // quanto — a diferença é produto sem sabor cadastrado (Mapear produtos).
  const ceoHist = await carregarCEO().catch(()=>null);
  tbody.innerHTML = nota + vendas.map(v=>{
    const pzSabores = contarPizzas(v.itens);
    const pzRegua = pizzasDoResumo(ceoHist, [v.loja], v.data_inicio, v.data_fim);
    const totalBebidas = contarBebidas(v.itens);
    const celPz = (pzRegua==null || Math.abs(pzRegua - pzSabores) < 0.01) ? fmtPizzas(pzRegua==null ? pzSabores : pzRegua)
      : `<span class="text-warning fw-semibold" title="Os sabores reconhecidos desta importação somam ${fmtPizzas(pzSabores)} — a diferença é produto sem sabor cadastrado em Mapear produtos">${fmtPizzas(pzRegua)}</span>`;
    return `<tr>
      <td><span class="badge ${LOJA_BADGE[v.loja]}">${LOJA_LABEL[v.loja]||v.loja}</span></td>
      <td>${fmtDate(v.data_inicio)} → ${fmtDate(v.data_fim)}</td>
      <td class="text-end">${celPz}</td>
      <td class="text-end">${fmtPizzas(totalBebidas)}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-primary py-0 px-1 me-1" onclick="editVenda(${v.id})" title="Editar período"><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteVenda(${v.id})" title="Excluir"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

async function editVenda(id) {
  const v = (await DB.getAll('vendas')).find(x=>x.id===id);
  if (!v) return;
  const ini = prompt('Data INÍCIO do período (dd/mm/aaaa):', fmtDate(v.data_inicio));
  if (ini===null) return;
  const fim = prompt('Data FIM do período (dd/mm/aaaa):', fmtDate(v.data_fim));
  if (fim===null) return;
  const di = parseDataFlex(ini), df = parseDataFlex(fim);
  if (!di||!df) { toast('Datas inválidas. Use o formato dd/mm/aaaa.','error'); return; }
  if (df<di) { toast('A data fim deve ser maior ou igual à data início!','error'); return; }
  await DB.put('vendas', {...v, data_inicio:di, data_fim:df});
  toast('Período da importação atualizado!','success');
  renderVendasHist();
}

async function deleteVenda(id) {
  if (!confirm('Apagar esta importação?')) return;
  await DB.delete('vendas', id);
  renderVendasHist();
  toast('Importação removida.','success');
}

// ================================================================
// 9. COMPRAS
// ================================================================
async function renderCompras() {
  // Populate ingredient select
  const cpIng = document.getElementById('cp-ing');
  if (cpIng.options.length <= 1) {
    TODOS_INGREDIENTES.forEach(n=>{
      const opt = new Option(n,n);
      cpIng.add(opt);
    });
  }

  // Populate transfer ingredient select too
  const trIng = document.getElementById('tr-ing');
  if (trIng.options.length <= 1) {
    TODOS_INGREDIENTES.forEach(n=>{ trIng.add(new Option(n,n)); });
  }

  document.getElementById('cp-data').value = today();
  document.getElementById('cp-loja').value = currentLoja;
  loadComprasHist();
}

function updateCpUnidade() {
  const ing = document.getElementById('cp-ing').value;
  const sel = document.getElementById('cp-un');
  sel.innerHTML = '';
  if (!ing) { sel.add(new Option('kg','KG')); return; }
  unidadesPossiveis(ing).forEach(([v,l])=>sel.add(new Option(l,v)));
  updateCpPreview();
}

function updateCpPreview() {
  const ing = document.getElementById('cp-ing').value;
  const qtd = parseFloat(document.getElementById('cp-qtd').value)||0;
  const un = document.getElementById('cp-un').value;
  const prev = document.getElementById('cp-preview');

  if (!ing || !qtd) { prev.textContent=''; return; }

  const base = calcCompraBase(ing, qtd, un);
  prev.textContent = `→ ${fmtNum(base.total,3)} ${base.unidade}`;
}

function calcCompraBase(ing, qtd, un) {
  const n = norm(ing);

  if (un === 'KG' || un === 'kg') return {total: qtd, unidade:'KG'};
  if (un === 'UN' || un === 'unidades') {
    const c = CONVERSAO.conversao_caixa[n];
    if (c) return {total: qtd * c.qtd_por_un, unidade: c.unidade};
    return {total: qtd, unidade:'UN'};
  }
  if (un === 'CX' || un === 'caixas') {
    const c = CONVERSAO.conversao_caixa[n];
    if (c) return {total: qtd * c.un_por_caixa * c.qtd_por_un, unidade: c.unidade};
    return {total: qtd, unidade:'UN'};
  }
  if (un === 'FARDOS') {
    const r = REFRIG_LOOKUP[n];
    if (r) return {total: qtd * r.un_por_fardo, unidade:'UN'};
    return {total: qtd, unidade:'UN'};
  }
  return {total: qtd, unidade:'UN'};
}

let _editCompraId = null;

async function salvarCompra() {
  return travarGravacao('compra', _salvarCompraImpl, '#cp-btn-salvar');
}

async function _salvarCompraImpl() {
  const data = document.getElementById('cp-data').value;
  const loja = document.getElementById('cp-loja').value;
  const ing = document.getElementById('cp-ing').value;
  const qtd = parseFloat(document.getElementById('cp-qtd').value)||0;
  const un = document.getElementById('cp-un').value;
  const forn = document.getElementById('cp-forn').value.trim();
  const valor = parseFloat(document.getElementById('cp-valor').value)||0;

  if (!data||!loja||!ing||!qtd) { toast('Preencha todos os campos obrigatórios!','error'); return; }
  if (qtd < 0 || valor < 0) { toast('Quantidade e valor não podem ser negativos.','error'); return; }

  const base = calcCompraBase(ing, qtd, un);
  const registro = {
    loja, data, ingrediente:ing,
    quantidade: qtd, unidade: un,
    quantidade_base: base.total, unidade_base: base.unidade,
    fornecedor: forn, valor_total: valor
  };

  if (_editCompraId) {
    // A IDENTIDADE DA NOTA SOBREVIVE À EDIÇÃO.
    // Antes, esta linha gravava apenas os 7 campos do formulário — e como DB.put
    // SUBSTITUI o registro inteiro, editar uma compra (tipicamente para trocar a
    // data de emissão pela data de RECEBIMENTO da loja) apagava nf_chave,
    // nf_numero e origem. Sem a chave, reimportar o mesmo XML deixava de ser
    // detectado: era essa a causa do "coloquei o XML de novo e ele não avisou".
    // MEDIDO no banco (25/08/2026): 168 compras vieram de XML, só 131 tinham chave.
    // Preservar created_at também importa — a auditoria de duplo clique se apoia
    // no horário ORIGINAL de gravação.
    const orig = (await DB.getAll('compras')).find(x=>x.id===_editCompraId) || {};
    await DB.put('compras', {...orig, ...registro, id:_editCompraId,
      created_at: orig.created_at || new Date().toISOString(),
      editado_em: new Date().toISOString()});
    toast(`Compra de ${ing} atualizada!`, 'success');
    cancelarEdicaoCompra();
  } else {
    await DB.add('compras', {...registro, created_at:new Date().toISOString()});
    toast(`Compra de ${ing} (${fmtNum(qtd,2)} ${un}) salva!`, 'success');
    document.getElementById('cp-qtd').value = '';
    document.getElementById('cp-valor').value = '';
    document.getElementById('cp-forn').value = '';
    document.getElementById('cp-preview').textContent = '';
  }
  _precoRefCache = null;   // compra nova entra na base de comparação de preço
  loadComprasHist();
}

async function editCompra(id) {
  const c = (await DB.getAll('compras')).find(x=>x.id===id);
  if (!c) return;
  _editCompraId = id;
  document.getElementById('cp-data').value = c.data;
  document.getElementById('cp-loja').value = c.loja;
  document.getElementById('cp-ing').value = c.ingrediente;
  updateCpUnidade();
  document.getElementById('cp-un').value = c.unidade;
  document.getElementById('cp-qtd').value = c.quantidade;
  document.getElementById('cp-forn').value = c.fornecedor||'';
  document.getElementById('cp-valor').value = c.valor_total||'';
  updateCpPreview();
  document.getElementById('cp-btn-salvar').innerHTML = '<i class="fas fa-save me-1"></i>Salvar alterações';
  document.getElementById('cp-btn-cancelar').classList.remove('d-none');
  document.getElementById('cp-data').scrollIntoView({block:'center'});
}

function cancelarEdicaoCompra() {
  _editCompraId = null;
  document.getElementById('cp-qtd').value = '';
  document.getElementById('cp-valor').value = '';
  document.getElementById('cp-forn').value = '';
  document.getElementById('cp-preview').textContent = '';
  document.getElementById('cp-btn-salvar').innerHTML = '<i class="fas fa-plus me-1"></i>Adicionar';
  document.getElementById('cp-btn-cancelar').classList.add('d-none');
}

async function loadComprasHist() {
  // filtro de mês (12 meses + Todos), populado uma vez
  const mesSel = document.getElementById('cp-filtro-mes');
  if (mesSel && !mesSel.options.length) {
    mesSel.add(new Option('Todos os meses',''));
    const base = new Date(today()+'T00:00:00');
    for (let i=0;i<12;i++) {
      const d = new Date(base.getFullYear(), base.getMonth()-i, 1);
      mesSel.add(new Option(MES_ABREV[d.getMonth()]+'/'+String(d.getFullYear()).slice(2),
        d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')));
    }
  }
  const filtroLoja = document.getElementById('cp-filtro-loja')?.value || '';
  const filtroMes = mesSel?.value || '';
  const txt = norm(document.getElementById('cp-filtro-texto')?.value || '');
  const compras = (await DB.getAll('compras'))
    .filter(c => !filtroLoja || c.loja===filtroLoja)
    .filter(c => !filtroMes || (c.data||'').startsWith(filtroMes))
    .filter(c => !txt || norm(c.ingrediente).includes(txt) || norm(c.fornecedor||'').includes(txt))
    .sort((a,b)=>b.data.localeCompare(a.data));

  const tbody = document.getElementById('cp-tbody');
  const resumoEl = document.getElementById('cp-resumo');
  if (!compras.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-3">${txt||filtroLoja||filtroMes?'Nenhuma compra para este filtro.':'Nenhuma compra.'}</td></tr>`;
    if (resumoEl) resumoEl.textContent = '';
    return;
  }
  if (resumoEl) {
    const totalValor = compras.reduce((s,c)=>s+(c.valor_total||0),0);
    resumoEl.innerHTML = `<i class="fas fa-filter me-1"></i><strong>${compras.length}</strong> compra${compras.length>1?'s':''}${txt?` com "<strong>${esc(document.getElementById('cp-filtro-texto').value.trim())}</strong>"`:''}${filtroMes?` em <strong>${MES_ABREV[parseInt(filtroMes.slice(5,7),10)-1]}/${filtroMes.slice(2,4)}</strong>`:''} · total pago <strong>${fmtBRL(totalValor)}</strong>`;
  }
  tbody.innerHTML = compras.map(c=>{
    // Preço pela UNIDADE COMPRADA (o que o Gabriel enxerga: bacon R$/kg, catupiry R$/un = por pote).
    // Usa quantidade/unidade da compra; se faltar, cai na base (quantidade_base/unidade_base).
    const temCompra = c.valor_total>0 && c.quantidade>0;
    const precoUn = temCompra ? c.valor_total/c.quantidade : ((c.valor_total>0 && c.quantidade_base>0) ? c.valor_total/c.quantidade_base : null);
    const unLbl = (temCompra ? c.unidade : c.unidade_base) || '';
    return `
    <tr>
      <td class="text-nowrap">${fmtDate(c.data)}</td>
      <td><span class="badge ${LOJA_BADGE[c.loja]}">${LOJA_LABEL[c.loja]||c.loja}</span></td>
      <td class="fw-semibold">${esc(c.ingrediente)}</td>
      <td class="text-end text-nowrap">${fmtNum(c.quantidade,2)} ${esc(c.unidade||'')}${c.unidade!==c.unidade_base?`<div class="small text-muted">${fmtNum(c.quantidade_base,2)} ${esc(c.unidade_base||'')}</div>`:''}</td>
      <td class="text-end fw-semibold">${c.valor_total>0?fmtBRL(c.valor_total):'<span class="text-danger" title="Compra sem valor — o custo desta entrada fica de fora das análises de R$">R$ 0,00 ⚠</span>'}</td>
      <td class="text-end text-muted">${precoUn!=null?fmtBRL(precoUn)+'<span class="small">/'+esc(unLbl.toLowerCase())+'</span>':'—'}</td>
      <td class="text-muted small">${esc(c.fornecedor)||'—'}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary py-0 px-1 me-1" onclick="editCompra(${c.id})" title="Editar"><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteCompra(${c.id})" title="Excluir"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

async function deleteCompra(id) {
  if (!confirm('Apagar esta compra?')) return;
  await DB.delete('compras', id);
  loadComprasHist();
  toast('Compra removida.','success');
}

// ================================================================
// 8B. MAPEAMENTO DE PRODUTOS TOTEM (definido pelo usuário)
// ================================================================
// Calculada na hora para incluir bebidas/fardos criados na página Cardápio & Fichas
function bebidasEstoque() {
  return TODOS_INGREDIENTES.filter(n=>REFRIG_LOOKUP[norm(n)]);
}
// Bebidas (refrigerantes/água/sucos) são produtos de revenda, não vão na pizza.
// Ficam FORA das análises de desperdício/consumo (Divergências, Painel, Curva ABC).
// O controle delas é pela Contagem, Compras e Previsão.
function ehBebida(nome) {
  return !!REFRIG_LOOKUP[norm(nome)];
}

let _mpModalObj = null;

async function renderMapeamentos() {
  const vendas = await DB.getAll('vendas');
  // agrega códigos ainda não reconhecidos em todas as importações salvas
  const pend = {};
  for (const v of vendas) {
    for (const it of (v.itens||[])) {
      if (!resolverMap(it)) {
        // mapeia pela chave mais estável que o item tiver: sku (PI007...) ou, na falta, o id
        const chave = (it.sku!=null && String(it.sku).trim()) ? String(it.sku).trim() : String(it.codigo);
        if (!pend[chave]) pend[chave] = {chave, produto:it.produto, qtd:0};
        pend[chave].qtd += it.qtde;
        if (it.produto && !pend[chave].produto) pend[chave].produto = it.produto;
      }
    }
  }
  const pendArr = Object.values(pend).sort((a,b)=>b.qtd-a.qtd);
  document.getElementById('mp-pend-count').textContent = pendArr.length;
  const ptb = document.getElementById('mp-pendentes-tbody');
  ptb.innerHTML = pendArr.length ? pendArr.map(p=>`
    <tr>
      <td class="fw-bold text-danger">${esc(p.chave)}</td>
      <td class="small">${p.produto?esc(p.produto):'<span class="text-muted">(sem nome)</span>'}</td>
      <td class="text-end">${fmtNum(p.qtd,0)}</td>
      <td><button class="btn btn-sm btn-primary py-0 px-2" onclick="openMpModal(${JSON.stringify(String(p.chave)).replace(/"/g,'&quot;')}, ${JSON.stringify(p.produto||'').replace(/"/g,'&quot;')})">Mapear</button></td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-success py-3"><i class="fas fa-check-circle me-1"></i>Tudo reconhecido! Nenhum produto pendente.</td></tr>';

  // mapeamentos criados pelo usuário
  const custom = getMapCustom();
  const entries = Object.entries(custom);
  document.getElementById('mp-custom-count').textContent = entries.length;
  const ctb = document.getElementById('mp-custom-tbody');
  ctb.innerHTML = entries.length ? entries.map(([cod,m])=>`
    <tr>
      <td class="fw-bold">${cod}</td>
      <td class="small">${descreverMap(m)}</td>
      <td><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteMapeamentoCustom('${cod}')" title="Remover"><i class="fas fa-trash"></i></button></td>
    </tr>`).join('')
    : '<tr><td colspan="3" class="text-center text-muted py-3">Você ainda não criou mapeamentos.</td></tr>';
}

function descreverMap(m) {
  const sab = m.nome_ficha || '<em class="text-muted">sem receita</em>';
  if (m.categoria==='MEIA') return `<span class="badge bg-secondary">½</span> Meia de <strong>${sab}</strong>`;
  if (m.categoria==='INTEIRA') return `<span class="badge bg-secondary">1</span> Inteira de <strong>${sab}</strong>`;
  if (m.categoria==='PREMIUM') return `<span class="badge bg-warning text-dark">★</span> Premium de <strong>${sab}</strong>`;
  if (m.categoria==='ADICIONAL') return `➕ Adicional de <strong>${m.adicional_ingrediente}</strong> (${m.porcao_gramas} ${ingEmUnidade(m.adicional_ingrediente)?'un':'g'})`;
  if (m.categoria==='BEBIDA') return `🥤 Bebida <strong>${m.bebida_estoque}</strong>`;
  if (m.categoria==='AGRUPADOR') return `<span class="text-muted">🚫 Ignorado (combo/agrupador)</span>`;
  return '?';
}

function openMpModal(codigo, produto) {
  _mpModalObj = {codigo:String(codigo), produto};
  document.getElementById('mp-m-cod').textContent = codigo;
  document.getElementById('mp-m-prod').textContent = produto||'(sem nome)';
  document.getElementById('mp-m-extra').innerHTML = '';
  // Pré-seleciona a categoria pelo PREFIXO do sku (PI/PM→pizza, RF/AG/CE→bebida, AA→adicional).
  // Para pizza, mpModalCat() ainda adivinha o sabor pelo nome. O usuário confirma tudo.
  const catPalpite = categoriaPorPrefixoSku(_mpModalObj.codigo);
  document.getElementById('mp-m-cat').value = catPalpite || '';
  if (catPalpite) mpModalCat();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('mp-modal')).show();
}

function mpModalCat() {
  const cat = document.getElementById('mp-m-cat').value;
  const extra = document.getElementById('mp-m-extra');
  const sabores = Object.keys(FICHA_TECNICA).sort();
  const palpite = _mpModalObj ? matchSabor(_mpModalObj.produto) : null;

  if (['MEIA','INTEIRA','PREMIUM'].includes(cat)) {
    extra.innerHTML = `<label class="form-label small fw-semibold">Qual o sabor?</label>
      <select id="mp-m-ficha" class="form-select">
        <option value="" ${!palpite?'selected':''}>— Sem receita (apenas contar como pizza) —</option>
        ${sabores.map(s=>`<option value="${esc(s)}" ${s===palpite?'selected':''}>${esc(s)}</option>`).join('')}
      </select>
      <div class="form-text">O consumo de ingredientes virá da ficha técnica deste sabor. Use "sem receita" para sabores que não estão na ficha (ex.: sobremesas Fini) — eles contam como pizza, mas não descontam ingredientes.</div>`;
  } else if (cat==='ADICIONAL') {
    // adivinha o ingrediente pelo nome (ex.: "ADICIONAL FRANGO" -> FRANGO); o usuário confirma e põe a gramatura
    const t = norm(_mpModalObj?.produto||'').replace(/^ADICIONAL\s+/,'').trim();
    const ingPalpite = t && (TODOS_INGREDIENTES.find(n=>normIng(n)===normIng(t))
      || TODOS_INGREDIENTES.find(n=>{const x=normIng(n); return x===t || t.includes(x) || x.includes(t);})) || '';
    extra.innerHTML = `<div class="row g-2">
      <div class="col-7"><label class="form-label small fw-semibold">Ingrediente</label>
        <select id="mp-m-ing" class="form-select" onchange="mpPorcaoUnidade()">${TODOS_INGREDIENTES.map(n=>`<option value="${n}" ${n===ingPalpite?'selected':''}>${n}</option>`).join('')}</select></div>
      <div class="col-5"><label class="form-label small fw-semibold" id="mp-m-porc-lbl">Porção (g)</label>
        <input type="number" id="mp-m-porc" class="form-control" value="100" min="0" step="0.1"></div>
    </div>
    <div class="form-text" id="mp-m-porc-hint">Ovo e caixa são em <strong>unidades</strong>; os demais (inclusive cebola) em <strong>gramas</strong>.</div>`;
    mpPorcaoUnidade();
  } else if (cat==='BEBIDA') {
    extra.innerHTML = `<label class="form-label small fw-semibold">Qual bebida do estoque?</label>
      <select id="mp-m-beb" class="form-select">${bebidasEstoque().map(n=>`<option value="${n}">${n}</option>`).join('')}</select>`;
  } else if (cat==='AGRUPADOR') {
    extra.innerHTML = `<div class="alert alert-secondary py-2 small mb-0">Este código será ignorado nos cálculos de consumo e na contagem de pizzas (ex.: combos, "pizza 2 sabores", "pizza do dia").</div>`;
  } else {
    extra.innerHTML = '';
  }
}

// Ajusta o campo de porção do ADICIONAL conforme o ingrediente: unidade (ovo/caixa) ou gramas.
function mpPorcaoUnidade() {
  const ingEl = document.getElementById('mp-m-ing');
  const lbl = document.getElementById('mp-m-porc-lbl');
  const inp = document.getElementById('mp-m-porc');
  if (!ingEl || !lbl || !inp) return;
  const un = ingEmUnidade(ingEl.value);
  lbl.textContent = un ? 'Porção (unidades)' : 'Porção (g)';
  if (un && (inp.value==='100' || inp.value==='')) inp.value = '1';     // ovo: padrão 1 unidade
  if (!un && (inp.value==='1' || inp.value==='')) inp.value = '100';    // grama: padrão 100 g
}

// tenta adivinhar o sabor (nome_ficha) a partir do texto do produto TOTEM
function matchSabor(produto) {
  const p = norm(produto||'').replace(/^(MEIA|1\/2|INTEIRA|PIZZA|PREMIUM)\s+/,'');
  const nomes = Object.keys(FICHA_TECNICA).sort((a,b)=>b.length-a.length);
  for (const n of nomes) if (p.includes(norm(n))) return n;
  for (const n of nomes) if (norm(n).includes(p) && p.length>3) return n;
  return null;
}

function salvarMapeamentoCustom() {
  if (!_mpModalObj) return;
  const cat = document.getElementById('mp-m-cat').value;
  if (!cat) { toast('Escolha uma categoria!','error'); return; }

  let entry;
  if (cat==='MEIA') entry = {categoria:'MEIA', fator_consumo:0.5, nome_ficha:document.getElementById('mp-m-ficha').value};
  else if (cat==='INTEIRA') entry = {categoria:'INTEIRA', fator_consumo:1.0, nome_ficha:document.getElementById('mp-m-ficha').value};
  else if (cat==='PREMIUM') entry = {categoria:'PREMIUM', fator_consumo:1.0, nome_ficha:document.getElementById('mp-m-ficha').value};
  else if (cat==='ADICIONAL') entry = {categoria:'ADICIONAL', adicional_ingrediente:document.getElementById('mp-m-ing').value, porcao_gramas:parseFloat(document.getElementById('mp-m-porc').value)||0};
  else if (cat==='BEBIDA') entry = {categoria:'BEBIDA', bebida_estoque:document.getElementById('mp-m-beb').value};
  else if (cat==='AGRUPADOR') entry = {categoria:'AGRUPADOR', ignorar_no_consumo:true};

  const custom = getMapCustom();
  custom[_mpModalObj.codigo] = entry;
  setMapCustom(custom);

  bootstrap.Modal.getInstance(document.getElementById('mp-modal'))?.hide();
  toast(`Código ${_mpModalObj.codigo} mapeado com sucesso!`, 'success');
  _mpModalObj = null;
  renderMapeamentos();
}

function deleteMapeamentoCustom(cod) {
  if (!confirm(`Remover o mapeamento do código ${cod}?`)) return;
  const custom = getMapCustom();
  delete custom[cod];
  setMapCustom(custom);
  renderMapeamentos();
  toast('Mapeamento removido.','success');
}

// ================================================================
// 9B. IMPORTAÇÃO DE COMPRAS (XML NF-e / XLSX)
// ================================================================
let _importCompras = null;

// Mapeamento aprendido: produto do fornecedor → ingrediente do sistema (persiste no navegador)
const MAP_FORN_KEY = 'map_fornecedor_produtos';
function getMapForn() { try { return JSON.parse(localStorage.getItem(MAP_FORN_KEY))||{}; } catch(e) { return {}; } }
function setMapForn(m) { localStorage.setItem(MAP_FORN_KEY, JSON.stringify(m)); }

// --- Nomes aprendidos: ver / corrigir / remover (melhoria 5) ---
let _aprendKeys = [];
function abrirAprendidos() {
  renderAprendidos();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('aprend-modal')).show();
}
function renderAprendidos() {
  const m = getMapForn();
  _aprendKeys = Object.keys(m).sort();
  const el = document.getElementById('aprend-lista');
  if (!_aprendKeys.length) {
    el.innerHTML = '<p class="text-muted small mb-0">Nada aprendido ainda. Quando você importar uma nota (XML/XLSX) e corrigir um produto que ficou em branco, ele aparece aqui.</p>';
    return;
  }
  const opts = (ing) => '<option value="">— remover —</option>' +
    TODOS_INGREDIENTES.map(n=>`<option value="${esc(n)}" ${n===ing?'selected':''}>${esc(n)}</option>`).join('');
  el.innerHTML = `<table class="table table-sm align-middle mb-0">
    <thead class="sticky-header table-light"><tr><th>Texto da nota</th><th style="width:200px">Vira o ingrediente</th><th class="text-muted small">Unid.</th></tr></thead>
    <tbody>${_aprendKeys.map((k,i)=>`<tr>
      <td class="small font-monospace">${esc(k)}</td>
      <td><select class="form-select form-select-sm" onchange="editarAprendido(${i}, this.value)">${opts(m[k].ing)}</select></td>
      <td class="small text-muted">${esc(m[k].un||'')}</td>
    </tr>`).join('')}</tbody></table>`;
}
function editarAprendido(i, ing) {
  const key = _aprendKeys[i];
  const m = getMapForn();
  if (!m[key]) return;
  if (!ing) { delete m[key]; toast('Nome removido do aprendizado.','info'); }
  else { m[key].ing = ing; toast('Aprendizado atualizado.','success'); }
  setMapForn(m);
  renderAprendidos();
}

// Sinônimos diretos: trecho da descrição → ingrediente do sistema
const SINONIMOS = {
  'MUCARELA':'MUSSARELA','MUSARELA':'MUSSARELA','MUZARELA':'MUSSARELA','MUZZARELA':'MUSSARELA',
  'MOZARELA':'MUSSARELA','MOZZARELA':'MUSSARELA','MUSSARELLA':'MUSSARELA','MUSSARELA':'MUSSARELA',
  'REQUEIJAO':'CATUPIRY','CATUPIRI':'CATUPIRY',
  'FARINHA DE TRIGO':'TRIGO','FARINHA TRIGO':'TRIGO',
  'MOLHO DE TOMATE':'MOLHO','POLPA DE TOMATE':'MOLHO','EXTRATO DE TOMATE':'MOLHO','TOMATE PELADO':'MOLHO',
  'PEITO DE FRANGO':'FRANGO','FILE DE FRANGO':'FRANGO','SASSAMI':'FRANGO','FRANGO DESFIADO':'FRANGO',
  'LINGUICA CALABRESA':'CALABRESA','LINGUICA TIPO CALABRESA':'CALABRESA',
  'OLEO DE SOJA':'OLEO','OLEO SOJA':'OLEO',
  'CHOC PRETO':'CHOCOLATE PRETO','CHOC BRANCO':'CHOCOLATE BRANCO','CHOC AO LEITE':'CHOCOLATE PRETO',
  'BATATA PALHA':'BATATA PALHA','MILHO VERDE':'MILHO','MILHO EM CONSERVA':'MILHO',
  'CREME DE LEITE':'CREME DE LEITE','DOCE DE LEITE':'DOCE DE LEITE','CREAM CHEESE':'CREAM CHEESE'
};

// Palavras que aparecem nas notas mas não fazem parte do nome do ingrediente
const QUALIFICADORES = [
  'FATIADA','FATIADO','FATIAS','FATIA','EM CUBOS','CUBOS','CUBO','RALADO','RALADA','RALADINHO',
  'PECA','PEDACO','PEDACOS','BARRA','BARRAS','CONGELADO','CONGELADA','RESFRIADO','RESFRIADA',
  'FRESCO','FRESCA','DEFUMADO','DEFUMADA','TEMPERADO','TEMPERADA','DESFIADO','DESFIADA',
  'MOIDA','MOIDO','GRANEL','PACOTE','PCT','PCTE','BANDEJA','BANDEJ','BALDE','POTE','LATA','SACO',
  'TIPO','PRIMEIRA','QUALIDADE','SADIA','SEARA','PERDIGAO','AURORA','SELECIONADO','SELECIONADA',
  'KG','KGS','GR','GRS','GRAMAS','UN','UND','UNID','UNIDADE','CX','CAIXA','FD','FARDO','UNI'
];

// Resolve bebidas pela combinação marca + tamanho + zero/normal
function resolverBebida(p) {
  const zero = /(ZERO|SEM ACUCAR|LIGHT|DIET|\bZ\b)/.test(p);
  const dois = /\b2\s?(L|LT|LITROS?)\b|2000\s?ML/.test(p);
  const umMeio = /1[,.]5|1500/.test(p);
  const um = /\b1\s?(L|LT|LITROS?)\b|1000\s?ML/.test(p);
  if (/COCA[\s-]?COLA|COCA\b/.test(p)) {
    if (umMeio) return null;
    if (um) return zero ? 'COCA ZERO 1L' : 'COCA NORMAL 1L';
    if (dois) return zero ? 'COCA ZERO 2L' : 'COCA NORMAL 2L';
    return zero ? 'COCA ZERO 2L' : 'COCA NORMAL 2L'; // sem tamanho na planilha (ex.: contagem "COCA NORMAL") → assume 2L (fardo padrão das 3 lojas)
  }
  if (/GUARANA/.test(p)) {
    if (umMeio) return zero ? 'GUARANA 1,5L Z' : 'GUARANA 1,5L';
    if (dois) return 'GUARANA 2L';
  }
  if (/\bKUAT\b/.test(p)) return 'KUAT';
  if (/SUCO.*UVA|UVA.*SUCO/.test(p)) return 'SUCO UVA';
  if (/SUCO.*PESSEGO|PESSEGO.*SUCO/.test(p)) return 'SUCO PESSEGO';
  if (/AGUA.*(C\/?\s?GAS|COM GAS|GASEIF)/.test(p)) return 'AGUA COM GAS';
  if (/AGUA.*(S\/?\s?GAS|SEM GAS|MINERAL|NATURAL)/.test(p)) return 'AGUA SEM GAS';
  return null;
}

// Tira plural simples e diminutivos: LOMBINHO→LOMBO, CUBINHOS→CUBOS, QUEIJINHO→QUEIJO
function singularizar(tok) {
  let t = tok.replace(/INHOS?$/,'O').replace(/INHAS?$/,'A');
  if (/[^AEIOU]S$/.test(t)) t = t.slice(0,-1); // plural genérico
  return t;
}

// Núcleo: tenta casar uma descrição livre com um ingrediente do sistema
function matchIngrediente(texto) {
  let p = norm(texto);
  if (!p) return null;

  // 0) já aprendido por uma correção anterior (vale no app TODO: compras XLSX/XML, contagem…)
  const apr = getMapForn()[p];
  if (apr && apr.ing && TODOS_INGREDIENTES.includes(apr.ing)) return apr.ing;

  // 1) sinônimo direto (trecho contido)
  for (const [chave, ing] of Object.entries(SINONIMOS)) {
    if (p.includes(chave)) return ing;
  }

  // 2) bebida
  const beb = resolverBebida(p);
  if (beb && TODOS_INGREDIENTES.includes(beb)) return beb;

  // 3) nome do ingrediente contido na descrição (mais específicos primeiro)
  const ords = [...TODOS_INGREDIENTES].sort((a,b)=>norm(b).length-norm(a).length);
  for (const ing of ords) {
    if (p.includes(norm(ing))) return ing;
  }

  // 4) match por tokens: limpa qualificadores/plurais/diminutivos e compara palavras
  let limpo = p;
  for (const q of QUALIFICADORES) limpo = limpo.replace(new RegExp('\\b'+q+'\\b','g'),' ');
  const toks = new Set(limpo.split(/[^A-Z0-9]+/).filter(Boolean).map(singularizar));
  let melhor = null;
  for (const ing of ords) {
    const ingToks = norm(ing).split(/[^A-Z0-9]+/).filter(Boolean).map(singularizar);
    if (ingToks.length && ingToks.every(t => toks.has(t))) {
      if (!melhor || norm(ing).length > norm(melhor).length) melhor = ing;
    }
  }
  return melhor;
}

function sugerirIngrediente(produto) {
  const p = norm(produto);
  const salvo = getMapForn()[p];
  if (salvo && salvo.ing) return salvo;
  const ing = matchIngrediente(produto);
  return ing ? {ing, un:null} : null;
}

function unidadesPossiveis(ing) {
  if (!ing) return [['UN','unidades']];
  const n = norm(ing);
  if (ITENS_KG_DIRETO.has(n)) return [['KG','kg']];
  if (REFRIG_LOOKUP[n]) return [['FARDOS','fardos'],['UN','unidades']];
  const c = CONVERSAO.conversao_caixa[n];
  if (c) {
    const opts = [['CX','caixas'],['UN','un. soltas']];
    if (c.unidade==='KG') opts.push(['KG','kg']);
    return opts;
  }
  return [['UN','unidades']];
}

function unFromRaw(raw, ing) {
  const u = norm(String(raw||''));
  const ps = unidadesPossiveis(ing);
  let alvo = null;
  if (/^(KG|QUILO|KILO)/.test(u)) alvo='KG';
  else if (/^(CX|CAIXA)/.test(u)) alvo='CX';
  else if (/^(FD|FARDO|PACK|PCK)/.test(u)) alvo='FARDOS';
  else if (/^(UN|PC|PCT|PT|BD|BALDE|GL|LT|FR|SC)/.test(u)) alvo='UN';
  if (alvo && ps.some(p=>p[0]===alvo)) return alvo;
  return ps[0][0];
}

function parseNumFlex(s) {
  s = String(s ?? '').trim();
  if (!s) return 0;
  if (s.includes(',')) return parseFloat(s.replace(/\./g,'').replace(',','.'))||0;
  return parseFloat(s)||0;
}

function dataLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseDataFlex(s) {
  // Data de célula do Excel (leitura com cellDates). A SheetJS 0.20 (desde 22/09/2026) entrega a data com o
  // relógio do Excel nos campos UTC (26/12 → 2025-12-26T00:00Z, que em Brasília é 25/12 às 21h). Ler pelo
  // calendário LOCAL, como era com a 0.18, voltaria UM DIA em toda compra/contagem importada — por isso UTC.
  // Provado em testes/xlsx_versoes.mjs com as planilhas reais (antes × depois, fuso de São Paulo).
  if (s instanceof Date && !isNaN(s)) return `${s.getUTCFullYear()}-${String(s.getUTCMonth()+1).padStart(2,'0')}-${String(s.getUTCDate()).padStart(2,'0')}`;
  s = String(s||'').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/aaaa — sempre formato brasileiro (dia antes do mês)
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (m) {
    let y = m[3]; if (y.length===2) y='20'+y;
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return '';
}

// CNPJ de cada loja (razão social no SKILL.md processar_nf). Usado para detectar, pela própria
// nota (destinatário), em qual loja a compra deve ser lançada — evita lançar na loja errada.
let LOJA_POR_CNPJ = {   // reescrito por aplicarCadastroLojas()
  '48685348000196':'BURITIS',
  '48367728000182':'PLANALTO',
  '64411897000129':'VENDA_NOVA'
};
const soDigitos = s => String(s||'').replace(/\D/g,'');
function lojaDoCNPJ(cnpj) { return LOJA_POR_CNPJ[soDigitos(cnpj)] || ''; }

async function importarComprasXML(input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;

  const rows = [];
  let fornecedor = '', dataEmissao = today();
  const nomesArq = [];
  const nfs = [];   // 1 entrada por NF: {arquivo, chave, numero, data, forn, loja, lojaCNPJ, lojaConhecida, total}

  for (const file of files) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      toast(`${file.name}: não é um XML válido.`,'error'); continue;
    }
    const dets = [...doc.getElementsByTagName('det')];
    if (!dets.length) {
      toast(`${file.name}: nenhum produto encontrado — é o XML da NF-e?`,'warning'); continue;
    }
    const emit = doc.getElementsByTagName('emit')[0];
    const forn = emit?.getElementsByTagName('xNome')[0]?.textContent?.trim() || '';
    if (forn && !fornecedor) fornecedor = forn;
    const dh = doc.getElementsByTagName('dhEmi')[0]?.textContent
            || doc.getElementsByTagName('dEmi')[0]?.textContent || '';
    const dataNF = dh ? dh.slice(0,10) : today();
    dataEmissao = dataNF;
    nomesArq.push(file.name);

    // --- Identidade da NF: chave de acesso (44 dígitos) + número (nNF) ---
    const infNFe = doc.getElementsByTagName('infNFe')[0];
    const chave = soDigitos(infNFe?.getAttribute('Id') || '').slice(-44);
    const ide = doc.getElementsByTagName('ide')[0];
    const numero = ide?.getElementsByTagName('nNF')[0]?.textContent?.trim() || '';
    // --- Loja DESTINO da nota (o comprador é o destinatário) ---
    const dest = doc.getElementsByTagName('dest')[0];
    const destCNPJ = dest?.getElementsByTagName('CNPJ')[0]?.textContent?.trim()
                  || dest?.getElementsByTagName('CPF')[0]?.textContent?.trim() || '';
    const lojaNF = lojaDoCNPJ(destCNPJ);

    const idxNF = nfs.length;
    let totalNF = 0;
    for (const det of dets) {
      const prod = det.getElementsByTagName('prod')[0];
      if (!prod) continue;
      const g = t => prod.getElementsByTagName(t)[0]?.textContent?.trim() || '';
      const produto = g('xProd');
      const qtd = parseFloat(g('qCom'))||0;
      if (!produto || !qtd) continue;
      const sug = sugerirIngrediente(produto);
      const ing = sug?.ing || '';
      const un = (sug?.un && unidadesPossiveis(ing).some(p=>p[0]===sug.un)) ? sug.un : unFromRaw(g('uCom'), ing);
      const valor = parseFloat(g('vProd'))||0;
      totalNF += valor;
      rows.push({produto, qtd, un, ing, valor, incluir: !!ing, forn,
                 data:dataNF, loja:lojaNF, nf_chave:chave, nf_numero:numero, _nfIdx:idxNF});
    }
    // --- Cobrança da nota: vencimentos e parcelas (bloco <cobr> da NF-e) ---
    // <fat> é a fatura (vLiq = valor a pagar); cada <dup> é UMA parcela/boleto,
    // com nDup (número), dVenc (vencimento) e vDup (valor da parcela). Nota
    // parcelada traz vários <dup> — medido numa nota real do Gabriel:
    // R$ 4.225,20 em 2 parcelas de R$ 2.112,60, vencendo 01/04 e 08/04.
    // Cobertura medida em 108 notas reais: 92 (85%) trazem dVenc.
    const cobr = doc.getElementsByTagName('cobr')[0];
    const vencimentos = [...(cobr?.getElementsByTagName('dup') || [])].map(d => ({
      n:     d.getElementsByTagName('nDup')[0]?.textContent?.trim() || '',
      venc:  d.getElementsByTagName('dVenc')[0]?.textContent?.trim() || '',
      valor: parseFloat(d.getElementsByTagName('vDup')[0]?.textContent) || 0
    })).filter(p => p.venc);
    const valorLiquido = parseFloat(cobr?.getElementsByTagName('vLiq')[0]?.textContent) || 0;

    nfs.push({arquivo:file.name, chave, numero, data:dataNF, forn,
              loja:lojaNF, lojaCNPJ:soDigitos(destCNPJ), lojaConhecida:!!lojaNF, total:totalNF,
              vencimentos, valorLiquido});
  }

  if (!rows.length) return;

  // Avisos: NF já lançada (duplicidade) e loja invertida — comparando com o que já está salvo.
  const avisos = await checarAvisosImportNF(nfs);
  await abrirImportCompras({origem:'XML: '+nomesArq.join(', '), fornecedor, data:dataEmissao, rows, nfs, avisos});
}

// Monta os avisos de DUPLICIDADE e LOJA INVERTIDA para um conjunto de NFs sendo importadas,
// comparando com as compras já salvas. Não bloqueia nada — só avisa (pedido do Gabriel).
async function checarAvisosImportNF(nfs) {
  const compras = await DB.getAll('compras');
  const chavesSalvas = new Set(compras.map(c=>c.nf_chave).filter(Boolean));
  // A data com que a nota foi LANÇADA pode não ser a da emissão (o Gabriel troca
  // para a data de recebimento na loja). Por isso indexamos as DUAS: sem isso,
  // trocar a data cegava as checagens 2 e 3 — parte da causa do "reimportei e ele
  // não avisou".
  const numerosSalvos = new Set();
  const numeroForn = new Set();
  compras.filter(c=>c.nf_numero).forEach(c=>{
    const base = c.nf_numero+'|'+(c.fornecedor||'');
    numerosSalvos.add(base+'|'+c.data);
    if (c.data_emissao) numerosSalvos.add(base+'|'+c.data_emissao);
    numeroForn.add(base);
  });
  const dups = [], lojas = [];
  for (const nf of nfs) {
    // 1) duplicidade pela chave (a mais segura — 44 dígitos, única por nota no país)
    let porChave = !!(nf.chave && chavesSalvas.has(nf.chave));
    let dup = porChave;
    let motivo = dup ? 'mesma chave de acesso (44 díg.)' : '';
    // 2) número + fornecedor + data (emissão OU recebimento)
    if (!dup && nf.numero && numerosSalvos.has(nf.numero+'|'+nf.forn+'|'+nf.data)) {
      dup = true; motivo = `NF nº ${nf.numero} do mesmo fornecedor e data`;
    }
    // 2b) número + fornecedor, SEM data. É o que pega a nota cuja data foi
    // editada depois do lançamento. Seguro porque o número da NF é sequencial
    // por fornecedor/série: mesmo número + mesmo emitente = mesma nota.
    if (!dup && nf.numero && numeroForn.has(nf.numero+'|'+nf.forn)) {
      dup = true; motivo = `NF nº ${nf.numero} deste fornecedor já foi lançada (com outra data)`;
    }
    // 3) heurística para notas antigas (sem chave/número salvos): mesma loja+data+fornecedor com total igual
    if (!dup && nf.total>0 && nf.loja) {
      const grupo = compras.filter(c=>c.loja===nf.loja && (c.fornecedor||'')===nf.forn
                                   && (c.data===nf.data || c.data_emissao===nf.data));
      const totalGrupo = grupo.reduce((s,c)=>s+(c.valor_total||0),0);
      if (grupo.length && Math.abs(totalGrupo-nf.total) < 0.02) { dup = true; motivo = 'já há compras dessa loja/data/fornecedor com o mesmo total'; }
    }
    if (dup) dups.push({nf, motivo, porChave});
    // Loja invertida: a nota é destinada a uma loja diferente da que está selecionada agora.
    if (nf.lojaConhecida && nf.loja !== currentLoja) lojas.push(nf);
    if (nf.lojaCNPJ && !nf.lojaConhecida) lojas.push(nf);   // CNPJ de destino não reconhecido
  }
  return {dups, lojas};
}

// ================================================================
// PREÇO FORA DO PADRÃO — o app já sabe quanto você costuma pagar
// ================================================================
// Base: todo o histórico de compras (734 lançamentos em 25/08/2026). Para cada
// insumo calculamos o preço por unidade-BASE (kg/un) — é o único jeito de
// comparar maçã com maçã, porque a mesma mussarela vem em peça de 3 kg ou caixa
// de 10 kg e o valor_total sozinho não diz nada.
// Usamos MEDIANA, e não média, de propósito: a média é puxada justamente pelos
// lançamentos errados que estamos tentando pegar (um zero a mais move a média,
// não move a mediana).
let _precoRefCache = null;
async function precosDeReferencia(compras) {
  if (_precoRefCache) return _precoRefCache;
  const lista = compras || await DB.getAll('compras');
  const porIng = {};
  for (const c of lista) {
    const qb = parseFloat(c.quantidade_base)||0;
    const vt = parseFloat(c.valor_total)||0;
    if (!qb || vt<=0 || !c.ingrediente) continue;
    (porIng[c.ingrediente] ||= {precos:[], un:c.unidade_base||''}).precos.push(vt/qb);
  }
  const ref = {};
  for (const [ing, o] of Object.entries(porIng)) {
    if (o.precos.length < 3) continue;      // sem histórico suficiente, não opinamos
    const p = o.precos.sort((a,b)=>a-b);
    const meio = Math.floor(p.length/2);
    ref[ing] = { mediana: p.length%2 ? p[meio] : (p[meio-1]+p[meio])/2, n:p.length, un:o.un };
  }
  return (_precoRefCache = ref);
}

// Devolve null quando o preço está dentro do normal, ou {texto, grave} quando destoa.
// Faixa de tolerância: 40% para cima ou para baixo. Abaixo disso é oscilação real
// de mercado (queijo varia mesmo); acima, quase sempre é unidade trocada, dígito a
// mais ou a nota inteira lançada numa linha só.
function alertaPreco(ing, qtdBase, valorTotal, ref) {
  const r = ref && ref[ing];
  if (!r || !qtdBase || !valorTotal || !r.mediana) return null;
  const unit = valorTotal/qtdBase;
  const fator = unit/r.mediana;
  if (fator < 1.4 && fator > 0.6) return null;
  const pct = Math.round(Math.abs(fator-1)*100);
  return {
    grave: fator>=2 || fator<=0.5,
    texto: `${fmtBRL(unit)}/${r.un||'un'} — ${pct}% ${fator>1?'acima':'abaixo'} do usual (${fmtBRL(r.mediana)}/${r.un||'un'}, base de ${r.n} compras)`
  };
}

async function importarComprasXLSX(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  let wb;
  // cellDates faz as datas virem como objeto Date (calendário correto), evitando o formato americano
  try { wb = XLSX.read(await file.arrayBuffer(), {type:'array', cellDates:true}); }
  catch(e) { toast('Não foi possível ler o arquivo XLSX.','error'); return; }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, {header:1, raw:true});
  const rows = [], erros = [];

  for (let i=0; i<linhas.length; i++) {
    const l = linhas[i];
    if (!l || !l.length || !l[0]) continue;
    if (norm(String(l[0]))==='DATA') continue; // cabeçalho
    const dt = parseDataFlex(l[0]);
    const lojaRaw = norm(String(l[1]||'')).replace(/\s+/g,'_');
    const loja = LOJAS_ATIVAS().includes(lojaRaw) ? lojaRaw : '';
    const ingRaw = String(l[2]||'').trim();
    const ing = TODOS_INGREDIENTES.find(n=>norm(n)===normIng(ingRaw)) || matchIngrediente(ingRaw) || '';
    const qtd = parseNumFlex(l[3]);
    if (!ingRaw && !qtd) continue;
    if (!ing) erros.push(`Linha ${i+1}: ingrediente "${ingRaw}" não reconhecido — veja a aba Instruções do modelo`);
    if (!qtd) { erros.push(`Linha ${i+1}: quantidade inválida`); continue; }
    rows.push({
      produto: ingRaw, qtd, un: unFromRaw(l[4], ing), ing,
      valor: parseNumFlex(l[6]), incluir: !!ing,
      data: dt, loja, forn: String(l[5]||'').trim()
    });
  }

  if (erros.length) toast(erros.slice(0,4).join('<br>'),'warning');
  if (!rows.length) { toast('Nenhuma linha válida encontrada. Baixe o modelo XLSX e preencha conforme o exemplo.','error'); return; }
  await abrirImportCompras({origem:'XLSX: '+file.name, fornecedor:'', data:today(), rows});
}

async function abrirImportCompras(d) {
  _importCompras = d;
  d.precoRef = await precosDeReferencia();   // para marcar preço fora do padrão na revisão
  document.getElementById('cp-import-origem').textContent = d.origem + (d.fornecedor ? ' — '+d.fornecedor : '');
  document.getElementById('cp-import-data').value = d.data || today();
  // Loja padrão: se a(s) nota(s) apontam para UMA loja conhecida pelo CNPJ, já seleciona ela; senão a atual.
  const lojasNF = [...new Set((d.nfs||[]).filter(n=>n.lojaConhecida).map(n=>n.loja))];
  document.getElementById('cp-import-loja').value = (lojasNF.length===1) ? lojasNF[0] : currentLoja;
  renderAvisosImportNF();
  document.getElementById('cp-import-card').classList.remove('d-none');
  renderImportRows();
}

// Banner de avisos do card de revisão: duplicidade de NF (item 1) e loja invertida (item 2).
function renderAvisosImportNF() {
  const host = document.getElementById('cp-import-aviso');
  if (!host) return;
  const av = (_importCompras && _importCompras.avisos) || {dups:[], lojas:[]};
  const nfsCobr = ((_importCompras && _importCompras.nfs) || []).filter(n => (n.vencimentos||[]).length);
  if (!av.dups.length && !av.lojas.length && !nfsCobr.length) { host.innerHTML = ''; return; }
  let html = '';
  if (av.dups.length) {
    html += `<div class="alert alert-danger py-2 mb-2"><i class="fas fa-copy me-1"></i><strong>Esta nota parece já ter sido lançada:</strong>`
      + `<ul class="mb-1 ps-3">` + av.dups.map(d=>
          `<li>${esc(d.nf.arquivo)}${d.nf.numero?` (NF nº ${esc(d.nf.numero)})`:''} — ${esc(d.motivo)}.</li>`).join('')
      + `</ul><div class="small">Confira antes de salvar para não lançar a mesma compra duas vezes. Se for mesmo uma nota nova, é só salvar.</div></div>`;
  }
  if (av.lojas.length) {
    html += `<div class="alert alert-warning py-2 mb-0"><i class="fas fa-shuffle me-1"></i><strong>Confira a loja:</strong>`
      + `<ul class="mb-0 ps-3">` + av.lojas.map(n=> n.lojaConhecida
          ? `<li>${esc(n.arquivo)}: pelo CNPJ do destinatário, esta nota é da <strong>${LOJA_LABEL[n.loja]}</strong> — já deixei essa loja marcada nos itens dela.</li>`
          : `<li>${esc(n.arquivo)}: o CNPJ de destino <span class="font-monospace">${esc(n.lojaCNPJ)}</span> não é de nenhuma das 3 lojas — confira se a nota é sua mesmo.</li>`
        ).join('') + `</ul></div>`;
  }
  // Cobrança da nota: o que essa compra vai custar e QUANDO. Vem do bloco <cobr>
  // da própria NF-e (85% das notas do Gabriel trazem), então não é estimativa.
  if (nfsCobr.length) {
    html += `<div class="alert alert-info py-2 mb-0"><i class="fas fa-file-invoice-dollar me-1"></i><strong>Pagamento desta nota:</strong>`
      + nfsCobr.map(n => {
          const ps = n.vencimentos;
          const linhas = ps.map(p =>
            `<li>${ps.length>1 ? `Parcela ${esc(p.n)} — ` : ''}vence <strong>${fmtDate(p.venc)}</strong> · ${fmtBRL(p.valor)}</li>`).join('');
          const cab = ps.length>1
            ? `${esc(n.forn||'')} — ${fmtBRL(n.valorLiquido||ps.reduce((s,p)=>s+p.valor,0))} em <strong>${ps.length}× parcelas</strong>:`
            : `${esc(n.forn||'')} — pagamento único:`;
          return `<div class="small mt-1">${cab}<ul class="mb-0 ps-3">${linhas}</ul></div>`;
        }).join('')
      + `</div>`;
  }
  host.innerHTML = html;
}

function renderImportRows() {
  const tbody = document.getElementById('cp-import-tbody');
  tbody.innerHTML = _importCompras.rows.map((r,i)=>{
    const unOpts = unidadesPossiveis(r.ing).map(([v,l])=>`<option value="${esc(v)}" ${v===r.un?'selected':''}>${esc(l)}</option>`).join('');
    const ingOpts = '<option value="">— ignorar —</option>'+
      TODOS_INGREDIENTES.map(n=>`<option value="${esc(n)}" ${n===r.ing?'selected':''}>${esc(n)}</option>`).join('');
    const base = (r.ing && r.incluir) ? calcCompraBase(r.ing, r.qtd, r.un) : null;
    const extra = r.data ? `<br><span class="text-muted">${fmtDate(r.data)}${r.loja?' · '+(LOJA_LABEL[r.loja]||r.loja):''}</span>` : '';
    // Preço destoando do histórico: quase sempre unidade trocada ou dígito a mais.
    const alerta = base ? alertaPreco(r.ing, base.total, r.valor||0, _importCompras.precoRef) : null;
    const avisoPreco = alerta
      ? `<br><span class="badge ${alerta.grave?'text-bg-danger':'text-bg-warning'} mt-1" style="white-space:normal;text-align:left;font-weight:500"><i class="fas fa-triangle-exclamation me-1"></i>${esc(alerta.texto)}</span>`
      : '';
    return `<tr class="${r.incluir?'':'table-secondary opacity-50'}">
      <td><input type="checkbox" class="form-check-input" ${r.incluir?'checked':''} onchange="impRow(${i},'incluir',this.checked)"></td>
      <td class="small">${esc(r.produto)}${extra}${avisoPreco}</td>
      <td><input type="number" class="form-control form-control-sm text-end" value="${r.qtd}" min="0" step="0.001" onchange="impRow(${i},'qtd',parseFloat(this.value)||0)"></td>
      <td><select class="form-select form-select-sm" onchange="impRow(${i},'un',this.value)">${unOpts}</select></td>
      <td><select class="form-select form-select-sm ${r.ing?'':'border-warning'}" onchange="impRow(${i},'ing',this.value)">${ingOpts}</select></td>
      <td><input type="number" class="form-control form-control-sm text-end" value="${r.valor||''}" min="0" step="0.01" onchange="impRow(${i},'valor',parseFloat(this.value)||0)"></td>
      <td class="small text-muted text-end">${base?fmtNum(base.total,3)+' '+base.unidade:'—'}</td>
    </tr>`;
  }).join('');

  const sel = _importCompras.rows.filter(r=>r.incluir && r.ing && r.qtd>0);
  const semMapa = _importCompras.rows.filter(r=>r.incluir && !r.ing).length;
  const totalSel = sel.reduce((s,r)=>s+(r.valor||0),0);
  document.getElementById('cp-import-resumo').textContent =
    `${sel.length} item(ns) prontos para salvar` +
    (semMapa ? ` · ${semMapa} sem ingrediente definido (serão ignorados)` : '') +
    ` · Total: ${totalSel ? fmtBRL(totalSel) : 'R$ 0,00'}`;
}

function impRow(i, campo, val) {
  const r = _importCompras.rows[i];
  r[campo] = val;
  if (campo==='ing') {
    const ps = unidadesPossiveis(val);
    if (!ps.some(p=>p[0]===r.un)) r.un = ps[0][0];
    if (val) r.incluir = true;
  }
  renderImportRows();
}

// A data escolhida no card vale para a nota INTEIRA e é a data de RECEBIMENTO.
// Antes este campo era decorativo na importação de XML: salvarImportCompras fazia
// `r.data || dataGlobal` e toda linha vinda de XML já chegava com a data de
// EMISSÃO preenchida — trocar a data aqui não mudava absolutamente nada, e a
// compra entrava com a data da nota. O Gabriel só descobria depois, no histórico,
// e ia corrigir no lápis (o que apagava a chave da NF — ver _salvarCompraImpl).
// Guardamos a emissão em `data_emissao` para não perder o dado da nota.
function impDataGlobal(v) {
  if (!_importCompras || !v) return;
  _importCompras.data = v;
  _importCompras.rows.forEach(r => {
    if (r.data && !r.data_emissao) r.data_emissao = r.data;
    r.data = v;
  });
  renderImportRows();   // a data nova aparece em cada linha: você VÊ que pegou
}

async function salvarImportCompras() {
  return travarGravacao('import-compras', _salvarImportComprasImpl, '[onclick*="salvarImportCompras"]');
}

async function _salvarImportComprasImpl() {
  if (!_importCompras) return;
  const dataGlobal = document.getElementById('cp-import-data').value || today();
  const lojaGlobal = document.getElementById('cp-import-loja').value;
  const rows = _importCompras.rows.filter(r=>r.incluir && r.ing && r.qtd>0);
  if (!rows.length) { toast('Nenhum item válido selecionado!','warning'); return; }

  // Duplicidade vira PARADA, não mais um aviso que rola para fora da tela.
  // A checagem por chave de acesso é exata (44 dígitos, única por nota no país):
  // se ela bate, a nota já está lançada e o normal é NÃO salvar.
  const dupsChave = (_importCompras.avisos?.dups || []).filter(d => d.porChave);
  if (dupsChave.length) {
    const lista = dupsChave.map(d => `• ${d.nf.arquivo}${d.nf.numero?` (NF nº ${d.nf.numero})`:''}`).join('\n');
    if (!confirm(`ESTA NOTA JÁ ESTÁ LANÇADA.\n\n${lista}\n\nA chave de acesso é única por nota — bateu com uma compra que já está no sistema. Salvar de novo vai DOBRAR essa compra e inflar o CMV.\n\nTem certeza absoluta que quer lançar assim mesmo?`)) {
      toast('Importação cancelada — a nota já estava lançada.','info');
      return;
    }
  }

  // Grava a nota INTEIRA de uma vez (22/09): eram uma ida à rede por item — com a rede caindo no meio,
  // metade da nota entrava e a outra não. Agora é um lote só (na nuvem, até 500 itens = um insert:
  // entra tudo ou nada). O carimbo de quem lançou vale também no lote (design/melhorias.js).
  const mapa = getMapForn();
  const linhas = [];
  for (const r of rows) {
    const base = calcCompraBase(r.ing, r.qtd, r.un);
    const nf = (_importCompras.nfs || [])[r._nfIdx] || {};
    linhas.push({
      loja: r.loja||lojaGlobal, data: r.data||dataGlobal, ingrediente: r.ing,
      quantidade: r.qtd, unidade: r.un,
      quantidade_base: base.total, unidade_base: base.unidade,
      fornecedor: r.forn||_importCompras.fornecedor||'', valor_total: r.valor||0,
      nf_chave: r.nf_chave||'', nf_numero: r.nf_numero||'',
      data_emissao: r.data_emissao||'',
      // Cobrança da nota (bloco <cobr> da NF-e): vencimentos e parcelas.
      // Medido nas notas reais do Gabriel: 92 de 108 (85%) trazem <dVenc>.
      nf_vencimentos: nf.vencimentos||[], nf_valor_liquido: nf.valorLiquido||0,
      origem: _importCompras.origem, created_at: new Date().toISOString()
    });
    // aprende o mapeamento p/ próxima nota do mesmo produto (só vale se a gravação der certo — ver abaixo)
    if (r.produto && norm(r.produto)!==norm(r.ing)) mapa[norm(r.produto)] = {ing:r.ing, un:r.un};
  }
  await _gravarLote('compras', linhas);
  setMapForn(mapa);
  _precoRefCache = null;   // compras novas entram na base de comparação de preço
  toast(`${rows.length} compra(s) importadas com sucesso!`,'success');
  cancelarImportCompras();
  loadComprasHist();
}

function cancelarImportCompras() {
  _importCompras = null;
  document.getElementById('cp-import-card').classList.add('d-none');
  document.getElementById('cp-import-tbody').innerHTML = '';
  const av = document.getElementById('cp-import-aviso'); if (av) av.innerHTML = '';
}

function baixarModeloCompras() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['DATA','LOJA','INGREDIENTE','QUANTIDADE','UNIDADE','FORNECEDOR','VALOR_TOTAL'],
    ['10/06/2026','BURITIS','MUSSARELA',25,'KG','Laticínios XYZ',798.39],
    ['10/06/2026','PLANALTO','CATUPIRY',2,'CX','Distribuidora ABC',594.00],
    ['10/06/2026','VENDA NOVA','COCA NORMAL 2L',5,'FARDOS','Atacadão',389.57]
  ]);
  ws['!cols'] = [{wch:12},{wch:12},{wch:20},{wch:12},{wch:10},{wch:22},{wch:13}];
  XLSX.utils.book_append_sheet(wb, ws, 'Compras');

  const ingRows = [['COMO PREENCHER'],
    ['DATA: use dd/mm/aaaa (ex: 10/06/2026). O sistema sempre lê dia antes do mês.'],
    ['INGREDIENTE: pode escrever variações (ex: "lombinho", "bacon em cubos") — o sistema reconhece.'],
    ['UNIDADE: KG, CX (caixas), UN (unidades soltas) ou FARDOS.'],
    [''],
    ['INGREDIENTE VÁLIDO','UNIDADES ACEITAS']];
  TODOS_INGREDIENTES.forEach(n=>ingRows.push([n, unidadesPossiveis(n).map(u=>u[0]).join(', ')]));
  ingRows.push([''],['LOJAS VÁLIDAS:'],['BURITIS'],['PLANALTO'],['VENDA NOVA']);
  const ws2 = XLSX.utils.aoa_to_sheet(ingRows);
  ws2['!cols'] = [{wch:24},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instruções');

  XLSX.writeFile(wb, 'modelo_compras.xlsx');
  toast('Modelo baixado! Preencha a aba "Compras" e importe pelo botão Importar XLSX.','info');
}

// ================================================================
// 10. TRANSFERÊNCIAS
// ================================================================
async function renderTransferencias() {
  const trIng = document.getElementById('tr-ing');
  if (trIng.options.length <= 1) {
    TODOS_INGREDIENTES.forEach(n=>{ trIng.add(new Option(n,n)); });
  }
  document.getElementById('tr-data').value = today();
  loadTransferHist();
}

let _editTransferId = null;

async function salvarTransferencia() {
  return travarGravacao('transferencia', _salvarTransferenciaImpl, '#tr-btn-salvar');
}

async function _salvarTransferenciaImpl() {
  const data = document.getElementById('tr-data').value;
  const origem = document.getElementById('tr-origem').value;
  const destino = document.getElementById('tr-destino').value;
  const ing = document.getElementById('tr-ing').value;
  const qtd = parseFloat(document.getElementById('tr-qtd').value)||0;
  const un = document.getElementById('tr-un').value;

  if (!data||!ing||!qtd) { toast('Preencha todos os campos!','error'); return; }
  if (qtd < 0) { toast('A quantidade não pode ser negativa.','error'); return; }
  if (origem===destino) { toast('Origem e destino não podem ser iguais!','error'); return; }

  const reg = {data, loja_origem:origem, loja_destino:destino, ingrediente:ing, quantidade:qtd, unidade:un};
  if (_editTransferId) {
    await DB.put('transferencias', {...reg, id:_editTransferId, created_at:new Date().toISOString()});
    toast('Transferência atualizada!', 'success');
    cancelarEdicaoTransfer();
  } else {
    await DB.add('transferencias', {...reg, created_at:new Date().toISOString()});
    toast(`Transferência ${LOJA_LABEL[origem]} → ${LOJA_LABEL[destino]}: ${qtd} ${un} de ${ing}`, 'success');
    document.getElementById('tr-qtd').value = '';
  }
  loadTransferHist();
}

async function editTransfer(id) {
  const t = (await DB.getAll('transferencias')).find(x=>x.id===id);
  if (!t) return;
  _editTransferId = id;
  document.getElementById('tr-data').value = t.data;
  document.getElementById('tr-origem').value = t.loja_origem;
  document.getElementById('tr-destino').value = t.loja_destino;
  document.getElementById('tr-ing').value = t.ingrediente;
  document.getElementById('tr-qtd').value = t.quantidade;
  document.getElementById('tr-un').value = t.unidade;
  document.getElementById('tr-btn-salvar').innerHTML = '<i class="fas fa-save me-1"></i>Salvar alterações';
  document.getElementById('tr-btn-cancelar').classList.remove('d-none');
  document.getElementById('tr-data').scrollIntoView({block:'center'});
}

function cancelarEdicaoTransfer() {
  _editTransferId = null;
  document.getElementById('tr-qtd').value = '';
  document.getElementById('tr-btn-salvar').innerHTML = '<i class="fas fa-save me-1"></i>Registrar';
  document.getElementById('tr-btn-cancelar').classList.add('d-none');
}

async function loadTransferHist() {
  const tr = (await DB.getAll('transferencias')).sort((a,b)=>b.data.localeCompare(a.data));
  const tbody = document.getElementById('tr-tbody');
  if (!tr.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Nenhuma transferência.</td></tr>';
    return;
  }
  tbody.innerHTML = tr.map(t=>`
    <tr>
      <td>${fmtDate(t.data)}</td>
      <td><span class="badge ${LOJA_BADGE[t.loja_origem]}">${LOJA_LABEL[t.loja_origem]||t.loja_origem}</span></td>
      <td><span class="badge bg-secondary">${LOJA_LABEL[t.loja_destino]||t.loja_destino}</span></td>
      <td class="fw-semibold">${esc(t.ingrediente)}</td>
      <td class="text-end">${fmtNum(t.quantidade,3)}</td>
      <td>${esc(t.unidade)}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary py-0 px-1 me-1" onclick="editTransfer(${t.id})" title="Editar"><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteTransfer(${t.id})" title="Excluir"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

async function deleteTransfer(id) {
  if (!confirm('Apagar transferência?')) return;
  await DB.delete('transferencias', id);
  loadTransferHist();
}

