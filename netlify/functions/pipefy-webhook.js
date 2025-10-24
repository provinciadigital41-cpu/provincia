// Fluxo: checkbox "gerar_contrato" => gera 3 docs no D4Sign => adiciona signatários => envia p/ assinatura
// => salva link no card => move p/ fase "Contrato enviado"

export async function handler(event) {
  try {
    if (event.httpMethod === "GET") {
      return text(200, "OK - use POST com JSON { cardId }");
    }
    if (event.httpMethod !== "POST") return text(405, "Method Not Allowed");

    const body = safeJson(event.body) || {};
    const cardId =
      body?.data?.card?.id ??
      body?.card?.id ??
      body?.data?.id ??
      body?.cardId ??
      null;
    if (!cardId) return json(400, { error: "cardId ausente" });

    // === Pipefy: buscar card ===
    const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
    if (!PIPEFY_TOKEN) return json(500, { error: "PIPEFY_TOKEN ausente" });

    const gql = (query, variables) =>
      fetch("https://api.pipefy.com/graphql", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${PIPEFY_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
      }).then(r => r.json());

    const CARD_Q = `
      query($cardId: ID!) {
        card(id: $cardId) {
          id
          title
          fields { name value report_value field { id } }
        }
      }
    `;
    const cardRes = await gql(CARD_Q, { cardId });
    if (cardRes.errors) return json(502, { error: "GraphQL Pipefy", details: cardRes.errors });
    const card = cardRes?.data?.card;
    const fields = card?.fields || [];

    // === 1. MONTAR DADOS E SIGNATÁRIOS ===
    const dados = montarDadosContrato(fields);
    const ADD = montarADD(dados);
    const signersList = montarSignatarios(dados);
    
    // === 2. BUSCAR COFRE DINÂMICO ===
    const cofreData = getCofreDataPorVendedor(dados.vendedor);
    if (!cofreData?.uuidSafe) {
        return json(400, { 
            error: "Vendedor não mapeado ou campo 'respons_vel' está vazio.", 
            vendedor: dados.vendedor 
        });
    }
    
    const DYNAMIC_UUID_SAFE = cofreData.uuidSafe;
    const DYNAMIC_UUID_FOLDER = cofreData.uuidFolder; // nulo inicialmente

    // === 3. PROCESSAR OS 3 DOCUMENTOS SEQUENCIALMENTE ===
    
    const docProcuracao = await processarDocumentoD4(
        ADD, dados, DYNAMIC_UUID_SAFE, 
        process.env.D4_ID_TEMPLATE_PROCURACAO, "Procuração", DYNAMIC_UUID_FOLDER
    );
    if (docProcuracao.error) return json(502, { error: "Falha Procuração", details: docProcuracao.error });

    const docContrato = await processarDocumentoD4(
        ADD, dados, DYNAMIC_UUID_SAFE, 
        process.env.D4_ID_TEMPLATE_CONTRATO, "Contrato", DYNAMIC_UUID_FOLDER
    );
    if (docContrato.error) return json(502, { error: "Falha Contrato", details: docContrato.error });
    
    const docAditivo = await processarDocumentoD4(
        ADD, dados, DYNAMIC_UUID_SAFE, 
        process.env.D4_ID_TEMPLATE_ADITIVO, "Aditivo", DYNAMIC_UUID_FOLDER
    );
    if (docAditivo.error) return json(502, { error: "Falha Aditivo", details: docAditivo.error });

    // Agrupa todos os documentos criados
    const allDocs = [docProcuracao, docContrato, docAditivo];
    let linkContrato = null;

    // === 4. ADICIONAR SIGNATÁRIOS E ENVIAR PARA CADA DOCUMENTO ===
    const signSendResults = [];
    
    for (const doc of allDocs) {
        if (!doc.uuidDoc) {
             signSendResults.push({ name: doc.name, status: "skip", details: "UUID não retornado" });
             continue;
        }

        // Adicionar Signatários
        const addS = await d4AddSigners(doc.uuidDoc, signersList);
        if (addS?.error) {
            signSendResults.push({ name: doc.name, status: "addSigner_ERROR", details: addS });
            continue;
        }

        // Enviar para Assinatura
        const send = await d4SendToSign(doc.uuidDoc);
        if (send?.error) {
            signSendResults.push({ name: doc.name, status: "sendToSign_ERROR", details: send });
        } else {
            signSendResults.push({ name: doc.name, status: "OK" });
        }
        
        // Usa o link do Contrato como link principal para o Pipefy
        if (doc.name === "Contrato") {
             linkContrato = doc.link; 
        }
    }

    // === 5. PIPEfy: SALVAR LINK E MOVER CARD ===
    
    const LINK_FIELD = process.env.PIPEFY_FIELD_LINK_CONTRATO || "documentos"; // Mude para o ID do campo "Link D4Sign"
    if (linkContrato) {
      const MUT_UPDATE = `
        mutation($card_id: ID!, $field_id: String!, $value: String!) {
          updateCardField(input: { card_id: $card_id, field_id: $field_id, new_value: $value }) { success }
        }
      `;
      await gql(MUT_UPDATE, { card_id: cardId, field_id: LINK_FIELD, value: linkContrato });
    }

    const DEST_PHASE = process.env.PIPEFY_PHASE_CONTRATO_ENVIADO;
    if (DEST_PHASE) {
      const MOVE_MUT = `
        mutation($card_id: ID!, $dest: ID!) {
          moveCardToPhase(input: { card_id: $card_id, destination_phase_id: $dest }) { card { id } }
        }
      `;
      await gql(MOVE_MUT, { card_id: cardId, dest: DEST_PHASE });
    }

    return json(200, {
      ok: true,
      cardId,
      cardTitle: card?.title || null,
      linkContrato,
      d4sign: { documents: allDocs, workflow: signSendResults }
    });

  } catch (e) {
    return json(500, { error: String(e), stack: e.stack });
  }
}

