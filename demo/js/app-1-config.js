/* ================================================================================================
   ARQUITETURA DO APP — leia antes de mexer (atualizado jul/2026)

   Um único arquivo por DECISÃO (roda no duplo clique, sem build/Node). Para crescer sem virar nó,
   o código segue CAMADAS — respeite-as ao adicionar código novo:

   1. CONFIG / DADOS-BASE ..... FICHA_TECNICA, MAPEAMENTO_TOTEM(_SKU), CONVERSAO, CUSTOS, massa,
                                personalizações (overlay em localStorage). Nada de UI aqui.
   2. DOMÍNIO (as CONTAS) ..... funções que calculam, sem mexer no DOM: contarPizzas,
                                calcConsumoPeriodo, calcDivergencias (MOTOR central de consumo),
                                cmvCeoInventario, faturamentoFormas, custoPagoIng/custoAtualIng,
                                custoFichaSabor, vendasDaJanela, sangriasDRE, dreCustosTotal.
                                → É a camada que VIAJA para o futuro SaaS multi-loja.
   3. PERSISTÊNCIA ............ openDB/DB (IndexedDB PizzaParaVoce_v2), cfgGet/Set, snapshots
                                (localStorage), backup (montarBackupObj/importarDados).
   4. UI POR PÁGINA ........... um renderXxx por page-* + helpers de tela (só estes leem o DOM).

   REGRAS DE OURO (é assim que as telas continuam batendo entre si):
   • Número oficial tem UMA fonte: faturamento = faturamentoFormas() · CMV/perda/furo =
     calcDivergencias (via cmvCeoInventario) · pizzas de uma janela = vendasDaJanela().
     NUNCA reimplemente essas contas dentro de uma tela — chame a função. Cada vez que uma tela
     refez a conta por conta própria, os números divergiram (bench e compest, corrigidos jul/2026).
   • Modal novo vai no bloco de modais no fim do <body>, NUNCA dentro de uma .page (backdrop cobre).
   • Ficha/custo/conversão se edita pela página Fichas & Insumos (overlay), não hard-code no HTML.
   • O MOTOR aceita dados injetados: calcDivergencias/cmvCeoInventario/cmvPeriodoCEO recebem um 4º
     parâmetro opcional `dados` ({contagens,vendas,compras,transferencias}) — é assim que o autoteste
     testa as contas sem tocar no banco, e é o contrato p/ a lógica rodar num servidor no futuro.
   • Overlay novo de localStorage que precisa viajar no backup: adicionar UMA linha em BACKUP_CAMPOS
     (perto de montarBackupObj) — exportar e restaurar leem essa tabela; não voltar ao campo-a-campo.
   • Depois de QUALQUER mudança: atualizar CLAUDE.md + memória e copiar p/ a pasta Publicar.
   ================================================================================================ */
