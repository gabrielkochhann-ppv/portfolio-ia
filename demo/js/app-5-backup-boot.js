// ================================================================
// 13. BACKUP
// ================================================================

// ---------- Pasta de backups: salva direto na pasta escolhida (senão, Downloads) ----------
async function obterPastaBackups(sub) {
  try {
    const dir = await cfgGet('pastaBackups');
    if (!dir) return null;
    let perm = await dir.queryPermission({mode:'readwrite'});
    if (perm === 'prompt') perm = await dir.requestPermission({mode:'readwrite'});
    if (perm !== 'granted') return null;
    return sub ? await dir.getDirectoryHandle(sub, {create:true}) : dir;
  } catch(e) { console.error(e); return null; }
}

// Grava o arquivo na subpasta JSON/Excel da pasta de backups; se não der, baixa normal.
// Devolve true se foi direto na pasta, false se foi para Downloads.
async function salvarArquivo(blob, nome, sub) {
  const pasta = await obterPastaBackups(sub);
  if (pasta) {
    try {
      const fh = await pasta.getFileHandle(nome, {create:true});
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      return true;
    } catch(e) { console.error(e); }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
  return false;
}

async function definirPastaBackups() {
  if (!window.showDirectoryPicker) {
    toast('Este navegador não permite fixar uma pasta — os arquivos continuarão indo para Downloads.','warning');
    return;
  }
  try {
    const dir = await showDirectoryPicker({mode:'readwrite'});
    await cfgSet('pastaBackups', dir);
    toast(`Pasta "${esc(dir.name)}" definida! Backups JSON vão para a subpasta JSON e planilhas para a Excel.`,'success');
  } catch(e) {
    if (e.name !== 'AbortError') toast('Não foi possível usar esta pasta: '+esc(e.message),'error');
  }
  atualizarPastaStatus();
}

async function esquecerPastaBackups() {
  await cfgDel('pastaBackups');
  toast('Pasta esquecida — os arquivos voltam a ir para Downloads.','info');
  atualizarPastaStatus();
}

async function atualizarPastaStatus() {
  const el = document.getElementById('bk-pasta-status');
  if (!el) return;
  if (!window.showDirectoryPicker) {
    el.innerHTML = 'Este navegador não suporta pasta fixa — os arquivos vão para <strong>Downloads</strong>.';
    return;
  }
  const dir = await cfgGet('pastaBackups');
  document.getElementById('bk-pasta-esquecer').classList.toggle('d-none', !dir);
  el.innerHTML = dir
    ? `Salvando direto em <strong>${esc(dir.name)}</strong> (subpastas <strong>JSON</strong> e <strong>Excel</strong>). Na primeira vez depois de abrir o navegador, ele pede permissão — clique em "Permitir".`
    : 'Nenhuma pasta definida — os arquivos vão para <strong>Downloads</strong>. Dica: escolha a pasta <strong>Backups</strong> dentro de "Claude CORRETO".';
}

// ---------- Proteção dos dados: persistência + auto-backup ----------
// Sem isto, o navegador pode APAGAR sozinho o banco (IndexedDB) quando ficar sem
// espaço. Como os dados moram só aqui, isso seria perda total — por isso pedimos
// "armazenamento persistente" (persist) e fazemos um backup automático por dia.
async function garantirPersistencia() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch(e) { return null; }
}

async function statusArmazenamento() {
  const out = {suporta:false, persistido:null, usado:null, cota:null};
  try {
    if (navigator.storage && navigator.storage.estimate) {
      out.suporta = true;
      if (navigator.storage.persisted) out.persistido = await navigator.storage.persisted();
      const est = await navigator.storage.estimate();
      out.usado = est.usage || 0;
      out.cota = est.quota || 0;
    }
  } catch(e) {}
  return out;
}

// Auto-backup SILENCIOSO: grava 1 backup por dia na pasta escolhida, SÓ se a permissão
// já estiver concedida (nunca abre pop-up sozinho). Falha em silêncio.
async function autoBackupSeNecessario() {
  try {
    const dir = await cfgGet('pastaBackups');
    if (!dir) return;                              // sem pasta fixa não dá pra gravar sem clique
    let perm = 'denied';
    try { perm = await dir.queryPermission({mode:'readwrite'}); } catch(e) {}
    if (perm !== 'granted') return;                // não incomoda com pop-up no carregamento
    const hoje = today();
    if (localStorage.getItem('ultimo_autobackup_dia') === hoje) return; // já fez hoje
    const obj = await montarBackupObj();
    if (!obj.contagens.length && !obj.vendas.length && !obj.compras.length && !obj.transferencias.length) return;
    const sub = await dir.getDirectoryHandle('JSON', {create:true});
    const fh = await sub.getFileHandle(`auto-backup-${hoje}.json`, {create:true});
    const w = await fh.createWritable();
    await w.write(new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'}));
    await w.close();
    localStorage.setItem('ultimo_autobackup_dia', hoje);
    localStorage.setItem('ultimo_autobackup_em', new Date().toISOString());
  } catch(e) { console.warn('auto-backup (silencioso) falhou:', e); }
}

function fmtMB(n) {
  if (n == null) return '—';
  return (n/1048576).toLocaleString('pt-BR', {maximumFractionDigits:1}) + ' MB';
}

async function pedirProtecao() {
  const ok = await garantirPersistencia();
  toast(ok ? 'Proteção ativada! O navegador não vai mais apagar seus dados sozinho.'
           : 'O navegador não concedeu a proteção agora. Mantenha o app favoritado e use os backups na pasta — eles são a garantia.',
        ok ? 'success' : 'warning');
  renderProtecaoStatus();
}

async function renderProtecaoStatus() {
  const el = document.getElementById('bk-protecao');
  if (!el) return;
  const st = await statusArmazenamento();
  const dir = await cfgGet('pastaBackups');
  const folderOn = !!dir;
  const abrindoArquivo = location.protocol === 'file:';
  const ultBk = localStorage.getItem('ultimo_backup_em');
  const ultBkTxt = ultBk ? new Date(ultBk).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : null;
  const diasSemBk = ultBk ? Math.floor((Date.now()-new Date(ultBk))/86400000) : null;
  const linhas = [];

  // Estado geral — tranquilo quando a pasta está configurada
  if (folderOn) {
    linhas.push('<div class="text-success"><i class="fas fa-circle-check me-1"></i><strong>Backup configurado.</strong> Quando você salva uma cópia, ela vai <strong>direto para a sua pasta Backups</strong> (subpasta JSON), não para Downloads.</div>');
  } else {
    linhas.push('<div class="text-warning"><i class="fas fa-triangle-exclamation me-1"></i><strong>Falta escolher a pasta de backups.</strong> Em "Exportar" (logo abaixo), clique em <strong>"Escolher pasta…"</strong> e aponte para a pasta <strong>Backups</strong>. Aí suas cópias ficam guardadas com segurança.</div>');
  }

  // Botão único e claro + quando foi a última cópia
  let acao = '<div class="mt-2 d-flex align-items-center gap-2 flex-wrap">';
  acao += '<button class="btn btn-success btn-sm" onclick="exportarDados()"><i class="fas fa-shield-halved me-1"></i>Salvar cópia de segurança agora</button>';
  if (ultBkTxt) {
    const cor = (diasSemBk!=null && diasSemBk>7) ? 'text-danger fw-semibold' : 'text-muted';
    const quanto = diasSemBk>0 ? ` (há ${diasSemBk} dia${diasSemBk>1?'s':''})` : ' (hoje)';
    acao += `<span class="small ${cor}">Última cópia: <strong>${ultBkTxt}</strong>${quanto}.</span>`;
  } else {
    acao += '<span class="small text-danger">Você ainda não salvou nenhuma cópia — clique no botão ao lado.</span>';
  }
  acao += '</div>';
  linhas.push(acao);

  // Espaço usado (informativo)
  if (st.suporta && st.usado != null) {
    linhas.push(`<div class="small text-muted mt-2">Espaço usado pelo app no navegador: <strong>${fmtMB(st.usado)}</strong>.</div>`);
  }

  // Rodapé discreto sobre a "proteção reforçada" do navegador — sem assustar
  if (st.persistido !== true) {
    linhas.push(`<div class="small text-muted mt-1"><i class="fas fa-circle-info me-1"></i>${abrindoArquivo
      ? 'A “proteção reforçada” do navegador não fica disponível ao abrir o app por duplo-clique no arquivo — isso é <strong>normal e não é problema</strong>. Sua garantia é a cópia na pasta, acima.'
      : 'Reforço opcional deste navegador: <button class="btn btn-sm btn-outline-success py-0 px-2" onclick="pedirProtecao()">pedir para não apagar os dados</button>.'}</div>`);
  }

  el.innerHTML = linhas.join('');
}

async function renderBackupStats() {
  renderProtecaoStatus();
  const [contagens, vendas, compras, transf] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);
  document.getElementById('bk-stats').innerHTML = `
    <div class="row g-2">
      <div class="col-6 col-md-3"><div class="stat-card text-center p-3">
        <div class="val">${contagens.length}</div><div class="lbl">Contagens</div></div></div>
      <div class="col-6 col-md-3"><div class="stat-card text-center p-3">
        <div class="val">${vendas.length}</div><div class="lbl">Importações TOTEM</div></div></div>
      <div class="col-6 col-md-3"><div class="stat-card text-center p-3">
        <div class="val">${compras.length}</div><div class="lbl">Compras</div></div></div>
      <div class="col-6 col-md-3"><div class="stat-card text-center p-3">
        <div class="val">${transf.length}</div><div class="lbl">Transferências</div></div></div>
    </div>
    <div class="text-muted small mt-2"><i class="fas fa-clock me-1"></i>Último backup JSON baixado:
      <strong>${(()=>{ const u = localStorage.getItem('ultimo_backup_em');
        return u ? new Date(u).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'nunca'; })()}</strong>
    </div>`;
  atualizarPastaStatus();
}