/* ================= helpers ================= */

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
function parseParcelas(s) { const m = String(s||"").match(/(\d+)/); return m ? Number(m[1]) : null; }
function parseTaxa(s) {
  if (!s) return { categoria: null, valor: null };
  const cat = String(s).split("(")[0].trim();
  const m = String(s).match(/R\$\s*([\d\.\,]+)/i);
  const valor = m ? parseCurrencyBRL(m[1]) : null;
  return { categoria: cat || null, valor };
}
function parseDocumentoURL(v) {
  if (!v) return null;
  try { if (String(v).trim().startsWith("[")) { const arr = JSON.parse(v); return Array.isArray(arr) ? arr[0] ?? null : null; } } catch {}
  return String(v);
}


// ====== MAPEAMENTO DE DADOS DO PIPEFY ======
function montarDadosContrato(fields) {
  // Use os IDs dos campos do Pipefy
  const nome                = toStr(getField(fields, "nome_do_contato"));
  const nome_da_marca       = toStr(getField(fields, "neg_cio"));
  const telefone            = toStr(getField(fields, "telefone"));
  const email               = toStr(getField(fields, "email_profissional"));
  const valorBruto          = getField(fields, "valor_do_neg_cio");
  const qtdParcelasRaw      = getField(fields, "quantidade_de_parcelas");
  const servicos            = toStr(getField(fields, "servi_os_de_contratos"));
  const pesquisa            = getField(fields, "paga");
  const taxaRaw             = getField(fields, "copy_of_pesquisa");
  const cep                 = toStr(getField(fields, "cep"));
  const uf                  = toStr(getField(fields, "uf"));
  const cidade              = toStr(getField(fields, "cidade"));
  const bairro              = toStr(getField(fields, "bairro"));
  const rua                 = toStr(getField(fields, "rua"));
  const numero              = toStr(getField(fields, "n_mero"));
  const cnpj                = toStr(getField(fields, "cnpj"));
  
  // ATENÇÃO: ID DO VENDEDOR CONFIRMADO
  const vendedor            = toStr(getField(fields, "respons_vel"));
  
  const docUrl              = parseDocumentoURL(getField(fields, "documentos"));

  const valor_do_negocio    = parseCurrencyBRL(valorBruto);
  const quantidade_de_parcelas = parseParcelas(qtdParcelasRaw);
  const { categoria: taxa, valor: taxa_valor } = parseTaxa(taxaRaw);

  return {
    nome, nome_da_marca, telefone, email,
    valor_do_negocio, quantidade_de_parcelas,
    servicos_de_contrato: servicos, pesquisa, taxa, taxa_valor,
    cnpj, cep, uf, cidade, bairro, rua, numero,
    documento_url: docUrl,
    vendedor // NOVO CAMPO RETORNADO
  };
}