// ================================================================
// 1. DADOS DE CONFIGURAÇÃO EMBUTIDOS
// ================================================================
let FICHA_TECNICA = {
  "AMERICANA":{"_ingredientes":{"Catupiry":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Presunto":100,"Trigo":250}},
  "BACON":{"_ingredientes":{"Bacon":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "BACON CHEDAR":{"_ingredientes":{"Bacon":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Cheddar":100,"Trigo":250}},
  "BACON CROCANTE":{"_ingredientes":{"Bacon":100,"Batata Palha":90,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "BACON MILHO":{"_ingredientes":{"Bacon":100,"Milho verde":80,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "BRIGADEIRO":{"_ingredientes":{"Chocolate preto":250,"Orégano":0.1,"Granulado":0.07,"Creme de leite":50,"Trigo":250}},
  "CAIPIRA":{"_ingredientes":{"Frango":100,"Milho verde":80,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "CALABRESA":{"_ingredientes":{"Calabresa":150,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "CATUPALHA":{"_ingredientes":{"Catupiry":100,"Batata Palha":90,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "CHOCOLATE BRANCO":{"_ingredientes":{"Chocolate branco":300,"Creme de leite":50,"Trigo":250}},
  "CHOCOLATE PRETO":{"_ingredientes":{"Chocolate preto":300,"Creme de leite":50,"Trigo":250}},
  "CHURROS":{"_ingredientes":{"Creme de leite":50,"Doce de leite":250,"Trigo":250}},
  "DOIS AMORES":{"_ingredientes":{"Chocolate branco":150,"Chocolate preto":150,"Molho":50,"Mussarela":130,"Creme de leite":50,"Trigo":250}},
  "ESPECIAL":{"_ingredientes":{"Frango":100,"Bacon":100,"Catupiry":100,"Batata Palha":80,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "FRANGO":{"_ingredientes":{"Frango":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "FRANGO CHEDAR":{"_ingredientes":{"Frango":100,"Orégano":0.1,"Molho":100,"Mussarela":130,"Cheddar":100,"Trigo":250}},
  "FRANGO CATUPIRY":{"_ingredientes":{"Frango":100,"Catupiry":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "FRANGO CROCANTE":{"_ingredientes":{"Frango":100,"Batata Palha":90,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "LOMBO":{"_ingredientes":{"Orégano":0.1,"Molho":50,"Mussarela":130,"Lombo":100,"Trigo":250}},
  "LOMBO COM CATUPIRY":{"_ingredientes":{"Catupiry":100,"Orégano":0.1,"Molho":50,"Mussarela":130,"Lombo":100,"Trigo":250}},
  "LOMBO COM CHEDDAR":{"_ingredientes":{"Orégano":0.1,"Molho":50,"Mussarela":130,"Cheddar":100,"Lombo":100,"Trigo":250}},
  "MILHO":{"_ingredientes":{"Milho verde":160,"Orégano":0.1,"Molho":50,"Mussarela":130,"Trigo":250}},
  "MUSSARELA":{"_ingredientes":{"Orégano":0.01,"Molho":50,"Mussarela":200,"Trigo":250}},
  "PORTUGUESA":{"_ingredientes":{"Orégano":0.01,"Molho":50,"Mussarela":130,"Presunto":100,"Trigo":250,"Ovo":1,"Cebola":50}},
  "QUATRO QUEIJOS":{"_ingredientes":{"Catupiry":100,"Provolone":50,"Parmesão":50,"Orégano":0.01,"Molho":50,"Mussarela":130,"Trigo":250}},
  "BAIANA":{"_ingredientes":{"Calabresa":150,"Orégano":0.2,"Molho":50,"Mussarela":180,"Trigo":250,"Cebola":100,"Pimenta Calabresa":0.2}},
  "CALABRESA COM CREAM CHEESE":{"_ingredientes":{"Calabresa":150,"Orégano":0.2,"Molho":50,"Mussarela":180,"Trigo":250,"Cream Cheese":100}},
  "CANADENSE":{"_ingredientes":{"Orégano":0.2,"Molho":50,"Mussarela":180,"Lombo":130,"Trigo":250,"Cream Cheese":100,"Champignon":30}},
  "CINCO QUEIJOS":{"_ingredientes":{"Catupiry":120,"Provolone":25,"Parmesão":25,"Orégano":0.2,"Molho":50,"Mussarela":180,"Trigo":250,"Gorgonzola":30}},
  "FRANGO CREMOSO":{"_ingredientes":{"Frango":100,"Orégano":0.2,"Molho":50,"Mussarela":180,"Creme de leite":50,"Trigo":250,"Cream Cheese":100}},
  "DA CASA":{"_ingredientes":{"Frango":100,"Bacon":80,"Orégano":0.2,"Molho":50,"Mussarela":180,"Creme de leite":50,"Trigo":250,"Cream Cheese":100,"Champignon":30}},
  "FRANGO MAROMBA":{"_ingredientes":{"Frango":200,"Orégano":0.2,"Molho":50,"Mussarela":180,"Creme de leite":50,"Trigo":250}},
  "PEPPERONI (NOVO)":{"_ingredientes":{"Orégano":0.2,"Molho":50,"Mussarela":180,"Trigo":250,"Pepperoni":100}},
  "PEPPERONI ESPECIAL":{"_ingredientes":{"Orégano":0.2,"Molho":50,"Mussarela":180,"Trigo":250,"Cream Cheese":100,"Champignon":30,"Pepperoni":100}},
  "ROMEU E JULIETA":{"_ingredientes":{"Mussarela":180,"Creme de leite":50,"Trigo":250,"Goiabada":150}}
};

const MAPEAMENTO_TOTEM = {
  "46":{"categoria":"ADICIONAL","adicional_ingrediente":"BACON","porcao_gramas":100},
  "48":{"categoria":"ADICIONAL","adicional_ingrediente":"CALABRESA","porcao_gramas":150},
  "49":{"categoria":"ADICIONAL","adicional_ingrediente":"CATUPIRY","porcao_gramas":100},
  "55":{"categoria":"ADICIONAL","adicional_ingrediente":"CHEDDAR","porcao_gramas":100},
  "52":{"categoria":"ADICIONAL","adicional_ingrediente":"MUSSARELA","porcao_gramas":130},
  "865":{"categoria":"ADICIONAL","adicional_ingrediente":"GORGONZOLA","porcao_gramas":30},
  "105":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "104":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "106":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "107":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "109":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "108":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "110":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "39":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "85":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "38":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "68":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "96":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "843":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "844":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "622":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"AMERICANA"},
  "23":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON"},
  "43":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON CHEDAR"},
  "24":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON MILHO"},
  "25":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON CROCANTE"},
  "18":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CAIPIRA"},
  "17":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CALABRESA"},
  "21":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CATUPALHA"},
  "27":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHOCOLATE BRANCO"},
  "28":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHOCOLATE PRETO"},
  "103":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHURROS"},
  "29":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"DOIS AMORES"},
  "92":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"ESPECIAL"},
  "45":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CHEDAR"},
  "20":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CATUPIRY"},
  "19":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CROCANTE"},
  "91":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BRIGADEIRO"},
  "114":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO"},
  "115":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO COM CATUPIRY"},
  "683":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO COM CHEDDAR"},
  "16":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"MILHO"},
  "22":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"MUSSARELA"},
  "829":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PORTUGUESA"},
  "26":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"QUATRO QUEIJOS"},
  "856":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CALABRESA COM CREAM CHEESE"},
  "857":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CANADENSE"},
  "858":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CINCO QUEIJOS"},
  "860":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CREMOSO"},
  "859":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"DA CASA"},
  "862":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PEPPERONI ESPECIAL"},
  "863":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PEPPERONI (NOVO)"},
  "621":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"AMERICANA"},
  "9":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON"},
  "42":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON CHEDAR"},
  "10":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON MILHO"},
  "89":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BRIGADEIRO"},
  "4":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CAIPIRA"},
  "3":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CALABRESA"},
  "7":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CATUPALHA"},
  "13":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE BRANCO"},
  "14":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE PRETO"},
  "102":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHURROS"},
  "15":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"DOIS AMORES"},
  "90":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"ESPECIAL"},
  "44":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CHEDAR"},
  "6":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CATUPIRY"},
  "5":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CROCANTE"},
  "112":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO"},
  "113":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO COM CATUPIRY"},
  "682":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO COM CHEDDAR"},
  "8":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"MUSSARELA"},
  "828":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"PORTUGUESA"},
  "11":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON CROCANTE"},
  "12":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"QUATRO QUEIJOS"},
  "848":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"CINCO QUEIJOS"},
  "852":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"FRANGO CREMOSO"},
  "850":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"PEPPERONI ESPECIAL"},
  "854":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"PEPPERONI (NOVO)"},
  "30":{"categoria":"BEBIDA","bebida_estoque":"COCA NORMAL 2L"},
  "81":{"categoria":"BEBIDA","bebida_estoque":"COCA ZERO 2L"},
  "71":{"categoria":"BEBIDA","bebida_estoque":"GUARANA 1,5L"},
  "800":{"categoria":"BEBIDA","bebida_estoque":"GUARANA 1,5L Z"},
  "62":{"categoria":"BEBIDA","bebida_estoque":"GUARANA 2L"},
  "99":{"categoria":"BEBIDA","bebida_estoque":"KUAT"},
  "35":{"categoria":"BEBIDA","bebida_estoque":"KUAT"}
};

// Mapeamento por SKU (codigo estruturado do TOTEM: PI/PM=inteira/meia, PPI/PPM=premium,
// AA=adicional, RF=refri, CO/JT/PZ=agrupador). O sku e UNICO e ESTAVEL entre as 3 lojas e
// vem direto na linha de venda (vw_pedidos_itens.sku) — chave mais segura que o id, que
// muda com o tempo e difere entre lojas. Gerado do MAPEAMENTO_TOTEM via de-para id->sku.
// Itens ambiguos (sku divergente entre lojas, ou colisao) NAO entram aqui de proposito —
// caem no fallback por id (lookupMapeamento), preservando o comportamento atual.
const MAPEAMENTO_TOTEM_SKU = {
  "AA001":{"categoria":"ADICIONAL","adicional_ingrediente":"BACON","porcao_gramas":100},
  "AA005":{"categoria":"ADICIONAL","adicional_ingrediente":"CALABRESA","porcao_gramas":150},
  "AA006":{"categoria":"ADICIONAL","adicional_ingrediente":"CATUPIRY","porcao_gramas":100},
  "AA007":{"categoria":"ADICIONAL","adicional_ingrediente":"CHEDDAR","porcao_gramas":100},
  "AA012":{"categoria":"ADICIONAL","adicional_ingrediente":"MUSSARELA","porcao_gramas":130},
  "AA032":{"categoria":"ADICIONAL","adicional_ingrediente":"GORGONZOLA","porcao_gramas":30},
  "CO006":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO010":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO011":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO012":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO014":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO016":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO021":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "JT001":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "PI001":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON"},
  "PI002":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON CHEDAR"},
  "PI003":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON CROCANTE"},
  "PI004":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON MILHO"},
  "PI005":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BRIGADEIRO"},
  "PI006":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CAIPIRA"},
  "PI007":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CALABRESA"},
  "PI008":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CATUPALHA"},
  "PI009":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE BRANCO"},
  "PI010":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE PRETO"},
  "PI012":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"DOIS AMORES"},
  "PI013":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"ESPECIAL"},
  "PI015":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CATUPIRY"},
  "PI016":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CHEDAR"},
  "PI017":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CROCANTE"},
  "PI018":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO"},
  "PI019":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO COM CATUPIRY"},
  "PI021":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"MUSSARELA"},
  "PI022":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"QUATRO QUEIJOS"},
  "PI023":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"LOMBO COM CHEDDAR"},
  "PI025":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHURROS"},
  "PI033":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"AMERICANA"},
  "PM001":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON"},
  "PM002":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON CHEDAR"},
  "PM003":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON CROCANTE"},
  "PM004":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BACON MILHO"},
  "PM005":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BRIGADEIRO"},
  "PM006":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CAIPIRA"},
  "PM007":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CALABRESA"},
  "PM008":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CATUPALHA"},
  "PM009":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHOCOLATE BRANCO"},
  "PM010":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHOCOLATE PRETO"},
  "PM012":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"DOIS AMORES"},
  "PM013":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"ESPECIAL"},
  "PM015":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CATUPIRY"},
  "PM016":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CHEDAR"},
  "PM017":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CROCANTE"},
  "PM018":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO"},
  "PM019":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO COM CATUPIRY"},
  "PM020":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"MILHO"},
  "PM021":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"MUSSARELA"},
  "PM022":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"QUATRO QUEIJOS"},
  "PM023":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"LOMBO COM CHEDDAR"},
  "PM025":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CHURROS"},
  "PM030":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"AMERICANA"},
  "PPI04":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"CINCO QUEIJOS"},
  "PPI06":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"FRANGO CREMOSO"},
  "PPI08":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"PEPPERONI ESPECIAL"},
  "PPI09":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"PEPPERONI (NOVO)"},
  "PPM02":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CALABRESA COM CREAM CHEESE"},
  "PPM03":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CANADENSE"},
  "PPM04":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"CINCO QUEIJOS"},
  "PPM05":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"DA CASA"},
  "PPM06":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO CREMOSO"},
  "PPM08":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PEPPERONI ESPECIAL"},
  "PPM09":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PEPPERONI (NOVO)"},
  "PPZ01":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "PPZ02":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "PZ001":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "PZ002":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "PZ003":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF014":{"categoria":"BEBIDA","bebida_estoque":"COCA NORMAL 2L"},
  "RF015":{"categoria":"BEBIDA","bebida_estoque":"COCA ZERO 2L"},
  "RF018":{"categoria":"BEBIDA","bebida_estoque":"KUAT"},
  "RF043":{"categoria":"BEBIDA","bebida_estoque":"GUARANA 2L"},
  // Completados 18/06 do catálogo vivo das 3 lojas — sabores com casamento EXATO na ficha
  // (inclui Portuguesa nas 3 lojas, Milho, Frango, promos que reduzem ao sabor base) + bebidas VN.
  "PI048":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"PORTUGUESA"},
  "PM034":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PORTUGUESA"},
  "PI020":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"MILHO"},
  "PI014":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO"},
  "PM014":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO"},
  "PI037":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON MILHO"},
  "PI035":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON MILHO"},
  "PI036":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"BACON MILHO"},
  "PI034":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"AMERICANA"},
  "PI032":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"AMERICANA"},
  "PI039":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"DOIS AMORES"},
  "PI029":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CALABRESA"},
  "PI038":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CROCANTE"},
  "PI041":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE PRETO"},
  "PI040":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"CHOCOLATE BRANCO"},
  "PI043":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"QUATRO QUEIJOS"},
  "PPI02":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"CALABRESA COM CREAM CHEESE"},
  "PPI05":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"DA CASA"},
  "PPI03":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"CANADENSE"},
  "PPI10":{"categoria":"PREMIUM","fator_consumo":1.0,"nome_ficha":"ROMEU E JULIETA"},
  "PPM01":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"BAIANA"},
  "PPM07":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"FRANGO MAROMBA"},
  "PPM10":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"ROMEU E JULIETA"},
  "RF029":{"categoria":"BEBIDA","bebida_estoque":"COCA NORMAL 1L"},
  "RF047":{"categoria":"BEBIDA","bebida_estoque":"COCA ZERO 1L"},
  "AG001":{"categoria":"BEBIDA","bebida_estoque":"AGUA SEM GAS"},
  "AG002":{"categoria":"BEBIDA","bebida_estoque":"AGUA COM GAS"},
  // Decisões do Gabriel (18/06): pepperoni comum = ficha "PEPPERONI (NOVO)"; frango c/ catupiry = FRANGO CATUPIRY;
  // mussarela 20 e sucos VN (sku numérico); combos = duplicidade (o sabor vem em linha separada) -> ignorar;
  // bebidas extras (tropical/cini/2,5L/600ml/cerveja) -> ignorar. Dogão/Fini/adicionais ficam p/ ele mapear na tela.
  "PI049":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"PEPPERONI (NOVO)"},
  "PM035":{"categoria":"MEIA","fator_consumo":0.5,"nome_ficha":"PEPPERONI (NOVO)"},
  "PI031":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"FRANGO CATUPIRY"},
  "835":{"categoria":"INTEIRA","fator_consumo":1.0,"nome_ficha":"MUSSARELA"},
  "838":{"categoria":"BEBIDA","bebida_estoque":"SUCO UVA"},
  "837":{"categoria":"BEBIDA","bebida_estoque":"SUCO PESSEGO"},
  "CO015":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO004":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO033":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO009":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CO008":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF037":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF007":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF010":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF008":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF044":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "RF023":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  "CE016":{"categoria":"AGRUPADOR","ignorar_no_consumo":true},
  // Guaraná 1,5L: no TOTEM o sku RF042 serve o normal E o zero (mesmo código). Mapeado como normal
  // (~96% do volume); ~181 un de zero entram como normal (desprezível). Necessário p/ o item resolver
  // pelo sku sem depender do id (id-lock).
  "RF042":{"categoria":"BEBIDA","bebida_estoque":"GUARANA 1,5L"}
};

