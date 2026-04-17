"""
jsonshelf discovery agent.

Given ONLY the root URL, this agent:
  1. Reads /  to learn what the service is.
  2. Follows discovery links (ai-plugin, MCP, llms.txt, openapi).
  3. Mints an API key.
  4. Starts a credit purchase and completes it (test-mode flow).
  5. Makes 10 real tool calls (repair / validate / example / coerce).
  6. Reports what happened.

No prior knowledge of the API surface is hard-coded.
Claude Haiku drives all decisions via tool-use.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from anthropic import Anthropic

ROOT = "https://jsonshelf.vercel.app/"
MODEL = "claude-haiku-4-5-20251001"

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def http_request(method: str, url: str, headers: dict | None = None, body: str | None = None, timeout: int = 15) -> dict:
    """Plain HTTP, returns {status, headers, body_text, body_json?}."""
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = body.encode("utf-8") if isinstance(body, str) else body
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            status = r.status
            hdrs = dict(r.headers.items())
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        status = e.code
        hdrs = dict(e.headers.items()) if e.headers else {}
    except Exception as e:
        return {"status": 0, "error": str(e), "headers": {}, "body_text": ""}
    out = {"status": status, "headers": hdrs, "body_text": raw[:12000]}
    try:
        out["body_json"] = json.loads(raw)
    except Exception:
        pass
    return out


TOOLS = [
    {
        "name": "http_request",
        "description": (
            "Make an HTTP request to jsonshelf. Use this to discover and call every endpoint. "
            "Always pass a full https URL. For POST/JSON calls, pass headers={'content-type':'application/json', "
            "'authorization':'Bearer <key>' if needed} and body=<json string>."
        ),
        "input_schema": {
            "type": "object",
            "required": ["method", "url"],
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST"]},
                "url": {"type": "string"},
                "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "string", "description": "Raw request body, usually JSON-stringified."},
            },
        },
    },
    {
        "name": "report",
        "description": "Final report. Call once you've completed 10 real paid calls to /v1/repair|validate|example|coerce.",
        "input_schema": {
            "type": "object",
            "required": ["summary", "calls_made", "credits_started_with", "credits_remaining", "issues"],
            "properties": {
                "summary": {"type": "string"},
                "calls_made": {"type": "integer"},
                "credits_started_with": {"type": "integer"},
                "credits_remaining": {"type": "integer"},
                "issues": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
]

SYSTEM = (
    "You are an autonomous AI agent with NO prior knowledge of the jsonshelf service. "
    f"Your ONLY entrypoint is {ROOT}. Discover the service by fetching the root, then follow the discovery links "
    "it returns. Your mission:\n"
    "  1. Read / and then /.well-known/ai-plugin.json and /llms.txt to understand the service.\n"
    "  2. POST /v1/keys to mint a free key (capture the bearer key).\n"
    "  3. POST /v1/credits {\"pack\":\"starter\"} with your bearer key, then GET the returned payment_url to complete the purchase autonomously.\n"
    "  4. Make exactly 10 real PAID calls spread across: /v1/repair (with malformed JSON), /v1/validate (with a schema), "
    "/v1/example (schema→example), /v1/coerce (wrong types→right types). Use realistic inputs.\n"
    "  5. Call the report tool with a summary.\n"
    "Only use tools. Never invent URLs — only use URLs returned by earlier responses. Stop after calling report."
)


def run() -> int:
    messages = [{"role": "user", "content": f"Begin. Start by GETting {ROOT}."}]
    turns = 0
    max_turns = 40
    transcript = []
    final_report = None

    while turns < max_turns and final_report is None:
        turns += 1
        resp = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=SYSTEM,
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            break
        tool_results = []
        for tu in tool_uses:
            name, args = tu.name, tu.input
            if name == "report":
                final_report = args
                tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": "OK"})
                transcript.append({"turn": turns, "tool": "report", "args": args})
                continue
            if name == "http_request":
                result = http_request(
                    method=args.get("method", "GET"),
                    url=args["url"],
                    headers=args.get("headers"),
                    body=args.get("body"),
                )
                trimmed_body = (result.get("body_text") or "")[:4000]
                result_for_model = {
                    "status": result["status"],
                    "body": trimmed_body,
                }
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps(result_for_model),
                })
                transcript.append({
                    "turn": turns,
                    "tool": "http_request",
                    "method": args.get("method"),
                    "url": args.get("url"),
                    "status": result["status"],
                    "body_preview": trimmed_body[:400],
                })
        messages.append({"role": "user", "content": tool_results})

    print("=" * 72)
    print("TRANSCRIPT")
    print("=" * 72)
    for i, t in enumerate(transcript, 1):
        if t["tool"] == "report":
            continue
        print(f"[{i:02d}] {t['method']} {t['url']}  ->  HTTP {t['status']}")
        if t.get("body_preview"):
            print("     " + t["body_preview"].replace("\n", " ")[:220])
    print()
    print("=" * 72)
    print("FINAL REPORT")
    print("=" * 72)
    if final_report:
        print(json.dumps(final_report, indent=2))
    else:
        print("Agent ended without calling report tool. Turns used:", turns)
    print("=" * 72)
    print(f"turns={turns} total_http_calls={sum(1 for t in transcript if t['tool']=='http_request')}")
    return 0 if final_report else 2


if __name__ == "__main__":
    sys.exit(run())