// Monta o objeto completo de backup (usado pelo botão manual E pelo auto-backup)
// MANIFESTO DO BACKUP — toda camada de localStorage que precisa viajar no backup está NESTA tabela,
// que o exportar (montarBackupObj) E o restaurar (importarDados) percorrem. REGRA: criou um overlay
// novo? Adicione UMA linha aqui e pronto — esquecê-lo era a maior fonte de bug do backup.
// `arr:true` = só restaura se vier array (protege contra backup velho/campo corrompido).
const BACKUP_CAMPOS = [
  {campo:'mapeamento_custom',    get:()=>getMapCustom(),       set:v=>setMapCustom(v)},
  {campo:'map_fornecedor',       get:()=>getMapForn(),         set:v=>setMapForn(v)},
  {campo:'personalizacoes',      get:()=>getPers(),            set:v=>setPers(v)},
  {campo:'ingredientes_ocultos', get:()=>getIngOcultos(),      set:v=>setIngOcultos(v)},
  {campo:'sabores_desligados',   get:()=>getSaboresDesligados(), set:v=>setSaboresDesligados(v)},   // Fase 3: sabores por loja (só dono)
  {campo:'repasse99_manual',     get:()=>getRepasse99Manual(), set:v=>setRepasse99Manual(v)},
  {campo:'pagamentos_correcao',  get:()=>getPagCorrecao(),     set:v=>setPagCorrecao(v)},
  {campo:'dre_custos',           get:()=>getDRECustosAll(),    set:v=>{localStorage.setItem('dre_custos_v1', JSON.stringify(v)); _dreCustosCache = v;}},
  {campo:'dre_custos_cad',       get:()=>getCFCad(),           set:v=>setCFCad(v), arr:true},
  {campo:'dre_grupos',           get:()=>getDREGrupos(),       set:v=>setDREGrupos(v), arr:true},
  {campo:'sangrias_correcao',    get:()=>getSangCorr(),        set:v=>setSangCorr(v)},
  {campo:'sangrias_regras',      get:()=>getSangRegras(),      set:v=>setSangRegras(v), arr:true},
  {campo:'emprestimos_lojas',    get:()=>getEmprestimos(),     set:v=>setEmprestimos(v), arr:true},
  {campo:'alertas_config',       get:()=>getAlertasConfig(),   set:v=>setAlertasConfig(v)},
  // Chips "o que cresce com a venda" do Ponto de Equilíbrio — antes NÃO viajava no backup e o
  // celular perdia a escolha do Gabriel (PE diferente do PC). Set ↔ array na fronteira do JSON.
  {campo:'be_variaveis',         get:()=>[...getBEVar()],      set:v=>setBEVar(new Set(v)), arr:true}
  // 21/09 (fase 1 SaaS): os 3 SNAPSHOTS DO TOTEM (ceo/pag/clientes) SAÍRAM daqui. Eram uma cópia
  // de pedidos/pagamentos/clientes (3,6 MB) que viajava no backup e nos overlays — e o app baixava
  // de novo a cada abertura E a cada volta ao app, além da tabela arquivos_totem (a fonte de
  // verdade na nuvem). Decisão do Gabriel: backup só com o que é dele; o TOTEM o robô traz.
  // Backup antigo com esses campos continua restaurando: campo que não está aqui é ignorado.
];

async function montarBackupObj() {
  const [contagens, vendas, compras, transf] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);
  // 21/09: o backup NÃO carrega mais os dados do TOTEM (os snapshots saíram de BACKUP_CAMPOS) —
  // então também não baixa mais os 3 arquivos (~4 MB) antes de montar. O robô traz o TOTEM de novo.
  const obj = {contagens, vendas, compras, transferencias:transf,
    versao_app: APP_VERSION, schema: SCHEMA_VERSION,
    exportado_em: new Date().toISOString()};
  for (const c of BACKUP_CAMPOS) obj[c.campo] = c.get();
  return obj;
}

// Pede a permissão da pasta de backups AINDA dentro do clique do usuário.
// Os exportadores fazem awaits longos (montar backup, buscar CEO/clientes pela rede) ANTES
// de gravar; esses awaits consomem o "gesto do usuário" e o navegador passa a recusar o
// requestPermission em silêncio → o arquivo cairia no Downloads mesmo com a pasta definida.
// Chamando isto PRIMEIRO, a permissão é concedida enquanto o gesto ainda vale, e a gravação
// seguinte (obterPastaBackups) encontra a permissão já 'granted'.
async function aquecerPermissaoPasta() {
  try {
    const dir = await cfgGet('pastaBackups');
    if (!dir || !dir.queryPermission) return;
    let perm = await dir.queryPermission({mode:'readwrite'});
    if (perm === 'prompt') await dir.requestPermission({mode:'readwrite'});
  } catch(e) { console.warn('permissão da pasta de backups:', e); }
}

async function exportarDados() {
  await aquecerPermissaoPasta();
  const data = await montarBackupObj();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const nome = `pizza-estoque-backup-${today()}.json`;
  const naPasta = await salvarArquivo(blob, nome, 'JSON');
  localStorage.setItem('ultimo_backup_em', new Date().toISOString());
  toast(naPasta ? `Backup salvo na pasta de backups (JSON\\${nome})!` : 'Backup baixado — confira a pasta Downloads.','success');
  renderBackupStats();
}

async function importarDados(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { toast('Arquivo inválido!','error'); return; }

  // Valida ANTES de apagar qualquer coisa: um JSON que não é backup não pode zerar o banco
  const stores = ['contagens','vendas','compras','transferencias'];
  if (!stores.some(s => Array.isArray(data?.[s]))) {
    toast('Este arquivo não parece um backup do sistema (não tem contagens/vendas/compras). Nada foi alterado.','error');
    return;
  }
  const resumo = stores.map(s => `${(data[s]||[]).length} ${s}`).join(', ');
  if (!confirm(`⚠️ ATENÇÃO: Isso vai SUBSTITUIR todos os dados existentes pelos do backup:\n\n${resumo}\n\nConfirma?`)) return;

  // NA NUVEM: cada store é trocado numa TRANSAÇÃO só (RPC restaurar_store, ver
  // banco/schema-restore.sql). Antes era `DB.clear` + `DB.addLote` = duas requisições: se a
  // internet caísse entre elas, apagava os dados da empresa e não gravava os novos — bem na
  // hora em que a pessoa está justamente com medo de perder dados. Agora ou troca tudo, ou
  // não muda nada. No modo local (IndexedDB, sem rede no meio) segue o caminho simples.
  const naNuvem = !!(window.Nuvem && Nuvem.ativa() && Nuvem.restaurarStore);
  try {
    for (const store of stores) {
      const rows = (data[store] || []).map(({id, ...rest}) => rest);
      if (naNuvem) {
        await Nuvem.restaurarStore(store, rows);
      } else {
        await DB.clear(store);
        if (DB.addLote) await DB.addLote(store, rows);
        else for (const row of rows) await DB.add(store, row);
      }
    }
  } catch (e) {
    const dica = /vendas_totem_dia_unico/.test(e.message)
      ? '<br><br>Este backup tem o MESMO dia de venda repetido para uma loja (duplicata antiga). '
        + 'O banco recusou para não dobrar seus números. Restaure um backup mais recente.'
      : '<br><br>Nada foi alterado — pode tentar de novo.';
    toast('Não consegui restaurar: ' + esc(e.message) + dica, 'error');
    return;
  }
  // Overlays/snapshots: tudo pelo MANIFESTO (mesma tabela do exportar) — campo ausente é pulado,
  // então backup antigo continua restaurando normalmente.
  for (const c of BACKUP_CAMPOS) {
    const v = data[c.campo];
    if (!v) continue;
    if (c.arr && !Array.isArray(v)) continue;
    c.set(v);
  }
  _ceoData = null; _cliData = null; _pagData = null;   // limpa cache em memória p/ reler o snapshot novo

  toast('Dados restaurados com sucesso!','success');
  renderBackupStats();
}