const CONVERSAO = {
  "itens_kg_direto":["MUSSARELA","BACON","CALABRESA","PROVOLONE","PARMESAO","PRESUNTO","FRANGO","GORGONZOLA","CEBOLA"],
  "conversao_caixa":{
    "LOMBO":{"un_por_caixa":1,"qtd_por_un":0.8,"unidade":"KG"},
    "CHEDDAR":{"un_por_caixa":10,"qtd_por_un":1.2,"unidade":"KG","rotulo":"unidade"},
    "CATUPIRY":{"un_por_caixa":10,"qtd_por_un":1.8,"unidade":"KG","rotulo":"unidade"},
    "CATUPIRY PURO":{"un_por_caixa":1,"qtd_por_un":1.8,"unidade":"KG"},
    "MOLHO":{"un_por_caixa":6,"qtd_por_un":2.0,"unidade":"KG"},
    "CHOCOLATE PRETO":{"un_por_caixa":8,"qtd_por_un":1.01,"unidade":"KG"},
    "CHOCOLATE BRANCO":{"un_por_caixa":8,"qtd_por_un":1.01,"unidade":"KG"},
    "DOCE DE LEITE":{"un_por_caixa":25,"qtd_por_un":1.0,"unidade":"KG"},
    "MILHO":{"un_por_caixa":6,"qtd_por_un":1.7,"unidade":"KG"},
    "BATATA PALHA":{"un_por_caixa":15,"qtd_por_un":1.0,"unidade":"KG","rotulo":"fardo"},
    "TRIGO":{"un_por_caixa":10,"qtd_por_un":1.0,"unidade":"KG","rotulo":"kg"},
    "OLEO":{"un_por_caixa":6,"qtd_por_un":1.0,"unidade":"UN"},
    "ACUCAR":{"un_por_caixa":5,"qtd_por_un":1.0,"unidade":"KG"},
    "SAL":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"UN"},
    "FERMENTO":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"UN"},
    "OREGANO":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"KG"},
    "CREME DE LEITE":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"UN"},
    "GRANULADO":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"UN"},
    "CAIXA DE PIZZA":{"un_por_caixa":50,"qtd_por_un":1.0,"unidade":"UN"},
    "OVO":{"un_por_caixa":30,"qtd_por_un":1.0,"unidade":"UN","rotulo":"pente"},
    "CREAM CHEESE":{"un_por_caixa":1,"qtd_por_un":1.01,"unidade":"KG"},
    "PEPPERONI":{"un_por_caixa":1,"qtd_por_un":0.5,"unidade":"KG"},
    "PIMENTA CALABRESA":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"KG"},
    "CHAMPIGNON":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"KG"},
    "WHEY":{"un_por_caixa":1,"qtd_por_un":1.0,"unidade":"KG"},
    "CAIXA PREMIUM":{"un_por_caixa":1,"qtd_por_un":100.0,"unidade":"UN"}
  },
  "refrigerantes":{
    "COMUNS_TODAS_LOJAS":{
      "COCA NORMAL 2L":{"un_por_fardo":8},
      "COCA ZERO 2L":{"un_por_fardo":8},
      "KUAT":{"un_por_fardo":8},
      "GUARANA 2L":{"un_por_fardo":6},
      "GUARANA 1,5L":{"un_por_fardo":6},
      "GUARANA 1,5L Z":{"un_por_fardo":6}
    },
    "EXCLUSIVOS_VENDA_NOVA":{
      "COCA NORMAL 1L":{"un_por_fardo":6},
      "COCA ZERO 1L":{"un_por_fardo":6},
      "AGUA COM GAS":{"un_por_fardo":6},
      "AGUA SEM GAS":{"un_por_fardo":6},
      "SUCO UVA":{"un_por_fardo":6},
      "SUCO PESSEGO":{"un_por_fardo":6}
    }
  }
};

let CUSTOS = {
  "BACON":22.08,"CALABRESA":17.9895,"PRESUNTO":14.9902,"CHEDDAR":16.99,
  "CATUPIRY":16.5,"LOMBO":31.9718,"MUSSARELA":31.9357,"PROVOLONE":43.9999,
  "PARMESAO":41.0701,"FRANGO":24.1985,"MOLHO":11.8821,"KUAT":5.368,
  "COCA NORMAL":9.7393,"COCA ZERO":9.7469,"MILHO":23.99,"CEBOLA":3.99,
  "OVO":0.7996,"PEPPERONI":44.9,"PEPERONI":44.9,"TRIGO":3.477,
  "CATUPIRY PURO":47.5,"CREAM CHEESE":34.5,"CHOCOLATE PRETO":27.01,
  "CHOCOLATE BRANCO":36.86,"GORGONZOLA":43.9999,
  // Embalagens (R$ por UNIDADE/caixa). Placeholder — o custo real vem das suas COMPRAS
  // de caixas (custoAtualIng) ou pode ser ajustado em Cardápio & Fichas > Insumos.
  "CAIXA DE PIZZA":1.30,"CAIXA PREMIUM":2.20
};

// ================================================================
// 1B. MAPEAMENTO TOTEM CUSTOMIZÁVEL (definido pelo usuário) + CONTAGEM DE PIZZAS
// ================================================================
const MAP_CUSTOM_KEY = 'mapeamento_totem_custom';
let _mapCustomCache = null;
function getMapCustom() {
  if (_mapCustomCache) return _mapCustomCache;
  try { _mapCustomCache = JSON.parse(localStorage.getItem(MAP_CUSTOM_KEY)) || {}; }
  catch(e) { _mapCustomCache = {}; }
  return _mapCustomCache;
}
function setMapCustom(m) { _mapCustomCache = m; localStorage.setItem(MAP_CUSTOM_KEY, JSON.stringify(m)); }

// Resolve o código TOTEM por ID: prioridade para o que o usuário mapeou manualmente.
// (Reserva — usado quando não há sku, ex.: CSV antigo / histórico.)
function lookupMapeamento(codigo) {
  const c = String(codigo);
  return getMapCustom()[c] || MAPEAMENTO_TOTEM[c] || null;
}

// Resolve o mapeamento de um ITEM de venda. Prioridade:
//   custom[sku] → custom[id] → embutido[sku] → embutido[id] → null
// O SKU (codigo estruturado, ex.: PI007) é único/estável entre lojas e é a chave
// preferida; o ID continua como reserva para dados sem sku. O mapeamento do
// usuário (custom) sempre vence, por qualquer das duas chaves.
function resolverMap(item) {
  if (!item) return null;
  const cust = getMapCustom();
  const sku = (item.sku!=null && String(item.sku).trim()) ? String(item.sku).trim() : null;
  const cId = (item.codigo!=null) ? String(item.codigo) : null;
  if (sku) {
    // ID-LOCK: item COM sku resolve SÓ pelo sku (chave única/estável entre lojas).
    // NUNCA cai no id — o id é reusado entre lojas (mesmo id = produto diferente), então
    // usá-lo aqui reintroduziria o erro de troca de produto. Sem mapa = pendente (correto).
    if (cust[sku]) return cust[sku];
    if (MAPEAMENTO_TOTEM_SKU[sku]) return MAPEAMENTO_TOTEM_SKU[sku];
    // Rede de segurança pelo PREFIXO — só agrupadores (JT/PZ/PPZ são SEMPRE ignorados).
    if (/^(PPZ|PZ|JT)/.test(sku)) return {categoria:'AGRUPADOR', ignorar_no_consumo:true, _auto:'prefixo'};
    return null;
  }
  // Item SEM sku (CSV antigo / importação de histórico): caminho por id (reserva).
  return (cId && cust[cId]) || (cId && MAPEAMENTO_TOTEM[cId]) || null;
}

// Migração única, não-destrutiva: copia mapeamentos manuais feitos por ID para a chave SKU
// correspondente, para continuarem valendo agora que item-com-sku resolve só por sku.
// Só copia quando o id↔sku é INEQUÍVOCO nas vendas e o sku ainda não está mapeado. Nunca apaga.
async function migrarCustomParaSku() {
  try {
    if (localStorage.getItem('map_custom_sku_migrado_v1')) return;
    const cust = getMapCustom();
    const idKeys = Object.keys(cust).filter(k => /^\d+$/.test(k)); // chaves numéricas = id antigo
    if (idKeys.length) {
      const vendas = await DB.getAll('vendas');
      const id2sku = {};
      for (const v of vendas) for (const it of (v.itens || [])) {
        if (it.sku && it.codigo != null) {
          const id = String(it.codigo);
          (id2sku[id] = id2sku[id] || new Set()).add(String(it.sku).trim());
        }
      }
      let copiados = 0;
      for (const id of idKeys) {
        const skus = id2sku[id];
        if (skus && skus.size === 1) {            // só se NÃO ambíguo entre lojas
          const sku = [...skus][0];
          if (!cust[sku]) { cust[sku] = cust[id]; copiados++; }
        }
      }
      if (copiados) { setMapCustom(cust); }
    }
    localStorage.setItem('map_custom_sku_migrado_v1', '1');
  } catch (e) { /* não bloqueia a abertura do app */ }
}

// Palpite de categoria pelo prefixo do sku (TOTEM). Verificado contra o grupo do PDV nas 3
// lojas: PI/PR=inteira, PM=meia, PPI=premium, PPM=meia premium, AA=adicional, RF/AG/CE=bebida,
// JT/PZ/PPZ=agrupador. CO é MISTO (combo/pizza/adicional) → sem palpite. Usado só p/ pré-
// preencher o formulário de "Mapear Produtos" (o usuário confirma o sabor/ingrediente).
function categoriaPorPrefixoSku(sku) {
  if (!sku) return null;
  const s = String(sku).trim().toUpperCase();
  if (/^(PPZ|PZ|JT)/.test(s)) return 'AGRUPADOR';
  if (/^PPI/.test(s)) return 'PREMIUM';
  if (/^PPM/.test(s)) return 'MEIA';
  if (/^PM/.test(s)) return 'MEIA';
  if (/^(PI|PR)/.test(s)) return 'INTEIRA';
  if (/^AA/.test(s)) return 'ADICIONAL';
  if (/^(RF|AG|CE)/.test(s)) return 'BEBIDA';
  return null;   // CO (misto) e numéricos: sem palpite
}

// Conta pizzas pelos SABORES: meia = 0,5 / inteira = 1 / premium = 1.
// Combos, "2 sabores", "pizza do dia", "grande 1 sabor" etc. são AGRUPADOR e NÃO entram.
function contarPizzas(itens) {
  return (itens||[]).reduce((s,i)=>{
    const m = resolverMap(i);
    if (m && ['MEIA','INTEIRA','PREMIUM'].includes(m.categoria)) return s + i.qtde * (m.fator_consumo||1);
    return s;
  }, 0);
}
function contarBebidas(itens) {
  return (itens||[]).reduce((s,i)=>{
    const m = resolverMap(i);
    if (m && m.categoria==='BEBIDA') return s + i.qtde;
    return s;
  }, 0);
}
function fmtPizzas(x) { return Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.',','); }

// ================================================================
// 2. HELPERS DE NORMALIZAÇÃO
// ================================================================
function norm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().trim();
}
const ALIASES_ING = {
  'MILHO VERDE':'MILHO','OREGANO':'OREGANO','PARMESAO':'PARMESAO',
  'PEPERONI':'PEPPERONI','WHEY PROTEIN':'WHEY',
  'CHOCOLATE PRETO ING':'CHOCOLATE PRETO',
  'CHOCOLATE BRANCO ING':'CHOCOLATE BRANCO'
};
function normIng(s) { const n=norm(s); return ALIASES_ING[n]||n; }

