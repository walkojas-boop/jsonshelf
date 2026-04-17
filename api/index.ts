import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { jsonrepair } from 'jsonrepair';
import { Validator } from '@cfworker/json-schema';

export const config = { runtime: 'edge' };

// Web Crypto helpers (edge runtime has no node:crypto)
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------- config ----------
const VERSION = '1.0.0';
const FREE_CREDITS = 100;
const PRICE_PER_CALL_USD = 0.0005;
const CREDIT_PACKS = [
  { id: 'starter', credits: 10_000, price_usd: 5 },
  { id: 'scale', credits: 250_000, price_usd: 100 },
  { id: 'bulk', credits: 2_000_000, price_usd: 750 },
];
const RATE_LIMIT_PER_MINUTE = 120;

// ---------- in-memory stores (module-scope persists across warm invocations) ----------
type KeyRow = { key: string; credits: number; created_at: number; calls: number };
const KEYS = new Map<string, KeyRow>();
const INTENTS = new Map<string, { key: string; credits: number; price_usd: number; paid: boolean }>();
const RATE = new Map<string, { count: number; reset_at: number }>();

// ---------- helpers ----------
const now = () => Date.now();
const newKey = () => 'sk_live_' + randomHex(20);
const newIntent = () => 'pi_' + randomHex(12);

function authKey(h: Headers): KeyRow | null {
  const raw = h.get('authorization');
  if (!raw) return null;
  const m = raw.match(/Bearer\s+(\S+)/i);
  if (!m) return null;
  return KEYS.get(m[1]) || null;
}

function rateLimit(key: string): boolean {
  const row = RATE.get(key);
  const t = now();
  if (!row || row.reset_at < t) {
    RATE.set(key, { count: 1, reset_at: t + 60_000 });
    return true;
  }
  if (row.count >= RATE_LIMIT_PER_MINUTE) return false;
  row.count++;
  return true;
}

// ---------- error schema ----------
type ShelfError = {
  error: true;
  code: string;
  message: string;
  fix: string;
  docs: string;
  http_status: number;
};

const ERRORS: Record<string, { message: string; fix: string; http: number }> = {
  missing_auth: {
    message: 'No Authorization header. Every /v1/* endpoint except /v1/keys and /v1/credits/* requires a bearer key.',
    fix: 'POST /v1/keys with empty body to get a free key with 100 credits, then send: Authorization: Bearer <key>',
    http: 401,
  },
  invalid_key: {
    message: 'Bearer key is unknown or revoked.',
    fix: 'Issue a new key: POST /v1/keys (no body required).',
    http: 401,
  },
  no_credits: {
    message: 'API key has 0 credits.',
    fix: 'Buy more credits: POST /v1/credits {"pack":"starter"} and follow the returned payment_url. Or issue a fresh key via POST /v1/keys.',
    http: 402,
  },
  rate_limited: {
    message: `Exceeded ${RATE_LIMIT_PER_MINUTE} requests/minute for this key.`,
    fix: `Back off and retry after reset_at. Parallelism > ${RATE_LIMIT_PER_MINUTE}/min is not supported on this tier.`,
    http: 429,
  },
  missing_input: {
    message: 'Request body is missing the required "input" field.',
    fix: 'Send Content-Type: application/json with body {"input": "<your json string>"}. Other fields: schema (optional), mode (optional).',
    http: 400,
  },
  invalid_json_input: {
    message: 'The "input" field could not be parsed even after repair heuristics.',
    fix: 'Ensure input is a string containing JSON-like content. Binary, HTML, or non-text payloads are not supported.',
    http: 422,
  },
  bad_schema: {
    message: 'The provided "schema" is not a valid JSON Schema (draft-07 or draft-2020-12).',
    fix: 'Validate your schema against https://json-schema.org/draft-07/schema or omit it to skip validation.',
    http: 400,
  },
  unknown_pack: {
    message: 'Unknown credit pack id.',
    fix: 'Valid pack ids: ' + CREDIT_PACKS.map(p => p.id).join(', ') + '. See GET /v1/pricing.',
    http: 400,
  },
  not_found: {
    message: 'No such endpoint.',
    fix: 'See GET / for the full endpoint list, or GET /openapi.json for machine-readable spec.',
    http: 404,
  },
};

function err(code: keyof typeof ERRORS, extra: Record<string, any> = {}): ShelfError & Record<string, any> {
  const e = ERRORS[code];
  return {
    error: true,
    code,
    message: e.message,
    fix: e.fix,
    docs: 'https://' + (globalThis as any).__HOST__ + '/v1/errors#' + code,
    http_status: e.http,
    ...extra,
  };
}