async function exportarExcel() {
  await aquecerPermissaoPasta();
  const [contagens, vendas, compras, transf] = await Promise.all([
    DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras'), DB.getAll('transferencias')
  ]);

  const wb = XLSX.utils.book_new();

  // Aba Compras
  const cpRows = compras.map(c=>[c.data, LOJA_LABEL[c.loja]||c.loja, c.ingrediente, c.quantidade, c.unidade, c.quantidade_base, c.unidade_base, c.fornecedor||'', c.valor_total||0]);
  const cpWs = XLSX.utils.aoa_to_sheet([['Data','Loja','Ingrediente','Qtd','Un','Qtd Base','Un Base','Fornecedor','Valor Total'], ...cpRows]);
  XLSX.utils.book_append_sheet(wb, cpWs, 'Compras');

  // Aba Transferências
  const trRows = transf.map(t=>[t.data, LOJA_LABEL[t.loja_origem]||t.loja_origem, LOJA_LABEL[t.loja_destino]||t.loja_destino, t.ingrediente, t.quantidade, t.unidade]);
  const trWs = XLSX.utils.aoa_to_sheet([['Data','Origem','Destino','Ingrediente','Qtd','Un'], ...trRows]);
  XLSX.utils.book_append_sheet(wb, trWs, 'Transferencias');

  // Aba Contagens (uma linha por ingrediente)
  const ctRows = [];
  for (const c of contagens) {
    for (const [ing, val] of Object.entries(c.ingredientes||{})) {
      ctRows.push([c.data, LOJA_LABEL[c.loja]||c.loja, ing, val.caixas||0, val.unidades||0, val.total||0, val.unidade||'']);
    }
  }
  const ctWs = XLSX.utils.aoa_to_sheet([['Data','Loja','Ingrediente','Caixas','Unidades','Total','Unidade'], ...ctRows]);
  XLSX.utils.book_append_sheet(wb, ctWs, 'Contagens');

  const nome = `pizza-estoque-${today()}.xlsx`;
  const out = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  const naPasta = await salvarArquivo(new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), nome, 'Excel');
  toast(naPasta ? `Excel salvo na pasta de backups (Excel\\${nome})!` : 'Excel baixado — confira a pasta Downloads.','success');
}

async function limparStore(store) {
  const nomes = {contagens:'todas as contagens',vendas:'todas as importações TOTEM',compras:'todas as compras',transferencias:'todas as transferências'};
  const total = (await DB.getAll(store)).length;
  if (!total) { toast('Não há registros para apagar.','info'); return; }
  if (!confirm(`Apagar ${nomes[store]} (${total} registros)? Esta ação NÃO pode ser desfeita!\n\nDica: baixe um Backup JSON antes, por garantia.`)) return;
  await DB.clear(store);
  toast(`${nomes[store]} apagado(a)s!`,'success');
  renderBackupStats();
}

// ================================================================
// 13A. CARDÁPIO & FICHAS (editor de pizzas e insumos)
// ================================================================
let _modalFicha = null, _modalInsumo = null;
let _fichaEditando = null;   // nome da pizza em edição (null = nova)
let _insumoEditando = null;  // {nome, base:bool}

function trocarTabCardapio(tab, el) {
  document.querySelectorAll('#cardapio-tabs .nav-link').forEach(a=>a.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('tab-fichas').classList.toggle('d-none', tab!=='fichas');
  document.getElementById('tab-insumos').classList.toggle('d-none', tab!=='insumos');
  document.getElementById('tab-massa').classList.toggle('d-none', tab!=='massa');
}

function renderCardapio() {
  renderFichasTab();
  renderInsumosTab();
  renderMassaTab();
}

const MASSA_LABEL = {TRIGO:'Trigo (farinha)', ACUCAR:'Açúcar', SAL:'Sal', FERMENTO:'Fermento', OLEO:'Óleo'};
function renderMassaTab() {
  const tbody = document.getElementById('cd-massa-tbody');
  if (!tbody) return;
  tbody.innerHTML = Object.entries(MASSA_RECEITA).map(([ing,d])=>{
    const vira = `${fmtNum(d.qtdBase,3)} ${unidadeBaseMassa(ing)}/pizza`;
    return `<tr>
      <td class="fw-semibold">${MASSA_LABEL[ing]||ing}</td>
      <td><div class="input-group input-group-sm">
        <input type="number" min="0" step="0.1" class="form-control" id="massa-${ing}" value="${d.qtdNat}">
        <span class="input-group-text">${d.un}</span></div></td>
      <td class="small text-muted">${MASSA_RECEITA_BASE[ing].embLbl}</td>
      <td class="text-end small text-muted">${vira}</td>
    </tr>`;
  }).join('');
}
// Unidade-base que o app conta para um insumo da massa (kg ou pacote/garrafa/L)
function unidadeBaseMassa(ing) {
  const u = getUnidadeIngrediente(ing);
  if (u==='KG') return 'kg';
  if (ing==='OLEO') return 'L';
  return 'pacote';
}

function salvarMassa() {
  const pers = getPers();
  pers.massa = pers.massa || {};
  for (const ing of Object.keys(MASSA_RECEITA_BASE)) {
    const v = parseFloat(String(document.getElementById('massa-'+ing).value).replace(',','.'));
    if (!isNaN(v) && v>=0) pers.massa[ing] = v; else delete pers.massa[ing];
  }
  setPers(pers);            // dispara aplicarPersonalizacoes() → reconstrói MASSA_RECEITA
  renderMassaTab();
  toast('Receita da massa salva! Vale para todas as pizzas.', 'success');
}

function voltarMassaPadrao() {
  if (!confirm('Voltar a receita da massa para os valores padrão?')) return;
  const pers = getPers();
  delete pers.massa;
  setPers(pers);
  renderMassaTab();
  toast('Receita da massa voltou ao padrão.', 'info');
}

function renderFichasTab() {
  const nomes = Object.keys(FICHA_TECNICA).sort((a,b)=>a.localeCompare(b));
  document.getElementById('cd-fichas-count').textContent = `${nomes.length} pizzas`;
  const pers = getPers();
  document.getElementById('cd-fichas-tbody').innerHTML = nomes.map(nome=>{
    const ings = Object.keys(FICHA_TECNICA[nome]._ingredientes||{});
    const custom = !!pers.fichas[nome];
    return `<tr>
      <td class="fw-semibold">${esc(nome)} ${custom?'<span class="badge bg-info text-dark ms-1" title="Editada/criada por você">editada</span>':''}</td>
      <td class="small text-muted">${esc(ings.join(', '))}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="abrirFicha('${argJS(nome)}')"><i class="fas fa-pen me-1"></i>Editar</button></td>
    </tr>`;
  }).join('');
}

function renderInsumosTab() {
  const pers = getPers();
  // Lista única na ordem da contagem
  const vistos = new Set();
  const linhas = [];
  for (const grupo of INGREDIENTES_CONTAGEM_LISTA) {
    for (const it of grupo.itens) {
      if (vistos.has(it.nome)) continue;
      vistos.add(it.nome);
      const temOv = !!pers.insumos[it.nome];
      const selo = temOv ? (ehInsumoBase(it.nome)
        ? '<span class="badge bg-warning text-dark ms-1" title="Custo/conversão ajustado por você">ajustado</span>'
        : '<span class="badge bg-info text-dark ms-1" title="Insumo criado por você">novo</span>') : '';
      linhas.push(`<tr>
        <td class="fw-semibold">${esc(it.nome)} ${selo}</td>
        <td class="small text-muted">${esc(grupo.g)}</td>
        <td>${esc(getUnidadeIngrediente(it.nome))}</td>
        <td class="text-end">${getCustoIng(it.nome)?fmtBRL(getCustoIng(it.nome)):'<span class="text-muted">—</span>'}</td>
        <td class="text-end"><button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="abrirInsumo('${argJS(it.nome)}')"><i class="fas fa-pen"></i></button></td>
      </tr>`);
    }
  }
  document.getElementById('cd-ins-count').textContent = `${vistos.size} insumos`;
  document.getElementById('cd-ins-tbody').innerHTML = linhas.join('');
}

// ---------- Editor de FICHA (pizza) ----------
function unidadeFichaIng(ing) {
  const n = normIng(ing);
  return ['OVO','CAIXA'].includes(n) ? 'un' : 'g';
}
function addLinhaFicha(ing='', qtd='') {
  const tb = document.getElementById('mf-ings');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control form-control-sm mf-ing" list="mf-ing-list" value="${ing.replace(/"/g,'&quot;')}" oninput="atualizarUnLinha(this)"></td>
    <td><input type="number" step="0.01" class="form-control form-control-sm mf-qtd" value="${qtd}"></td>
    <td><span class="mf-un badge bg-secondary">${ing?unidadeFichaIng(ing):'g'}</span></td>
    <td><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="this.closest('tr').remove()"><i class="fas fa-xmark"></i></button></td>`;
  tb.appendChild(tr);
}
function atualizarUnLinha(input) {
  const span = input.closest('tr').querySelector('.mf-un');
  if (span) span.textContent = input.value.trim() ? unidadeFichaIng(input.value) : 'g';
}
function abrirFicha(nome) {
  _fichaEditando = nome;
  // datalist de ingredientes conhecidos
  const conhecidos = new Set(TODOS_INGREDIENTES);
  for (const f of Object.values(FICHA_TECNICA)) for (const i of Object.keys(f._ingredientes||{})) conhecidos.add(i);
  document.getElementById('mf-ing-list').innerHTML = [...conhecidos].sort().map(n=>`<option value="${esc(n)}">`).join('');
  document.getElementById('mf-ings').innerHTML = '';
  if (nome && FICHA_TECNICA[nome]) {
    document.getElementById('mf-titulo').textContent = 'Editar pizza';
    document.getElementById('mf-nome').value = nome;
    document.getElementById('mf-excluir').classList.remove('d-none');
    for (const [ing,g] of Object.entries(FICHA_TECNICA[nome]._ingredientes)) addLinhaFicha(ing, g);
  } else {
    document.getElementById('mf-titulo').textContent = 'Nova pizza';
    document.getElementById('mf-nome').value = '';
    document.getElementById('mf-excluir').classList.add('d-none');
    addLinhaFicha(); addLinhaFicha();
  }
  _modalFicha = _modalFicha || bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFicha'));
  _modalFicha.show();
}
function salvarFicha() {
  const nome = nomeSeguro(document.getElementById('mf-nome').value);
  if (!nome) { toast('Dê um nome para a pizza.','error'); return; }
  const ings = {};
  let n = 0;
  for (const tr of document.querySelectorAll('#mf-ings tr')) {
    const ing = tr.querySelector('.mf-ing').value.trim().replace(/["'<>\\`]/g,'');
    const q = parseFloat(tr.querySelector('.mf-qtd').value);
    if (!ing || isNaN(q) || q<=0) continue;
    ings[ing] = q; n++;
  }
  if (!n) { toast('Adicione pelo menos um ingrediente com quantidade.','error'); return; }
  const pers = getPers();
  pers.fichas[nome] = ings;
  pers.fichasRemovidas = pers.fichasRemovidas.filter(x=>x!==nome); // se estava removida, volta
  setPers(pers);
  toast(`Pizza ${nome} salva! Vale em todos os cálculos agora.`,'success');
  _modalFicha.hide();
  renderCardapio();
}
function excluirFicha() {
  if (!_fichaEditando) return;
  if (!confirm(`Excluir a pizza "${_fichaEditando}" do cardápio?`)) return;
  const pers = getPers();
  delete pers.fichas[_fichaEditando];
  if (FICHA_BASE[_fichaEditando] && !pers.fichasRemovidas.includes(_fichaEditando))
    pers.fichasRemovidas.push(_fichaEditando);
  setPers(pers);
  toast(`Pizza ${_fichaEditando} excluída.`,'success');
  _modalFicha.hide();
  renderCardapio();
}