// Nomes criados pelo usuário (pizzas/insumos) não podem ter aspas ou <> — quebrariam o HTML gerado
function nomeSeguro(s) { return norm(s).replace(/["'<>\\`]/g,'').trim(); }

let ITENS_KG_DIRETO = new Set(CONVERSAO.itens_kg_direto);

// Build refrigerante lookup
let REFRIG_LOOKUP = {};
for (const [grp,items] of Object.entries(CONVERSAO.refrigerantes)) {
  for (const [nome,data] of Object.entries(items)) {
    REFRIG_LOOKUP[norm(nome)] = data;
  }
}

function converterContagem(ing, caixas, unidades) {
  const n = norm(ing);
  caixas = parseFloat(caixas)||0;
  unidades = parseFloat(unidades)||0;

  if (ITENS_KG_DIRETO.has(n)) return {total: caixas + unidades, unidade:'KG'};

  if (REFRIG_LOOKUP[n]) {
    return {total: caixas * REFRIG_LOOKUP[n].un_por_fardo + unidades, unidade:'UN'};
  }

  const c = CONVERSAO.conversao_caixa[n];
  if (c) {
    return {total: caixas * c.un_por_caixa * c.qtd_por_un + unidades * c.qtd_por_un, unidade: c.unidade};
  }

  return {total: caixas + unidades, unidade:'UN'};
}

function getUnidadeIngrediente(ing) {
  const n = norm(ing);
  if (ITENS_KG_DIRETO.has(n)) return 'KG';
  if (REFRIG_LOOKUP[n]) return 'UN';
  const c = CONVERSAO.conversao_caixa[n];
  return c ? c.unidade : 'UN';
}

// Ingredientes contados/usados em UNIDADE (não em gramas): ovo e caixa de pizza.
// Nas fichas e nos adicionais o número é em unidades, não em gramas (não divide por 1000).
// Cebola saiu daqui (jun/2026): passou a ser controlada em KG/gramas como os demais frios.
function ingEmUnidade(n) { return ['OVO','CAIXA'].includes(normIng(n)); }

function getLabelCaixas(ing) {
  const n = norm(ing);
  if (ITENS_KG_DIRETO.has(n)) return 'kg inteiros';
  if (REFRIG_LOOKUP[n]) return 'fardos';
  if (ehAtendimento(n)) return 'pacotes';
  return 'caixas';
}

function getLabelUnidades(ing) {
  const n = norm(ing);
  if (ITENS_KG_DIRETO.has(n)) return 'kg restante';
  if (REFRIG_LOOKUP[n]) return 'un soltas';
  const c = CONVERSAO.conversao_caixa[n];
  if (c) return c.unidade === 'KG' ? 'un soltas → kg' : 'unid. soltas';
  return 'unidades';
}

// Converte uma quantidade da unidade-base (kg/un) para a unidade de COMPRA
// (kg p/ itens comprados em kg; balde/un p/ catupiry, cheddar, molho…; fardo
// p/ refrigerantes). Usado na Previsão para mostrar "como o Gabriel compra".
function qtdEmUnidadeCompra(ing, qtdBase) {
  const n = norm(ing);
  if (ITENS_KG_DIRETO.has(n)) return {valor: qtdBase, unidade: 'kg'};
  if (REFRIG_LOOKUP[n]) {
    const f = REFRIG_LOOKUP[n].un_por_fardo || 1;
    return {valor: qtdBase / f, unidade: f>1 ? 'fardos' : 'un'};
  }
  const c = CONVERSAO.conversao_caixa[n];
  if (c && c.unidade === 'KG') return {valor: qtdBase / (c.qtd_por_un||1), unidade: 'un'};
  return {valor: qtdBase, unidade: 'un'};
}

function getCustoIng(ing) {
  const n = normIng(ing);
  return CUSTOS[n] || CUSTOS[n.replace(/ \d+L.*$/,'')] || 0;
}

// Custo EFETIVO do insumo (R$ por unidade-base) = o que foi REALMENTE pago.
// Regra (pedido do Gabriel, jun/2026 — vale para CMV, custo/pizza, desperdício, valor em estoque):
//   1) há compra(s) do insumo no período [ini,fim] (na loja) → média ponderada R$/base (R$ ÷ kg)
//   2) senão → a compra MAIS PRÓXIMA no tempo (mesma loja; se a loja nunca comprou, a rede toda)
//   3) senão (nunca comprou em lugar nenhum) → preço-base cadastrado (getCustoIng)
// `compras` = array completo de compras já carregado. `loja` vazio/null = rede toda (todas as lojas).
// Para "valor em estoque" (foto, não período), chamar com ini=fim=data da contagem → cai no passo 2 (mais próxima).
function custoPagoIng(ing, ini, fim, compras, loja) {
  const base = getCustoIng(ing);
  if (!Array.isArray(compras) || !compras.length) return base;
  const n = normIng(ing);
  const desteIng = compras.filter(c => normIng(c.ingrediente)===n && c.valor_total>0 && c.quantidade_base>0);
  if (!desteIng.length) return base;
  const naLoja = loja ? desteIng.filter(c=>c.loja===loja) : desteIng;
  const pool = naLoja.length ? naLoja : desteIng;   // loja nunca comprou → usa a rede
  const media = arr => { let v=0,q=0; for (const c of arr){ v+=c.valor_total; q+=c.quantidade_base; } return q>0 ? v/q : 0; };
  // 1) compras dentro do período
  const noPeriodo = pool.filter(c => (!ini || c.data>=ini) && (!fim || c.data<=fim));
  if (noPeriodo.length) return media(noPeriodo) || base;
  // 2) compra mais próxima no tempo do período analisado
  const alvo = fim || ini || today();
  let bestData=null, bestDist=Infinity;
  for (const c of pool) {
    const d = Math.abs(new Date(c.data) - new Date(alvo));
    if (d < bestDist) { bestDist=d; bestData=c.data; }
  }
  if (bestData) return media(pool.filter(c=>c.data===bestData)) || base; // média do dia mais próximo
  return base;
}

// Custo ATUAL do insumo (R$ por unidade-base) = o preço que o Gabriel pagou por ÚLTIMO.
// Pedido dele p/ o Painel do CEO: "CMV no valor que paguei no insumo mais recente; se não tiver,
// pelo valor base". Regra: compra mais RECENTE do insumo (mesma loja; se a loja nunca comprou, a
// rede toda; várias no mesmo dia → média do dia) → senão preço-base cadastrado.
function custoAtualIng(ing, compras, loja) {
  const base = getCustoIng(ing);
  if (!Array.isArray(compras) || !compras.length) return base;
  const n = normIng(ing);
  const desteIng = compras.filter(c => normIng(c.ingrediente)===n && c.valor_total>0 && c.quantidade_base>0);
  if (!desteIng.length) return base;
  const naLoja = loja ? desteIng.filter(c=>c.loja===loja) : desteIng;
  const pool = naLoja.length ? naLoja : desteIng;          // loja nunca comprou → usa a rede
  const maxData = pool.reduce((m,c)=> c.data>m ? c.data : m, '');
  let v=0, q=0; for (const c of pool) if (c.data===maxData) { v+=c.valor_total; q+=c.quantidade_base; }
  return q>0 ? v/q : base;
}

// CMV (custo da mercadoria vendida) de um período/loja, a preço ATUAL (mais recente pago).
// Reusa calcConsumoPeriodo (vendas × ficha + massa). loja vazio = soma as 3 (custo é por loja).
// BEBIDAS ficam FORA (auditoria 02/07): são revenda e o motor de Divergências também as separa —
// senão o CMV estimado e o real teriam escopos diferentes e nunca fechariam entre si.
// `dados` (opcional): {vendas, compras} injetados — mesmo contrato de calcDivergencias.
async function cmvPeriodoCEO(loja, ini, fim, dados) {
  // Só as vendas do período (22/09): o filtro abaixo é o MESMO do vendasPeriodo, então o resultado é
  // idêntico — mas o Painel do CEO chamava isto até 20× por abertura e cada chamada varria a tabela inteira.
  const [vendas, compras] = dados
    ? [dados.vendas||[], dados.compras||[]]
    : await Promise.all([DB.vendasPeriodo?DB.vendasPeriodo(ini,fim):DB.getAll('vendas'), DB.getAll('compras')]);
  const lojas = loja ? [loja] : LOJAS_ATIVAS();
  let cmv = 0;
  for (const lj of lojas) {
    const vLj = vendas.filter(v => v.loja===lj && (!ini || v.data_fim>=ini) && (!fim || v.data_inicio<=fim));
    if (!vLj.length) continue;
    const consumo = calcConsumoPeriodo(vLj);
    for (const [ing, qt] of Object.entries(consumo)) {
      if (ehBebida(ing)) continue;
      cmv += qt * custoAtualIng(ing, compras, lj);
    }
  }
  return cmv;
}

// Mesma conta do cmvPeriodoCEO, mas devolve a COMPOSIÇÃO por insumo (para o drill-down do
// "CMV esperado do período"). Esperado = pizzas do período × ficha (sem bebida), independe de contagem.
async function cmvPeriodoCEOItens(loja, ini, fim, dados) {
  const [vendas, compras] = dados
    ? [dados.vendas||[], dados.compras||[]]
    : await Promise.all([DB.vendasPeriodo?DB.vendasPeriodo(ini,fim):DB.getAll('vendas'), DB.getAll('compras')]);
  const lojas = loja ? [loja] : LOJAS_ATIVAS();
  const acc = {};   // ING_NORM -> {ing, q, custo, esp}
  for (const lj of lojas) {
    const vLj = vendas.filter(v => v.loja===lj && (!ini || v.data_fim>=ini) && (!fim || v.data_inicio<=fim));
    if (!vLj.length) continue;
    const consumo = calcConsumoPeriodo(vLj);
    for (const [ing, qt] of Object.entries(consumo)) {
      if (ehBebida(ing)) continue;
      const custo = custoAtualIng(ing, compras, lj);
      const k = norm(ing);
      if (!acc[k]) acc[k] = {ing, q:0, custo, esp:0};
      acc[k].q += qt; acc[k].esp += qt*custo;
    }
  }
  return Object.values(acc);
}

// ================================================================
// 3. LISTA DE INGREDIENTES PARA CONTAGEM
// ================================================================
let INGREDIENTES_CONTAGEM_LISTA = [
  {g:'Frios', itens:[
    {nome:'MUSSARELA'},{nome:'BACON'},{nome:'CALABRESA'},{nome:'PRESUNTO'},
    {nome:'FRANGO'},{nome:'PROVOLONE'},{nome:'PARMESAO'},{nome:'GORGONZOLA'},
    {nome:'LOMBO'},{nome:'PEPPERONI'}
  ]},
  {g:'Queijos/Cremes', itens:[
    {nome:'CATUPIRY'},{nome:'CHEDDAR'},{nome:'CREAM CHEESE'},{nome:'CATUPIRY PURO'}
  ]},
  {g:'Massa / Molho', itens:[
    {nome:'TRIGO'},{nome:'MOLHO'},{nome:'OLEO'},{nome:'ACUCAR'},{nome:'SAL'},{nome:'FERMENTO'}
  ]},
  {g:'Complementos', itens:[
    {nome:'MILHO'},{nome:'BATATA PALHA'},{nome:'CREME DE LEITE'},{nome:'OVO'},{nome:'CEBOLA'},
    {nome:'OREGANO'},{nome:'CHAMPIGNON'},{nome:'PIMENTA CALABRESA'}
  ]},
  // Temperos/secos controlados só no ESTOQUE (contagem + valor), sem ficha técnica —
  // por isso não têm consumo esperado no CMV; aparecem na contagem e no valor em
  // estoque quando houver compra lançada. Pedido do Gabriel (set/2026). Contados em UN
  // (caixas + unidades, sem multiplicador) por não terem conversão de caixa cadastrada.
  {g:'Temperos / Secos', itens:[
    {nome:'CALDO DE GALINHA'},{nome:'COLORAL'},{nome:'CANELA'},{nome:'FUBA'}
  ]},
  {g:'Doces', itens:[
    {nome:'CHOCOLATE PRETO'},{nome:'CHOCOLATE BRANCO'},{nome:'DOCE DE LEITE'},{nome:'GRANULADO'}
  ]},
  {g:'Embalagens', itens:[
    {nome:'CAIXA DE PIZZA'},{nome:'CAIXA PREMIUM'}
  ]},
  {g:'Bebidas (todas lojas)', itens:[
    {nome:'COCA NORMAL 2L'},{nome:'COCA ZERO 2L'},{nome:'KUAT'},
    {nome:'GUARANA 2L'},{nome:'GUARANA 1,5L'},{nome:'GUARANA 1,5L Z'}
  ]},
  {g:'Bebidas (Venda Nova)', itens:[
    {nome:'COCA NORMAL 1L'},{nome:'COCA ZERO 1L'},{nome:'AGUA COM GAS'},
    {nome:'AGUA SEM GAS'},{nome:'SUCO UVA'},{nome:'SUCO PESSEGO'}
  ]},
  // ATENDIMENTO = material de limpeza/serviço (o "lado direito" da contagem). É CONTROLE
  // de estoque da loja: conta e SALVA junto, mas fica FORA da divergência/CMV (o motor
  // pula por ehAtendimento). Contado em PACOTE + unidades (soma simples, UN). Cada loja
  // esconde o que não usa em "Itens desta loja". Pedido do Gabriel (set/2026).
  {g:'Atendimento', atendimento:true, itens:[
    {nome:'SACOLA'},{nome:'SACO DE LIXO'},{nome:'COPO'},{nome:'TOUCA'},
    {nome:'ALCOOL LIQUIDO'},{nome:'ALCOOL EM GEL'},{nome:'AGUA SANITARIA'},
    {nome:'DESINFETANTE'},{nome:'DESENGORDURANTE'},{nome:'SABAO EM PO'},
    {nome:'PAPEL HIGIENICO'},{nome:'PAPEL INTERFOLHADO'},{nome:'PANO DE CHAO'},
    {nome:'CANETA'},{nome:'CANETAO'},{nome:'BOBINA IMPRESSORA'},{nome:'BOBINA MAQUININHA'},
    {nome:'GRAMPO'},{nome:'DUREX'},{nome:'PERFEX'},{nome:'LUVA'},{nome:'CAFE'},
    {nome:'BOBINA PLASTICA'},{nome:'GUARDANAPO'},{nome:'DETERGENTE'},
    {nome:'ESPONJA DE ACO'},{nome:'ESPONJA DE LOUCA'},{nome:'MESINHAS DE PIZZA'},{nome:'DIVISORIA'}
  ]}
];

let TODOS_INGREDIENTES = INGREDIENTES_CONTAGEM_LISTA.flatMap(g=>g.itens.map(i=>i.nome));

// ATENDIMENTO: conjunto (normalizado) dos itens dos grupos marcados `atendimento:true`.
// ehAtendimento() é a fonte única do "isto é controle, não é ingrediente de CMV" — o motor
// (calcDivergencias) e a conferência pulam por ela. Rebuild junto com TODOS_INGREDIENTES.
let ATENDIMENTO_SET = new Set();
function _rebuildAtendimentoSet() {
  ATENDIMENTO_SET = new Set(
    INGREDIENTES_CONTAGEM_LISTA.filter(g => g.atendimento).flatMap(g => g.itens.map(i => normIng(i.nome)))
  );
}
_rebuildAtendimentoSet();
function ehAtendimento(nome) { return ATENDIMENTO_SET.has(normIng(nome)); }

// ================================================================
// 3B. PERSONALIZAÇÕES DO CARDÁPIO (fichas e insumos editáveis pelo usuário)
// ================================================================
// Mesmo padrão do mapeamento custom: as alterações ficam em localStorage e são
// aplicadas por cima das tabelas-base embutidas. Assim o Gabriel adiciona/edita
// pizzas e insumos sem precisar mexer no código.
const PERS_KEY = 'personalizacoes_v1';
const FICHA_BASE = JSON.parse(JSON.stringify(FICHA_TECNICA));
const CUSTOS_BASE = JSON.parse(JSON.stringify(CUSTOS));
const CONVERSAO_CAIXA_BASE = JSON.parse(JSON.stringify(CONVERSAO.conversao_caixa));
const KG_DIRETO_BASE = [...CONVERSAO.itens_kg_direto];
const ING_LISTA_BASE = JSON.parse(JSON.stringify(INGREDIENTES_CONTAGEM_LISTA));

// ---------- RECEITA DA MASSA (insumos por pizza, comuns a TODAS) ----------
// Pedido do Gabriel (jun/2026): a massa tem insumos que não estavam nas fichas
// (óleo, açúcar, sal, fermento). Guardamos a receita "natural" (g/ml por pizza) +
// a embalagem (emb) para converter à unidade-BASE que o app conta:
//   trigo/açúcar → kg (÷1000) ; sal/fermento → pacote ; óleo → litro.
// Aplicada a TODA pizza (meia=0,5). O trigo sai das fichas no cálculo (MASSA_SET)
// para não contar dobrado. Editável via personalizacoes.massa (só o nº por pizza).
const MASSA_RECEITA_BASE = {
  TRIGO:    {qtd:250, un:'g',  emb:1000, embLbl:'kg'},            // 0,250 kg
  ACUCAR:   {qtd:8,   un:'g',  emb:1000, embLbl:'kg'},            // 0,008 kg
  SAL:      {qtd:5,   un:'g',  emb:1000, embLbl:'pacote de 1 kg'},// 0,005 pacote
  FERMENTO: {qtd:1,   un:'g',  emb:500,  embLbl:'pacote de 500 g'},// 0,002 pacote
  OLEO:     {qtd:25,  un:'ml', emb:1000, embLbl:'garrafa de 1 L'},// 0,025 L
};
const MASSA_SET = new Set(Object.keys(MASSA_RECEITA_BASE));
let MASSA_RECEITA = {}; // {ING: {qtdBase, qtdNat, un, emb, embLbl}} — por pizza, em unidade-base
function buildMassaReceita() {
  const ov = getPers().massa || {};
  const out = {};
  for (const [ing,d] of Object.entries(MASSA_RECEITA_BASE)) {
    const qtdNat = (ov[ing]!=null && ov[ing]!=='' && !isNaN(ov[ing])) ? Number(ov[ing]) : d.qtd;
    out[ing] = { qtdBase: qtdNat/d.emb, qtdNat, un:d.un, emb:d.emb, embLbl:d.embLbl };
  }
  MASSA_RECEITA = out;
}
// Soma o consumo da massa num mapa, dado o nº de pizzas-equivalentes (já com meia=0,5).
function addConsumoMassa(cons, pizzasEquiv) {
  if (!(pizzasEquiv > 0)) return;
  for (const [ing,d] of Object.entries(MASSA_RECEITA))
    if (d.qtdBase > 0) cons[ing] = (cons[ing]||0) + d.qtdBase * pizzasEquiv;
}

// ---------- EMBALAGEM (caixa por pizza) ----------
// Pedido do Gabriel (jun/2026): toda pizza leva 1 caixa — entra na receita e no CMV.
// Premium (Buritis) usa CAIXA PREMIUM; as demais, CAIXA DE PIZZA. 1 caixa por pizza-
// equivalente (meia=0,5 → 2 meias dividem 1 caixa). Custo vem das compras (custoAtualIng/
// custoPagoIng) ou do preço-base. A caixa já é um insumo contado (grupo Embalagens).
const CAIXA_POR_PIZZA = 1;
function caixaDaCategoria(cat){ return cat==='PREMIUM' ? 'CAIXA PREMIUM' : 'CAIXA DE PIZZA'; }
// Auditoria 02/07: MEIA premium (sku PPM) tem categoria MEIA mas usa CAIXA PREMIUM — o prefixo
// do sku (PPI/PPM) decide junto com a categoria; senão o esperado de caixa premium fica subestimado.
function addConsumoEmbalagem(cons, categoria, pizzasEquiv, sku) {
  if (!(pizzasEquiv > 0)) return;
  const premium = categoria==='PREMIUM' || /^PP/i.test(sku||'');
  const cx = normIng(premium ? 'CAIXA PREMIUM' : 'CAIXA DE PIZZA');
  cons[cx] = (cons[cx]||0) + CAIXA_POR_PIZZA * pizzasEquiv;
}

let _persCache = null;
function getPers() {
  if (_persCache) return _persCache;
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PERS_KEY)) || {}; } catch(e) { p = {}; }
  p.fichas = p.fichas || {};                 // { "NOME": { "Ingrediente": gramas, ... } }  (nova ou substitui base)
  p.fichasRemovidas = p.fichasRemovidas || []; // [ "NOME", ... ]
  p.insumos = p.insumos || {};               // { "NOME": {grupo, custo, tipo, un_por_caixa, qtd_por_un, unidade, un_por_fardo} }
  p.custos = p.custos || {};                  // { "NOME_NORMALIZADO": custo }  (sobrescreve custo de insumo base)
  p.massa = p.massa || {};                    // { "TRIGO": gramas_por_pizza, ... } (sobrescreve a receita da massa)
  _persCache = p;
  return p;
}
function setPers(p) { _persCache = p; localStorage.setItem(PERS_KEY, JSON.stringify(p)); aplicarPersonalizacoes(); }