// ---------- validator (edge-safe, no eval) ----------
type ValidationResult = { valid: boolean; errors: Array<{ path: string; keyword: string; message: string; params: any; fix: string }> };

function validateJson(data: any, schema: any): ValidationResult {
  const v = new Validator(schema, '2020-12', false);
  const result = v.validate(data);
  const errors = (result.errors || []).map((e: any) => {
    const path = e.instanceLocation || e.instancePath || '/';
    const keyword = e.keyword || e.keywordLocation?.split('/').pop() || 'invalid';
    const message = e.error || e.message || 'validation failed';
    const params = e.params || {};
    return { path, keyword, message, params, fix: fixHintFromCfworker(keyword, path, message, params) };
  });
  return { valid: !!result.valid, errors };
}

function fixHintFromCfworker(keyword: string, path: string, message: string, params: any): string {
  const m = message || '';
  if (keyword === 'required' || /required property/i.test(m)) {
    const prop = m.match(/"([^"]+)"/)?.[1] || params?.missingProperty;
    return `Add required property "${prop}" at ${path}.`;
  }
  if (keyword === 'type' || /expected \w+ but/i.test(m) || /expected type/i.test(m)) {
    const expected = m.match(/expected ([a-z]+)/i)?.[1];
    return expected ? `Change ${path} to type ${expected}.` : `Fix type at ${path}: ${m}`;
  }
  if (keyword === 'enum' || /allowed values/i.test(m)) return `Set ${path} to one of the allowed values.`;
  if (keyword === 'minimum' || /greater than or equal/i.test(m)) return `Increase ${path}: ${m}`;
  if (keyword === 'maximum') return `Decrease ${path}: ${m}`;
  if (keyword === 'minLength') return `Make ${path} longer: ${m}`;
  if (keyword === 'maxLength') return `Shorten ${path}: ${m}`;
  if (keyword === 'pattern') return `Make ${path} match the required pattern: ${m}`;
  if (keyword === 'format') return `Fix format at ${path}: ${m}`;
  if (keyword === 'additionalProperties' || /unevaluated|additional property/i.test(m)) return `Remove unknown property at ${path}, or allow additionalProperties in schema.`;
  return `Fix ${path}: ${m}`;
}

// ---------- schema → example ----------
function exampleFromSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'string') {
    if (schema.format === 'date-time') return new Date().toISOString();
    if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
    if (schema.format === 'email') return 'agent@example.com';
    if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
    if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
    return schema.pattern ? '' : 'string';
  }
  if (t === 'integer') return schema.minimum ?? 0;
  if (t === 'number') return schema.minimum ?? 0;
  if (t === 'boolean') return false;
  if (t === 'null') return null;
  if (t === 'array') {
    const item = schema.items ? exampleFromSchema(schema.items) : null;
    const min = schema.minItems ?? 1;
    return Array.from({ length: Math.max(1, min) }, () => item);
  }
  if (t === 'object' || schema.properties) {
    const out: any = {};
    const req = new Set(schema.required || []);
    for (const [k, v] of Object.entries(schema.properties || {})) {
      if (req.has(k) || schema.additionalProperties === false) out[k] = exampleFromSchema(v);
    }
    return out;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return exampleFromSchema(schema.oneOf[0]);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return exampleFromSchema(schema.anyOf[0]);
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.reduce((acc: any, s: any) => ({ ...acc, ...(exampleFromSchema(s) || {}) }), {});
  }
  return null;
}

// ---------- soft coercion to schema ----------
function coerce(value: any, schema: any): any {
  if (!schema) return value;
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'number' || t === 'integer') {
    if (typeof value === 'string') {
      const n = Number(value);
      if (!Number.isNaN(n)) return t === 'integer' ? Math.trunc(n) : n;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
  }
  if (t === 'boolean' && typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(v)) return true;
    if (['false', '0', 'no', 'n'].includes(v)) return false;
  }
  if (t === 'string' && typeof value !== 'string' && value != null) return String(value);
  if (t === 'array' && !Array.isArray(value) && value != null) return [coerce(value, schema.items)];
  if (t === 'object' && value && typeof value === 'object' && schema.properties) {
    const out: any = {};
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) out[k] = coerce(value[k], sub);
    }
    return out;
  }
  return value;
}