// Mapeia os dados do Pipefy para as VARIÁVEIS do seu template D4Sign
function montarADD(d) {
  // As chaves devem ser IDÊNTICAS às variáveis no seu template Word
  return {
    nome: d.nome,
    nome_da_marca: d.nome_da_marca,
    email: d.email,
    valor_do_negocio: d.valor_do_negocio,
    // ... adicione todas as variáveis necessárias para o D4Sign
    // ...
  };
}

// ====== MAPEAMENTO DE COFRES POR VENDEDOR ======
function getCofreDataPorVendedor(vendedor) {
    // Padroniza a chave de busca (remove acentos, espaços extras e usa minúsculas)
    const chave = String(vendedor || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .trim();
    
    // Mapeamento fornecido (sem acentos, minúsculas)
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
        return { 
            uuidSafe: MAPA_COFRES[chave].uuidSafe,
            uuidFolder: null // Manter nulo para salvar na raiz do cofre. Se precisar de subcofre, adicione a lógica aqui.
        };
    }

    console.error(`Vendedor "${vendedor}" não encontrado no mapeamento.`);
    return {
        uuidSafe: process.env.D4_UUID_SAFE_PADRAO || null,
        uuidFolder: null 
    };
}

// ====== LÓGICA DE SIGNATÁRIOS DINÂMICOS ======
function montarSignatarios(dados) {
    // Signatário 1: Cliente (E-mail vindo do Pipefy)
    const signatarioCliente = {
        "email": dados.email, // E-mail do cliente
        "act": "1", // 1 = Assinar (Ação padrão)
        "foreign": "0",
        "certificadoicpbr": "0"
    };

    // Signatário 2: Representante da Empresa (E-mail fixo)
    const signatarioEmpresa = {
        "email": process.env.EMAIL_ASSINATURA_EMPRESA, // Deve ser configurado no Netlify
        "act": "1",
        "foreign": "0",
        "certificadoicpbr": "0"
    };
    
    // Você pode adicionar lógica para que o signatário da empresa seja o Vendedor (dados.vendedor)
    // se o campo vendedor for um campo de e-mail ou se o e-mail for mapeado.

    return [signatarioCliente, signatarioEmpresa];
}

/* ========== D4Sign: FUNÇÕES DE API ========== */
const D4_BASE = "https://secure.d4sign.com.br/api/v1"; 

async function processarDocumentoD4(ADD, dados, uuidSafe, idTemplateWord, docName, uuidFolder = null) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  
  if (!tokenAPI || !cryptKey || !uuidSafe || !idTemplateWord) {
      return { error: `Vars D4 incompletas para ${docName}` };
  }

  const url = `${D4_BASE}/documents/${uuidSafe}/makedocumentbytemplateword?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  
  const body = {
      name_document: `${docName} - ${dados.nome_da_marca || dados.nome || "Sem Nome"}`,
      uuid_folder: uuidFolder, 
      templates: {
        [idTemplateWord]: ADD 
      }
  };
  
  const r = await fetch(url, {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify(body)
  });
  const out = await r.json().catch(() => ({}));
  
  if (!r.ok || out.message) {
      return { error: true, status: r.status, name: docName, response: out };
  }
  
  const uuidDoc = out.uuid || out.uuidDoc || out.uuid_document;
  const link = out.url || out.url_document || null;

  return { 
      ok: true, name: docName, uuidDoc, link, response: out 
  };
}

// Adiciona signatários (agora aceita a lista dinâmica)
async function d4AddSigners(uuidDoc, signersArray) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;

  if (!uuidDoc) return { error: "uuidDoc ausente" };
  if (!signersArray?.length) return { error: "Lista de signatários vazia" };

  // Endpoint 'addsigner' ou 'createlist'
  const url = `${D4_BASE}/documents/${uuidDoc}/addsigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`; 
  
  // Corpo da requisição: objeto com a chave 'signers' contendo o array stringificado
  const body = {
    signers: JSON.stringify(signersArray)
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out };
}

// Envia para assinatura
async function d4SendToSign(uuidDoc) {
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;

  if (!uuidDoc) return { error: "uuidDoc ausente" };

  const url = `${D4_BASE}/documents/${uuidDoc}/sendtosigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  
  const r = await fetch(url, { method: "POST" });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out };
}
