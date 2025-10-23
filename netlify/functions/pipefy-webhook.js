// netlify/functions/pipefy-webhook.js
// Função Netlify: Pipefy -> (mapeia campos) -> ADD do D4Sign -> (opcional) cria doc por template Word

// GET: responde no navegador para teste rápido
// POST: recebe { cardId } ou payload de webhook do Pipefy, busca GraphQL e (opcional) chama D4Sign

export async function handler(event) {
  try {
    if (event.httpMethod === "GET") {
      return text(200, "OK - use POST com JSON { cardId } ou payload do Pipefy");
    }

    if (event.httpMethod !== "POST") {
      return text(405, "Method Not Allowed");
    }

    // -------- entrada --------
    const body = parseJSON(event.body) || {};
    // tenta vários caminhos comuns do webhook do Pipefy
    const cardId =
      body?.data?.card?.id ??
      body?.card?.id ??
      body?.data?.id ??
      body?.cardId ??
      null;

    if (!cardId) {
      return json(400, {
        error: "cardId ausente",
        hint: "Envie { cardId: \"123\" } ou payload do webhook do Pipefy (data.card.id)."
      });
    }

    // -------- busca no Pipefy (GraphQL) --------
    const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
    if (!PIPEFY_TOKEN) {
      return json(500, { error: "Env var PIPEFY_TOKEN não configurada no Netlify." });
    }

    const PIPEFY_GQL = "https://api.pipefy.com/graphql";
    const QUERY = /* GraphQL */ `
      query($cardId: ID!) {
        card(id: $cardId) {
          id
          title
          fields {
            name
            value
            report_value
            field { id }
          }
        }
      }
    `;

    const gqlResp = await fetch(PIPEFY_GQL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PIPEFY_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: QUERY, variables: { cardId } })
    });

    const gqlJson = await gqlResp.json();
    if (!gqlResp.ok || gqlJson?.errors) {
      return json(502, { error: "Erro no GraphQL do Pipefy", details: gqlJson?.errors || await gqlResp.text() });
    }

    const card = gqlJson?.data?.card;
    const fields = card?.fields || [];

    // -------- mapeamento dos campos --------
    const dados = montarDadosContrato(fields);
    const ADD = montarADD(dados);

    // -------- (opcional) criar documento no D4Sign por template Word --------
    const D4_ENABLED = hasAll([
      process.env.D4_TOKEN,
      process.env.D4_CRYPT,
      process.env.D4_UUID_SAFE,
      process.env.D4_ID_TEMPLATE_WORD
    ]);

    let d4sign = {
      enabled: D4_ENABLED,
      note: D4_ENABLED
        ? "D4Sign: variáveis presentes; tentativa de criação do documento."
        : "D4Sign: variáveis ausentes; não foi feita chamada à API."
    };

    if (D4_ENABLED) {
      try {
        d4sign = await gerarContratoNoD4Sign(ADD, dados);
      } catch (e) {
        d4sign = { enabled: true, sent: false, error: String(e) };
      }
    }

    // -------- resposta --------
    return json(200, {
      ok: true,
      cardId,
      cardTitle: card?.title || null,
      dados,      // valores normalizados do card
      ADD,        // chaves para o template do D4Sign
      d4sign      // resultado (ou motivo de não envio)
    });

  } catch (err) {
    return json(500, { error: String(err) });
  }
}

/* ===================== helpers ===================== */

function parseJSON(str) { try { return JSON.parse(str); } catch { return null; } }

function text(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "text/plain; charset=utf-8" }, body };
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 2) };
}

function hasAll(arr) { return arr.every(Boolean); }

const toStr = v => (v == null ? null : String(v).trim());

function getField(fields, fieldId) {
  const f = fields.find(x => x.field?.id === fieldId);
  return f?.report_value ?? f?.value ?? null;
}