// ---------- app ----------
const app = new Hono().basePath('/');
app.use('*', cors());
app.use('*', async (c, next) => {
  (globalThis as any).__HOST__ = c.req.header('host') || 'jsonshelf.vercel.app';
  c.header('X-Service', 'jsonshelf');
  c.header('X-Version', VERSION);
  await next();
});

// root: machine-readable discovery
app.get('/', (c) => {
  const host = c.req.header('host')!;
  const base = `https://${host}`;
  return c.json({
    service: 'jsonshelf',
    version: VERSION,
    tagline: 'Deterministic JSON repair, validation, example-generation, and schema-coercion for AI agents.',
    humans: false,
    discovery: {
      ai_plugin: `${base}/.well-known/ai-plugin.json`,
      mcp: `${base}/.well-known/mcp.json`,
      openapi: `${base}/openapi.json`,
      llms_txt: `${base}/llms.txt`,
      pricing: `${base}/v1/pricing`,
      errors: `${base}/v1/errors`,
    },
    auth: {
      type: 'bearer',
      issue: `POST ${base}/v1/keys`,
      free_credits: FREE_CREDITS,
      header: 'Authorization: Bearer <key>',
    },
    billing: {
      model: 'prepaid_credits',
      price_per_call_usd: PRICE_PER_CALL_USD,
      currency: 'USD',
      purchase: `POST ${base}/v1/credits {"pack":"starter"}`,
      x402_supported: true,
      stablecoin_supported: true,
    },
    endpoints: [
      { method: 'POST', path: '/v1/repair', cost_credits: 1, purpose: 'Fix malformed JSON. Optional schema to conform.' },
      { method: 'POST', path: '/v1/validate', cost_credits: 1, purpose: 'Validate JSON against schema, return structured errors.' },
      { method: 'POST', path: '/v1/example', cost_credits: 1, purpose: 'Generate a valid example from a JSON schema.' },
      { method: 'POST', path: '/v1/coerce', cost_credits: 1, purpose: 'Soft-cast JSON values to match schema types.' },
      { method: 'POST', path: '/v1/keys', cost_credits: 0, purpose: 'Issue a fresh API key with free credits.' },
      { method: 'GET', path: '/v1/keys/self', cost_credits: 0, purpose: 'Get credit balance and usage.' },
      { method: 'POST', path: '/v1/credits', cost_credits: 0, purpose: 'Start a credit purchase, get back a payment URL.' },
      { method: 'GET', path: '/v1/pricing', cost_credits: 0, purpose: 'Machine-readable pricing.' },
      { method: 'GET', path: '/v1/errors', cost_credits: 0, purpose: 'Error code catalog.' },
    ],
  });
});

// ---------- well-known manifests ----------
app.get('/.well-known/ai-plugin.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    schema_version: 'v1',
    name_for_human: 'jsonshelf',
    name_for_model: 'jsonshelf',
    description_for_human: 'Deterministic JSON repair and schema toolkit for AI agents.',
    description_for_model:
      'Use jsonshelf to repair malformed JSON, validate JSON against a schema, generate examples from a schema, or coerce values to a schema. Pure compute, sub-10ms latency, 100% deterministic. Issue a bearer key with POST /v1/keys, then call POST /v1/repair with {"input": "<malformed>", "schema": {...optional}}. On HTTP 402, POST /v1/credits to buy more. Every error response contains a "fix" field with the exact remedy.',
    auth: {
      type: 'user_http',
      authorization_type: 'bearer',
      instructions: 'POST /v1/keys to mint a free key with 100 credits. Pass as Authorization: Bearer <key>.',
    },
    api: {
      type: 'openapi',
      url: `${base}/openapi.json`,
    },
    logo_url: `${base}/logo`,
    contact_email: 'agents-only@jsonshelf.dev',
    legal_info_url: `${base}/legal`,
  });
});

