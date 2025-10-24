// Fluxo: checkbox "gerar_contrato" => gera 3 docs no D4Sign => adiciona signatários => envia p/ assinatura
// => salva link no card => move p/ fase "Contrato enviado"

/* ================== CONSTANTES E HELPERS BÁSICOS ================== */

// URL BASE da D4Sign (Produção)
const D4_BASE = "https://secure.d4sign.com.br/api/v1"; 

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function text(status, body) { return { statusCode: status, headers: { "Content-Type": "text/plain; charset=utf-8" }, body }; }
function json(status, obj) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 2) }; }
const toStr = v => (v == null ? null : String(v).trim());

function getField(fields, fieldId) {
  const f = fields.find(x => x.field?.id === fieldId);
  return f?.report_value ?? f?.value ?? null;
}
function parseCurrencyBRL(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d\,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}
// Outras helpers devem estar aqui (parseParcelas, parseTaxa, etc.)


/* ================== FUNÇÕES DE DADOS PIPEFY ================== */

function montarDadosContrato(card) {
  const fields = card?.fields || [];
  
  // --- Leitura de campos normais (exemplo) ---
  const nome                = toStr(getField(fields, "nome_do_contato"));
  const nome_da_marca       = toStr(getField(fields, "neg_cio"));
  const email               = toStr(getField(fields, "email_profissional"));
  const valorBruto          = getField(fields, "valor_do_neg_cio");
  const valor_do_negocio    = parseCurrencyBRL(valorBruto);

  // --- CORREÇÃO: Leitura do Responsável (Assignee) ---
  let vendedor = null;
  const responsaveis = card?.assignees || [];
  
  if (responsaveis.length > 0) {
      vendedor = toStr(responsaveis[0].name); 
  }
  
  return {
    nome, nome_da_marca, email,
    valor_do_negocio, 
    vendedor
    // ... retorne todos os outros dados
  };
}

function montarADD(d) {
  return {
    "NOME_CLIENTE": d.nome,
    "EMAIL_CLIENTE": d.email,
    "VALOR_NEGOCIO": d.valor_do_negocio,
    // ...
  };
}


/* ================== LÓGICA DE COFRES E SIGNATÁRIOS ================== */

function getCofreDataPorVendedor(vendedor) {
    const chave = String(vendedor || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .trim();
    
    const MAPA_COFRES = {
        "mauro furlan neto": { uuidSafe: "623b7ae4-5c01-4cff-a7e4-5b0a9f58af07" },
        "brenda rosa da silva": { uuidSafe: "b6dd6fad-c9fe-4cf1-8a90-6488d2537930" },
        "ronaldo scariot da silva": { uuidSafe: "f9bff85c-e2d2-4c8e-8fae-818906090d4a" },
        "jeferson andrade siqueira": { uuidSafe: "2697a33a-3c9c-4997-829a-f2197b0575fd" },
        "maykon campos": { uuidSafe: "1686e23a-73de-4738-a1a1-7e7d2d8fbef0" },
        "debora goncalves": { uuidSafe: "5ae00672-398d-4dd3-b048-a363f32d0491" },
        "mariana cristina de oliveira": { uuidSafe: "672b3f5d-7b96-4021-9f4f-ce9778a5426c" },
        "valdeir almeida": { uuidSafe: "c59ad739-b920-4407-95b7-61f01589cc6e" },
        "edna berto da silva": { uuidSafe: "f2810606-e496-4955-bb65-a7f6218bc116" },
        "greyce maria candido souza": { uuidSafe: "b05ba8d4-ed65-4659-b348-ceda08fd7724" }
    };
    
    if (MAPA_COFRES[chave]) {
        return { uuidSafe: MAPA_COFRES[chave].uuidSafe, uuidFolder: null };
    }
    return { uuidSafe: process.env.D4_UUID_SAFE_PADRAO || null, uuidFolder: null };
}

function montarSignatarios(dados) {
    const signatarioCliente = { "email": dados.email, "act": "1", "foreign": "0", "certificadoicpbr": "0" };
    const signatarioEmpresa = { "email": process.env.EMAIL_ASSINATURA_EMPRESA, "act": "1", "foreign": "0", "certificadoicpbr": "0" };
    
    if (!process.env.EMAIL_ASSINATURA_EMPRESA) {
        console.error("Variável EMAIL_ASSINATURA_EMPRESA ausente.");
        return [signatarioCliente]; 
    }
    return [signatarioCliente, signatarioEmpresa];
}


/* ================== D4Sign: FUNÇÕES DE API (PRODUÇÃO) ================== */

async function processarDocumentoD4(ADD, dados, uuidSafe, idTemplateWord, docName, uuidFolder = null) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  
  if (!tokenAPI || !cryptKey || !uuidSafe || !idTemplateWord) {
      return { error: true, details: `Vars D4 incompletas para ${docName}` };
  }

  const url = `${D4_BASE}/documents/${uuidSafe}/makedocumentbytemplateword?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  
  const body = {
      name_document: `${docName} - ${dados.nome_da_marca || dados.nome || "Sem Nome"}`,
      uuid_folder: uuidFolder, 
      templates: { [idTemplateWord]: ADD }
  };
  
  const r = await fetch(url, { method: "POST", headers: { "accept": "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  
  if (!r.ok || out.message) {
      return { error: true, status: r.status, name: docName, response: out, details: `Erro na criação: ${out.mensagem_pt || out.message}` };
  }
  
  const uuidDoc = out.uuid || out.uuidDoc || out.uuid_document;
  const link = out.url || out.url_document || null;

  return { ok: true, name: docName, uuidDoc, link, response: out };
}

async function d4AddSigners(uuidDoc, signersArray) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  const url = `${D4_BASE}/documents/${uuidDoc}/addsigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`; 
  const body = { signers: JSON.stringify(signersArray) };

  const r = await fetch(url, { method: "POST", headers: { "accept": "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out, details: `Erro ao adicionar: ${out.mensagem_pt || out.message}` };
}

async function d4SendToSign(uuidDoc) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  const url = `${D4_BASE}/documents/${uuidDoc}/sendtosigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  
  const r = await fetch(url, { method: "POST" });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out, details: `Erro no envio: ${out.mensagem_pt || out.message}` };
}