// ---------- Editor de INSUMO ----------
function atualizarTipoInsumo() {
  const t = document.getElementById('mi-tipo').value;
  document.getElementById('mi-caixa-campos').classList.toggle('d-none', t!=='CAIXA');
  document.getElementById('mi-fardo-campos').classList.toggle('d-none', t!=='FARDO');
}
function ehInsumoBase(nome) {
  return !!nome && ING_LISTA_BASE.some(g=>g.itens.some(i=>i.nome===nome));
}
function abrirInsumo(nome) {
  const pers = getPers();
  const ehBase = ehInsumoBase(nome);
  const temOverride = !!nome && !!pers.insumos[nome];
  _insumoEditando = nome ? {nome, base:ehBase} : null;
  // popular grupos
  const grupos = INGREDIENTES_CONTAGEM_LISTA.map(g=>g.g);
  if (!grupos.includes('Personalizados')) grupos.push('Personalizados');
  document.getElementById('mi-grupo').innerHTML = grupos.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
  const extra = document.getElementById('mi-novo-extra');
  const nomeEl = document.getElementById('mi-nome');
  const excluir = document.getElementById('mi-excluir');
  const voltar = document.getElementById('mi-voltar-padrao');
  const notaRetro = document.getElementById('mi-nota-retro');
  const grupoEl = document.getElementById('mi-grupo');

  if (!nome) {
    // NOVO insumo
    document.getElementById('mi-titulo').textContent = 'Novo insumo';
    nomeEl.value = ''; nomeEl.readOnly = false;
    document.getElementById('mi-custo').value = '';
    document.getElementById('mi-tipo').value = 'KG_DIRETO';
    document.getElementById('mi-uncx').value = 1; document.getElementById('mi-kgun').value = 1;
    document.getElementById('mi-unbase').value = 'KG'; document.getElementById('mi-unfardo').value = 6;
    grupoEl.value = 'Personalizados'; grupoEl.disabled = false;
    extra.classList.remove('d-none'); excluir.classList.add('d-none'); voltar.classList.add('d-none');
    notaRetro.classList.add('d-none');
    document.getElementById('mi-nome-hint').textContent = 'Será gravado em MAIÚSCULAS.';
    atualizarTipoInsumo();
  } else if (ehBase) {
    // INSUMO DO SISTEMA: edita custo + conversão (caixas / kg por unidade / fardo). NÃO retroativo.
    document.getElementById('mi-titulo').textContent = 'Editar insumo do sistema';
    nomeEl.value = nome; nomeEl.readOnly = true;
    document.getElementById('mi-custo').value = getCustoIng(nome) || '';
    const n = norm(nome);
    let tipo = 'SIMPLES';
    if (ITENS_KG_DIRETO.has(n)) tipo = 'KG_DIRETO';
    else if (REFRIG_LOOKUP[n]) tipo = 'FARDO';
    else if (CONVERSAO.conversao_caixa[n]) tipo = 'CAIXA';
    document.getElementById('mi-tipo').value = tipo;
    const c = CONVERSAO.conversao_caixa[n] || {};
    document.getElementById('mi-uncx').value = c.un_por_caixa ?? 1;
    document.getElementById('mi-kgun').value = c.qtd_por_un ?? 1;
    document.getElementById('mi-unbase').value = c.unidade || 'KG';
    document.getElementById('mi-unfardo').value = (REFRIG_LOOKUP[n]?.un_por_fardo) ?? 6;
    const grpAtual = (INGREDIENTES_CONTAGEM_LISTA.find(g=>g.itens.some(i=>i.nome===nome))||{}).g || 'Personalizados';
    grupoEl.value = grpAtual; grupoEl.disabled = true; // não deixa mover de grupo (evita duplicar)
    extra.classList.remove('d-none');
    excluir.classList.add('d-none');
    voltar.classList.toggle('d-none', !temOverride); // "voltar ao padrão" só se já houver ajuste
    notaRetro.classList.remove('d-none');
    document.getElementById('mi-nome-hint').textContent = 'Insumo do sistema — ajuste o custo e a conversão (caixa / kg por unidade / fardo).';
    atualizarTipoInsumo();
  } else {
    // INSUMO CRIADO POR VOCÊ: edita tudo
    const cfg = pers.insumos[nome];
    document.getElementById('mi-titulo').textContent = 'Editar insumo';
    nomeEl.value = nome; nomeEl.readOnly = true;
    document.getElementById('mi-custo').value = cfg.custo ?? '';
    document.getElementById('mi-tipo').value = cfg.tipo || 'SIMPLES';
    document.getElementById('mi-uncx').value = cfg.un_por_caixa ?? 1;
    document.getElementById('mi-kgun').value = cfg.qtd_por_un ?? 1;
    document.getElementById('mi-unbase').value = cfg.unidade || 'KG';
    document.getElementById('mi-unfardo').value = cfg.un_por_fardo ?? 6;
    grupoEl.value = cfg.grupo || 'Personalizados'; grupoEl.disabled = false;
    extra.classList.remove('d-none'); excluir.classList.remove('d-none'); voltar.classList.add('d-none');
    notaRetro.classList.add('d-none');
    document.getElementById('mi-nome-hint').textContent = 'Insumo criado por você.';
    atualizarTipoInsumo();
  }
  _modalInsumo = _modalInsumo || bootstrap.Modal.getOrCreateInstance(document.getElementById('modalInsumo'));
  _modalInsumo.show();
}
function montarCfgInsumo(custoVal) {
  const tipo = document.getElementById('mi-tipo').value;
  const cfg = { grupo: document.getElementById('mi-grupo').value, tipo };
  if (custoVal!=='') cfg.custo = parseFloat(custoVal)||0; // sem custo = mantém o do sistema
  if (tipo==='CAIXA') {
    cfg.un_por_caixa = parseFloat(document.getElementById('mi-uncx').value)||1;
    cfg.qtd_por_un = parseFloat(document.getElementById('mi-kgun').value)||1;
    cfg.unidade = document.getElementById('mi-unbase').value;
  } else if (tipo==='FARDO') {
    cfg.un_por_fardo = parseFloat(document.getElementById('mi-unfardo').value)||1;
  }
  return cfg;
}
function voltarPadraoInsumo() {
  if (!_insumoEditando) return;
  const nome = _insumoEditando.nome;
  if (!confirm(`Voltar "${nome}" ao padrão do sistema? Seu ajuste de custo e de conversão será removido (não afeta o que já está salvo).`)) return;
  const pers = getPers();
  delete pers.insumos[nome];
  delete pers.custos[normIng(nome)];
  setPers(pers);
  toast(`${nome} voltou ao padrão do sistema.`,'success');
  _modalInsumo.hide(); renderCardapio();
}
function salvarInsumo() {
  const pers = getPers();
  const custoVal = document.getElementById('mi-custo').value;
  if (_insumoEditando && _insumoEditando.base) {
    // Insumo do sistema: salva custo + conversão como AJUSTE (overlay). Vale só daqui pra frente.
    const nome = _insumoEditando.nome;
    pers.insumos[nome] = montarCfgInsumo(custoVal);
    delete pers.custos[normIng(nome)]; // o cfg.custo já cuida do custo (evita duplicar)
    setPers(pers);
    toast(`${nome} ajustado — vale para as próximas contagens e compras.`,'success');
    _modalInsumo.hide(); renderCardapio(); return;
  }
  // Novo ou custom
  const nome = nomeSeguro(document.getElementById('mi-nome').value);
  if (!nome) { toast('Dê um nome ao insumo.','error'); return; }
  const tipo = document.getElementById('mi-tipo').value;
  const cfg = {
    grupo: document.getElementById('mi-grupo').value,
    custo: custoVal===''?0:parseFloat(custoVal)||0,
    tipo
  };
  if (tipo==='CAIXA') {
    cfg.un_por_caixa = parseFloat(document.getElementById('mi-uncx').value)||1;
    cfg.qtd_por_un = parseFloat(document.getElementById('mi-kgun').value)||1;
    cfg.unidade = document.getElementById('mi-unbase').value;
  } else if (tipo==='FARDO') {
    cfg.un_por_fardo = parseFloat(document.getElementById('mi-unfardo').value)||1;
  }
  pers.insumos[nome] = cfg;
  setPers(pers);
  toast(`Insumo ${nome} salvo!`,'success');
  _modalInsumo.hide(); renderCardapio();
}
function excluirInsumo() {
  if (!_insumoEditando || _insumoEditando.base) return;
  const nome = _insumoEditando.nome;
  if (!confirm(`Excluir o insumo "${nome}"?`)) return;
  const pers = getPers();
  delete pers.insumos[nome];
  delete pers.custos[normIng(nome)];
  setPers(pers);
  toast(`Insumo ${nome} excluído.`,'success');
  _modalInsumo.hide(); renderCardapio();
}