// Reconstrói TODAS as estruturas derivadas a partir da base + personalizações.
function aplicarPersonalizacoes() {
  const p = getPers();
  // --- FICHAS ---
  FICHA_TECNICA = JSON.parse(JSON.stringify(FICHA_BASE));
  for (const nome of p.fichasRemovidas) delete FICHA_TECNICA[nome];
  for (const [nome, ings] of Object.entries(p.fichas)) {
    FICHA_TECNICA[nome] = { _ingredientes: {...ings} };
  }
  // --- CUSTOS ---
  CUSTOS = {...CUSTOS_BASE};
  for (const [k,v] of Object.entries(p.custos)) CUSTOS[k] = v;
  // --- CONVERSÃO / UNIDADES / LISTA DE CONTAGEM ---
  const kg = new Set(KG_DIRETO_BASE);
  const caixa = JSON.parse(JSON.stringify(CONVERSAO_CAIXA_BASE));
  const refrig = {};
  for (const items of Object.values(CONVERSAO.refrigerantes))
    for (const [nome,data] of Object.entries(items)) refrig[norm(nome)] = data;
  const lista = JSON.parse(JSON.stringify(ING_LISTA_BASE));
  for (const [nome, cfg] of Object.entries(p.insumos)) {
    const n = norm(nome);
    if (cfg.custo !== undefined && cfg.custo !== null && cfg.custo !== '')
      CUSTOS[normIng(nome)] = parseFloat(cfg.custo) || 0;
    if (cfg.tipo === 'KG_DIRETO') kg.add(n);
    else if (cfg.tipo === 'CAIXA') caixa[n] = {un_por_caixa:+cfg.un_por_caixa||1, qtd_por_un:+cfg.qtd_por_un||1, unidade:cfg.unidade||'KG'};
    else if (cfg.tipo === 'FARDO') refrig[n] = {un_por_fardo:+cfg.un_por_fardo||1};
    // adiciona na lista de contagem (grupo escolhido ou "Personalizados")
    const grupoNome = cfg.grupo || 'Personalizados';
    let g = lista.find(x => x.g === grupoNome);
    if (!g) { g = {g:grupoNome, itens:[]}; lista.push(g); }
    if (!g.itens.find(i => norm(i.nome) === n)) g.itens.push({nome});
  }
  ITENS_KG_DIRETO = kg;
  CONVERSAO.conversao_caixa = caixa;
  REFRIG_LOOKUP = refrig;
  INGREDIENTES_CONTAGEM_LISTA = lista;
  TODOS_INGREDIENTES = lista.flatMap(g => g.itens.map(i => i.nome));
  _rebuildAtendimentoSet();
  // --- RECEITA DA MASSA ---
  buildMassaReceita();
  // FASE 1 ("config é dado"): canais e formas de pagamento por empresa (definido em app-3-analise).
  // Guarda opcional (typeof) porque a função vive num arquivo posterior — reaplica junto da config.
  if (typeof aplicarConfigVendas === 'function') aplicarConfigVendas();
}