/* ================== HANDLER PRINCIPAL (FLUXO - COM DEBUG) ================== */

export async function handler(event) {
  try {
    if (event.httpMethod === "GET") { return text(200, "OK - use POST"); }
    if (event.httpMethod !== "POST") return text(405, "Method Not Allowed");

    // --- CORREÇÃO: LEITURA ROBUSTA DO BODY E DEBUG ---
    const body = safeJson(event.body);
    let cardId = null;

    if (body) {
        // 1. Tenta ler do formato padrão {"cardId": ...}
        cardId = body?.data?.card?.id ?? body?.card?.id ?? body?.data?.id ?? body?.cardId ?? null;
    } 
    // Se o body for string e não JSON, o Pipefy pode estar enviando o cardId direto ou texto.
    // Não precisamos de um log específico aqui, a falha do 'cardId' nos dirá o suficiente.
    
    console.log(`[CHECK 1] Card ID processado: ${cardId}`);

    if (!cardId) {
        console.error("ERRO [FALHA 1]: cardId ausente. Tentativa de Body RAW:", event.body);
        return json(400, { error: "cardId ausente. Revise o Body do Webhook no Pipefy." });
    }

    const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
    if (!PIPEFY_TOKEN) {
         console.error("ERRO [FALHA 2]: PIPEFY_TOKEN ausente.");
         return json(500, { error: "PIPEFY_TOKEN ausente" });
    }

    // === GraphQL Pipefy ===
    console.log(`[CHECK 3] Iniciando busca GraphQL do Card ${cardId}`);

    const gql = (query, variables) =>
      fetch("https://api.pipefy.com/graphql", {
        method: "POST",
        headers: { "Authorization": `Bearer ${PIPEFY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables })
      }).then(r => r.json());

    const CARD_Q = `
      query($cardId: ID!) {
        card(id: $cardId) {
          id title
          fields { name value report_value field { id } }
          assignees { id name } 
        }
      }
    `;
    const cardRes = await gql(CARD_Q, { cardId });
    
    if (cardRes.errors) {
        console.error("ERRO [FALHA 3]: GraphQL Pipefy retornou erros.", JSON.stringify(cardRes.errors));
        return json(502, { error: "GraphQL Pipefy, revise o token ou query", details: cardRes.errors });
    }
    
    const card = cardRes?.data?.card;
    if (!card) {
         console.error("ERRO [FALHA 3.1]: Card não encontrado no Pipefy.");
         return json(404, { error: "Card não encontrado, ID inválido ou token sem permissão." });
    }

    console.log(`[CHECK 3 SUCESSO] Card '${card?.title}' buscado.`);

    // === DADOS E COFRE ===
    const dados = montarDadosContrato(card); 
    const ADD = montarADD(dados);
    const signersList = montarSignatarios(dados);
    const cofreData = getCofreDataPorVendedor(dados.vendedor);
    
    if (!cofreData?.uuidSafe) {
        console.error(`ERRO [FALHA 4]: Vendedor '${dados.vendedor}' não mapeado.`);
        return json(400, { error: `Vendedor '${dados.vendedor}' não mapeado. Ajuste a função getCofreDataPorVendedor.` });
    }
    
    const DYNAMIC_UUID_SAFE = cofreData.uuidSafe;
    const DYNAMIC_UUID_FOLDER = cofreData.uuidFolder;
    
    // === 3. CRIAÇÃO DOS DOCUMENTOS (D4Sign) ===
    console.log(`[CHECK 5] Iniciando criação dos 3 docs no Cofre: ${DYNAMIC_UUID_SAFE}`);

    const docProcuracao = await processarDocumentoD4(ADD, dados, DYNAMIC_UUID_SAFE, process.env.D4_ID_TEMPLATE_PROCURACAO, "Procuração", DYNAMIC_UUID_FOLDER);
    if (docProcuracao.error) return json(502, { error: "Falha Procuração D4Sign", details: docProcuracao.details, response: docProcuracao.response });

    const docContrato = await processarDocumentoD4(ADD, dados, DYNAMIC_UUID_SAFE, process.env.D4_ID_TEMPLATE_CONTRATO, "Contrato", DYNAMIC_UUID_FOLDER);
    if (docContrato.error) return json(502, { error: "Falha Contrato D4Sign", details: docContrato.details, response: docContrato.response });
    
    const docAditivo = await processarDocumentoD4(ADD, dados, DYNAMIC_UUID_SAFE, process.env.D4_ID_TEMPLATE_ADITIVO, "Aditivo", DYNAMIC_UUID_FOLDER);
    if (docAditivo.error) return json(502, { error: "Falha Aditivo D4Sign", details: docAditivo.details, response: docAditivo.response });

    const allDocs = [docProcuracao, docContrato, docAditivo];
    let linkContrato = null;
    const signSendResults = [];
    
    // === 4. ASSINATURA DOS DOCUMENTOS (D4Sign) ===
    for (const doc of allDocs) {
        if (!doc.uuidDoc) continue;
        console.log(`[CHECK 6] Processando signatários e envio para: ${doc.name}`);

        const addS = await d4AddSigners(doc.uuidDoc, signersList);
        if (addS?.error) { signSendResults.push({ name: doc.name, status: "addSigner_ERROR", details: addS.details }); continue; }

        const send = await d4SendToSign(doc.uuidDoc);
        if (send?.error) { signSendResults.push({ name: doc.name, status: "sendToSign_ERROR", details: send.details }); } 
        else { signSendResults.push({ name: doc.name, status: "OK" }); }
        
        if (doc.name === "Contrato") { linkContrato = doc.link; }
    }

    // === 5. ATUALIZAR PIPEFY ===
    const LINK_FIELD = process.env.PIPEFY_FIELD_LINK_CONTRATO || "documentos"; 
    if (linkContrato) {
      const MUT_UPDATE = `mutation($card_id: ID!, $field_id: String!, $value: String!) { updateCardField(input: { card_id: $card_id, field_id: $field_id, new_value: $value }) { success } }`;
      await gql(MUT_UPDATE, { card_id: cardId, field_id: LINK_FIELD, value: linkContrato });
    }

    const DEST_PHASE = process.env.PIPEFY_PHASE_CONTRATO_ENVIADO;
    if (DEST_PHASE) {
      const MOVE_MUT = `mutation($card_id: ID!, $dest: ID!) { moveCardToPhase(input: { card_id: $card_id, destination_phase_id: $dest }) { card { id } } }`;
      await gql(MOVE_MUT, { card_id: cardId, dest: DEST_PHASE });
    }
    
    console.log("[FIM] Fluxo concluído com sucesso. Retornando 200.");

    return json(200, {
      ok: true,
      cardId,
      cardTitle: card?.title || null,
      d4sign: { documents: allDocs.map(d => d.name), workflow: signSendResults }
    });

  } catch (e) {
    console.error(`[ERRO FATAL GERAL]: ${String(e)}`);
    return json(500, { error: String(e), stack: e.stack });
  }
}
