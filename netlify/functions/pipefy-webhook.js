// netlify/functions/pipefy-webhook.js
// Fluxo: checkbox "gerar_contrato" => gera doc no D4Sign => adiciona signatários => envia p/ assinatura
// => salva link no card => move p/ fase "Contrato enviado"
// Obs.: para mover p/ "Contrato assinado", use o webhook do D4Sign (ver notas ao final).

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

    // === montar dados / ADD ===
    const dados = montarDadosContrato(fields);
    const ADD = montarADD(dados);

    // === D4Sign: criar doc por template Word ===
    const d4 = await gerarDocumentoD4(ADD, dados);
    if (!d4?.sent) {
      return json(502, { error: "Falha ao criar documento no D4Sign", d4 });
    }
    const uuidDoc = d4?.response?.uuid || d4?.response?.uuidDoc || d4?.response?.uuid_document; // compat

    // === D4Sign: adicionar signatários e enviar p/ assinatura ===
    const addS = await d4AddSigners(uuidDoc);
    if (addS?.error) return json(502, { error: "Falha ao adicionar signatários", addS });

    const send = await d4SendToSign(uuidDoc);
    if (send?.error) return json(502, { error: "Falha ao enviar para assinatura", send });

    // D4Sign costuma devolver link público do documento (ou você pode montar via painel).
    const linkContrato = d4?.response?.url || d4?.response?.url_document || null;

    // === Pipefy: salvar link no campo (default: 'documentos') ===
    const LINK_FIELD = process.env.PIPEFY_FIELD_LINK_CONTRATO || "documentos";
    if (linkContrato) {
      const MUT_UPDATE = `
        mutation($card_id: ID!, $field_id: String!, $value: String!) {
          updateCardField(input: { card_id: $card_id, field_id: $field_id, new_value: $value }) { success }
        }
      `;
      await gql(MUT_UPDATE, { card_id: cardId, field_id: LINK_FIELD, value: linkContrato });
    }

    // (Opcional) resetar checkbox para evitar duplicidade
    // try { await gql(MUT_UPDATE, { card_id: cardId, field_id: "gerar_contrato", value: "false" }); } catch {}

    // === Pipefy: mover card para "Contrato enviado" ===
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
      d4sign: { create: d4, addSigners: addS, sendToSign: send }
    });

  } catch (e) {
    return json(500, { error: String(e) });
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
  const n = Number(String(s).replace(/\./g, "").replace(",", "."));
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

// ====== mapeamento conforme seus cards anteriores ======
function montarDadosContrato(fields) {
  const nome               = toStr(getField(fields, "nome_do_contato"));
  const nome_da_marca      = toStr(getField(fields, "neg_cio"));
  const telefone           = toStr(getField(fields, "telefone"));
  const email              = toStr(getField(fields, "email_profissional"));
  const valorBruto         = getField(fields, "valor_do_neg_cio");
  const qtdParcelasRaw     = getField(fields, "quantidade_de_parcelas");
  const servicos           = toStr(getField(fields, "servi_os_de_contratos"));
  const pesquisa           = toStr(getField(fields, "paga"));
  const taxaRaw            = getField(fields, "copy_of_pesquisa");
  const cep                = toStr(getField(fields, "cep"));
  const uf                 = toStr(getField(fields, "uf"));
  const cidade             = toStr(getField(fields, "cidade"));
  const bairro             = toStr(getField(fields, "bairro"));
  const rua                = toStr(getField(fields, "rua"));
  const numero             = toStr(getField(fields, "n_mero"));
  const cnpj               = toStr(getField(fields, "cnpj"));
  const docUrl             = parseDocumentoURL(getField(fields, "documentos"));

  const valor_do_negocio   = parseCurrencyBRL(valorBruto);
  const quantidade_de_parcelas = parseParcelas(qtdParcelasRaw);
  const { categoria: taxa, valor: taxa_valor } = parseTaxa(taxaRaw);

  return {
    nome, nome_da_marca, telefone, email,
    valor_do_negocio, quantidade_de_parcelas,
    servicos_de_contrato: servicos, pesquisa, taxa, taxa_valor,
    cnpj, cep, uf, cidade, bairro, rua, numero,
    documento_url: docUrl
  };
}

function montarADD(d) {
  return {
    nome: d.nome,
    nome_da_marca: d.nome_da_marca,
    telefone: d.telefone,
    email: d.email,
    valor_do_negocio: d.valor_do_negocio,
    quantidade_de_parcelas: d.quantidade_de_parcelas,
    servicos_de_contrato: d.servicos_de_contrato,
    pesquisa: d.pesquisa,
    taxa: d.taxa,
    taxa_valor: d.taxa_valor,
    cnpj: d.cnpj,
    cep: d.cep,
    uf: d.uf,
    cidade: d.cidade,
    bairro: d.bairro,
    rua: d.rua,
    numero: d.numero
  };
}

/* ========== D4Sign ========== */

async function gerarDocumentoD4(ADD, dados) {
  const D4_BASE = "https://sandbox.d4sign.com.br/api/v1";
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  const uuidSafe = process.env.D4_UUID_SAFE;
  const idTemplateWord = process.env.D4_ID_TEMPLATE_WORD;

  if (!tokenAPI || !cryptKey || !uuidSafe || !idTemplateWord) {
    return { sent: false, reason: "vars D4 incompletas" };
  }

  const url = `${D4_BASE}/documents/${uuidSafe}/makedocumentbytemplateword?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  const body = {
    name_document: `Contrato - ${dados.nome_da_marca || dados.nome || "Sem Nome"}`,
    uuid_folder: null,
    id_template: [idTemplateWord],
    ADD
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const out = await r.json().catch(() => ({}));

  return { sent: r.ok, status: r.status, response: out };
}

// adiciona signatários (usa env D4_SIGNERS como JSON)
async function d4AddSigners(uuidDoc) {
  const D4_BASE = "https://sandbox.d4sign.com.br/api/v1";
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  const signers = safeJson(process.env.D4_SIGNERS || "[]") || [];

  if (!uuidDoc) return { error: "uuidDoc ausente" };
  if (!signers.length) return { error: "D4_SIGNERS vazio" };

  const url = `${D4_BASE}/documents/${uuidDoc}/addsigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify(signers)
  });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out };
}

// envia para assinatura
async function d4SendToSign(uuidDoc) {
  const D4_BASE = "https://sandbox.d4sign.com.br/api/v1";
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;

  if (!uuidDoc) return { error: "uuidDoc ausente" };

  const url = `${D4_BASE}/documents/${uuidDoc}/sendtosigner?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;
  const r = await fetch(url, { method: "POST" });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, response: out } : { error: true, status: r.status, response: out };
}