// ================================================================
// 4. INDEXEDDB
// ================================================================
const DB_NAME = 'PizzaParaVoce_v2';
// Versão do app e do formato dos dados — gravadas no backup para compatibilidade futura
// Carimbo da versão. Aparece na sidebar (chip da nuvem) — é assim que se descobre, em 1 segundo,
// se o celular/Netlify está rodando a versão nova ou uma antiga em cache. ATUALIZAR a cada publicação.
const APP_VERSION = '2026-09-11·4ccb8f5+';
const SCHEMA_VERSION = 1;
let _db = null;

function openDB() {
  return new Promise((res,rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      ['contagens','vendas','compras','transferencias'].forEach(store => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, {keyPath:'id', autoIncrement:true});
        }
      });
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror = e => rej(e.target.error);
  });
}

// CAMADA DE DADOS PLUGÁVEL (SaaS): DBLocal = IndexedDB (igual ao app original).
// No boot, se a nuvem estiver configurada e o login OK, DB passa a apontar p/ Nuvem.DB
// (Supabase). Todo o resto do app só conhece "DB" — mesma interface nos dois mundos.
const DBLocal = {
  add(store, data) {
    return new Promise((res,rej)=>{
      const tx = _db.transaction(store,'readwrite');
      const r = tx.objectStore(store).add(data);
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  },
  getAll(store) {
    return new Promise((res,rej)=>{
      const tx = _db.transaction(store,'readonly');
      const r = tx.objectStore(store).getAll();
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  },
  delete(store, id) {
    return new Promise((res,rej)=>{
      const tx = _db.transaction(store,'readwrite');
      const r = tx.objectStore(store).delete(id);
      r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
    });
  },
  // Mesma interface do Nuvem.DB (ver js/nuvem.js): apaga vários ids numa transação só.
  deleteMuitos(store, ids) {
    return new Promise((res,rej)=>{
      if (!ids.length) return res();
      const tx = _db.transaction(store,'readwrite');
      const os = tx.objectStore(store);
      for (const id of ids) os.delete(id);
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
  },
  // No local não há custo de rede: as "chaves" saem do getAll mesmo.
  async chavesVendas() {
    return (await DBLocal.getAll('vendas'))
      .map(v => ({id:v.id, loja:v.loja, data_inicio:v.data_inicio, data_fim:v.data_fim, origem:v.origem}));
  },
  // Mesma interface do Nuvem.DB. No IndexedDB não há ganho em filtrar no "servidor", mas o
  // recorte tem que ser IDÊNTICO ao da nuvem — é o que garante que os números batem nos dois modos.
  async vendasPeriodo(ini, fim) {
    return (await DBLocal.getAll('vendas'))
      .filter(v => (!ini || v.data_fim >= ini) && (!fim || v.data_inicio <= fim));
  },
  put(store, data) {
    return new Promise((res,rej)=>{
      const tx = _db.transaction(store,'readwrite');
      const r = tx.objectStore(store).put(data);
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  },
  clear(store) {
    return new Promise((res,rej)=>{
      const tx = _db.transaction(store,'readwrite');
      const r = tx.objectStore(store).clear();
      r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
    });
  }
};
let DB = DBLocal;   // trocado por Nuvem.DB no bootApp quando a nuvem está configurada

// Banco SEPARADO só para configurações (ex.: pasta de backups).
// Separado de propósito: não muda a versão do banco principal de dados.
let _cfgDb = null;
function openCfgDB() {
  return new Promise(res => {
    const req = indexedDB.open('PizzaParaVoce_cfg', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('config', {keyPath:'k'});
    req.onsuccess = e => { _cfgDb = e.target.result; res(_cfgDb); };
    req.onerror = () => res(null); // sem config o app funciona igual (downloads normais)
  });
}
function cfgGet(k) {
  return new Promise(res => {
    if (!_cfgDb) return res(null);
    const r = _cfgDb.transaction('config','readonly').objectStore('config').get(k);
    r.onsuccess = () => res(r.result ? r.result.v : null);
    r.onerror = () => res(null);
  });
}
function cfgSet(k, v) {
  return new Promise(res => {
    if (!_cfgDb) return res(false);
    const r = _cfgDb.transaction('config','readwrite').objectStore('config').put({k, v});
    r.onsuccess = () => res(true);
    r.onerror = () => res(false);
  });
}
function cfgDel(k) {
  return new Promise(res => {
    if (!_cfgDb) return res(false);
    const r = _cfgDb.transaction('config','readwrite').objectStore('config').delete(k);
    r.onsuccess = () => res(true);
    r.onerror = () => res(false);
  });
}

// ================================================================
// 5. UTILIDADES UI
// ================================================================
let currentPage = 'dashboard';
let currentLoja = localStorage.getItem('loja') || 'BURITIS';
// Empresa nova não tem 'BURITIS'. Depois que o cadastro carrega, se a loja salva não existir
// mais (ou nunca existiu nesta empresa), cai na primeira do cadastro em vez de ficar num
// código fantasma que não filtra nada.
function garantirLojaValida() {
  if (!LOJA_LABEL[currentLoja]) {
    currentLoja = LOJAS_ORDEM[0];
    localStorage.setItem('loja', currentLoja);
  }
}

// ---- CADASTRO DE LOJAS (31/07/2026) -------------------------------------------------------
// Estas estruturas eram CONSTANTES no código — era preciso editar o programa para uma pizzaria
// nova existir. Agora elas são MONTADAS no boot a partir da tabela `lojas` do banco
// (banco/schema-lojas.sql), por `aplicarCadastroLojas()`.
//
// A COSTURA É AQUI DE PROPÓSITO: todo o resto do app continua lendo LOJA_LABEL/LOJA_BADGE/
// LOJAS_ATIVAS() como sempre leu e não sabe que mudou nada. Uma emenda em vez das 56 trocas
// espalhadas — que é onde número quebra.
//
// Os valores abaixo são o PADRÃO da rede do Gabriel e continuam valendo como está hoje quando
// não há cadastro (modo local, ou nuvem que ainda não rodou o schema-lojas.sql).
let LOJA_LABEL = {BURITIS:'Buritis',PLANALTO:'Planalto',VENDA_NOVA:'Venda Nova'};
let LOJA_BADGE = {BURITIS:'badge-loja-B',PLANALTO:'badge-loja-P',VENDA_NOVA:'badge-loja-V'};
let LOJA_COR   = {BURITIS:'#922b21',PLANALTO:'#1a5276',VENDA_NOVA:'#145a32'};
// Ordem oficial das lojas. Substituiu os 16 ['BURITIS','PLANALTO','VENDA_NOVA'] espalhados —
// é SEMPRE LOJAS_ATIVAS() que uma tela deve usar para saber "quais são as lojas".
let LOJAS_ORDEM = ['BURITIS','PLANALTO','VENDA_NOVA'];
const LOJAS_ATIVAS = () => LOJAS_ORDEM.slice();
let CADASTRO_LOJAS = null;   // linhas cruas da tabela `lojas` (inclui pausadas) — só a tela de Lojas usa

// Lê o cadastro na nuvem e reescreve as estruturas acima. Falhou ou não existe? Segue com o
// padrão — o app nunca deixa de abrir por causa disto.
async function aplicarCadastroLojas() {
  if (!(window.Nuvem && Nuvem.ativa() && Nuvem.lerLojas)) return false;
  let linhas;
  try { linhas = await Nuvem.lerLojas(); } catch (e) { console.warn('cadastro de lojas:', e); return false; }
  if (!linhas || !linhas.some(l => l.ativa !== false)) return false;
  CADASTRO_LOJAS = linhas;

  // Loja PAUSADA (22/09): sai de LOJAS_ORDEM (lançamentos, seletores, "todas as lojas"), mas o
  // nome dela continua em LOJA_LABEL — um registro antigo dela aparece com o nome, não com o código.
  LOJA_LABEL = {}; LOJA_BADGE = {}; LOJA_COR = {}; LOJAS_ORDEM = [];
  const cnpjs = {}, fatores = {_default: 0.43};
  for (const l of linhas) {
    if (l.ativa !== false) LOJAS_ORDEM.push(l.chave);
    // Saneamento na FRONTEIRA, uma vez só: o nome da loja vira tela em ~100 pontos de innerHTML
    // (badges, banner, detalhes do drill-down, benchmark) e a cor entra em style inline. Removo
    // apenas os caracteres que quebram HTML/atributo, PRESERVANDO caixa e acento — nomeSeguro()/
    // norm() fariam .toUpperCase() e "Venda Nova" viraria "VENDA NOVA" na tela. A `chave` (a
    // coluna que junta o histórico) não é tocada. Espelha o CHECK de lojas.nome/cor no banco.
    LOJA_LABEL[l.chave] = String(l.nome ?? '').replace(/["'<>\\`]/g, '').trim() || l.chave;
    LOJA_COR[l.chave]   = /^#[0-9a-fA-F]{6}$/.test(l.cor) ? l.cor : '#922b21';
    LOJA_BADGE[l.chave] = 'badge-loja-' + l.chave;      // a classe é gerada logo abaixo
    if (l.cnpj) cnpjs[String(l.cnpj).replace(/\D/g,'')] = l.chave;
    if (l.fator_99 != null) fatores[l.chave] = Number(l.fator_99);
  }
  // Uma classe de cor por loja, injetada de uma vez (loja nova já nasce com selo colorido).
  const st = document.getElementById('css-lojas') || document.createElement('style');
  st.id = 'css-lojas';
  st.textContent = LOJAS_ORDEM.map(c => `.badge-loja-${c}{background:${LOJA_COR[c]}!important;}`).join('');
  if (!st.parentNode) document.head.appendChild(st);

  LOJA_POR_CNPJ = cnpjs;      // detecção de loja ao importar NF
  FATOR_99 = fatores;         // repasse estimado da 99Food
  popularSelectsDeLoja();
  return true;
}

// Os 25 seletores de loja do app têm as 3 lojas ESCRITAS NO HTML — uma loja nova não apareceria
// em lugar nenhum. Aqui as opções de loja são regeradas a partir do cadastro, preservando as
// opções especiais ('' = Todas / '*' = Todos os gastos), que não são loja e têm texto próprio
// em cada tela ("Todas as lojas", "Todas", "Rede/geral"…). A opção selecionada é mantida.
//
// ⚠️ QUEM É SELETOR DE LOJA ESTÁ MARCADO NO HTML com `data-lojas` — LISTA EXPLÍCITA, de propósito.
// A versão de 31/07 adivinhava pelo formato do valor ("opção em MAIÚSCULAS = loja") e por isso
// SEQUESTROU 5 seletores que não são de loja: `tr-un` (KG/UN), `mp-m-cat` (MEIA/INTEIRA/…),
// `mi-tipo` (KG_DIRETO/CAIXA/…), `mi-unbase` (KG/UN) e `pc-forma` (DINHEIRO/DEBITO/…) — todos
// viraram "Buritis/Planalto/Venda Nova" na tela. É a MESMA lição do banner de loja em 30/07:
// mapa explícito, nunca querySelector/heurística. Seletor de loja NOVO → marque com data-lojas.
function popularSelectsDeLoja() {
  document.querySelectorAll('select[data-lojas]').forEach(sel => {
    const escolhido = sel.value;
    const fixas = [...sel.options].filter(o => o.value === '' || o.value === '*');
    sel.innerHTML = '';
    fixas.forEach(o => sel.add(o));
    for (const c of LOJAS_ORDEM) sel.add(new Option(LOJA_LABEL[c], c));
    // volta para o que estava, se ainda existir
    sel.value = [...sel.options].some(o => o.value === escolhido) ? escolhido : (fixas[0] ? fixas[0].value : LOJAS_ORDEM[0]);
  });
}

function fmtNum(n, dec=3) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', {minimumFractionDigits:dec, maximumFractionDigits:dec});
}
function fmtBRL(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
// Data de hoje no calendário LOCAL (toISOString usaria UTC e viraria o dia às 21h no Brasil)
function today() { return dataLocalISO(new Date()); }

// Soma (ou subtrai) dias a uma data ISO 'AAAA-MM-DD', sem cair na armadilha do UTC.
function addDiasISO(iso, n) {
  const [y,m,d] = iso.split('-').map(Number);
  return dataLocalISO(new Date(y, m-1, d + n));
}

// Escapa texto vindo de arquivos (CSV/XML/XLSX) antes de inserir em HTML
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Texto que vai DENTRO de um onclick, entre aspas simples: onclick="abrirFicha('AQUI')".
// Precisa de DUAS camadas: JS (barra e aspa simples) e depois HTML (a aspa DUPLA fecharia o
// atributo). O padrão antigo `${nome.replace(/'/g,"\\'")}` só cobria a primeira — um insumo
// chamado com aspas duplas escapava do atributo. O navegador desfaz as entidades ao ler o
// atributo, então a função recebe a string original.
function argJS(s) {
  return esc(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// ================================================================
// TRAVA DE GRAVAÇÃO — um clique é um registro
// ================================================================
// MEDIDO em produção (25/08/2026): 7 linhas fantasma no banco, R$ 1.881,53 de
// compra que nunca existiu, com 0,5 s a 3,1 s entre as cópias — a assinatura do
// duplo clique. As funções de salvar são `async`: entre a checagem de duplicata
// e a escrita há uma ida à rede inteira, e o segundo clique atravessa essa porta
// antes de o primeiro fechá-la.
//
// A trava por CHAVE (e não só desabilitar o botão) é o que fecha o caso de
// verdade: a mesma função é alcançável por caminhos diferentes — a Contagem tem
// DOIS botões que chamam salvarContagem(), e há Enter/atalho.
// O `finally` devolve o botão mesmo quando a gravação falha; sem ele, um erro de
// rede deixaria a tela travada até recarregar.
// NÃO restauramos innerHTML de propósito: salvarCompra/salvarContagem trocam o
// texto do botão ao sair do modo de edição, e restaurar desfaria essa troca.
const _gravando = new Set();
async function travarGravacao(chave, fn, seletorBotoes) {
  if (_gravando.has(chave)) return;          // 2º clique: ignorado de propósito
  _gravando.add(chave);
  const btns = seletorBotoes ? [...document.querySelectorAll(seletorBotoes)] : [];
  const estado = btns.map(b => ({b, dis: b.disabled}));
  btns.forEach(b => { b.disabled = true; b.classList.add('is-gravando'); });
  try {
    return await fn();
  } finally {
    _gravando.delete(chave);
    estado.forEach(({b, dis}) => { b.disabled = dis; b.classList.remove('is-gravando'); });
  }
}

// A ROLAGEM DO MOUSE NÃO ALTERA NÚMERO.
// Num <input type="number"> focado, girar a roda incrementa/decrementa o valor
// pelo `step` — que na Contagem é 0,001, ou seja, mexe na terceira casa decimal
// sem ninguém ver. E a tabela da Contagem vive dentro de um contêiner com
// rolagem própria (#ct-scroll), então "rolar a lista logo depois de digitar" era
// exatamente o gesto que corrompia a quantidade.
// Tirar o foco resolve os dois lados: o valor para de mudar e a rolagem volta a
// ser da página. Vale para os ~92 campos da Contagem e também para Compras,
// Transferências e o card de revisão da NF.
document.addEventListener('wheel', (e) => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === 'number' && el === document.activeElement) el.blur();
}, {passive:true});

// Dia da semana por extenso (selo do "Resumo do dia"). A versão abreviada é diaDaSemana().
const DIAS_SEM_LONGO = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
function diaDaSemanaLongo(iso) {
  if (!iso) return '';
  return DIAS_SEM_LONGO[new Date(iso+'T00:00:00').getDay()];
}

// Texto padrão de "ainda não tem dado do TOTEM". MODO NUVEM: quem traz o dado é o robô do
// GitHub (⚡ da barra lateral) — o atalho .bat do PC não existe no celular/Netlify, e mandar o
// Gabriel abrir um .bat no iPhone era instrução morta (7 telas repetiam esse texto até jul/2026).
function dicaAtualizarTotem() {
  return (window.Nuvem && Nuvem.ativa())
    ? 'use o <strong><i class="fas fa-bolt"></i> da barra lateral</strong> para o robô buscar agora (~2 min)'
    : 'abra pelo atalho <strong>Abrir Estoque PPV</strong>';
}
function textoSemTotem(oQue) {
  return `${oQue} aparece com os dados do TOTEM carregados — ${dicaAtualizarTotem()}.`;
}

// Preenche os avisos ESTÁTICOS de "sem dados do TOTEM" no HTML das páginas. Eles ficam no
// markup (não em template), então recebem o texto certo no boot, já sabendo se há nuvem.
function aplicarAvisosTotem() {
  document.querySelectorAll('[data-sem-totem]').forEach(el => {
    el.innerHTML = textoSemTotem(el.getAttribute('data-sem-totem'));
  });
}

function toast(msg, tipo='success') {
  const id = 'toast'+Date.now();
  const colors = {success:'bg-success',error:'bg-danger',warning:'bg-warning text-dark',info:'bg-info text-dark'};
  const icons = {success:'check-circle',error:'times-circle',warning:'exclamation-triangle',info:'info-circle'};
  const el = document.createElement('div');
  el.id=id; el.className=`toast show align-items-center text-white ${colors[tipo]||colors.info} border-0 mb-2`;
  el.innerHTML=`<div class="d-flex"><div class="toast-body"><i class="fas fa-${icons[tipo]||'info'} me-2"></i>${msg}</div>
    <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="document.getElementById('${id}').remove()"></button></div>`;
  document.getElementById('toast-container').appendChild(el);
  // erros e avisos ficam mais tempo na tela para dar tempo de ler
  setTimeout(()=>el.remove(), (tipo==='error'||tipo==='warning') ? 7000 : 4000);
}

// Menu lateral no celular (hambúrguer abre, fundo escuro ou navegação fecham)
function toggleSidebar(abrir) {
  const sb = document.getElementById('sidebar');
  const novo = (abrir === undefined) ? !sb.classList.contains('aberto') : abrir;
  sb.classList.toggle('aberto', novo);
  document.getElementById('sidebar-backdrop').classList.toggle('aberto', novo);
}
function atualizarTopbarLoja() {
  document.getElementById('topbar-loja').textContent = LOJA_LABEL[currentLoja] || currentLoja;
}

// Banner central: mostra a loja que está sendo analisada na aba atual (o seletor global do
// menu foi removido). Lê o filtro de loja da própria página; "Todas as lojas" quando vazio.
// ---- BANNER DA LOJA (a faixa grande no topo do conteúdo) ----------------------------------
// Qual seletor manda em cada página. ISTO É EXPLÍCITO DE PROPÓSITO (30/07/2026): antes o banner
// fazia `querySelector('select[id$="-loja"]')` e pegava o PRIMEIRO do HTML — na página Compras
// isso era o `cp-import-loja` (loja da importação de NF, que nem sincroniza), então o banner
// mostrava "Buritis" para sempre enquanto a barra do topo mostrava outra loja. Em Custos Fixos
// pegava o `cf-loja`, cujo valor padrão é '*', e o banner exibia um asterisco literal.
// Página que não está aqui e não é de rede/sistema cai na loja ativa do app.
const LOJA_SELECT_PAGINA = {
  dashboard:'dash-loja', contagem:'ct-loja', compras:'cp-loja', analise:'an-loja',
  ceo:'ceo-loja', pagamentos:'pag-loja', pagcategorias:'pcat-loja', custosfixos:'cf-loja',
  menu:'me-loja', clientes:'cli-loja', pizzasdia:'pd-loja', painel:'pn-loja',
  comprassemana:'cs-loja', previsao:'pv-loja', contagens:'cn-loja', abc:'abc-loja'
};
// Como a página se relaciona com "loja":
//   entrada = você LANÇA para uma loja (o rótulo "Loja em análise" estava errado aqui)
//   rede    = a tela compara/soma a rede inteira — banner de loja única não faz sentido
//   sistema = nada a ver com loja (fichas, backup, diagnóstico)
//   (o resto é 'analise')
const BANNER_PAGINA = {
  contagem:'entrada', compras:'entrada', transferencias:'entrada', vendas:'entrada',
  mapeamentos:'entrada',
  bench:'rede', compest:'rede',
  cardapio:'sistema', backup:'sistema', diagnostico:'sistema',
  lojas:'sistema', usuarios:'sistema'   // telas de cadastro: "loja em análise" não faz sentido nelas
};

function atualizarLojaBanner() {
  const el = document.getElementById('loja-atual');
  if (!el) return;
  const tipo = BANNER_PAGINA[currentPage] || 'analise';
  if (tipo === 'rede' || tipo === 'sistema') {       // :empty no CSS esconde a faixa
    el.dataset.loja = 'TODAS'; el.innerHTML = '';
    return;
  }
  const sel = document.getElementById(LOJA_SELECT_PAGINA[currentPage] || '');
  const val = sel ? sel.value : currentLoja;
  const ehLoja = !!LOJA_LABEL[val];    // '' (Todas as lojas) e '*' (Todos os gastos) NÃO são loja
  el.dataset.loja = ehLoja ? val : 'TODAS';
  el.innerHTML = `<span class="la-eyebrow">${tipo === 'entrada' ? 'Lançando para' : 'Loja em análise'}</span>`
    + `<i class="fas fa-store me-2" style="font-size:.72em;opacity:.65"></i>`
    + esc(ehLoja ? LOJA_LABEL[val] : 'Todas as lojas');
}

// Ações de render por página (usado por showPage e ao trocar a loja).
// PAGE_ACTIONS mapeia página → função de render. Como o app foi dividido em 5
// arquivos (31/08/2026), estas funções vivem em arquivos POSTERIORES e ainda não
// existem no escopo global quando ESTE arquivo carrega — o hoisting de função só
// vale dentro do próprio arquivo. Por isso cada valor é um wrapper que resolve a
// função no MOMENTO DA CHAMADA (quando todos os 5 arquivos já carregaram). O ponto
// de chamada segue sendo PAGE_ACTIONS[page]() — nada nas telas mudou.
const PAGE_ACTIONS = {
  dashboard: (...a)=>renderDashboard(...a),
  ceo: (...a)=>renderCEO(...a),
  custosfixos: (...a)=>renderCustosFixos(...a),
  pagamentos: (...a)=>renderPagamentos(...a),
  pagcategorias: (...a)=>renderPagCategorias(...a),
  clientes: (...a)=>renderClientes(...a),
  menu: (...a)=>renderMenu(...a),
  bench: (...a)=>renderBench(...a),
  contagem: (...a)=>renderContagem(...a),
  vendas: (...a)=>renderVendasHist(...a),
  mapeamentos: (...a)=>renderMapeamentos(...a),
  compras: (...a)=>renderCompras(...a),
  transferencias: (...a)=>renderTransferencias(...a),
  analise: (...a)=>renderDatasContagem(...a),   // atalhos das datas que TÊM contagem na loja
  painel: (...a)=>renderPainel(...a),
  pizzasdia: (...a)=>renderPizzasDia(...a),
  comprassemana: (...a)=>renderComprasSemana(...a),
  contagens: (...a)=>renderContagens(...a),
  previsao: ()=>{},         // seletor já sincronizado; o usuário clica em rodar
  compest: (...a)=>renderComparativoEstoque(...a),
  abc: (...a)=>renderABC(...a),
  cardapio: (...a)=>renderCardapio(...a),
  backup: (...a)=>renderBackupStats(...a),
  diagnostico: (...a)=>renderDiagnosticoCusto(...a)   // "insumos sem custo"; autoteste roda no botão
};

// Todos os seletores de loja (menu + páginas) ficam SEMPRE na mesma loja ativa.
const LOJA_SELECT_IDS = ['ct-loja','cp-loja','an-loja','pn-loja','pd-loja','ceo-loja','pag-loja','cli-loja','me-loja','abc-loja','pv-loja','cs-loja'];
function syncLojaSelectors() {
  LOJA_SELECT_IDS.forEach(id=>{ const el=document.getElementById(id); if (el) el.value = currentLoja; });
}

// Re-renderiza a página atual após trocar de loja (trata a contagem em edição).
function rerenderPaginaAtual() {
  if (currentPage === 'contagem') {
    if (_editContagemId) cancelarEdicaoContagem(); else renderContagem();
    return;
  }
  if (PAGE_ACTIONS[currentPage]) PAGE_ACTIONS[currentPage]();
}

function setLoja(loja) {
  if (!loja) return;                 // "Todas as lojas" não vira loja ativa
  currentLoja = loja;
  localStorage.setItem('loja', loja);
  atualizarTopbarLoja();
  syncLojaSelectors();               // todos os seletores de página acompanham
  atualizarLojaBanner();
  rerenderPaginaAtual();
}

// Troca de loja por um seletor DE PÁGINA: loja específica sincroniza tudo;
// "Todas as lojas" (só Painel/ABC) é visão local e não muda a loja ativa.
function lojaPaginaChange(sel, page) {
  if (sel.value) setLoja(sel.value);
  else { atualizarLojaBanner(); if (PAGE_ACTIONS[page]) PAGE_ACTIONS[page](); }   // "Todas as lojas"
}

// Páginas que viraram SUB-ABAS de um item do menu: o destaque do menu fica no item-grupo.
// "Estoque & CMV" (painel) agrupa Divergências/ABC/Previsão; "Painel do CEO" (ceo) agrupa Comparativo (bench).
const GRUPO_PAGINA = { analise:'painel', abc:'painel', previsao:'painel', compest:'painel', contagens:'painel', bench:'ceo', custosfixos:'ceo', pagcategorias:'pagamentos' };
// Sub-abas de cada grupo (injetadas no .grupo-tabs-host da página ativa).
const GRUPO_TABS = {
  estoque: [['painel','Painel Gerencial','fa-chart-line'],['analise','Divergências','fa-chart-bar'],['abc','Curva ABC & Giro','fa-layer-group'],['compest','Comparativo Lojas','fa-trophy'],['contagens','Última Contagem','fa-clipboard-check']],
  ceo:     [['ceo','Painel do CEO','fa-chart-line'],['custosfixos','Custos Fixos','fa-pen-to-square'],['bench','Comparativo Lojas','fa-scale-balanced']],
  pag:     [['pagamentos','Pagamentos','fa-money-bill-wave'],['pagcategorias','Corrigir categorias','fa-tags']],
};
function renderGrupoTabs(page) {
  const host = document.querySelector('#page-'+page+' .grupo-tabs-host');
  if (!host) return;
  const tabs = GRUPO_TABS[host.dataset.grupo] || [];
  host.innerHTML = '<ul class="nav grupo-tabs mb-3">'+tabs.map(([p,lbl,ic])=>
    `<li class="nav-item"><a class="nav-link ${p===page?'active':''}" href="#" onclick="showPage('${p}');return false"><i class="fas ${ic} me-1"></i>${lbl}</a></li>`).join('')+'</ul>';
}

// ================================================================
// 5B. PERMISSÕES POR PAPEL (SaaS)
// Quem MANDA é o banco (RLS em schema-rbac.sql). Isto aqui é só conforto: não
// mostrar ao usuário porta que ele não pode abrir. Nunca é a barreira de segurança.
//   dono     → tudo (null = sem restrição)
//   operacao → só lança; nada de dinheiro
//   leitura  → só vê; nenhuma tela de entrada nem Backup
// ================================================================
const PAGINAS_POR_PAPEL = {
  dono: null,
  // 21/09: conta do robô do TOTEM (migração papel_robo). Ele não usa a tela; se alguém entrar com
  // ela, abre só a Visão geral — vazia, porque o banco não entrega nada a ele. Sem esta linha,
  // papel indefinido = interface de DONO (armadilha já mapeada no papel atendente).
  robo: ['dashboard'],
  operacao: ['contagem','compras','transferencias'],
  leitura: ['dashboard','ceo','custosfixos','pagamentos','pagcategorias','clientes','menu',
            'painel','analise','abc','compest','contagens','comprassemana','pizzasdia','bench']
};
let _papelAtual = 'dono';       // sem nuvem (modo local) = dono
let _paginaInicial = 'dashboard';

function podeVerPagina(page) {
  const permitidas = PAGINAS_POR_PAPEL[_papelAtual];
  return !permitidas || permitidas.includes(page);
}

function aplicarPermissoes(papel) {
  _papelAtual = papel || 'dono';
  const permitidas = PAGINAS_POR_PAPEL[_papelAtual];
  if (!permitidas) return;                       // dono: nada a esconder
  // esconde os itens de menu que este papel não pode abrir
  document.querySelectorAll('#sidebar .nav-item a[onclick^="showPage("]').forEach(a => {
    const m = a.getAttribute('onclick').match(/showPage\('([^']+)'\)/);
    if (m && !permitidas.includes(m[1])) a.closest('.nav-item').style.display = 'none';
  });
  // esconde o título da seção que ficou sem nenhum item visível
  document.querySelectorAll('#sidebar .section-title').forEach(t => {
    let n = t.nextElementSibling, algumVisivel = false;
    while (n && !n.classList.contains('section-title')) {
      if (n.classList.contains('nav-item') && n.style.display !== 'none') algumVisivel = true;
      n = n.nextElementSibling;
    }
    if (!algumVisivel) t.style.display = 'none';
  });
  _paginaInicial = permitidas[0];
}

function showPage(page) {
  // Rede de segurança da TELA: papel sem acesso cai na primeira página permitida.
  if (!podeVerPagina(page)) {
    toast('Seu acesso não inclui esta tela. Fale com o dono da conta.', 'error');
    page = _paginaInicial;
  }
  toggleSidebar(false); // no celular, navegar fecha o menu
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  renderGrupoTabs(page);                        // injeta a barra de sub-abas, se for página de grupo
  const navKey = GRUPO_PAGINA[page] || page;   // sub-aba mantém o item do grupo destacado
  document.querySelectorAll('#sidebar .nav-item a').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick')?.includes("'"+navKey+"'"));
  });
  currentPage = page;
  syncLojaSelectors();               // seletor da página entra já na loja ativa
  atualizarLojaBanner();             // banner central mostra a loja da aba atual
  if (PAGE_ACTIONS[page]) PAGE_ACTIONS[page]();
}