// ================================================================
// 13B. IMPORTAR HISTÓRICO (planilha HISTORICO_ESTOQUE_PIZZA_PARA_VOCE.xlsx)
// ================================================================
// O histórico foi gerado por outro sistema e tem uma particularidade: itens
// que o app controla em KG (catupiry, molho, cheddar, lombo...) foram contados
// em CAIXAS/BALDES (coluna Unidade = UN) até maio, e só em junho passaram a KG.
// Na importação convertemos esses "UN" para KG com os mesmos fatores do app,
// deixando tudo consistente para o cálculo de divergências.
const HIST_NOME_CONTAGEM = { 'COCA NORMAL':'COCA NORMAL 2L', 'COCA ZERO':'COCA ZERO 2L' };
let _histParsed = null;

function histNum(v) { return typeof v==='number' ? v : parseNumFlex(v); }
function normLojaHist(s) {
  const n = norm(s).replace(/\s+/g,'_');
  if (n.includes('BURITIS')) return 'BURITIS';
  if (n.includes('PLANALTO')) return 'PLANALTO';
  if (n.includes('VENDA')) return 'VENDA_NOVA';
  return null;
}
function histRows(wb, nome) {
  const ws = wb.Sheets[nome];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:''});
}
function histHeader(rows, primeiraCol) {
  const alvo = primeiraCol.toLowerCase();
  for (let i=0;i<Math.min(rows.length,15);i++) {
    if (String(rows[i][0]||'').trim().toLowerCase() === alvo) return i;
  }
  return -1;
}

async function lerHistorico(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    _histParsed = parseHistorico(wb);
    await renderHistPreview(_histParsed);
  } catch(e) {
    toast('Erro ao ler a planilha: '+e.message, 'error');
    console.error(e);
  }
  input.value = '';
}

function parseHistorico(wb) {
  // ---- COMPRAS: Data | Loja | Insumo | Qtd | Valor R$ | Fornecedor ----
  const compras = [];
  const rCp = histRows(wb, 'Compras');
  if (rCp) {
    const h = histHeader(rCp, 'Data');
    if (h>=0) for (let i=h+1;i<rCp.length;i++) {
      const row = rCp[i];
      const data = parseDataFlex(row[0]); if (!data) continue;
      const loja = normLojaHist(row[1]); if (!loja) continue;
      const ing = String(row[2]||'').trim(); if (!ing) continue;
      const qtd = histNum(row[3]);
      const un = getUnidadeIngrediente(ing);
      compras.push({loja, data, ingrediente:ing, quantidade:qtd, unidade:un,
        quantidade_base:qtd, unidade_base:un, fornecedor:String(row[5]||'').trim(),
        valor_total:histNum(row[4]), origem:'historico'});
    }
  }
  // ---- CONTAGENS: Data | Loja | Insumo | Unidade | Saldo (agrupa por loja+data) ----
  const ctMap = {};
  let convertidos = 0;
  const rCt = histRows(wb, 'Contagens');
  if (rCt) {
    const h = histHeader(rCt, 'Data');
    if (h>=0) for (let i=h+1;i<rCt.length;i++) {
      const row = rCt[i];
      const data = parseDataFlex(row[0]); if (!data) continue;
      const loja = normLojaHist(row[1]); if (!loja) continue;
      let ing = String(row[2]||'').trim(); if (!ing) continue;
      const unHist = String(row[3]||'').trim().toUpperCase();
      const saldo = histNum(row[4]);
      ing = HIST_NOME_CONTAGEM[ing] || ing;
      const appUn = getUnidadeIngrediente(ing);
      let total, unidade;
      if (appUn==='KG' && unHist && unHist!=='KG') {
        const r = converterContagem(ing, 0, saldo);  // conta como "unidades soltas" → KG
        total = r.total; unidade = r.unidade; convertidos++;
      } else {
        total = saldo; unidade = appUn;
      }
      const key = loja+'|'+data;
      if (!ctMap[key]) ctMap[key] = {loja, data, ingredientes:{}, origem:'historico'};
      ctMap[key].ingredientes[ing] = {caixas:0, unidades:0, total, unidade};
    }
  }
  const contagens = Object.values(ctMap);
  // ---- VENDAS: Periodo_Inicio | Periodo_Fim | Loja | Categoria | Codigo | Produto | Qtd | Valor | Subtotal ----
  const vMap = {};
  const rVd = histRows(wb, 'Vendas');
  if (rVd) {
    const h = histHeader(rVd, 'Periodo_Inicio');
    if (h>=0) for (let i=h+1;i<rVd.length;i++) {
      const row = rVd[i];
      const ini = parseDataFlex(row[0]), fim = parseDataFlex(row[1]);
      if (!ini || !fim) continue;
      const loja = normLojaHist(row[2]); if (!loja) continue;
      const codigo = String(row[4]||'').trim(); if (!codigo) continue;
      const produto = String(row[5]||'').trim();
      const qtde = histNum(row[6]);
      const item = {codigo, produto, qtde, valor:histNum(row[7])};
      const key = loja+'|'+ini+'|'+fim;
      if (!vMap[key]) vMap[key] = {loja, data_inicio:ini, data_fim:fim, itens:[], unmapped:[], filename:'HISTORICO', origem:'historico'};
      vMap[key].itens.push(item);
      if (!lookupMapeamento(codigo)) vMap[key].unmapped.push({codigo, produto, qtde});
    }
  }
  const vendas = Object.values(vMap);
  return {compras, contagens, vendas, convertidos};
}

function _cpKey(c){ return c.loja+'|'+c.data+'|'+norm(c.ingrediente)+'|'+(c.valor_total||0)+'|'+(c.quantidade_base||0); }