// "2.460,00" -> 2460.00
function parseCurrencyBRL(input) {
  if (!input) return null;
  const s = String(input).replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

// "10X" -> 10
function parseParcelas(input) {
  if (!input) return null;
  const m = String(input).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// "MEI/ME/EPP/PF (R$440,00)" -> { categoria, valor }
function parseTaxa(input) {
  if (!input) return { categoria: null, valor: null };
  const s = String(input);
  const categoria = s.split("(")[0].trim() || null;
  const valMatch = s.match(/R\$\s*([\d\.\,]+)/i);
  const valor = valMatch ? parseCurrencyBRL(valMatch[1]) : null;
  return { categoria: categoria || null, valor };
}

function parseDocumentoURL(input) {
  if (!input) return null;
  try {
    if (String(input).trim().startsWith("[")) {
      const arr = JSON.parse(input);
      return Array.isArray(arr) ? arr[0] ?? null : null;
    }
  } catch {}
  return String(input);
}

/* ====== mapeamento de campos do seu pipe ======
   Ajuste os field_ids abaixo se necessário. */
function montarDadosContrato(fields) {
  const nome               = toStr(getField(fields, "nome_do_contato"));
  const nome_da_marca      = toStr(getField(fields, "neg_cio"));
  const telefone           = toStr(getField(fields, "telefone"));
  const email              = toStr(getField(fields, "email_profissional"));
  const valorBruto         = getField(fields, "valor_do_neg_cio");
  const qtdParcelasRaw     = getField(fields, "quantidade_de_parcelas");
  const servicos           = toStr(getField(fields, "servi_os_de_contratos"));
  const pesquisa           = toStr(getField(fields, "paga"));            // "Isenta", etc.
  const taxaRaw            = getField(fields, "copy_of_pesquisa");       // "MEI/ME/EPP/PF (R$440,00)"
  const cep                = toStr(getField(fields, "cep"));
  const uf                 = toStr(getField(fields, "uf"));
  const cidade             = toStr(getField(fields, "cidade"));
  const bairro             = toStr(getField(fields, "bairro"));          // pode não existir em alguns cards
  const rua                = toStr(getField(fields, "rua"));
  const numero             = toStr(getField(fields, "n_mero"));
  const cnpj               = toStr(getField(fields, "cnpj"));            // pode não existir em alguns cards
  const docUrl             = parseDocumentoURL(getField(fields, "documentos"));

  const valor_do_negocio   = parseCurrencyBRL(valorBruto);
  const quantidade_de_parcelas = parseParcelas(qtdParcelasRaw);
  const { categoria: taxa, valor: taxa_valor } = parseTaxa(taxaRaw);

  return {
    nome,
    nome_da_marca,
    telefone,
    email,
    valor_do_negocio,
    quantidade_de_parcelas,
    servicos_de_contrato: servicos,
    pesquisa,
    taxa,
    taxa_valor,
    cnpj,
    cep,
    uf,
    cidade,
    bairro,
    rua,
    numero,
    documento_url: docUrl
  };
}

function montarADD(d) {
  // ajuste as chaves para baterem com os placeholders do seu template D4Sign
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

/* ========== D4Sign (opcional) ========== */
/* Cria documento por template Word. Para ativar:
   - defina no Netlify (Environment variables):
     D4_TOKEN, D4_CRYPT, D4_UUID_SAFE, D4_ID_TEMPLATE_WORD
   - garanta que seu template Word usa placeholders compatíveis com ADD
*/
async function gerarContratoNoD4Sign(ADD, dados) {
  const D4_BASE = "https://sandbox.d4sign.com.br/api/v1"; // troque para produção se aplicável
  const tokenAPI = process.env.D4_TOKEN;
  const cryptKey = process.env.D4_CRYPT;
  const uuidSafe = process.env.D4_UUID_SAFE;
  const idTemplateWord = process.env.D4_ID_TEMPLATE_WORD;

  const url = `${D4_BASE}/documents/${uuidSafe}/makedocumentbytemplateword?tokenAPI=${tokenAPI}&cryptKey=${cryptKey}`;

  const bodyD4 = {
    name_document: `Contrato - ${dados.nome_da_marca || dados.nome || "Sem Nome"}`,
    uuid_folder: null,
    id_template: [idTemplateWord],
    ADD
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify(bodyD4)
  });

  const out = await r.json().catch(() => ({}));

  return {
    enabled: true,
    sent: r.ok,
    status: r.status,
    response: out
  };
}

