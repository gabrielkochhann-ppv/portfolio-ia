/* ============================================================================
   CAMADA DE NUVEM DO SaaS — adaptador Supabase (auth + dados + overlays).

   Contrato com o app (index.html):
   • Nuvem.configurada()      → true quando js/config-nuvem.js tem url + anonKey.
   • Nuvem.entrar()           → garante sessão (mostra a tela #nuvem-login se preciso)
                                e descobre a EMPRESA do usuário (multi-tenant).
   • Nuvem.DB                 → mesma interface do DBLocal (getAll/add/put/delete/clear
                                + addLote), com cache em memória por store.
   • Nuvem.puxarOverlays()    → aplica no localStorage os overlays salvos na nuvem
                                (percorre BACKUP_CAMPOS, a mesma tabela do backup).
   • Nuvem.observarOverlays() → qualquer gravação no localStorage agenda um envio
                                (debounce 2,5s) só dos campos que mudaram.
   • Nuvem.sair()             → encerra a sessão e recarrega.

   Regras de ouro:
   • TODA linha nas tabelas leva empresa_id — e o RLS no banco recusa qualquer
     leitura/escrita fora da empresa do usuário logado (não é filtro de front).
   • Este arquivo NÃO conhece telas do app (só a #nuvem-login, que é dele).
   ============================================================================ */
