// ================================================================
// 11C. COMPRAS DA SEMANA — sugestão de compra por loja e fornecedor
// ================================================================
let _listaCompras = null;  // guarda a última lista gerada (para exportar)

// Aba "Última Contagem": mostra, por loja, a contagem CRUA mais recente (sem projeção).
// Cards de resumo no topo + tabela por valor (onde está o dinheiro do estoque).
async function renderContagens() {
  const lojaSel = document.getElementById('cn-loja')?.value || '';
  const lojas = lojaSel ? [lojaSel] : LOJAS_ATIVAS();
  const [contagens, compras] = await Promise.all([DB.getAll('contagens'), DB.getAll('compras')]);
  const host = document.getElementById('cn-content');
  if (!host) return;
  let cards = '', tabelas = '';
  for (const loja of lojas) {
    const ct = contagens.filter(c=>c.loja===loja).sort((a,b)=>b.data.localeCompare(a.data))[0];
    if (!ct) {
      cards += `<div class="col"><div class="stat-card h-100">
        <div class="lbl"><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span></div>
        <div class="val" style="font-size:20px">—</div><div class="lbl">nunca contou esta loja</div></div></div>`;
      tabelas += `<div class="card mb-3"><div class="card-header"><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span></div>
        <div class="card-body"><div class="alert alert-secondary py-2 small mb-0">Sem contagem salva — faça uma contagem desta loja.</div></div></div>`;
      continue;
    }
    const dias = diasDesde(ct.data);
    const itens = Object.entries(ct.ingredientes||{})
      .map(([nome,v])=>({ nome, total:v.total||0, un:v.unidade||getUnidadeIngrediente(nome),
        valor:(v.total||0)*custoPagoIng(nome, ct.data, ct.data, compras, loja) }))
      .filter(x=>x.total>0)
      .sort((a,b)=>b.valor-a.valor);
    const valorTotal = itens.reduce((s,x)=>s+x.valor,0);
    const corData = dias>7 ? 'text-danger fw-semibold' : 'text-muted';
    cards += `<div class="col"><div class="stat-card h-100">
      <div class="lbl"><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span></div>
      <div class="val" style="font-size:22px">${fmtBRL(valorTotal)}</div>
      <div class="lbl">${itens.length} itens · contado ${fmtDate(ct.data)} <span class="${corData}">(há ${dias}d)</span></div></div></div>`;
    const linhas = itens.map(x=>`
      <tr>
        <td class="fw-semibold">${esc(x.nome)}</td>
        <td class="text-end">${fmtNum(x.total,2)} ${x.un}</td>
        <td class="text-end">${fmtBRL(x.valor)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="text-muted text-center py-3">Nada com saldo nesta contagem.</td></tr>';
    tabelas += `<div class="card mb-3">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span>
          <span class="text-muted small ms-1">contagem de ${fmtDate(ct.data)} · há ${dias} dia${dias===1?'':'s'}</span></span>
        <span class="fw-bold">${fmtBRL(valorTotal)}</span>
      </div>
      <div class="card-body p-0" style="max-height:60vh;overflow-y:auto">
        <table class="table table-sm table-hover mb-0">
          <thead class="sticky-header table-light"><tr><th>Ingrediente</th><th class="text-end">Quantidade</th><th class="text-end">Valor</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div></div>`;
  }
  host.innerHTML = `<div class="row row-cols-1 row-cols-md-3 g-3 mb-3">${cards}</div>${tabelas}`;
}

function renderComprasSemana() {
  const sel = document.getElementById('cs-loja');
  if (currentLoja && !sel.dataset.iniciado) { sel.dataset.iniciado='1'; }
  gerarListaCompras();
}

// Fornecedor mais recente para um ingrediente (prioriza a própria loja, senão qualquer loja)
function fornecedorHabitual(compras, loja, ingNorm) {
  const cand = compras
    .filter(c => normIng(c.ingrediente)===ingNorm && (c.fornecedor||'').trim())
    .sort((a,b)=>b.data.localeCompare(a.data));
  const pick = cand.find(c=>c.loja===loja) || cand[0];
  return pick ? pick.fornecedor.trim() : '';
}

// Preço médio pago por unidade-base (prioriza a própria loja, senão qualquer loja); 0 se nunca comprou
function precoBasePago(compras, loja, ingNorm) {
  const calc = arr => {
    let val=0,q=0;
    for (const c of arr) {
      if (normIng(c.ingrediente)!==ingNorm || !(c.valor_total>0) || !(c.quantidade_base>0)) continue;
      val+=c.valor_total; q+=c.quantidade_base;
    }
    return q>0 ? val/q : 0;
  };
  return calc(compras.filter(c=>c.loja===loja)) || calc(compras);
}

// Como o ingrediente é COMPRADO: quantos da unidade-base cabem em 1 "pacote" de compra
// (balde de catupiry = 1,8 kg, fardo de coca = 8 un, pente de ovo = 30 un…) e como chamar
// esse pacote. FONTE ÚNICA da regra — sugerirCompra e toda a tela de Compras da Semana
// usam isto (pedido do Gabriel 20/07: pensar SEMPRE na unidade que ele compra, nunca
// "catupiry em kg", mesmo que a conta interna seja em kg).
function infoUnidadeCompra(ing) {
  const n = norm(ing);
  const plural = {caixa:'caixas', fardo:'fardos', pente:'pentes'};
  if (REFRIG_LOOKUP[n]) {
    const f = REFRIG_LOOKUP[n].un_por_fardo || 1;
    return f>1 ? {porPacote:f, sing:'fardo', plu:'fardos', unBase:'UN'}
               : {porPacote:1, sing:'un', plu:'un', unBase:'UN'};
  }
  if (ITENS_KG_DIRETO.has(n)) return {porPacote:1, sing:'kg', plu:'kg', unBase:'KG'};
  const c = CONVERSAO.conversao_caixa[n];
  if (c) {
    const rot = c.rotulo;   // só muda o comportamento quando o insumo tem um rótulo de compra definido
    if (rot === 'kg') return {porPacote:1, sing:'kg', plu:'kg', unBase:c.unidade};
    if (rot) {
      // 'unidade' = compra avulsa (1 por vez); 'caixa'/'fardo'/'pente' = embalagem fechada com vários dentro.
      const unPorPacote = (rot === 'unidade') ? 1 : c.un_por_caixa;
      return {porPacote: unPorPacote * c.qtd_por_un,
              sing: rot==='unidade' ? 'un' : rot,
              plu:  rot==='unidade' ? 'un' : (plural[rot] || rot+'s'),
              unBase: c.unidade};
    }
    // padrão (sem rótulo): aplica a REGRA do Gabriel — embalagem 1:1 com a unidade NÃO é "caixa",
    // é unidade (UN) ou kg (peso). Só vira "caixa" quando a embalagem tem VÁRIOS dentro (un_por_caixa>1).
    if (c.un_por_caixa <= 1) {
      if (c.unidade === 'KG') return {porPacote:1, sing:'kg', plu:'kg', unBase:'KG'};
      return {porPacote:c.qtd_por_un, sing:'un', plu:'un', unBase:'UN'};
    }
    return {porPacote:c.un_por_caixa * c.qtd_por_un, sing:'caixa', plu:'caixas', unBase:c.unidade};
  }
  return {porPacote:1, sing:'un', plu:'un', unBase:'UN'};
}

// Converte a quantidade que falta (em unidade-base) na unidade de compra (caixa/fardo/kg), arredondando para cima
function sugerirCompra(ing, faltaBase) {
  const i = infoUnidadeCompra(ing);
  const qt = Math.max(1, Math.ceil(faltaBase / i.porPacote));
  return {qtd:qt, un: qt===1 ? i.sing : i.plu, base: qt*i.porPacote, unBase:i.unBase};
}

async function gerarListaCompras() {
  const lojaSel = document.getElementById('cs-loja').value;
  const dias   = Math.max(1, parseInt(document.getElementById('cs-dias').value)||10);
  const janela = Math.max(0, parseInt(document.getElementById('cs-janela').value)||0);
  const lead   = Math.max(0, parseInt(document.getElementById('cs-lead').value)||0);
  const segPct = Math.max(0, parseFloat(String(document.getElementById('cs-seg').value).replace(',','.'))||0);
  const fatorSeg = 1 + segPct/100;
  const lojas = lojaSel ? [lojaSel] : LOJAS_ATIVAS();

  const [contagens, vendas, compras, transferencias] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);

  const out = [];
  const exportRows = []; // objetos {loja, fornecedor, ingrediente, ...}
  let algumaLista = false;

  for (const loja of lojas) {
    const cts = contagens.filter(c=>c.loja===loja).sort((a,b)=>b.data.localeCompare(a.data));
    const ultima = cts[0];
    const vendasLoja = vendas.filter(v=>v.loja===loja);

    // Insumos que a loja REALMENTE trabalha (mesmo conjunto da cobrança de contagem):
    // premium fora da Buritis e refri exclusivo fora da Venda Nova NÃO entram na lista (pedido 20/07).
    const existe = await carregarInsumosExistentes(loja);
    const filtraExiste = existe.size > 0;   // loja sem histórico nenhum: não filtra (senão a lista nasce vazia)

    if (!ultima || !vendasLoja.length) {
      out.push(`<div class="card mb-3"><div class="card-header d-flex justify-content-between align-items-center">
        <span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span></div>
        <div class="card-body"><div class="alert alert-secondary py-2 small mb-0">
        ${!ultima ? 'Sem contagem salva — faça uma contagem desta loja para o sistema saber o estoque atual.'
                  : 'Sem vendas TOTEM importadas — preciso delas para estimar o consumo.'}</div></div></div>`);
      continue;
    }

    // Janela de análise escolhida + denominador = dias REALMENTE cobertos pelas vendas
    const {vendasJanela, refDate, corteISO} = vendasNaJanela(vendasLoja, janela);
    const diasReais = diasCobertosVendas(vendasJanela);
    if (!vendasJanela.length || diasReais <= 0) {
      out.push(`<div class="card mb-3"><div class="card-header"><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span></div>
        <div class="card-body"><div class="alert alert-secondary py-2 small mb-0">
        Sem vendas dentro da janela de ${janela||'todos os'} dias. Aumente a janela ou importe mais vendas TOTEM.</div></div></div>`);
      continue;
    }
    const cons = calcConsumoPeriodo(vendasJanela); // consumo em unidade-base por ingrediente

    // GASTO REAL DA SEMANA: consumo entre as DUAS últimas contagens, pelo MOTOR oficial
    // das Divergências (inicial + compras + transferências − final, com regra de momento).
    // Fonte única — mesma conta da auditoria mestre; furo (consumo negativo) fica marcado, não somado.
    const anterior = cts[1] || null;
    let gastoSem = null, semanaInfo = '';
    if (anterior) {
      const div = await calcDivergencias(loja, anterior.data, ultima.data, {contagens, vendas, compras, transferencias});
      gastoSem = {};
      for (const r of [...div.resultado, ...div.resultadoBebidas]) {
        const k1 = normIng(r.ing), k2 = norm(r.ing);
        const g = gastoSem[k1] || gastoSem[k2] || {qtd:0, valor:0, furo:false};
        if (r.impossivel) g.furo = true;
        else if (r.consumoReal > 0) { g.qtd += r.consumoReal; g.valor += r.consumoReal * r.custo; }
        gastoSem[k1] = g; if (k2 !== k1) gastoSem[k2] = g;   // mesmo objeto nas 2 chaves (não duplica soma)
      }
      const gap = Math.round((new Date(ultima.data) - new Date(anterior.data)) / 86400000);
      semanaInfo = ` · gasto real: ${fmtDate(anterior.data)} → ${fmtDate(ultima.data)} (${gap}d)`;
    }

    // Monta itens a comprar — modelo de ponto de reposição:
    // necessidade = consumo/dia × (cobertura desejada + prazo de entrega) × (1 + margem segurança)
    const itens = [];
    let ocultados = 0;
    for (const nome of TODOS_INGREDIENTES) {
      const consTotal = cons[normIng(nome)] ?? cons[norm(nome)] ?? 0;
      if (consTotal<=0.05) continue; // ignora traços (orégano, sal…) — consumo desprezível
      if (filtraExiste && !existe.has(norm(nome)) && !existe.has(normIng(nome))) { ocultados++; continue; }
      const consDia = consTotal/diasReais;
      const estoque = ultima.ingredientes?.[nome]?.total ?? 0;
      const alvoBase = consDia * (dias + lead);          // par level (sem segurança)
      const necessidade = alvoBase * fatorSeg;           // + margem de segurança
      const faltaBase = necessidade - estoque;
      const cobertura = consDia>0 ? estoque/consDia : Infinity;
      if (faltaBase <= 0) continue; // estoque já cobre o alvo
      const ingNorm = normIng(nome);
      const sug = sugerirCompra(nome, faltaBase);
      const precoBase = precoBasePago(compras, loja, ingNorm) || getCustoIng(nome);
      const custo = sug.base * precoBase;
      const forn = fornecedorHabitual(compras, loja, ingNorm) || 'Sem fornecedor definido';
      const gasto = gastoSem ? (gastoSem[ingNorm] || gastoSem[norm(nome)] || null) : null;
      itens.push({nome, estoque, consDia, cobertura, sug, custo, forn, gasto, temSemana: !!anterior});
    }

    const baseInfo = `contagem de ${fmtDate(ultima.data)} · consumo de ${fmtDate(vendasJanela.map(v=>v.data_inicio).sort()[0])} a ${fmtDate(refDate)} (${diasReais} dia${diasReais>1?'s':''} com dados)${semanaInfo}`;

    if (!itens.length) {
      out.push(`<div class="card mb-3"><div class="card-header"><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span>
        <span class="text-muted small ms-2">${baseInfo}</span></div>
        <div class="card-body"><div class="alert alert-success py-2 small mb-0">
        <i class="fas fa-check-circle me-1"></i>Estoque cobre o alvo (${dias} + ${lead} dias, margem ${segPct}%) — nada urgente para comprar.</div></div></div>`);
      continue;
    }
    algumaLista = true;

    // Agrupa por fornecedor
    const porForn = {};
    for (const it of itens) (porForn[it.forn] = porForn[it.forn]||[]).push(it);
    const fornNomes = Object.keys(porForn).sort((a,b)=>a==='Sem fornecedor definido'?1:b==='Sem fornecedor definido'?-1:a.localeCompare(b));
    const totalLoja = itens.reduce((s,it)=>s+it.custo,0);

    let blocos = '';
    for (const f of fornNomes) {
      const lista = porForn[f].sort((a,b)=>b.custo-a.custo);
      const subtotal = lista.reduce((s,it)=>s+it.custo,0);
      blocos += `
        <div class="ing-group-header d-flex justify-content-between"><span><i class="fas fa-store me-1"></i>${esc(f)}</span><span>${fmtBRL(subtotal)}</span></div>
        <div style="overflow-x:auto"><table class="table table-sm mb-0">
          <tbody>
          ${lista.map(it=>{
            // TUDO na unidade em que o Gabriel COMPRA (balde/fardo/pente/caixa/kg) — pedido 20/07
            const info = infoUnidadeCompra(it.nome);
            const emC  = q => q / info.porPacote;
            const rot  = q => Math.abs(emC(q)-1)<0.005 ? info.sing : info.plu;
            const estTxt = `${fmtNum(emC(it.estoque),1)} ${rot(it.estoque)}`;
            const diaTxt = `${fmtNum(emC(it.consDia),2)} ${info.plu}/dia`;
            const temFuro = it.temSemana && it.gasto && it.gasto.furo;
            const gastoQtdTxt = `${fmtNum(emC(it.gasto?.qtd||0),1)} ${rot(it.gasto?.qtd||0)}`;
            const gastoTxt = !it.temSemana ? '—'
              : temFuro ? '<span class="text-danger" title="Furo entre as 2 últimas contagens — confira em Divergências">furo?</span>'
              : gastoQtdTxt;
            const cobCls = it.cobertura<lead?'text-danger fw-bold':it.cobertura<dias?'text-warning':'text-muted';
            exportRows.push({loja:LOJA_LABEL[loja], fornecedor:f, ingrediente:it.nome,
              gastoSemana: !it.temSemana ? 'sem contagem anterior' : temFuro ? 'furo? (ver Divergências)' : gastoQtdTxt,
              gastoSemanaRS: (it.temSemana && it.gasto && !temFuro) ? Number(it.gasto.valor.toFixed(2)) : '',
              estoque: estTxt,
              comprar: `${it.sug.qtd} ${it.sug.un}`,
              custo: Number(it.custo.toFixed(2)),
              consumoDia: diaTxt,
              kgTotais: it.sug.unBase==='KG' ? Number(it.sug.base.toFixed(2)) : `${fmtNum(it.sug.base,0)} un`});
            return `<tr>
              <td class="fw-semibold" style="width:170px">${esc(it.nome)}</td>
              <td class="text-end text-muted small" style="width:130px" title="Consumo real entre as 2 últimas contagens (mesma conta das Divergências)">sem.: ${gastoTxt}</td>
              <td class="text-end text-muted small" style="width:110px">tem ${estTxt}</td>
              <td class="text-end small" style="width:120px">${diaTxt}</td>
              <td class="text-end ${cobCls}" style="width:100px">${isFinite(it.cobertura)?'cobre '+it.cobertura.toFixed(1)+'d':'—'}</td>
              <td class="text-end fw-bold" style="width:150px"><i class="fas fa-cart-plus me-1 text-success"></i>${it.sug.qtd} ${it.sug.un}${info.porPacote!==1?` <span class="text-muted small">(~${fmtNum(it.sug.base,0)} ${it.sug.unBase==='KG'?'kg':'un'})</span>`:''}</td>
              <td class="text-end" style="width:110px">${fmtBRL(it.custo)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table></div>`;
    }

    const notaOcultos = ocultados
      ? `<div class="small text-muted px-3 py-2 border-top"><i class="fas fa-eye-slash me-1"></i>${ocultados} insumo(s) ficaram fora por nunca terem sido contados/comprados nesta loja (ex.: premium fora da Buritis, refri exclusivo fora da Venda Nova). Se a loja passou a usar algum, basta contá-lo uma vez.</div>` : '';
    out.push(`
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-1">
          <span><span class="badge ${LOJA_BADGE[loja]}">${LOJA_LABEL[loja]}</span>
            <span class="text-muted small ms-2">${baseInfo}</span></span>
          <span class="fw-bold" style="color:var(--cor)">Total estimado: ${fmtBRL(totalLoja)}</span>
        </div>
        <div class="card-body p-0">${blocos}${notaOcultos}</div>
      </div>`);
  }

  _listaCompras = exportRows;
  document.getElementById('cs-resultado').innerHTML = out.join('');
  document.getElementById('cs-vazio').classList.toggle('d-none', algumaLista || out.length>0);
}

// Nome de aba do Excel válido (<=31 chars, sem :\/?*[], único no arquivo)
function nomeAbaSegura(s, usadas) {
  let n = String(s||'Fornecedor').replace(/[:\\\/?*\[\]]/g,' ').replace(/\s+/g,' ').trim().slice(0,28) || 'Fornecedor';
  let base = n, i = 2;
  while (usadas.has(n.toLowerCase())) { n = base.slice(0,26)+' '+i; i++; }
  usadas.add(n.toLowerCase());
  return n;
}

async function exportarListaCompras() {
  if (!_listaCompras || !_listaCompras.length) { toast('Gere a lista primeiro (ou não há nada a comprar).','warning'); return; }
  await aquecerPermissaoPasta();
  const wb = XLSX.utils.book_new();
  const rows = _listaCompras;

  // --- Aba RESUMO: tudo, com total geral ---
  // Colunas do jeito que o Gabriel pediu (20/07): tudo na unidade em que ele COMPRA;
  // "Gasto na semana" = consumo real entre as 2 últimas contagens (motor das Divergências);
  // "Kg totais" = a compra sugerida convertida para kg (itens em unidade mostram "N un").
  const cabResumo = ['Loja','Fornecedor','Ingrediente','Gasto na semana','Gasto na semana R$','Estoque atual','Comprar (un. compra)','Custo estimado R$','Consumo/dia','Kg totais'];
  const corpoResumo = rows.map(r=>[r.loja, r.fornecedor, r.ingrediente, r.gastoSemana, r.gastoSemanaRS, r.estoque, r.comprar, r.custo, r.consumoDia, r.kgTotais]);
  const totalGeral = rows.reduce((s,r)=>s+(r.custo||0),0);
  const wsResumo = XLSX.utils.aoa_to_sheet([cabResumo, ...corpoResumo, [], ['','','','','','','TOTAL', Number(totalGeral.toFixed(2)),'','']]);
  wsResumo['!cols'] = [{wch:12},{wch:24},{wch:18},{wch:16},{wch:16},{wch:13},{wch:16},{wch:16},{wch:14},{wch:10}];
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

  // --- Uma aba por fornecedor ---
  const porForn = {};
  for (const r of rows) (porForn[r.fornecedor] = porForn[r.fornecedor]||[]).push(r);
  const usadas = new Set(['resumo']);
  const fornNomes = Object.keys(porForn).sort((a,b)=>a==='Sem fornecedor definido'?1:b==='Sem fornecedor definido'?-1:a.localeCompare(b));
  for (const f of fornNomes) {
    const lista = porForn[f];
    const cab = ['Loja','Ingrediente','Gasto na semana','Estoque atual','Comprar (un. compra)','Custo estimado R$','Consumo/dia','Kg totais'];
    const corpo = lista.map(r=>[r.loja, r.ingrediente, r.gastoSemana, r.estoque, r.comprar, r.custo, r.consumoDia, r.kgTotais]);
    const subtotal = lista.reduce((s,r)=>s+(r.custo||0),0);
    const ws = XLSX.utils.aoa_to_sheet([[f], [], cab, ...corpo, [], ['','','','','TOTAL', Number(subtotal.toFixed(2)),'','']]);
    ws['!cols'] = [{wch:12},{wch:20},{wch:16},{wch:13},{wch:16},{wch:16},{wch:14},{wch:10}];
    XLSX.utils.book_append_sheet(wb, ws, nomeAbaSegura(f, usadas));
  }

  const nome = `lista-compras-${today()}.xlsx`;
  const out = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  const naPasta = await salvarArquivo(new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), nome, 'Excel');
  toast(naPasta ? `Lista salva na pasta de backups (Excel\\${nome})!` : 'Lista de compras exportada — confira a pasta Downloads.','success');
}

// ================================================================
// 12. PREVISÃO
// ================================================================
async function rodarPrevisao() {
  const loja   = document.getElementById('pv-loja').value;
  const janela = Math.max(0, parseInt(document.getElementById('pv-janela').value)||0);
  const lead   = Math.max(0, parseInt(document.getElementById('pv-lead').value)||0);

  document.getElementById('pv-vazio').classList.add('d-none');

  const [contagens, vendas] = await Promise.all([DB.getAll('contagens'), DB.getAll('vendas')]);

  const contagensLoja = contagens.filter(c=>c.loja===loja).sort((a,b)=>b.data.localeCompare(a.data));
  const ultimaContagem = contagensLoja[0];

  if (!ultimaContagem) {
    toast('Nenhuma contagem encontrada para esta loja!','warning');
    document.getElementById('pv-vazio').classList.remove('d-none');
    return;
  }

  // Consumo por dia = consumo total na janela ÷ dias REALMENTE cobertos pelas vendas.
  const vendasLoja = vendas.filter(v=>v.loja===loja);
  const {vendasJanela, refDate, corteISO} = vendasNaJanela(vendasLoja, janela);
  const diasReais = diasCobertosVendas(vendasJanela);
  const consumoTotal = calcConsumoPeriodo(vendasJanela); // unidade-base por ingrediente (pizzas+adicionais+bebidas)

  // Limites de status atrelados ao prazo de entrega
  const limiteCrit = Math.max(1, lead);
  const limiteAten = Math.max(limiteCrit+2, lead*2);

  const tbody = document.getElementById('pv-tbody');
  const rows = [];

  for (const [ing, total] of Object.entries(ultimaContagem.ingredientes||{})) {
    const consumoD = diasReais>0 ? (consumoTotal[normIng(ing)] ?? consumoTotal[norm(ing)] ?? 0) / diasReais : 0;
    if (consumoD === 0 && (total.total||0) === 0) continue;
    const dias = consumoD > 0 ? (total.total||0) / consumoD : Infinity;

    let status, cls;
    if (!isFinite(dias)) { status='Sem consumo'; cls='text-muted'; }
    else if (dias < limiteCrit) { status='🔴 Pedir já'; cls='text-danger fw-bold'; }
    else if (dias < limiteAten) { status='🟡 Atenção'; cls='text-warning fw-bold'; }
    else { status='🟢 OK'; cls='text-success'; }

    rows.push({ing, total:total.total, unidade:total.unidade, consumoD, dias, status, cls});
  }

  rows.sort((a,b)=>a.dias-b.dias);

  const modoUn = document.getElementById('pv-unidade')?.value || 'compra';
  tbody.innerHTML = rows.map(r=>{
    const est = modoUn==='compra' ? qtdEmUnidadeCompra(r.ing, r.total)     : {valor:r.total,    unidade:(r.unidade||'').toLowerCase()};
    const con = modoUn==='compra' ? qtdEmUnidadeCompra(r.ing, r.consumoD)  : {valor:r.consumoD, unidade:(r.unidade||'').toLowerCase()};
    return `<tr>
      <td class="fw-semibold">${esc(r.ing)}</td>
      <td class="text-end">${fmtNum(est.valor,2)} ${est.unidade}</td>
      <td class="text-end">${r.consumoD>0?fmtNum(con.valor,2)+' '+con.unidade+'/dia':'—'}</td>
      <td class="text-end ${r.cls}">${isFinite(r.dias)?r.dias.toFixed(1)+'d':'∞'}</td>
      <td class="${r.cls}">${r.status}</td>
    </tr>`;
  }).join('');

  // Base do cálculo + aviso de poucos dados
  const baseEl = document.getElementById('pv-base');
  if (!vendasJanela.length || diasReais<=0) {
    baseEl.className = 'small mb-2';
    baseEl.innerHTML = `<div class="alert alert-warning py-2 mb-0"><i class="fas fa-triangle-exclamation me-1"></i>
      <strong>${LOJA_LABEL[loja]}:</strong> sem vendas TOTEM na janela escolhida — não dá para estimar o consumo.
      A tabela mostra só o estoque atual. Aumente a janela (ou use 0 = tudo) ou importe mais vendas.</div>`;
  } else {
    const iniReal = vendasJanela.map(v=>v.data_inicio).sort()[0];
    const poucos = diasReais < 7;
    baseEl.className = 'small mb-2 text-muted';
    baseEl.innerHTML = `<i class="fas fa-circle-info me-1"></i>
      <strong>${LOJA_LABEL[loja]}</strong> — contagem de <strong>${fmtDate(ultimaContagem.data)}</strong> ·
      consumo de <strong>${fmtDate(iniReal)}</strong> a <strong>${fmtDate(refDate)}</strong>
      (<strong>${diasReais} dia${diasReais>1?'s':''}</strong> com dados) · prazo de entrega <strong>${lead} dia${lead!==1?'s':''}</strong>.
      ${poucos ? '<span class="text-warning d-block mt-1"><i class="fas fa-triangle-exclamation me-1"></i>Poucos dias de dados — a estimativa pode variar bastante. Quanto mais vendas você importar, melhor.</span>' : ''}`;
  }

  document.getElementById('pv-resultado').classList.remove('d-none');
  document.getElementById('pv-vazio').classList.add('d-none');
}

// ================================================================
// 12D. CURVA ABC & GIRO DE ESTOQUE (melhoria 6)
// ================================================================
// Página NOVA e isolada: só LÊ os stores (vendas/contagens/compras), não muda
// nada do resto. Curva ABC = Pareto do CONSUMO (o que saiu × custo), em duas
// bases: "esperado" (vendas × ficha) e "real" (entre 2 contagens, via
// calcDivergencias — só leitura). Giro = quanto o estoque atual dura.
async function renderABC() {
  const loja = document.getElementById('abc-loja').value;
  const janela = parseInt(document.getElementById('abc-janela').value) || 0;
  const base = document.getElementById('abc-base').value; // 'esperado' | 'real' | 'desperdicio'
  const [vendas, contagens, compras] = await Promise.all([
    DB.getAll('vendas'), DB.getAll('contagens'), DB.getAll('compras')
  ]);

  // Corte de data (a partir de hoje) para selecionar contagens da base "real"
  let corteISO = null;
  if (janela > 0) { const d = new Date(); d.setDate(d.getDate() - (janela-1)); corteISO = dataLocalISO(d); }
  const hojeISO = today();

  // ---------- CURVA ABC (por CONSUMO, não por compra) ----------
  const lojas = loja ? [loja] : LOJAS_ATIVAS();
  const valor = {};      // nomeNormalizado -> R$ no período (consumo ou desperdício)
  let avisoBase = '';
  const lbl = {esperado:'· esperado (vendas)', real:'· real (contagem)', desperdicio:'· desperdício (perda)'};
  document.getElementById('abc-base-lbl').textContent = lbl[base] || lbl.esperado;
  // Cabeçalho da coluna de valor muda conforme a base
  const colValorEl = document.getElementById('abc-col-valor');
  if (colValorEl) colValorEl.textContent = base==='desperdicio' ? 'Desperdício (R$)' : 'Consumo (R$)';

  // As 3 bases saem da MESMA janela (entre a 1ª e a última contagem do período),
  // via calcDivergencias (que já exclui bebidas, inclui a massa e usa preço pago).
  // Assim esperado, real e desperdício são COMPARÁVEIS (antes o esperado somava
  // todas as vendas dos N dias e o real só o intervalo entre 2 contagens → não batia).
  let lojasOk = 0;
  for (const lj of lojas) {
    const cont = contagens.filter(c=>c.loja===lj).sort((a,b)=>a.data.localeCompare(b.data));
    const inWin = corteISO ? cont.filter(c=>c.data>=corteISO) : cont;
    if (inWin.length < 2) continue;
    const d = await calcDivergencias(lj, inWin[0].data, inWin[inWin.length-1].data);
    for (const r of d.resultado) {
      const n = normIng(r.ing);
      if (base === 'desperdicio') {
        if (r.impacto > 0) valor[n] = (valor[n]||0) + r.impacto;        // só a perda (real além do esperado)
      } else if (base === 'real') {
        if (r.consumoReal > 0) valor[n] = (valor[n]||0) + r.consumoReal*r.custo; // o que saiu de verdade
      } else {
        if (r.esperado > 0) valor[n] = (valor[n]||0) + r.esperado*r.custo;       // esperado pela ficha+massa, MESMA janela
      }
    }
    lojasOk++;
  }
  if (!lojasOk) avisoBase = 'Preciso de pelo menos 2 contagens no período (uma no começo e uma no fim) para montar a curva. Aumente os dias ou faça outra contagem.';

  const arr = Object.entries(valor).map(([nome,v])=>({nome, valor:v})).filter(x=>x.valor>0).sort((a,b)=>b.valor-a.valor);
  const total = arr.reduce((s,x)=>s+x.valor,0);
  const tbody = document.getElementById('abc-tbody');
  const resumoEl = document.getElementById('abc-resumo');
  const badge = {A:'bg-danger', B:'bg-warning text-dark', C:'bg-secondary'};
  if (!arr.length || total<=0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">${avisoBase || (base==='desperdicio' ? 'Sem desperdício no período. 🎉' : 'Sem consumo no período.')}</td></tr>`;
    resumoEl.innerHTML = '';
  } else {
    let acum = 0, nA=0,nB=0,nC=0,vA=0;
    tbody.innerHTML = arr.map(x=>{
      const pct = x.valor/total*100;
      acum += pct;
      const cls = acum<=80 ? 'A' : acum<=95 ? 'B' : 'C';
      if (cls==='A'){nA++;vA+=x.valor;} else if (cls==='B'){nB++;} else {nC++;}
      return `<tr>
        <td><span class="badge ${badge[cls]}">${cls}</span></td>
        <td class="fw-semibold">${esc(x.nome)}</td>
        <td class="text-end">${fmtBRL(x.valor)}</td>
        <td class="text-end">${fmtPct(pct)}</td>
        <td class="text-end text-muted">${fmtPct(acum)}</td>
      </tr>`;
    }).join('');
    const oQue = base==='desperdicio' ? 'do desperdício' : 'do custo';
    resumoEl.innerHTML =
      `<span class="badge bg-danger me-1">A</span><strong>${nA}</strong> itens = ${fmtPct(vA/total*100)} ${oQue} · `+
      `<span class="badge bg-warning text-dark me-1">B</span>${nB} · `+
      `<span class="badge bg-secondary me-1">C</span>${nC} · total no período <strong>${fmtBRL(total)}</strong>`;
  }

  // ---------- GIRO DE ESTOQUE (precisa de UMA loja: estoque é por loja) ----------
  const giroTbody = document.getElementById('giro-tbody');
  const giroAviso = document.getElementById('giro-aviso');
  const lojaGiro = loja || currentLoja;
  const contLoja = contagens.filter(c=>c.loja===lojaGiro).sort((a,b)=>a.data.localeCompare(b.data));
  const ultCont = contLoja[contLoja.length-1];
  const vendasLoja = vendas.filter(v=>v.loja===lojaGiro);
  if (!ultCont || !vendasLoja.length) {
    giroTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Falta contagem e/ou vendas TOTEM desta loja.</td></tr>';
    giroAviso.innerHTML = '';
  } else {
    const {vendasJanela} = vendasNaJanela(vendasLoja, janela);
    const diasReais = diasCobertosVendas(vendasJanela) || 1;
    const consumo = calcConsumoPeriodo(vendasJanela);
    giroAviso.innerHTML = `<span class="text-muted">Loja <strong>${LOJA_LABEL[lojaGiro]}</strong> · estoque de ${fmtDate(ultCont.data)} · consumo de ${diasReais} dia(s) com vendas.</span>`;
    const linhas = [];
    for (const [ing, val] of Object.entries(ultCont.ingredientes||{})) {
      const estoque = val.total||0;
      if (estoque<=0) continue;
      const n = normIng(ing);
      const consDia = (consumo[n]||0)/diasReais;
      const valorEstoque = estoque*custoPagoIng(ing, ultCont.data, ultCont.data, compras, lojaGiro); // preço pago

      let dias, classe, ord;
      if (consDia<=0.0001) { dias=Infinity; classe='Parado'; ord=1e9 + valorEstoque; }
      else { dias = estoque/consDia; ord = dias; classe = dias<7?'Rápido':dias<=21?'Médio':'Lento'; }
      linhas.push({ing, valorEstoque, dias, classe, ord});
    }
    linhas.sort((a,b)=>b.ord-a.ord); // parados e lentos no topo (capital parado)
    const gb = {'Parado':'bg-dark','Lento':'bg-danger','Médio':'bg-warning text-dark','Rápido':'bg-success'};
    giroTbody.innerHTML = linhas.length ? linhas.map(r=>`
      <tr>
        <td class="fw-semibold">${esc(r.ing)}</td>
        <td class="text-end">${fmtBRL(r.valorEstoque)}</td>
        <td class="text-end">${r.dias===Infinity?'—':fmtNum(r.dias,1)}</td>
        <td><span class="badge ${gb[r.classe]}">${r.classe}</span></td>
      </tr>`).join('') : '<tr><td colspan="4" class="text-center text-muted py-3">Sem estoque na última contagem.</td></tr>';
  }
}