async function renderHistPreview(p) {
  const [contEx, vendEx, compEx] = await Promise.all([DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras')]);
  const ctDup = new Set(contEx.map(c=>c.loja+'|'+c.data));
  const vDup = new Set(vendEx.map(v=>v.loja+'|'+v.data_inicio+'|'+v.data_fim));
  const cpDup = new Set(compEx.map(_cpKey));
  const incluirVendas = document.getElementById('hist-incluir-vendas').checked;
  const cpNew = p.compras.filter(c=>!cpDup.has(_cpKey(c))).length;
  const ctNew = p.contagens.filter(c=>!ctDup.has(c.loja+'|'+c.data)).length;
  const vNew = incluirVendas ? p.vendas.filter(v=>!vDup.has(v.loja+'|'+v.data_inicio+'|'+v.data_fim)).length : 0;
  const box = document.getElementById('hist-preview');
  box.classList.remove('d-none');
  if (!cpNew && !ctNew && !vNew) {
    box.innerHTML = `<div class="alert alert-secondary mb-0">Nada novo para importar com as opções atuais.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="alert alert-info mb-0">
      <div class="fw-bold mb-2"><i class="fas fa-magnifying-glass me-1"></i>O que será importado (períodos repetidos são ignorados):</div>
      <ul class="mb-2">
        <li><strong>${cpNew}</strong> compras novas <span class="text-muted">(${p.compras.length} na planilha)</span></li>
        <li><strong>${ctNew}</strong> contagens novas <span class="text-muted">(${p.contagens.length} na planilha; ${p.convertidos} itens convertidos de caixa/un → KG)</span></li>
        <li>${incluirVendas ? `<strong>${vNew}</strong> períodos de venda novos <span class="text-muted">(${p.vendas.length} na planilha)</span>` : '<span class="text-muted">vendas: não serão importadas (caixa desmarcada)</span>'}</li>
      </ul>
      <button class="btn btn-success" onclick="confirmarHistorico()"><i class="fas fa-check me-1"></i>Importar agora</button>
      <button class="btn btn-outline-secondary" onclick="document.getElementById('hist-preview').classList.add('d-none')">Cancelar</button>
    </div>`;
}

// Grava uma lista INTEIRA de uma vez. Em modo nuvem vira uma requisição por lote de 500; o
// laço só roda no modo LOCAL (IndexedDB), onde não existe addLote e não há rede envolvida.
// Regra que isto materializa: nunca deixar um `await` de REDE dentro de laço. Uma importação
// de 180 registros virava ~360 requisições sequenciais e nunca terminava no celular — e como
// o arquivo vinha agrupado, morriam sempre as MESMAS lojas (bug de 30/07/2026).
async function _gravarLote(store, linhas) {
  if (!linhas.length) return 0;
  if (DB.addLote) await DB.addLote(store, linhas);
  else for (const l of linhas) await DB.add(store, l);
  return linhas.length;
}

async function confirmarHistorico() {
  return travarGravacao('historico', _confirmarHistoricoImpl, '[onclick*="confirmarHistorico"]');
}

async function _confirmarHistoricoImpl() {
  if (!_histParsed) return;
  const p = _histParsed;
  const [contEx, vendEx, compEx] = await Promise.all([DB.getAll('contagens'), DB.getAll('vendas'), DB.getAll('compras')]);
  const ctDup = new Set(contEx.map(c=>c.loja+'|'+c.data));
  const vDup = new Set(vendEx.map(v=>v.loja+'|'+v.data_inicio+'|'+v.data_fim));
  const cpDup = new Set(compEx.map(_cpKey));
  const incluirVendas = document.getElementById('hist-incluir-vendas').checked;
  const agora = new Date().toISOString();

  // Separa o que entra (aplicando a dedup) e SÓ DEPOIS grava, em lote.
  const novasCompras = [], novasContagens = [], novasVendas = [];
  for (const c of p.compras) { const k=_cpKey(c); if (cpDup.has(k)) continue; cpDup.add(k); novasCompras.push({...c, created_at:agora}); }
  for (const c of p.contagens) { const k=c.loja+'|'+c.data; if (ctDup.has(k)) continue; ctDup.add(k); novasContagens.push({...c, created_at:agora}); }
  if (incluirVendas) for (const v of p.vendas) { const k=v.loja+'|'+v.data_inicio+'|'+v.data_fim; if (vDup.has(k)) continue; vDup.add(k); novasVendas.push({...v, created_at:agora}); }

  const np = await _gravarLote('compras', novasCompras);
  const nc = await _gravarLote('contagens', novasContagens);
  const nv = await _gravarLote('vendas', novasVendas);

  toast(`Histórico importado: ${np} compras, ${nc} contagens${incluirVendas?`, ${nv} períodos de venda`:''}.`, 'success');
  _histParsed = null;
  document.getElementById('hist-preview').classList.add('d-none');
  renderBackupStats();
}

async function removerHistorico() {
  return travarGravacao('historico', _removerHistoricoImpl, '[onclick*="removerHistorico"]');
}

async function _removerHistoricoImpl() {
  if (!confirm('Remover TODOS os registros que foram importados do histórico?\n\nOs dados que você lançou manualmente (origem normal) NÃO são afetados.')) return;
  let n = 0;
  for (const store of ['compras','contagens','vendas']) {
    // Um `delete` por linha eram N idas à rede; deleteMuitos existe nos DOIS modos (nuvem em
    // lotes de 200, local numa transação só), então aqui o lote é sempre o caminho usado.
    const ids = (await DB.getAll(store)).filter(r => r.origem === 'historico').map(r => r.id);
    if (!ids.length) continue;
    if (DB.deleteMuitos) await DB.deleteMuitos(store, ids);
    else for (const id of ids) await DB.delete(store, id);
    n += ids.length;
  }
  toast(`${n} registros importados do histórico foram removidos.`, 'success');
  renderBackupStats();
}

// ================================================================
// 13C. DIAGNÓSTICO / AUTOTESTE (não toca nos dados — só funções de cálculo)
// ================================================================
// Testa as funções PURAS que sustentam todos os números financeiros (conversão,
// contagem de pizzas, consumo da ficha+massa+caixa, custo a preço pago). Tudo com
// entradas de teste em memória — NÃO lê nem grava nos stores do Gabriel. As asserções
// são robustas: leem a gramatura/custo atuais em runtime, então editar uma ficha não
// quebra o teste; o que o teste pega é a LÓGICA de cálculo regredir.
function _aprox(a, b, tol=1e-6) { return Math.abs((a||0)-(b||0)) <= tol; }

// Insumos usados (ficha/massa/caixa/adicional/contagem) SEM custo-base cadastrado.
// Bebidas ficam de fora (são revenda). Devolve [{ing, usos:[...], temCompra}]. `temCompra`
// false = não tem custo-base NEM compra → entra como R$ 0 silencioso. SÍNCRONA (recebe compras).
function insumosSemCusto(compras) {
  const usos = {};   // normIng -> Set(onde é usado)
  const add = (nome, uso) => { const n = normIng(nome); if (n) (usos[n] = usos[n] || new Set()).add(uso); };
  for (const f of Object.values(FICHA_TECNICA)) for (const ing of Object.keys(f._ingredientes||{})) add(ing,'ficha');
  for (const ing of Object.keys(MASSA_RECEITA)) add(ing,'massa');
  add('CAIXA DE PIZZA','caixa'); add('CAIXA PREMIUM','caixa');
  for (const mp of [MAPEAMENTO_TOTEM, MAPEAMENTO_TOTEM_SKU, getMapCustom()])
    for (const m of Object.values(mp||{})) if (m && m.categoria==='ADICIONAL' && m.adicional_ingrediente) add(m.adicional_ingrediente,'adicional');
  for (const nome of TODOS_INGREDIENTES) add(nome,'contagem');
  const temCompra = new Set((compras||[]).filter(c=>c.quantidade_base>0 && c.valor_total>0).map(c=>normIng(c.ingrediente)));
  const out = [];
  for (const [n, set] of Object.entries(usos)) {
    if (ehBebida(n)) continue;          // bebida é revenda → fora do CMV
    if (getCustoIng(n) > 0) continue;   // já tem custo-base
    out.push({ ing:n, usos:[...set], temCompra: temCompra.has(n) });
  }
  out.sort((a,b)=> (a.temCompra - b.temCompra) || a.ing.localeCompare(b.ing));
  return out;
}

// Marca em vermelho os insumos sem custo nem compra (R$ 0 silencioso).
async function renderDiagnosticoCusto() {
  const host = document.getElementById('diag-custo');
  if (!host) return;
  host.innerHTML = '<span class="text-muted">Analisando…</span>';
  let compras = [];
  try { compras = await DB.getAll('compras'); } catch(e){}
  const faltando = insumosSemCusto(compras);

  if (!faltando.length) {
    host.innerHTML = '<div class="alert alert-success py-2 mb-0">Todos os insumos usados têm custo cadastrado. ✔</div>';
    return;
  }
  const semCompra = faltando.filter(f=>!f.temCompra).length;
  let html = `<div class="alert alert-warning py-2">${faltando.length} insumo(s) sem custo-base. ` +
    (semCompra ? `<strong>${semCompra} sem nenhuma compra também</strong> → entram como R$ 0 nos cálculos (subestimam o estoque e zeram o impacto de perda deles).`
               : 'Todos têm compra, então o custo vem do preço pago — mas cadastrar o custo-base deixa mais firme.') + '</div>';
  html += '<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead class="table-light"><tr><th>Insumo</th><th>Unid.</th><th>Onde é usado</th><th>Situação</th></tr></thead><tbody>';
  for (const f of faltando) {
    const grave = !f.temCompra;
    html += `<tr class="${grave?'table-danger':''}"><td>${esc(f.ing)}</td><td class="text-muted">${esc(getUnidadeIngrediente(f.ing))}</td>` +
      `<td class="small text-muted">${f.usos.map(esc).join(', ')}</td>` +
      `<td>${grave?'<span class="text-danger fw-bold">R$ 0 silencioso</span>':'<span class="text-warning">usa preço de compra</span>'}</td></tr>`;
  }
  html += '</tbody></table></div>';
  host.innerHTML = html;
}

async function rodarAutoteste() {
  const T = [];
  const ok = (nome, cond, detalhe='') => T.push({nome, pass: !!cond, detalhe});
  try {
    // 1. Normalização
    ok('norm() tira acento e deixa maiúsculo', norm('Mussárela')==='MUSSARELA');
    ok('normIng() aplica alias (Milho verde → MILHO)', normIng('Milho verde')==='MILHO');

    // 2. Bebida × insumo (bebidas ficam fora de CMV/desperdício)
    const algumaBeb = Object.keys(REFRIG_LOOKUP)[0];
    if (algumaBeb) ok('ehBebida() reconhece refrigerante', ehBebida(algumaBeb)===true, algumaBeb);
    ok('ehBebida() NÃO marca mussarela como bebida', ehBebida('MUSSARELA')===false);

    // 3. Conversão de contagem (caixas/unidades → unidade-base)
    const kgItem = [...ITENS_KG_DIRETO][0];
    if (kgItem) {
      const r = converterContagem(kgItem, 2, 3);
      ok('converterContagem() KG direto: 2 + 3 = 5 kg', _aprox(r.total,5) && r.unidade==='KG', kgItem+' → '+r.total+' '+r.unidade);
    }
    if (algumaBeb) {
      const f = REFRIG_LOOKUP[algumaBeb].un_por_fardo||1;
      const r = converterContagem(algumaBeb, 1, 0);
      ok('converterContagem() refrigerante: 1 fardo = '+f+' un', _aprox(r.total, f), algumaBeb+' → '+r.total);
    }
    const cxNome = Object.keys(CONVERSAO.conversao_caixa)[0];
    if (cxNome) {
      const c = CONVERSAO.conversao_caixa[cxNome];
      const esp = 1*c.un_por_caixa*c.qtd_por_un;
      const r = converterContagem(cxNome, 1, 0);
      ok('converterContagem() caixa ('+cxNome+'): 1 caixa = '+esp+' '+c.unidade, _aprox(r.total, esp), 'deu '+r.total);
    }

    // 4. Contagem de pizzas (regra do Gabriel: duas meias = uma inteira; combos não contam)
    let skuInt=null, skuMeia=null, skuAgrup=null;
    for (const [sku,m] of Object.entries(MAPEAMENTO_TOTEM_SKU)) {
      if (!skuInt && m.categoria==='INTEIRA') skuInt=sku;
      if (!skuMeia && m.categoria==='MEIA') skuMeia=sku;
      if (!skuAgrup && (m.categoria==='AGRUPADOR'||m.ignorar_no_consumo)) skuAgrup=sku;
    }
    if (skuInt) ok('contarPizzas() 4 inteiras = 4', _aprox(contarPizzas([{sku:skuInt,qtde:4}]),4));
    if (skuMeia) ok('contarPizzas() 4 meias = 2 (duas meias = uma inteira)', _aprox(contarPizzas([{sku:skuMeia,qtde:4}]),2));
    if (skuAgrup) ok('contarPizzas() ignora combo/agrupador', _aprox(contarPizzas([{sku:skuAgrup,qtde:9}]),0));

    // 5. Engine de consumo: vender N inteiras de um sabor com mussarela
    let skuMussa=null, gMussa=0;
    for (const [sku,m] of Object.entries(MAPEAMENTO_TOTEM_SKU)) {
      if (m.categoria==='INTEIRA' && m.nome_ficha && FICHA_TECNICA[m.nome_ficha]) {
        const ing = FICHA_TECNICA[m.nome_ficha]._ingredientes;
        const k = Object.keys(ing).find(x=>normIng(x)==='MUSSARELA');
        if (k) { skuMussa=sku; gMussa=ing[k]; break; }
      }
    }
    if (skuMussa) {
      const N = 10;
      const cons = calcConsumoPeriodo([{itens:[{sku:skuMussa,qtde:N}]}]);
      ok('calcConsumoPeriodo() mussarela = '+N+' × '+gMussa+' g', _aprox(cons['MUSSARELA'], N*gMussa/1000), 'deu '+(cons['MUSSARELA']||0).toFixed(3)+' kg');
      const trigoPP = (MASSA_RECEITA['TRIGO']||{}).qtdBase || 0;
      if (trigoPP>0) ok('calcConsumoPeriodo() massa: trigo = '+N+' × '+trigoPP, _aprox(cons['TRIGO'], N*trigoPP), 'deu '+(cons['TRIGO']||0).toFixed(3));
      ok('calcConsumoPeriodo() embalagem: 1 caixa por pizza = '+N, _aprox(cons['CAIXA DE PIZZA'], N), 'deu '+(cons['CAIXA DE PIZZA']||0));
    }

    // 6. Custo a preço PAGO (média ponderada das compras)
    const compras = [
      {ingrediente:'MUSSARELA', loja:'BURITIS', data:'2026-06-01', valor_total:300, quantidade_base:10},
      {ingrediente:'MUSSARELA', loja:'BURITIS', data:'2026-06-03', valor_total:340, quantidade_base:10}
    ];
    const cp = custoPagoIng('MUSSARELA','2026-06-01','2026-06-05',compras,'BURITIS');
    ok('custoPagoIng() média ponderada (300+340)/(10+10) = 32', _aprox(cp,32), 'deu '+cp.toFixed(2));
    const cpFora = custoPagoIng('MUSSARELA','2026-07-01','2026-07-31',compras,'BURITIS');
    ok('custoPagoIng() fora do período usa a compra mais próxima (34)', _aprox(cpFora,34), 'deu '+cpFora.toFixed(2));
    const cpSem = custoPagoIng('MUSSARELA','2026-06-01','2026-06-05',[],'BURITIS');
    ok('custoPagoIng() sem compras cai no preço-base', _aprox(cpSem, getCustoIng('MUSSARELA')), 'base = '+getCustoIng('MUSSARELA'));

    // 7. MOTOR calcDivergencias — caso dourado com dados INJETADOS (loja fictícia; NÃO toca no banco).
    // Cenário: mussarela 50kg inicial + 10kg compra − 5kg transferência − 20kg final = consumo real 35kg.
    // Catupiry conta MAIS no final do que entrou = furo (consumo negativo) → tem que ser flagrado e
    // bloquear o fechamento no cmvCeoInventario (regra da auditoria 02/07).
    if (skuMussa) {
      const itensVenda = [{sku:skuMussa, qtde:100}];
      const dados = {
        contagens: [
          {loja:'TESTE', data:'2026-06-01', ingredientes:{ MUSSARELA:{total:50, unidade:'KG'}, CATUPIRY:{total:5, unidade:'KG'} }},
          {loja:'TESTE', data:'2026-06-08', ingredientes:{ MUSSARELA:{total:20, unidade:'KG'}, CATUPIRY:{total:10, unidade:'KG'} }}
        ],
        vendas: [{loja:'TESTE', data_inicio:'2026-06-01', data_fim:'2026-06-07', itens:itensVenda}],
        compras: [{loja:'TESTE', data:'2026-06-03', ingrediente:'MUSSARELA', quantidade_base:10, unidade_base:'KG', valor_total:320}],
        transferencias: [{loja_origem:'TESTE', loja_destino:'BURITIS', data:'2026-06-04', ingrediente:'MUSSARELA', quantidade:5}]
      };
      const d = await calcDivergencias('TESTE','2026-06-01','2026-06-08', dados);
      ok('motor: janela respeita o momento (01/06 → 07/06)', d.janIni==='2026-06-01' && d.janFim==='2026-06-07', d.janIni+' → '+d.janFim);
      const rM = d.resultado.find(r=>r.ing==='MUSSARELA');
      ok('motor: consumo real mussarela = 50+10−5−20 = 35 kg', rM && _aprox(rM.consumoReal,35), 'deu '+(rM?rM.consumoReal:'linha ausente'));
      const espM = calcConsumoPeriodo([{itens:itensVenda}])['MUSSARELA']||0;
      ok('motor: consumo esperado = ficha × vendas ('+espM.toFixed(1)+' kg)', rM && _aprox(rM.esperado, espM), 'deu '+(rM?rM.esperado.toFixed(3):'—'));
      ok('motor: custo = preço pago da janela (320/10 = 32)', rM && _aprox(rM.custo,32), 'deu '+(rM?rM.custo:'—'));
      ok('motor: impacto R$ = divergência × custo pago', rM && _aprox(rM.impacto,(35-espM)*32), 'deu '+(rM?rM.impacto.toFixed(2):'—'));
      const rC = d.resultado.find(r=>r.ing==='CATUPIRY');
      ok('motor: furo flagrado (catupiry 5→10 sem compra = consumo −5)', rC && rC.impossivel===true && _aprox(rC.consumoReal,-5), 'deu '+(rC?rC.consumoReal:'—'));
      const cmv = await cmvCeoInventario(['TESTE'],'2026-06-01','2026-06-08', dados);
      ok('cmvCeoInventario: furo BLOQUEIA o fechamento', cmv.status==='bloqueado' && cmv.furos===1, 'status='+cmv.status+' furos='+cmv.furos);
      ok('cmvCeoInventario: furo fica FORA do CMV real', _aprox(cmv.real, 35*32), 'real='+cmv.real.toFixed(2)+' (só mussarela + linhas de ficha sem estoque)');
    }

  } catch(e) {
    ok('ERRO inesperado ao rodar os testes', false, String(e && e.message || e));
  }

  const passN = T.filter(t=>t.pass).length;
  const falhou = T.length - passN;
  const cor = falhou ? 'danger' : 'success';
  let html = `<div class="alert alert-${cor} py-2"><strong>${passN}/${T.length} testes passaram.</strong> ${falhou ? '⚠ '+falhou+' falharam — confira antes de confiar nos números.' : 'Tudo certo ✔'}</div>`;
  html += '<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead class="table-light"><tr><th style="width:34px"></th><th>Teste</th><th>Detalhe</th></tr></thead><tbody>';
  for (const t of T) {
    html += `<tr class="${t.pass?'':'table-danger'}"><td>${t.pass?'<span class="text-success">✔</span>':'<span class="text-danger fw-bold">✘</span>'}</td><td>${esc(t.nome)}</td><td class="text-muted small">${esc(t.detalhe)}</td></tr>`;
  }
  html += '</tbody></table></div>';
  document.getElementById('diag-result').innerHTML = html;
}

// ================================================================
// 14. INICIALIZAÇÃO E PROTEÇÕES GLOBAIS
// ================================================================

// Qualquer erro inesperado vira um aviso visível (em vez de falhar em silêncio)
let _ultimoErroMsg = '';
function avisarErro(msg) {
  if (!msg || msg === _ultimoErroMsg) return;
  _ultimoErroMsg = msg;
  try { toast('Algo deu errado: '+esc(msg)+'<br><small>Se algo parar de responder, recarregue a página (F5). Seus dados continuam salvos.</small>','error'); } catch(_) {}
}
window.addEventListener('error', e => { console.error(e.error||e); avisarErro(e.message); });
window.addEventListener('unhandledrejection', e => { console.error(e.reason); avisarErro(e.reason?.message || String(e.reason||'')); });

// Avisa antes de fechar/atualizar a aba com trabalho não salvo
window.addEventListener('beforeunload', e => {
  let pendente = !!(_vendasParsed || _importCompras || _histParsed);
  if (!pendente && currentPage === 'contagem') {
    pendente = [...document.querySelectorAll('#ct-tbody input')].some(i => parseFloat(i.value) > 0);
  }
  if (pendente) { e.preventDefault(); e.returnValue = ''; }
});

// Tema global dos gráficos (Chart.js): tipografia, gridlines suaves e tooltips da marca.
// NÃO mexe nas cores dos dados (identidade por loja é mantida). Guardado: nunca quebra o app.
function temGraficos() {
  if (!window.Chart) return;
  try {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = '#5a6472';
    if (Chart.defaults.scale && Chart.defaults.scale.grid) Chart.defaults.scale.grid.color = 'rgba(0,0,0,.05)';
    const tt = Chart.defaults.plugins.tooltip;
    tt.backgroundColor = 'rgba(31,44,66,.95)'; tt.padding = 10; tt.cornerRadius = 6;
    tt.titleColor = '#fff'; tt.bodyColor = '#e8ebf0';
    const lg = Chart.defaults.plugins.legend.labels;
    lg.usePointStyle = true; lg.boxWidth = 8; lg.padding = 12;
  } catch(e) {}
}

async function init() {
  await openDB();
  await openCfgDB(); // configurações (pasta de backups) — se falhar, segue sem

  // Gráficos com a voz da marca (uma vez só): Inter, tinta, grade cor de crosta, roscas com
  // borda cor de massa — em vez do visual default do Chart.js.
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = "'Inter','Segoe UI',sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#6B7280';
    Chart.defaults.borderColor = 'rgba(228,216,192,.55)';
    Chart.defaults.elements.arc.borderColor = '#FBF5E9';
    Chart.defaults.elements.arc.borderWidth = 2;
    Chart.defaults.plugins.tooltip.backgroundColor = '#26334D';
    Chart.defaults.plugins.tooltip.titleFont = {family:"'Inter',sans-serif", weight:'600'};
    Chart.defaults.plugins.tooltip.cornerRadius = 6;
    // MODO LEVE no celular/Netlify (pedido do Gabriel: telas travando no iPhone): sem animação de
    // gráfico e canvas em resolução 1.5x no máximo (iPhone 3x torra CPU desenhando o triplo de pixels).
    if (modoLeveCelular()) {
      Chart.defaults.animation = false;
      Chart.defaults.transitions.active.animation.duration = 0;
      Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio||1, 1.5);
    }
  }

  // Blindagem dos dados (não bloqueia a abertura do app):
  garantirPersistencia();   // pede ao navegador para NÃO apagar o banco sozinho
  autoBackupSeNecessario(); // grava um backup automático do dia, se houver pasta liberada

  // Sem internet os CDNs (Bootstrap/Chart.js/SheetJS) não carregam — avisa em vez de falhar em silêncio
  const faltando = [];
  if (typeof bootstrap === 'undefined') faltando.push('Bootstrap (janelas e botões)');
  if (typeof Chart === 'undefined') faltando.push('Chart.js (gráficos)');
  if (typeof XLSX === 'undefined') faltando.push('SheetJS (importar/exportar Excel)');
  if (faltando.length) {
    const div = document.createElement('div');
    div.className = 'alert alert-danger mb-3';
    div.innerHTML = `<strong><i class="fas fa-wifi me-1"></i>Sem internet?</strong> Não consegui carregar: ${faltando.join(', ')}.
      A interface precisa de internet para carregar — conecte e aperte F5. <u>Seus dados continuam salvos neste navegador.</u>`;
    document.getElementById('main').prepend(div);
  }

  temGraficos();  // tema visual dos gráficos (só estética; cores dos dados intactas)

  // Aplicar personalizações de cardápio/insumos salvas pelo usuário
  aplicarPersonalizacoes();

  // Restaurar loja salva (sincroniza todos os seletores)
  syncLojaSelectors();
  atualizarTopbarLoja();
  aplicarAvisosTotem();   // avisos de "sem dados do TOTEM" já sabendo se há nuvem

  // Alguns seletores de loja NÃO passam por lojaPaginaChange (dash-loja, cf-loja, pcat-loja,
  // cn-loja — eles têm "Todas" como padrão de propósito e não devem virar a loja ativa do app).
  // Um ouvinte só, delegado, mantém o banner honesto quando qualquer um deles muda.
  const IDS_BANNER = new Set(Object.values(LOJA_SELECT_PAGINA));
  document.addEventListener('change', ev => {
    if (ev.target && IDS_BANNER.has(ev.target.id)) atualizarLojaBanner();
  });

  // Atualização automática via API do TOTEM (vendas_totem.json). Em file:// é no-op.
  await atualizarDoTotem();

  // Migra (uma vez) mapeamentos manuais antigos de id→sku, agora que item-com-sku resolve só por sku.
  await migrarCustomParaSku();

  showPage(_paginaInicial);   // dono abre no Dashboard; papel restrito, na 1ª tela permitida
}

// BOOT DO SaaS: com a nuvem configurada (js/config-nuvem.js), exige login e troca a camada de
// dados para o Supabase ANTES do init. Sem configuração, roda em modo local — idêntico ao original.
async function bootApp() {
  const chip = document.getElementById('nuvem-status');
  if (window.Nuvem && Nuvem.configurada()) {
    // Chegou pelo link "definir nova senha" do e-mail? Mostra o campo da senha nova e PARA aqui —
    // sem isto, o token de recuperação só logava a pessoa e ela nunca trocava a senha (bug 07/08).
    if (Nuvem.recuperacaoNaURL && Nuvem.recuperacaoNaURL()) { await Nuvem.telaTrocarSenha(); return; }
    await Nuvem.entrar();                       // mostra a tela de login se não houver sessão
    DB = Nuvem.DB;                             // dados passam a morar no Postgres (RLS por empresa)
    aplicarPermissoes(Nuvem.papel());          // esconde o que o papel não abre (o RLS é quem barra)
    // ANTES dos overlays e do init: quais lojas esta empresa tem, como se chamam e de que cor
    // são. Todo o resto do app já lê LOJA_LABEL/LOJAS_ATIVAS() — aqui é onde eles nascem.
    await aplicarCadastroLojas();
    garantirLojaValida();
    await Nuvem.puxarOverlays();               // configurações (fichas, custos, correções) descem da nuvem
    Nuvem.observarOverlays();                  // e qualquer mudança local sobe sozinha (debounce)
    atualizarChipNuvem();
    const sair = document.getElementById('nav-sair'); if (sair) sair.style.display = '';
  } else if (chip) {
    chip.innerHTML = '<span class="badge text-bg-secondary"><i class="fas fa-laptop me-1"></i>Demonstração</span> dados fictícios';
  }
  await init();
}

bootApp().catch(err => {
  document.body.innerHTML = `<div class="container mt-5 text-center">
    <i class="fas fa-exclamation-triangle fa-3x text-danger mb-3"></i>
    <h4>Erro ao iniciar o aplicativo</h4>
    <p class="text-muted">${err.message}</p>
    <p class="small">Se a mensagem falar em nuvem/empresa, confira o PASSO-A-PASSO.md (configuração do Supabase).<br>
    Senão, certifique-se de abrir em um navegador moderno (Chrome, Edge ou Firefox).</p>
  </div>`;
});