window.Nuvem = (() => {
  let cli = null;          // cliente supabase
  let empresaId = null;    // tenant do usuário logado
  let email = null;
  let papel = null;       // dono | operacao | leitura | atendente (quem MANDA é o RLS; isto é só p/ a tela)
  let minhaLoja = null;   // loja do vínculo — só o papel `atendente` usa; null = todas
  let empresaSuporte = null;  // empresa aberta pelo SUPORTE (admin da plataforma), null = uso normal
  let suporteAte = null;      // quando a liberação vence (só no modo suporte)

  // Overlays que NÃO são dinheiro — espelha overlay_operacional() do schema-rbac.sql.
  // Se mudar lá, mude aqui (o banco continua sendo a barreira real).
  const OVERLAY_OPERACIONAL = new Set(['personalizacoes','mapeamento_custom','map_fornecedor',
                                       'ingredientes_ocultos','alertas_config']);
  const podeGravarOverlay = (campo) =>
    papel === 'dono' || (papel === 'operacao' && OVERLAY_OPERACIONAL.has(campo));

  const configurada = () =>
    !!(window.NUVEM_CONFIG && NUVEM_CONFIG.url && NUVEM_CONFIG.anonKey && window.supabase);

  // ---------- sessão ----------
  async function entrar() {
    cli = supabase.createClient(NUVEM_CONFIG.url, NUVEM_CONFIG.anonKey);
    const { data: { session } } = await cli.auth.getSession();
    if (!session) await loginInterativo();
    const { data: { user } } = await cli.auth.getUser();
    email = user?.email || null;

    // Empresa (tenant) do usuário: v1 usa a primeira; multi-empresa vem depois.
    // ORDENADO DE PROPÓSITO (30/07/2026): sem `order by`, o Postgres não promete ordem nenhuma —
    // quem pertencesse a 2 empresas poderia abrir numa hoje e noutra amanhã, sem perceber, e ver
    // "os dados errados". Com a ordem fixa (associação mais ANTIGA), a empresa é sempre a mesma.
    // Quando existir seletor de empresa, é aqui que ele entra.
    const { data: memb, error } = await cli.from('usuarios_empresas')
      .select('empresa_id,papel,loja').order('criado_em').order('empresa_id').limit(1);
    if (error) throw new Error('Não consegui ler sua empresa na nuvem: ' + error.message);
    if (!memb || !memb.length) throw new Error('Seu usuário ainda não pertence a nenhuma empresa — rode o SQL de convite (fim do schema-rbac.sql) no Supabase.');
    empresaId = memb[0].empresa_id;
    papel = memb[0].papel || 'dono';   // banco sem RBAC ainda (papel nulo) = comporta como dono
    // Loja do vínculo (papel `atendente`). NULL = sem restrição de loja, que é o
    // caso de dono/operacao/leitura — para eles nada muda.
    // Quem MANDA é o RLS (schema-atendente.sql); isto aqui só permite a tela
    // já abrir na loja certa e travar o seletor.
    minhaLoja = memb[0].loja || null;

    // MODO SUPORTE (22/09): o administrador da plataforma pediu para abrir a empresa de um
    // franqueado que liberou suporte. Quem decide é o BANCO: `meu_papel(empresa)` só devolve
    // 'leitura' se a liberação estiver valendo — se voltar vazio, a chave é descartada e o
    // app abre normal. Nada aqui concede acesso; o RLS é que concede (e proíbe gravar).
    const alvo = (() => { try { return localStorage.getItem('pv_suporte_empresa'); } catch (e) { return null; } })();
    if (alvo && alvo !== empresaId) {
      const { data: p } = await cli.rpc('meu_papel', { emp: alvo });
      if (p === 'leitura') {
        const { data: lib } = await cli.from('suporte_liberacoes').select('ate').eq('empresa_id', alvo).maybeSingle();
        empresaSuporte = alvo; empresaId = alvo; papel = 'leitura'; minhaLoja = null;
        suporteAte = lib?.ate || null;   // o dono é quem lê a liberação; no suporte pode vir vazio
      } else {
        try { localStorage.removeItem('pv_suporte_empresa'); } catch (e) {}
      }
    }
  }

  function loginInterativo() {
    return new Promise((resolve) => {
      const tela = document.getElementById('nuvem-login');
      const form = document.getElementById('nl-form');
      const erro = document.getElementById('nl-erro');
      const botao = document.getElementById('nl-entrar');
      tela.style.display = 'flex';
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        erro.style.display = 'none';
        botao.disabled = true; botao.innerHTML = 'Entrando…';
        const { error } = await cli.auth.signInWithPassword({
          email: document.getElementById('nl-email').value.trim(),
          password: document.getElementById('nl-senha').value
        });
        botao.disabled = false; botao.innerHTML = '<i class="fas fa-cloud me-1"></i>Entrar';
        if (error) {
          erro.textContent = /credential/i.test(error.message)
            ? 'E-mail ou senha incorretos.' : 'Erro ao entrar: ' + error.message;
          erro.style.display = 'block';
          return;
        }
        tela.style.display = 'none';
        resolve();
      };
    });
  }

  async function sair() {
    try { await empurrarOverlays(); } catch (e) { /* melhor esforço antes de sair */ }
    await cli.auth.signOut();
    location.reload();
  }

  // ---------- recuperação de senha ----------
  // Quando alguém clica no link "definir nova senha" do e-mail, o Supabase o traz de volta ao app
  // com um token de RECUPERAÇÃO no #hash da URL (…#access_token=…&type=recovery). SEM uma tela para
  // digitar a senha nova, o app apenas embarcava normalmente e a pessoa NUNCA conseguia trocar —
  // bug relatado em 07/08/2026 ("clico no link do e-mail e sou mandado pro app"). Esta função
  // detecta esse retorno; telaTrocarSenha() mostra o campo e chama updateUser(). O #hash é lido
  // ANTES de qualquer createClient (o supabase-js limpa o hash ao processá-lo).
  // 27/08: passou a aceitar TAMBÉM `type=invite`. O convite (tela de Usuários →
  // função `convidar`) traz a pessoa por este mesmo caminho, e sem isto ela cairia
  // logada no app SEM NUNCA poder definir a senha — exatamente o bug de 07/08,
  // só que agora atingindo todo mundo que fosse convidado.
  const _tipoDeLink = () => {
    const m = /(?:^|[#&?])type=(recovery|invite)(?:&|$)/
      .exec((location.hash || '') + '&' + (location.search || ''));
    return m ? m[1] : null;
  };
  const recuperacaoNaURL = () => _tipoDeLink() !== null;

  async function telaTrocarSenha() {
    const ehConvite = _tipoDeLink() === 'invite';
    cli = supabase.createClient(NUVEM_CONFIG.url, NUVEM_CONFIG.anonKey);
    try { await cli.auth.getSession(); } catch (e) {}   // deixa o supabase-js consumir o token do #hash
    const tela = document.getElementById('nuvem-login');
    tela.querySelector('.nl-card').innerHTML = `
      <div class="logo-ppv" style="height:96px;margin:0 auto 6px" role="img" aria-label="Pizza Para Você"></div>
      <h4>${ehConvite ? 'Bem-vindo! Crie sua senha' : 'Definir nova senha'}</h4>
      <p class="nl-sub">${ehConvite
        ? 'Você foi convidado para o sistema. Escolha uma senha (mínimo de 8 caracteres) para entrar.'
        : 'Escolha a nova senha da sua conta (mínimo de 8 caracteres).'}</p>
      <form id="rec-form" autocomplete="on">
        <label class="form-label" for="rec-s1">Nova senha</label>
        <input type="password" id="rec-s1" class="form-control" required autocomplete="new-password" minlength="8">
        <label class="form-label mt-2" for="rec-s2">Repita a nova senha</label>
        <input type="password" id="rec-s2" class="form-control" required autocomplete="new-password" minlength="8">
        <div id="rec-erro" class="alert alert-danger py-2 mt-3 mb-0" style="display:none"></div>
        <button type="submit" id="rec-ok" class="btn btn-primary w-100 mt-3"><i class="fas fa-key me-1"></i>Salvar nova senha</button>
      </form>`;
    tela.style.display = 'flex';
    const form = document.getElementById('rec-form');
    const erro = document.getElementById('rec-erro');
    const botao = document.getElementById('rec-ok');
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      erro.style.display = 'none';
      const s1 = document.getElementById('rec-s1').value;
      const s2 = document.getElementById('rec-s2').value;
      if (s1.length < 8) { erro.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; erro.style.display = 'block'; return; }
      if (s1 !== s2)     { erro.textContent = 'As duas senhas não são iguais.'; erro.style.display = 'block'; return; }
      botao.disabled = true; botao.innerHTML = 'Salvando…';
      const { error } = await cli.auth.updateUser({ password: s1 });
      botao.disabled = false; botao.innerHTML = '<i class="fas fa-key me-1"></i>Salvar nova senha';
      if (error) {
        erro.textContent = /session|expired|token|missing/i.test(error.message)
          ? 'Este link de recuperação expirou ou já foi usado. Peça um novo e-mail de "esqueci a senha".'
          : 'Não consegui salvar: ' + error.message;
        erro.style.display = 'block';
        return;
      }
      try { await cli.auth.signOut(); } catch (e) {}
      history.replaceState(null, '', location.pathname);   // remove o token do #hash
      alert('Senha alterada com sucesso! Agora entre com a senha nova.');
      location.reload();
    };
  }

  // ---------- dados (mesma interface do DBLocal) ----------
  // Payload inteiro em `dados` (jsonb) — espelho fiel do IndexedDB; `id` vem da coluna.
  const _cache = {};
  const lojaDe = (d) => d.loja || d.loja_origem || null;

  // Limpa o cache de um store INCLUINDO as janelas ('vendas' e 'vendas@2026-06-01|2026-07-31').
  // Sem isto, uma importação atualizava a lista inteira mas as telas com filtro de período
  // continuavam mostrando o recorte velho — o dado novo ficava invisível.
  const _invalidar = (store) => {
    delete _cache[store];
    const pre = store + '@';
    for (const k of Object.keys(_cache)) if (k.startsWith(pre)) delete _cache[k];
    if (store === 'vendas') _limparVendasMes();
  };

  // ---------- vendas por MÊS (fase 1 SaaS, 21/09/2026) ----------
  // As telas pedem as vendas de várias janelas diferentes (cada janela de contagem, cada trecho,
  // cada semana): um mês na tela de Estoque eram 12 janelas = 12 consultas que varriam a tabela.
  // Agora cada MÊS de calendário é lido uma vez e guardado; qualquer janela é recortada daqui.
  // O recorte devolvido é IDÊNTICO ao do servidor: entra a venda cujo período CRUZA [ini,fim].
  // Prova: um registro que cruza [a,b] cruza algum dia d de [a,b]; d está num mês já lido e a
  // leitura daquele mês trouxe todo registro que cruza o mês — logo, trouxe este.
  let _vMapa = new Map(), _vCob = [], _vFila = Promise.resolve(), _vGeracao = 0;
  function _limparVendasMes() { _vMapa = new Map(); _vCob = []; _vGeracao++; }
  const _iniMes = d => d.slice(0, 8) + '01';
  const _fimMes = d => { const [y, m] = d.split('-').map(Number); return d.slice(0, 8) + String(new Date(y, m, 0).getDate()).padStart(2, '0'); };
  const _diaAntes = d => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); };
  const _diaDepois = d => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); };
  function _faltando(a, b) {
    let segs = [[a, b]];
    for (const [i, f] of _vCob) segs = segs.flatMap(([x, y]) => (f < x || i > y) ? [[x, y]]
      : [x < i ? [x, _diaAntes(i)] : null, y > f ? [_diaDepois(f), y] : null].filter(Boolean));
    return segs;
  }
  // Uma consulta ao servidor. Usa as colunas data_inicio/data_fim (índice — migração
  // 20260921120000): com RLS, o filtro DENTRO do JSON nunca usa índice. Se o banco ainda não
  // tiver as colunas (app publicado antes da migração), cai no filtro antigo sem quebrar.
  let _vColunas = true;
  async function _vendasServidor(ini, fim) {
    const todos = []; const TAM = 1000; let de = 0;
    while (true) {
      let q = cli.from('vendas').select('id,dados');
      if (ini) q = _vColunas ? q.gte('data_fim', ini) : q.gte('dados->>data_fim', ini);
      if (fim) q = _vColunas ? q.lte('data_inicio', fim) : q.lte('dados->>data_inicio', fim);
      const { data, error } = await q.order('id').range(de, de + TAM - 1);
      if (error) {
        if (_vColunas && /data_(fim|inicio)/.test(error.message || '')) { _vColunas = false; return _vendasServidor(ini, fim); }
        throw new Error('vendas (período): ' + error.message);
      }
      todos.push(...data);
      if (data.length < TAM) break;
      de += TAM;
    }
    return todos.map(r => ({ ...r.dados, id: r.id }));
  }

  const DBN = {
    async getAll(store) {
      if (_cache[store]) return _cache[store].slice();
      const todos = []; const TAM = 1000; let de = 0;
      while (true) {  // pagina de 1000 em 1000 (limite padrão do PostgREST)
        const { data, error } = await cli.from(store).select('id,dados').order('id').range(de, de + TAM - 1);
        if (error) throw new Error(store + ': ' + error.message);
        todos.push(...data);
        if (data.length < TAM) break;
        de += TAM;
      }
      _cache[store] = todos.map(r => ({ ...r.dados, id: r.id }));
      return _cache[store].slice();
    },
    async add(store, dados) {
      const { data, error } = await cli.from(store)
        .insert({ empresa_id: empresaId, loja: lojaDe(dados), dados }).select('id').single();
      if (error) throw new Error(store + ': ' + error.message);
      _invalidar(store);
      return data.id;
    },
    async addLote(store, linhas) {
      for (let i = 0; i < linhas.length; i += 500) {
        const fatia = linhas.slice(i, i + 500).map(d => ({ empresa_id: empresaId, loja: lojaDe(d), dados: d }));
        const { error } = await cli.from(store).insert(fatia);
        if (error) throw new Error(store + ' (lote): ' + error.message);
      }
      _invalidar(store);
    },
    async put(store, obj) {
      const { id, ...dados } = obj;
      const { error } = await cli.from(store).update({ loja: lojaDe(dados), dados }).eq('id', id);
      if (error) throw new Error(store + ': ' + error.message);
      _invalidar(store);
      return id;
    },
    async delete(store, id) {
      const { error } = await cli.from(store).delete().eq('id', id);
      if (error) throw new Error(store + ': ' + error.message);
      _invalidar(store);
    },
    // Apaga MUITOS ids de uma vez (lotes de 200 p/ não estourar o tamanho da URL do PostgREST).
    // Sem isto, apagar 180 dias de venda eram 180 idas à rede — a importação do TOTEM não
    // terminava no celular e as lojas do FIM da lista ficavam sem os dias novos (bug jul/2026).
    async deleteMuitos(store, ids) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await cli.from(store).delete().in('id', ids.slice(i, i + 200));
        if (error) throw new Error(store + ' (delete em lote): ' + error.message);
      }
      if (ids.length) _invalidar(store);
    },
    // Vendas que ENCOSTAM na janela [ini,fim] — filtradas no SERVIDOR.
    // Motivo (31/07/2026): a tabela inteira são 4.485 kB / 2.867 linhas, mas 60 dias são
    // 339 kB / 180 linhas — 6% das linhas. Toda tela baixava 4 anos para mostrar 2 meses, e
    // era isso que travava o iPhone. Um registro entra se o período dele CRUZA a janela
    // (importação de período tem data_inicio < data_fim), a MESMA regra do filtro em memória
    // que as telas já faziam — por isso os números não mudam.
    // Cache por janela; qualquer escrita limpa tudo (o `delete _cache[store]` dos métodos acima).
    // 21/09: janela completa → recorte dos meses guardados (ver _vendasServidor/_faltando acima).
    // Janela aberta (sem início ou sem fim) → consulta direta, com cache por janela como antes.
    async vendasPeriodo(ini, fim) {
      if (!ini || !fim) {
        const chave = 'vendas@' + (ini || '') + '|' + (fim || '');
        if (!_cache[chave]) _cache[chave] = await _vendasServidor(ini, fim);
        return _cache[chave].slice();
      }
      if (fim < ini) return [];
      const geracao = _vGeracao;
      await (_vFila = _vFila.catch(() => {}).then(async () => {
        if (geracao !== _vGeracao) return;           // alguém gravou no meio: a próxima chamada lê de novo
        for (const [x, y] of _faltando(_iniMes(ini), _fimMes(fim))) {
          const lote = await _vendasServidor(x, y);
          if (geracao !== _vGeracao) return;
          for (const v of lote) _vMapa.set(v.id, v);
          _vCob.push([x, y]);
        }
      }));
      if (_faltando(ini, fim).length) return _vendasServidor(ini, fim);   // não coube no guardado: vai direto
      return [..._vMapa.values()].filter(v => v.data_fim >= ini && v.data_inicio <= fim).sort((a, b) => a.id - b.id);
    },
    // Só as CHAVES das vendas (id/loja/data/origem), sem o campo `itens`. A tabela inteira passa
    // de 4 MB; para decidir o que substituir na importação bastam alguns KB.
    async chavesVendas() {
      const todos = []; const TAM = 1000; let de = 0;
      while (true) {
        const { data, error } = await cli.from('vendas')
          .select('id,loja,data_inicio:dados->>data_inicio,data_fim:dados->>data_fim,origem:dados->>origem')
          .order('id').range(de, de + TAM - 1);
        if (error) throw new Error('vendas (chaves): ' + error.message);
        todos.push(...data);
        if (data.length < TAM) break;
        de += TAM;
      }
      return todos;
    },
    async clear(store) {
      const { error } = await cli.from(store).delete().eq('empresa_id', empresaId);
      if (error) throw new Error(store + ': ' + error.message);
      _invalidar(store);
    }
  };

  // ---------- overlays (localStorage ↔ nuvem) ----------
  // Reusa BACKUP_CAMPOS (a tabela oficial do backup): o que viaja no backup é
  // exatamente o que sincroniza com a nuvem.
  //
  // ⚠️ ATÉ 27/08/2026 ERA "ÚLTIMA GRAVAÇÃO VENCE" — desenho de 1 usuário por empresa.
  // Com duas pessoas na mesma empresa isso APAGAVA EM SILÊNCIO: quem salvasse por
  // último mandava o pacote INTEIRO do campo, montado sobre um estado velho, e a
  // alteração da outra pessoa sumia sem erro, sem aviso e sem rastro. Como o dono e
  // o Matheus já usam a mesma empresa, a falha era alcançável hoje.
  //
  // AGORA: fusão de 3 vias (base / minha / do servidor). O `_ultimoJSON` já era,
  // sem querer, o ANCESTRAL COMUM — o valor de quando puxei ou empurrei pela última
  // vez. Com os três lados dá para saber QUEM mudou O QUÊ e juntar sem perder nada:
  // mexemos em itens diferentes → entram os dois; só um mexeu → vence quem mexeu;
  // os dois mexeram no MESMO item → o meu vence (estou olhando pra tela) e o app AVISA.
  const _ultimoJSON = {};
  let _timer = null;

  // Derivados e marcadores ficam fora da fusão de propósito: os snapshots são cache
  // recalculável (e pesam MB — fundir seria caro e inútil) e o `totem_import_sig` é
  // um marcador de coordenação, onde "o último vence" é justamente a semântica certa.
  const _SEM_FUSAO = new Set(['ceo_snapshot', 'pag_snapshot', 'clientes_snapshot', 'totem_import_sig']);

  const _ehObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const _j = x => JSON.stringify(x ?? null);

  /* Fusão de 3 vias. Formas MEDIDAS no banco em 27/08 (não supostas):
       objeto por id .... dre_custos (mês → id do gasto), mapeamento_custom (111 SKUs),
                          map_fornecedor, repasse99_manual (LOJA|data), personalizacoes
       lista com id ..... dre_custos_cad (37 itens), emprestimos_lojas
       lista de texto ... ingredientes_ocultos[loja], dre_grupos, be_variaveis → CONJUNTO
     `conflitos` recebe o caminho de cada item que os dois lados mudaram. */
  function _fundir3(base, meu, deles, caminho, conflitos) {
    const jm = _j(meu), jd = _j(deles);
    if (jm === jd) return meu;                 // ninguém divergiu
    const jb = _j(base);
    if (jb === jm) return deles;               // só o outro mexeu
    if (jb === jd) return meu;                 // só eu mexi

    if (_ehObj(meu) && _ehObj(deles)) {
      const b = _ehObj(base) ? base : {};
      const out = {};
      for (const k of new Set([...Object.keys(meu), ...Object.keys(deles)])) {
        const emM = k in meu, emD = k in deles, emB = k in b;
        const p = caminho ? caminho + ' › ' + k : k;
        if (emM && emD) out[k] = _fundir3(b[k], meu[k], deles[k], p, conflitos);
        // some de um lado só = apagado por ele. Só honro o apagar se o outro lado NÃO
        // alterou o item; alterar e apagar ao mesmo tempo é conflito, e editar ganha
        // de apagar (recuperar um item apagado por engano é mais caro que reapagar).
        else if (emM && !emD) { if (!emB || _j(b[k]) !== _j(meu[k])) { out[k] = meu[k]; if (emB) conflitos.push(p + ' (você editou, o outro apagou)'); } }
        else if (!emM && emD) { if (!emB || _j(b[k]) !== _j(deles[k])) { out[k] = deles[k]; if (emB) conflitos.push(p + ' (o outro editou, você apagou)'); } }
      }
      return out;
    }

    if (Array.isArray(meu) && Array.isArray(deles)) {
      // ⚠️ tem que devolver null para não-objeto. Escrito com `&&` isto devolvia
      // FALSE para texto, e `false != null` é VERDADEIRO em JS — então
      // ['A','B','C'] passava por "lista com id", todos viravam a chave "false" e a
      // fusão devolvia UM item só. Pego pelo teste do ingredientes_ocultos.
      const idDe = x => (!_ehObj(x) ? null : (x.id != null ? String(x.id) : (x.nome != null ? String(x.nome) : null)));
      const temId = a => a.length > 0 && a.every(x => idDe(x) != null);
      if (temId(meu) && temId(deles)) {
        const b = Array.isArray(base) ? base : [];
        const mapa = a => Object.fromEntries(a.map(x => [idDe(x), x]));
        const M = mapa(meu), D = mapa(deles), B = mapa(b);
        const out = [];
        for (const id of new Set([...meu.map(idDe), ...deles.map(idDe)])) {
          const emM = id in M, emD = id in D, emB = id in B;
          const p = (caminho ? caminho + ' › ' : '') + id;
          if (emM && emD) out.push(_fundir3(B[id], M[id], D[id], p, conflitos));
          else if (emM && !emD) { if (!emB || _j(B[id]) !== _j(M[id])) { out.push(M[id]); if (emB) conflitos.push(p + ' (você editou, o outro apagou)'); } }
          else if (!emM && emD) { if (!emB || _j(B[id]) !== _j(D[id])) { out.push(D[id]); if (emB) conflitos.push(p + ' (o outro editou, você apagou)'); } }
        }
        return out;
      }
      // lista de valores simples = CONJUNTO: soma o que cada um acrescentou e
      // respeita o que qualquer um dos dois removeu.
      const sb = new Set((Array.isArray(base) ? base : []).map(_j));
      const sm = new Set(meu.map(_j)), sd = new Set(deles.map(_j));
      const out = new Set(sb);
      for (const x of sm) if (!sb.has(x)) out.add(x);
      for (const x of sd) if (!sb.has(x)) out.add(x);
      for (const x of sb) if (!sm.has(x) || !sd.has(x)) out.delete(x);
      return [...out].map(x => JSON.parse(x));
    }

    // valor simples que os dois mudaram: o MEU vence (é a tela que a pessoa está vendo)
    conflitos.push(caminho || '(o campo inteiro)');
    return meu;
  }

  function _avisarFusao(campos, conflitos) {
    try {
      if (conflitos.length) {
        toast('<strong>Outra pessoa mexeu nas configurações ao mesmo tempo.</strong> Juntei as duas edições; onde os dois mudaram o mesmo item, ficou o <strong>seu</strong>: '
              + esc(conflitos.slice(0, 3).join('; ')) + (conflitos.length > 3 ? '…' : ''), 'warning');
      } else {
        toast('<strong>Configurações juntadas.</strong> Outra pessoa também estava editando — nada foi perdido dos dois lados.', 'info');
      }
    } catch (e) { console.warn('fusao overlays', campos, conflitos); }
  }

  async function puxarOverlays() {
    // 21/09: só os campos que o app usa (BACKUP_CAMPOS). Antes vinha a tabela inteira — inclusive
    // os snapshots do TOTEM (3,6 MB), a cada abertura e a cada volta ao app.
    const campos = BACKUP_CAMPOS.map(c => c.campo);
    const { data, error } = await cli.from('overlays').select('campo,valor').in('campo', campos);
    if (error) throw new Error('overlays: ' + error.message);
    const porCampo = Object.fromEntries((data || []).map(r => [r.campo, r.valor]));
    const fundidos = [], conflitos = [];
    for (const c of BACKUP_CAMPOS) {
      const v = porCampo[c.campo];
      if (v == null) continue;
      if (c.arr && !Array.isArray(v)) continue;
      let valor = v;
      // Este puxar roda também ao VOLTAR pro app (visibilitychange). Antes ele
      // sobrescrevia a edição local ainda não enviada — a mesma perda silenciosa,
      // só que na direção contrária. Havendo alteração pendente, funde.
      if (_ultimoJSON[c.campo] !== undefined && !_SEM_FUSAO.has(c.campo)) {
        try {
          const meu = c.get();
          if (_j(meu) !== _ultimoJSON[c.campo]) {
            valor = _fundir3(JSON.parse(_ultimoJSON[c.campo]), meu, v, '', conflitos);
            fundidos.push(c.campo);
          }
        } catch (e) { /* getter falhou: fica com o da nuvem */ }
      }
      // A base passa a ser o que o SERVIDOR tem. Se a fusão mudou algo, o valor local
      // fica diferente da base e o empurrar seguinte manda o resultado — de propósito.
      try { c.set(valor); _ultimoJSON[c.campo] = _j(v); }
      catch (e) { console.warn('overlay ' + c.campo, e); }
    }
    if (fundidos.length) _avisarFusao(fundidos, conflitos);
  }

  async function empurrarOverlays() {
    if (!empresaId || papel === 'leitura') return;   // leitura nunca grava
    const candidatos = [];
    for (const c of BACKUP_CAMPOS) {
      // não tenta subir o que o papel não pode gravar (o RLS recusaria e viraria erro na tela)
      if (!podeGravarOverlay(c.campo)) continue;
      let v; try { v = c.get(); } catch (e) { continue; }
      if (_j(v) !== _ultimoJSON[c.campo]) candidatos.push({ c, v });
    }
    if (!candidatos.length) return;

    // Lê o estado ATUAL do servidor só dos campos que mudaram, para saber se alguém
    // escreveu desde que puxei. Uma requisição a mais, só quando há o que salvar.
    let remoto = {};
    const podeFundir = candidatos.filter(x => !_SEM_FUSAO.has(x.c.campo)).map(x => x.c.campo);
    if (podeFundir.length) {
      try {
        const { data } = await cli.from('overlays').select('campo,valor').in('campo', podeFundir);
        remoto = Object.fromEntries((data || []).map(r => [r.campo, r.valor]));
      } catch (e) { /* sem leitura, cai no comportamento antigo (o meu vence) */ }
    }

    const mudados = [], fundidos = [], conflitos = [];
    for (const { c, v } of candidatos) {
      let valor = v;
      const base = _ultimoJSON[c.campo];
      if (!_SEM_FUSAO.has(c.campo) && base !== undefined && (c.campo in remoto)) {
        const deles = remoto[c.campo];
        if (_j(deles) !== base) {                 // alguém gravou depois que eu puxei
          valor = _fundir3(JSON.parse(base), v, deles, '', conflitos);
          fundidos.push(c.campo);
          try { c.set(valor); } catch (e) {}      // a tela passa a mostrar o resultado da fusão
        }
      }
      // relê pelo getter: `set` pode normalizar (Set↔array, ordem de chave) e a foto
      // tem que ser do que o app REALMENTE tem, senão o próximo empurrar acha que mudou.
      let foto = valor; try { foto = c.get(); } catch (e) {}
      _ultimoJSON[c.campo] = _j(foto);
      mudados.push({ empresa_id: empresaId, campo: c.campo, valor: valor ?? null, atualizado_em: new Date().toISOString() });
    }

    const { error } = await cli.from('overlays').upsert(mudados);
    if (error) {
      console.error('sync overlays', error);
      try { toast('Não consegui salvar as configurações na nuvem: ' + esc(error.message), 'error'); } catch (e) {}
      return;
    }
    if (fundidos.length) _avisarFusao(fundidos, conflitos);
  }

  function observarOverlays() {
    // foto inicial do que NÃO veio da nuvem → só sobe quando realmente mudar
    for (const c of BACKUP_CAMPOS) {
      if (!(c.campo in _ultimoJSON)) { try { _ultimoJSON[c.campo] = JSON.stringify(c.get() ?? null); } catch (e) {} }
    }
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k, v) => {
      original(k, v);
      clearTimeout(_timer);
      _timer = setTimeout(() => { empurrarOverlays(); }, 2500);
    };
    window.addEventListener('pagehide', () => { empurrarOverlays(); });
    // a hora da rodada do robô ANTES de o app ler os arquivos do TOTEM (o init lê logo depois):
    // se o robô rodar no meio, a próxima volta ao app relê uma vez — nunca fica preso em dado velho
    ultimaAtualizacaoTotem().then(dt => { _versaoTotem = dt ? dt.getTime() : null; }).catch(() => {});
    observarRetorno();
  }

  // "Quase tempo real" entre aparelhos: ao VOLTAR para o app (trocou do WhatsApp pro app,
  // voltou pra aba do PC), joga fora o cache, puxa overlays novos e re-renderiza as telas
  // financeiras abertas. Páginas de DIGITAÇÃO (Contagem etc.) não são tocadas — nada se perde.
  let _ultimaVolta = 0, _versaoTotem = null;
  function observarRetorno() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - _ultimaVolta < 30000) return;   // no máximo 1 refresh a cada 30s
      _ultimaVolta = Date.now();
      Object.keys(_cache).forEach(k => delete _cache[k]);              // linhas do banco
      _limparVendasMes();
      puxarOverlays().catch(() => {});                                  // configurações/correções
      try { if (typeof atualizarChipNuvem === 'function') atualizarChipNuvem(); } catch (e) {}  // "atualizado há X"
      // 21/09: os arquivos do TOTEM (≈ 4 MB) só são baixados de novo SE O ROBÔ RODOU desde a última
      // leitura — 1 consulta pequena decide. Antes era a cada volta ao app, mesmo sem nada novo.
      // Sem resposta (rede), faz como antes: relê — nunca fica preso em dado velho.
      let novo = true;
      try { const dt = await ultimaAtualizacaoTotem(); const v = dt ? dt.getTime() : null; novo = (v == null || v !== _versaoTotem); if (novo) _versaoTotem = v; } catch (e) {}
      if (novo) {
        try { if (typeof limparCacheTotem === 'function') limparCacheTotem(); } catch (e) {}  // arquivos do TOTEM
        // Reimporta as vendas se o robô publicou um arquivo novo enquanto o app estava em segundo
        // plano (tem trava contra chamada concorrente e marcador entre aparelhos).
        try { if (typeof atualizarDoTotem === 'function') atualizarDoTotem(); } catch (e) {}
      }
      try { if (typeof atualizarTelasFinanceiras === 'function') atualizarTelasFinanceiras(); } catch (e) {}
    });
  }

  // ---------- arquivos do TOTEM (a "ponte": o PC sobe, qualquer aparelho lê) ----------
  // Tabela arquivos_totem: 1 linha por arquivo (vendas_totem.json, pedidos_resumo.json…),
  // conteúdo em jsonb. Enviada pelo script Saas/ponte/enviar_totem_nuvem.py.
  async function lerArquivo(nome) {
    if (!cli || !empresaId) return null;
    const { data, error } = await cli.from('arquivos_totem').select('conteudo').eq('nome', nome).limit(1);
    if (error) { console.warn('arquivos_totem ' + nome, error.message); return null; }
    return (data && data[0]) ? data[0].conteudo : null;
  }

  // Restaura UM store inteiro numa transação só (banco/schema-restore.sql). O par
  // clear+addLote que existia antes eram DUAS requisições: internet caindo entre elas apagava
  // os dados da empresa e não gravava os novos. Aqui, ou troca tudo, ou não muda nada.
  async function restaurarStore(store, linhas) {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const { data, error } = await cli.rpc('restaurar_store', { p_store: store, p_linhas: linhas });
    if (error) throw new Error(store + ': ' + error.message);
    Object.keys(_cache).forEach(k => delete _cache[k]);
    return data;
  }

  // Cadastro de lojas da empresa (banco/schema-lojas.sql). É o que faz "loja" ser DADO e não
  // código: o app monta LOJA_LABEL/LOJA_COR/LOJAS_ORDEM a partir daqui no boot.
  // 22/09: traz também as PAUSADAS (o app as tira dos lançamentos, mas o nome delas continua
  // aparecendo no histórico) e filtra pela empresa aberta (quem estiver em 2 empresas não mistura).
  // `select('*')` de propósito: funciona com e sem a coluna nova `totem_codigo`.
  async function lerLojas() {
    if (!cli || !empresaId) return null;
    const { data, error } = await cli.from('lojas')
      .select('*').eq('empresa_id', empresaId).order('ordem');
    if (error) { console.warn('lojas:', error.message); return null; }
    return data;
  }

  // Tela de Lojas (Fase 3): cria ou altera UMA loja. O banco só deixa o dono (lojas_ins/lojas_upd).
  // `nova` = true → insert (a chave nasce aqui e nunca muda: é ela que liga o histórico).
  async function salvarLoja(l, nova) {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const campos = { nome: l.nome, cnpj: l.cnpj || null, ativa: l.ativa !== false, ordem: l.ordem || 0 };
    if (l.totem_codigo !== undefined) campos.totem_codigo = l.totem_codigo || null;
    const q = nova
      ? cli.from('lojas').insert({ empresa_id: empresaId, chave: l.chave, ...campos })
      : cli.from('lojas').update(campos).eq('empresa_id', empresaId).eq('chave', l.chave);
    const { error } = await q;
    if (error) throw new Error(/duplicate|lojas_pkey/.test(error.message) ? 'Já existe uma loja com esse nome.' : error.message);
  }

  // ---------- SUPORTE POR 48 H + PAINEL DE ADMINISTRAÇÃO (Fase 3, 22/09/2026) ----------
  // Quem manda é o banco: `sou_dono_de` deixa só o dono liberar/cortar; com a liberação valendo,
  // `minhas_empresas()`/`meu_papel()` põem o administrador da plataforma na empresa como LEITURA
  // (todas as regras de gravação exigem dono/operacao/atendente → o suporte vê e não grava).
  // Provado no banco de teste em 22/09 — ver supabase/pendentes/20260922110000_suporte_e_admin.sql.
  const SUPORTE_CHAVE = 'pv_suporte_empresa';

  async function souAdminPlataforma() {
    if (!cli) return false;
    const { data, error } = await cli.rpc('sou_admin_plataforma');
    if (error) return false;                      // banco sem a migração = não é admin
    return data === true;
  }
  // a liberação da empresa aberta (só o dono lê). `undefined` = o banco ainda não tem a tabela
  // (migração não aplicada) → a tela esconde o cartão em vez de prometer o que não existe.
  async function lerSuporte() {
    if (!cli || !empresaId) return undefined;
    const { data, error } = await cli.from('suporte_liberacoes').select('ate,liberado_em').eq('empresa_id', empresaId).maybeSingle();
    if (error) return undefined;
    return data || null;
  }
  async function liberarSuporte(horas) {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const h = Math.min(48, Math.max(1, Number(horas) || 48));
    const ate = new Date(Date.now() + h * 3600e3).toISOString();
    // o banco carimba quem liberou e quando; o check recusa mais de 48 h
    const { error } = await cli.from('suporte_liberacoes').upsert({ empresa_id: empresaId, ate }, { onConflict: 'empresa_id' });
    if (error) throw new Error(error.message);
    return ate;
  }
  async function cortarSuporte() {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const { error } = await cli.from('suporte_liberacoes').delete().eq('empresa_id', empresaId);
    if (error) throw new Error(error.message);
  }
  async function acessosSuporte(limite) {          // o dono vê o que o suporte abriu
    if (!cli || !empresaId) return [];
    const { data, error } = await cli.from('suporte_acessos').select('tela,em').eq('empresa_id', empresaId)
      .order('em', { ascending: false }).limit(limite || 50);
    if (error) return [];
    return data || [];
  }
  async function adminResumo() {                   // painel de administração (só admin)
    if (!cli) throw new Error('sem nuvem');
    const { data, error } = await cli.rpc('admin_resumo');
    if (error) throw new Error(error.message);
    return data || [];
  }
  async function registrarAcessoSuporte(tela) {    // rastro; falha em silêncio (não pode travar a tela)
    if (!cli || !empresaSuporte) return;
    try { await cli.rpc('registrar_acesso_suporte', { emp: empresaSuporte, p_tela: String(tela || '').slice(0, 60) }); } catch (e) {}
  }
  function entrarNoSuporte(emp) { localStorage.setItem(SUPORTE_CHAVE, emp); location.reload(); }
  function sairDoSuporte() { localStorage.removeItem(SUPORTE_CHAVE); location.reload(); }
  function noSuporte() { return !!empresaSuporte; }

  // Manda o robô do TOTEM rodar AGORA. Chama a função disparar_robo_totem() no banco,
  // que lê o token do cofre e aciona o GitHub. O token nunca chega ao navegador.
  // Só 'dono' consegue (a própria função barra os demais).
  async function dispararRobo() {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const { data, error } = await cli.rpc('disparar_robo_totem');
    if (error) throw new Error(error.message);
    return data;
  }

  // ---- Solicitação de exclusão (banco/schema-exclusao.sql) ----
  // A atendente não apaga; ela PEDE. O dono aprova/rejeita.
  async function solicitarExclusao(store, registroId, resumo, motivo) {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const { error } = await cli.from('solicitacoes_exclusao').insert({
      empresa_id: empresaId, loja: minhaLoja || null, store, registro_id: registroId,
      resumo: resumo || null, motivo: motivo || null,
      solicitado_por: email || null, status: 'pendente'
    });
    if (error) throw new Error(error.message);
  }
  async function listarSolicitacoes(status) {
    if (!cli || !empresaId) return [];
    let q = cli.from('solicitacoes_exclusao').select('*').eq('empresa_id', empresaId).order('solicitado_em', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) { console.warn('solicitacoes:', error.message); return []; }
    return data || [];
  }
  async function resolverExclusao(id, aprovar) {
    if (!cli || !empresaId) throw new Error('sem nuvem');
    const { data, error } = await cli.rpc('resolver_exclusao', { p_id: id, p_aprovar: !!aprovar });
    if (error) throw new Error(error.message);
    Object.keys(_cache).forEach(k => delete _cache[k]);   // registro apagado → cache velho
    return data;
  }

  // Quando o robô da nuvem atualizou os dados do TOTEM pela última vez? (o mais recente dos 4)
  // É o sinal de vida do robô: se passar de ~2h, alguma coisa está errada.
  async function ultimaAtualizacaoTotem() {
    if (!cli || !empresaId) return null;
    const { data, error } = await cli.from('arquivos_totem')
      .select('atualizado_em').order('atualizado_em', { ascending: false }).limit(1);
    if (error || !data || !data.length) return null;
    return new Date(data[0].atualizado_em);
  }

  // Marcadores compartilhados entre aparelhos (ex.: assinatura da última importação de vendas —
  // evita que PC e celular importem o mesmo arquivo em duplicidade). Vivem na tabela overlays.
  async function lerMarcador(campo) {
    if (!cli || !empresaId) return null;
    const { data } = await cli.from('overlays').select('valor').eq('campo', campo).limit(1);
    return (data && data[0]) ? data[0].valor : null;
  }
  async function gravarMarcador(campo, valor) {
    if (!cli || !empresaId) return;
    await cli.from('overlays').upsert({ empresa_id: empresaId, campo, valor, atualizado_em: new Date().toISOString() });
  }

  // ---------- convite de pessoas (tela Usuários) ----------
  // Fala com a Edge Function `convidar`, que é quem tem a chave de administrador.
  // O navegador NUNCA cria usuário — ele só pede, com o token de quem está logado,
  // e a função confere do lado de lá se quem pediu é dono. Ver
  // supabase/functions/convidar/index.ts.
  async function _chamarConvidar(corpo) {
    if (!cli) throw new Error('Sem conexão com a nuvem.');
    const { data: { session } } = await cli.auth.getSession();
    if (!session) throw new Error('Sessão expirada. Entre de novo.');
    let r;
    try {
      r = await fetch(String(NUVEM_CONFIG.url).replace(/\/+$/, '') + '/functions/v1/convidar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: NUVEM_CONFIG.anonKey,
                   Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify(corpo)
      });
    } catch (e) { throw new Error('Sem internet ou o servidor não respondeu.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.erro) throw new Error(j.erro || ('Falhou (código ' + r.status + ').'));
    return j;
  }
  const convidarPessoa = (email, papel, loja) => _chamarConvidar({ email, papel, loja });
  const listarPessoas  = () => _chamarConvidar({ acao: 'listar' }).then(j => j.pessoas || []);
  const removerAcesso  = (email) => _chamarConvidar({ acao: 'remover', email });

  return { configurada, entrar, sair, DB: DBN, puxarOverlays, observarOverlays,
           empurrarOverlays, usuarioEmail: () => email, papel: () => papel, minhaLoja: () => minhaLoja,
           ativa: () => !!(cli && empresaId), lerArquivo, lerMarcador, gravarMarcador,
           ultimaAtualizacaoTotem, dispararRobo, restaurarStore, lerLojas, salvarLoja,
           souAdminPlataforma, lerSuporte, liberarSuporte, cortarSuporte, acessosSuporte,
           adminResumo, registrarAcessoSuporte, entrarNoSuporte, sairDoSuporte, noSuporte,
           suporteVenceEm: () => suporteAte, empresaAberta: () => empresaId,
           solicitarExclusao, listarSolicitacoes, resolverExclusao,
           convidarPessoa, listarPessoas, removerAcesso,
           recuperacaoNaURL, telaTrocarSenha,
           // exposta só para TESTE da fusão de overlays (nenhuma tela chama isto)
           _fundir3 };
})();
