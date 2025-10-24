// netlify/functions/pipefy-webhook.js
// ATUALIZE SEU CÓDIGO COM ESTAS MENSAGENS DE LOG

export async function handler(event) {
  try {
    // ----------------------------------------------------------------------
    // PONTO DE CHECAGEM 1: Recebimento do cardId (Se falhar aqui, duração ~5ms)
    // ----------------------------------------------------------------------
    const body = safeJson(event.body) || {};
    const cardId =
      body?.data?.card?.id ??
      body?.card?.id ??
      body?.data?.id ??
      body?.cardId ??
      null;

    console.log(`[CHECK 1] Card ID recebido: ${cardId}`); // <--- DEVE APARECER NO LOG
    console.log(`[CHECK 1] Body recebido: ${JSON.stringify(body)}`); // <--- DEVE APARECER NO LOG

    if (!cardId) {
      console.error("ERRO [FALHA 1]: cardId ausente ou Body inválido. Abortando.");
      return json(400, { error: "cardId ausente. Revise o Webhook Body no Pipefy." });
    }

    // === Pipefy: buscar card ===
    const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
    if (!PIPEFY_TOKEN) return json(500, { error: "PIPEFY_TOKEN ausente" });

    // ----------------------------------------------------------------------
    // PONTO DE CHECAGEM 2: Chamada GraphQL do Pipefy (Se falhar aqui, duração > 50ms)
    // ----------------------------------------------------------------------
    
    console.log(`[CHECK 2] Iniciando busca GraphQL do Card ${cardId}`); // <--- DEVE APARECER NO LOG

    const gql = (query, variables) =>
      fetch("https://api.pipefy.com/graphql", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${PIPEFY_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
      }).then(r => r.json());

    // ... (O restante da sua função handler continua aqui, inalterado) ...
    
    const CARD_Q = `
      query($cardId: ID!) {
        card(id: $cardId) {
          id
          title
          fields { name value report_value field { id } }
        }
      }
    `;
    
    // ... (restante da função) ...

  } catch (e) {
    console.error(`[ERRO FATAL GERAL]: ${String(e)}`);
    return json(500, { error: String(e), stack: e.stack });
  }
}

// ... (Restante das funções helper)
