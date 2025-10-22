# Pipefy → D4Sign on Netlify Functions (Starter)

Este projeto cria uma **função serverless** gratuita na **Netlify** para receber o **webhook do Pipefy**, buscar os dados do card via **GraphQL** e montar o objeto `ADD` para o **D4Sign**.

## Como usar (passo-a-passo)

1) **Crie um repositório no GitHub** (vazio) e suba estes arquivos.
   - Alternativa: use o **Netlify CLI** (`npm i -g netlify-cli`) e rode `netlify init`.

2) No painel da **Netlify**:
   - Clique em **Add new site → Import an existing project** e conecte ao seu repositório.
   - Em **Build settings**, deixe **Build command** vazio (ou `npm run build`) e **Publish directory** vazio.
   - Confirme que **Functions directory** está `netlify/functions` (este repo já tem `netlify.toml`).

3) Em **Site settings → Environment variables**, adicione:
   - `PIPEFY_TOKEN` = seu token de acesso do Pipefy
   - (Opcional) `D4_TOKEN` e `D4_CRYPT` para a API do D4Sign
   - (Opcional) `D4_UUID_SAFE` e `D4_ID_TEMPLATE_WORD` (se for template Word)
   - (Opcional) `D4_ID_TEMPLATE_HTML` (se for template HTML)

4) Faça o **Deploy**.
   - Sua URL do endpoint ficará: `https://<seu-site>.netlify.app/.netlify/functions/pipefy-webhook`

5) No **Pipefy**, crie um **Webhook** apontando para essa URL (método **POST**).

6) **Teste** com cURL:
   ```bash
   curl -X POST "https://<seu-site>.netlify.app/.netlify/functions/pipefy-webhook"      -H "Content-Type: application/json"      -d '{"data":{"card":{"id":"123456"}}}'
   ```

> Dica: Primeiro valide com um **cardId fixo** no GraphQL (`{ me { id } }` e depois `card(id: X) { ... }`).

## Estrutura

```
netlify.toml
netlify/functions/pipefy-webhook.js
package.json
```

## Próximos passos

- Descomente a parte da chamada ao **D4Sign** no arquivo da função, informe os envs (`D4_*`), e ajuste os placeholders do template (`ADD`).

Boa integração! 🎯