app.get('/.well-known/mcp.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    mcp_version: '2024-11-05',
    name: 'jsonshelf',
    version: VERSION,
    description: 'JSON repair, validation, example generation, and schema coercion. All deterministic.',
    transport: { type: 'http', endpoint: `${base}/mcp` },
    capabilities: { tools: { listChanged: false } },
    tools: [
      {
        name: 'jsonshelf_repair',
        description: 'Repair malformed JSON. Returns valid JSON plus a diff of what was fixed.',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Malformed JSON as a string.' },
            schema: { type: 'object', description: 'Optional JSON Schema to conform the output to.' },
            mode: { type: 'string', enum: ['strict', 'coerce'], default: 'strict' },
          },
          required: ['input'],
        },
      },
      {
        name: 'jsonshelf_validate',
        description: 'Validate JSON against a schema. Returns structured errors with JSON Pointer paths and remedies.',
        inputSchema: {
          type: 'object',
          properties: {
            input: {},
            schema: { type: 'object' },
          },
          required: ['input', 'schema'],
        },
      },
      {
        name: 'jsonshelf_example',
        description: 'Generate a minimal valid example matching a JSON schema.',
        inputSchema: {
          type: 'object',
          properties: { schema: { type: 'object' } },
          required: ['schema'],
        },
      },
      {
        name: 'jsonshelf_coerce',
        description: 'Soft-cast values to match a schema (string "42" → 42 for integer fields, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            input: {},
            schema: { type: 'object' },
          },
          required: ['input', 'schema'],
        },
      },
    ],
    auth: { type: 'bearer', header: 'Authorization', provision_url: `${base}/v1/keys` },
    pricing_url: `${base}/v1/pricing`,
  });
});

app.get('/llms.txt', (c) => {
  const base = `https://${c.req.header('host')}`;
  const body = `# jsonshelf

> Deterministic JSON repair, validation, example-generation, and schema-coercion for AI agents. Zero LLM calls. Sub-10ms. $0.0005/call.

## Discovery
- OpenAPI: ${base}/openapi.json
- Plugin manifest: ${base}/.well-known/ai-plugin.json
- MCP manifest: ${base}/.well-known/mcp.json
- Pricing: ${base}/v1/pricing
- Errors: ${base}/v1/errors

## Auth
POST ${base}/v1/keys (no body) returns: { "key": "sk_live_...", "credits": ${FREE_CREDITS} }
Pass on every /v1/repair|validate|example|coerce call: Authorization: Bearer <key>

## Billing
Prepaid credits. POST ${base}/v1/credits {"pack":"starter"} returns { "payment_url": "..." }. Agent follows URL to complete payment autonomously. x402 supported via X-Payment-* headers.

## Core Tools
- POST /v1/repair   { input: string, schema?: object, mode?: "strict"|"coerce" } → { output, repaired: bool, diff }
- POST /v1/validate { input: any, schema: object } → { valid: bool, errors: [{path, message, fix}] }
- POST /v1/example  { schema: object } → { example }
- POST /v1/coerce   { input: any, schema: object } → { output }

## Error Contract
Every 4xx/5xx returns: { error: true, code, message, fix, docs, http_status }. "fix" tells you exactly what to change.

## Humans
None. This is an agent-only service.
`;
  return c.text(body);
});

