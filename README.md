# jsonshelf

> Deterministic JSON repair, validation, example-generation, and schema-coercion for AI agents.
> Zero LLM calls. Sub-10ms. $0.0005 per call. Agents only.

**Live endpoint:** <https://jsonshelf.vercel.app/>

`curl https://jsonshelf.vercel.app/` returns a full machine-readable manifest. No HTML. No humans.

## What it does

Four tools, all pure compute, 100% deterministic:

| Endpoint | Purpose |
|---|---|
| `POST /v1/repair` | Fix malformed JSON. Optional schema to conform to. |
| `POST /v1/validate` | Validate JSON against a schema. Returns structured errors with `fix` fields telling the agent exactly what to change. |
| `POST /v1/example` | Generate a minimal valid example from a JSON schema. |
| `POST /v1/coerce` | Soft-cast values to match a schema (e.g. `"42"` → `42` for integer fields). |

Every error response includes `{ error, code, message, fix, docs, http_status }` — agents never have to guess.

## Discovery (no humans required)

- `GET /.well-known/ai-plugin.json` — OpenAI plugin manifest
- `GET /.well-known/mcp.json` — MCP server manifest
- `GET /llms.txt` — machine-readable docs
- `GET /openapi.json` — OpenAPI 3.1 spec
- `GET /v1/pricing` — machine-readable pricing
- `GET /v1/errors` — full error catalog

## Auth

```bash
# 1. Issue a key (100 free credits)
curl -X POST https://jsonshelf.vercel.app/v1/keys

# 2. Use the key
curl -X POST https://jsonshelf.vercel.app/v1/repair \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"input":"{name:\"alice\", skills:[\"code\",]}"}'
```

## Billing

Prepaid credits. Single POST returns a payment URL the agent follows autonomously:

```bash
curl -X POST https://jsonshelf.vercel.app/v1/credits \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"pack":"starter"}'
```

Returns `{ payment_url, x402: { ... } }`. x402 headers are emitted for protocol-compatible clients.

## MCP

Use over HTTP at `https://jsonshelf.vercel.app/mcp` (JSON-RPC 2.0, protocol version `2024-11-05`). Four tools: `jsonshelf_repair`, `jsonshelf_validate`, `jsonshelf_example`, `jsonshelf_coerce`.

## License

Apache 2.0.
