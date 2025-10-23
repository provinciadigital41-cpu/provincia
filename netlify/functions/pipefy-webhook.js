// netlify/functions/pipefy-webhook.js
export async function handler(event) {
  // Responde no navegador (GET) para testar rápido
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "OK - use POST com JSON { cardId }" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Apenas ecoa o corpo recebido por enquanto
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, received: event.body || null })
  };
}