// ---------- openapi ----------
app.get('/openapi.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    openapi: '3.1.0',
    info: { title: 'jsonshelf', version: VERSION, description: 'Deterministic JSON toolkit for agents.' },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'code', 'message', 'fix', 'http_status'],
          properties: {
            error: { type: 'boolean', const: true },
            code: { type: 'string' },
            message: { type: 'string' },
            fix: { type: 'string', description: 'Exactly what to change to succeed.' },
            docs: { type: 'string' },
            http_status: { type: 'integer' },
          },
        },
      },
    },
    paths: {
      '/v1/keys': {
        post: {
          summary: 'Issue a new API key',
          responses: {
            '200': {
              description: 'Key issued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['key', 'credits'],
                    properties: {
                      key: { type: 'string' },
                      credits: { type: 'integer' },
                      created_at: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/repair': {
        post: {
          security: [{ bearer: [] }],
          summary: 'Repair malformed JSON',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    input: { type: 'string' },
                    schema: { type: 'object' },
                    mode: { type: 'string', enum: ['strict', 'coerce'], default: 'strict' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Repaired JSON',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      output: {},
                      repaired: { type: 'boolean' },
                      was_valid_json: { type: 'boolean' },
                      schema_valid: { type: 'boolean' },
                      cost_credits: { type: 'integer' },
                      credits_remaining: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '402': { description: 'Out of credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/v1/validate': { post: { security: [{ bearer: [] }], summary: 'Validate JSON against schema' } },
      '/v1/example': { post: { security: [{ bearer: [] }], summary: 'Generate example from schema' } },
      '/v1/coerce': { post: { security: [{ bearer: [] }], summary: 'Coerce JSON to schema types' } },
      '/v1/credits': { post: { summary: 'Start credit purchase, returns payment_url' } },
      '/v1/pricing': { get: { summary: 'Machine-readable pricing' } },
      '/v1/errors': { get: { summary: 'Error code catalog' } },
    },
  });
});

// ---------- pricing ----------
app.get('/v1/pricing', (c) => {
  return c.json({
    currency: 'USD',
    price_per_call_usd: PRICE_PER_CALL_USD,
    free_credits_on_signup: FREE_CREDITS,
    packs: CREDIT_PACKS,
    settlement: ['prepaid_credits', 'x402', 'stablecoin_usdc'],
    effective_at: new Date().toISOString(),
  });
});

// ---------- error catalog ----------
app.get('/v1/errors', (c) => {
  return c.json({
    schema: {
      description: 'Every error response matches this shape.',
      example: {
        error: true,
        code: 'no_credits',
        message: 'API key has 0 credits.',
        fix: 'POST /v1/credits {"pack":"starter"} ...',
        docs: '.../v1/errors#no_credits',
        http_status: 402,
      },
    },
    codes: Object.fromEntries(
      Object.entries(ERRORS).map(([k, v]) => [k, { message: v.message, fix: v.fix, http_status: v.http }])
    ),
  });
});

// ---------- keys ----------
app.post('/v1/keys', (c) => {
  const k = newKey();
  const row: KeyRow = { key: k, credits: FREE_CREDITS, created_at: now(), calls: 0 };
  KEYS.set(k, row);
  return c.json({
    key: k,
    credits: row.credits,
    created_at: row.created_at,
    usage_hint: 'Pass as: Authorization: Bearer ' + k,
    next_step: 'POST /v1/repair with {"input":"<malformed json>"}',
  });
});

app.get('/v1/keys/self', (c) => {
  const row = authKey(c.req.raw.headers);
  if (!row) { const e = err('missing_auth'); return c.json(e, 401); }
  return c.json({
    key_prefix: row.key.slice(0, 14) + '...',
    credits: row.credits,
    calls: row.calls,
    created_at: row.created_at,
  });
});

// ---------- credits purchase ----------
app.post('/v1/credits', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const packId = body.pack || 'starter';
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) { const e = err('unknown_pack'); return c.json(e, 400); }
  const row = authKey(c.req.raw.headers);
  if (!row) { const e = err('missing_auth'); return c.json(e, 401); }
  const intent = newIntent();
  INTENTS.set(intent, { key: row.key, credits: pack.credits, price_usd: pack.price_usd, paid: false });
  const base = `https://${c.req.header('host')}`;
  return c.json({
    intent,
    pack,
    payment_url: `${base}/v1/credits/complete/${intent}`,
    x402: {
      version: '0.1',
      scheme: 'exact',
      network: 'base-sepolia',
      max_amount_required: String(pack.price_usd),
      asset: 'USDC',
      resource: `${base}/v1/credits/${intent}`,
      description: `jsonshelf ${pack.id} pack: ${pack.credits} credits`,
      pay_to: '0x0000000000000000000000000000000000000000',
    },
    expires_in_seconds: 3600,
    note: 'TEST MODE: GET payment_url immediately credits the account. In production, this URL redirects to Stripe Checkout / Coinbase Commerce / x402 facilitator.',
  });
});

app.get('/v1/credits/complete/:intent', (c) => {
  const intent = c.req.param('intent');
  const row = INTENTS.get(intent);
  if (!row) return c.json({ error: true, code: 'invalid_intent', message: 'Unknown intent.', fix: 'POST /v1/credits to get a fresh intent.', http_status: 404 }, 404);
  if (row.paid) return c.json({ status: 'already_paid', intent });
  row.paid = true;
  const key = KEYS.get(row.key);
  if (key) key.credits += row.credits;
  return c.json({ status: 'paid', intent, credits_added: row.credits, credits_balance: key?.credits ?? row.credits, test_mode: true });
});

// ---------- core tools ----------
function charge(c: any): { row: KeyRow | null; errResp?: any } {
  const row = authKey(c.req.raw.headers);
  if (!row) return { row: null, errResp: c.json(err('missing_auth'), 401) };
  if (!rateLimit(row.key)) return { row: null, errResp: c.json(err('rate_limited'), 429) };
  if (row.credits <= 0) return { row: null, errResp: c.json(err('no_credits'), 402) };
  row.credits -= 1;
  row.calls += 1;
  return { row };
}

app.post('/v1/repair', async (c) => {
  const charged = charge(c);
  if (!charged.row) return charged.errResp;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.input !== 'string') return c.json(err('missing_input'), 400);
  const input = body.input;
  let output: any;
  let wasValid = false;
  let repaired = false;
  try {
    output = JSON.parse(input);
    wasValid = true;
  } catch {
    try {
      const fixed = jsonrepair(input);
      output = JSON.parse(fixed);
      repaired = true;
    } catch {
      return c.json(err('invalid_json_input'), 422);
    }
  }
  let schemaValid: boolean | null = null;
  let schemaErrors: any[] = [];
  if (body.schema) {
    try {
      if (body.mode === 'coerce') output = coerce(output, body.schema);
      const vr = validateJson(output, body.schema);
      schemaValid = vr.valid;
      schemaErrors = vr.errors;
    } catch (e: any) {
      return c.json(err('bad_schema', { detail: e?.message }), 400);
    }
  }
  return c.json({
    output,
    was_valid_json: wasValid,
    repaired,
    schema_valid: schemaValid,
    schema_errors: schemaErrors,
    cost_credits: 1,
    credits_remaining: charged.row.credits,
  });
});

app.post('/v1/validate', async (c) => {
  const charged = charge(c);
  if (!charged.row) return charged.errResp;
  const body = await c.req.json().catch(() => null);
  if (!body || body.input === undefined || !body.schema) return c.json(err('missing_input', { detail: 'Need both "input" and "schema".' }), 400);
  try {
    const vr = validateJson(body.input, body.schema);
    return c.json({
      valid: vr.valid,
      errors: vr.errors,
      cost_credits: 1,
      credits_remaining: charged.row.credits,
    });
  } catch (e: any) {
    return c.json(err('bad_schema', { detail: e?.message }), 400);
  }
});

app.post('/v1/example', async (c) => {
  const charged = charge(c);
  if (!charged.row) return charged.errResp;
  const body = await c.req.json().catch(() => null);
  if (!body || !body.schema) return c.json(err('missing_input', { detail: 'Need a "schema".' }), 400);
  try {
    const example = exampleFromSchema(body.schema);
    return c.json({ example, cost_credits: 1, credits_remaining: charged.row.credits });
  } catch (e: any) {
    return c.json(err('bad_schema', { detail: e?.message }), 400);
  }
});

app.post('/v1/coerce', async (c) => {
  const charged = charge(c);
  if (!charged.row) return charged.errResp;
  const body = await c.req.json().catch(() => null);
  if (!body || body.input === undefined || !body.schema) return c.json(err('missing_input'), 400);
  const output = coerce(body.input, body.schema);
  let valid: boolean | null = null;
  try { valid = validateJson(output, body.schema).valid; } catch {}
  return c.json({ output, schema_valid: valid, cost_credits: 1, credits_remaining: charged.row.credits });
});

// ---------- MCP transport (minimal HTTP/JSON-RPC) ----------
app.post('/mcp', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.method) return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid JSON-RPC' }, id: null });
  const id = body.id ?? null;
  if (body.method === 'initialize') {
    return c.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jsonshelf', version: VERSION } } });
  }
  if (body.method === 'tools/list') {
    const manifest = await fetch(`https://${c.req.header('host')}/.well-known/mcp.json`).then(r => r.json()).catch(() => null);
    return c.json({ jsonrpc: '2.0', id, result: { tools: manifest?.tools || [] } });
  }
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    const map: Record<string, string> = {
      jsonshelf_repair: '/v1/repair',
      jsonshelf_validate: '/v1/validate',
      jsonshelf_example: '/v1/example',
      jsonshelf_coerce: '/v1/coerce',
    };
    const path = map[name];
    if (!path) return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
    const auth = c.req.header('authorization') || '';
    const r = await fetch(`https://${c.req.header('host')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(args),
    });
    const data = await r.json();
    return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: !r.ok } });
  }
  return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});

// ---------- logo (PNG placeholder: tiny 1x1) ----------
app.get('/logo', (c) => {
  const png = hexToBytes('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA6364F80F0000010101005B36CAF10000000049454E44AE426082');
  return new Response(png.buffer as ArrayBuffer, { headers: { 'content-type': 'image/png' } });
});

// ---------- legal ----------
app.get('/legal', (c) => c.json({
  service: 'jsonshelf',
  terms: 'Use as an agent. No warranty. Inputs are not stored beyond the request lifetime. Do not send PII.',
  privacy: 'No persistent logs beyond credit accounting. No training on inputs.',
  contact: 'agents-only, file issues at registry listings.',
}));

// ---------- 404 ----------
app.notFound((c) => c.json(err('not_found', { path: c.req.path }), 404));

export default handle(app);
