from __future__ import annotations

import json
import os
import re
from typing import Any

import psycopg
from openai import OpenAI


MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-luna")

TOOLS = [
    {
        "type": "function",
        "name": "get_my_day",
        "description": "Get Maya Iyer's authored demo day from C4C, Outlook, Teams, and Outlook Calendar. Use this for today, morning briefing, reminders, unread mail/messages, and schedule questions.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "get_work_order_context",
        "description": "Get a complete briefing for one C4C work order: work order, account, site, asset, service history, related email, Teams messages, reserved parts, and opportunities.",
        "parameters": {
            "type": "object",
            "properties": {"work_order_id": {"type": "string"}},
            "required": ["work_order_id"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "search_work_orders",
        "description": "Search C4C work orders by customer, instrument, issue, work order ID, location, status, or other text.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "search_emails",
        "description": "Search Maya's Outlook demo mailbox by subject, sender, customer, instrument, work order, or message text.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "search_teams_messages",
        "description": "Search Microsoft Teams demo messages by person, customer, instrument, work order, channel, or message text.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]

_SESSIONS: dict[str, dict[str, Any]] = {}


def get_session(session_id: str) -> dict[str, Any]:
    return _SESSIONS.setdefault(session_id, {
        "active_work_order_id": None,
        "active_asset_id": None,
        "active_account_id": None,
        "recent_work_orders": [],
        "openai_response_id": None,
    })


def _conn(database_url: str):
    return psycopg.connect(database_url, sslmode="require")


def _meta(conn, key: str) -> dict[str, Any]:
    row = conn.execute("SELECT value FROM demo_meta WHERE key=%s", (key,)).fetchone()
    return row[0] if row else {}


def _get_my_day(database_url: str) -> dict[str, Any]:
    with _conn(database_url) as conn:
        ctx = _meta(conn, "demo_context")
        dataset = _meta(conn, "dataset")
        day = ctx["demo_date"]
        asof = ctx["demo_as_of"]
        maya = dataset["logged_in_user_id"]

        work_orders = []
        rows = conn.execute("""
            SELECT wo.data, a.data, s.data, ast.data
            FROM work_orders wo
            LEFT JOIN accounts a ON a.id=wo.account_id
            LEFT JOIN sites s ON s.id=wo.site_id
            LEFT JOIN assets ast ON ast.id=wo.asset_id
            WHERE wo.assigned_engineer_id=%s AND wo.scheduled_start::date=%s::date
            ORDER BY wo.scheduled_start
        """, (maya, day)).fetchall()
        for wo, account, site, asset in rows:
            work_orders.append({"work_order": wo, "account": account, "site": site, "asset": asset})

        calendar = [r[0] for r in conn.execute(
            "SELECT data FROM calendar_events WHERE start_at::date=%s::date ORDER BY start_at", (day,)
        ).fetchall()]
        reminders = [r[0] for r in conn.execute("""
            SELECT data FROM notifications
            WHERE status='unread' AND created_at <= %s::timestamp
            ORDER BY CASE lower(severity) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
        """, (asof,)).fetchall()]
        emails = [r[0] for r in conn.execute("""
            SELECT data FROM emails
            WHERE is_read=false AND status <> 'draft' AND COALESCE(received_at,sent_at) <= %s::timestamp
            ORDER BY COALESCE(received_at,sent_at) DESC
        """, (asof,)).fetchall()]
        teams = [r[0] for r in conn.execute("""
            SELECT data FROM teams_messages
            WHERE is_read=false AND sent_at <= %s::timestamp
            ORDER BY sent_at DESC
        """, (asof,)).fetchall()]

        return {
            "demo_date": day,
            "as_of": asof,
            "source_systems": ["C4C", "Microsoft Outlook", "Microsoft Teams", "Outlook Calendar"],
            "work_orders": work_orders,
            "calendar": calendar,
            "reminders": reminders,
            "unread_emails": emails,
            "unread_teams_messages": teams,
            "preferred_response_order": ["work_orders", "reminders", "unread_emails", "unread_teams_messages"],
        }


def _get_work_order_context(database_url: str, work_order_id: str) -> dict[str, Any]:
    with _conn(database_url) as conn:
        row = conn.execute("""
            SELECT wo.data, a.data, s.data, ast.data
            FROM work_orders wo
            LEFT JOIN accounts a ON a.id=wo.account_id
            LEFT JOIN sites s ON s.id=wo.site_id
            LEFT JOIN assets ast ON ast.id=wo.asset_id
            WHERE wo.id=%s
        """, (work_order_id,)).fetchone()
        if not row:
            return {"error": "work_order_not_found", "work_order_id": work_order_id}

        work_order, account, site, asset = row
        asset_id = work_order.get("asset_id")
        account_id = work_order.get("account_key")

        history = []
        if asset_id:
            history = [r[0] for r in conn.execute("""
                SELECT data FROM work_orders
                WHERE asset_id=%s AND id<>%s
                ORDER BY scheduled_start DESC NULLS LAST LIMIT 12
            """, (asset_id, work_order_id)).fetchall()]
            emails = [r[0] for r in conn.execute("""
                SELECT data FROM emails
                WHERE work_order_id=%s OR asset_id=%s
                ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST LIMIT 20
            """, (work_order_id, asset_id)).fetchall()]
            teams = [r[0] for r in conn.execute("""
                SELECT data FROM teams_messages
                WHERE work_order_id=%s OR asset_id=%s
                ORDER BY sent_at DESC NULLS LAST LIMIT 20
            """, (work_order_id, asset_id)).fetchall()]
        else:
            emails = [r[0] for r in conn.execute("""
                SELECT data FROM emails
                WHERE work_order_id=%s
                ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST LIMIT 20
            """, (work_order_id,)).fetchall()]
            teams = [r[0] for r in conn.execute("""
                SELECT data FROM teams_messages
                WHERE work_order_id=%s
                ORDER BY sent_at DESC NULLS LAST LIMIT 20
            """, (work_order_id,)).fetchall()]

        parts = [r[0] for r in conn.execute(
            "SELECT data FROM part_reservations WHERE work_order_id=%s", (work_order_id,)
        ).fetchall()]
        opportunities = []
        if account_id:
            opportunities = [r[0] for r in conn.execute(
                "SELECT data FROM opportunities WHERE account_id=%s LIMIT 10", (account_id,)
            ).fetchall()]

        return {
            "source": "C4C",
            "work_order": work_order,
            "account": account,
            "site": site,
            "asset": asset,
            "service_history": history,
            "related_outlook": emails,
            "related_teams": teams,
            "part_reservations": parts,
            "related_opportunities": opportunities,
        }


def _search_json_table(database_url: str, table: str, query: str, order_sql: str, limit: int) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit or 10), 20))
    with _conn(database_url) as conn:
        return [r[0] for r in conn.execute(
            f"SELECT data FROM {table} WHERE data::text ILIKE %s {order_sql} LIMIT %s",
            (f"%{query}%", limit),
        ).fetchall()]


def execute_tool(database_url: str, name: str, arguments: dict[str, Any]) -> Any:
    if name == "get_my_day":
        return _get_my_day(database_url)
    if name == "get_work_order_context":
        return _get_work_order_context(database_url, arguments["work_order_id"])
    if name == "search_work_orders":
        return _search_json_table(database_url, "work_orders", arguments["query"], "ORDER BY scheduled_start DESC NULLS LAST", arguments.get("limit", 10))
    if name == "search_emails":
        return _search_json_table(database_url, "emails", arguments["query"], "ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST", arguments.get("limit", 10))
    if name == "search_teams_messages":
        return _search_json_table(database_url, "teams_messages", arguments["query"], "ORDER BY sent_at DESC NULLS LAST", arguments.get("limit", 10))
    raise ValueError(f"Unknown tool: {name}")


def _remember_tool_result(session: dict[str, Any], tool_name: str, result: Any) -> None:
    if tool_name == "get_my_day" and isinstance(result, dict):
        recent = []
        for item in result.get("work_orders", []):
            wo = item.get("work_order") or {}
            acct = item.get("account") or {}
            site = item.get("site") or {}
            asset = item.get("asset") or {}
            recent.append({
                "work_order_id": wo.get("work_order_id") or wo.get("id"),
                "scheduled_start": wo.get("scheduled_start"),
                "account_name": acct.get("name") or acct.get("account_name") or wo.get("account_name"),
                "site_name": site.get("site_name") or site.get("name"),
                "asset_name": asset.get("product_name") or asset.get("name") or wo.get("product_name"),
                "issue": wo.get("subject") or wo.get("issue_summary") or wo.get("description"),
            })
        session["recent_work_orders"] = recent
        if recent:
            session["active_work_order_id"] = recent[0]["work_order_id"]
    elif tool_name == "get_work_order_context" and isinstance(result, dict):
        wo = result.get("work_order") or {}
        session["active_work_order_id"] = wo.get("work_order_id") or wo.get("id")
        session["active_asset_id"] = wo.get("asset_id")
        session["active_account_id"] = wo.get("account_key")
    elif tool_name == "search_work_orders" and isinstance(result, list) and len(result) == 1:
        wo = result[0]
        session["active_work_order_id"] = wo.get("work_order_id") or wo.get("id")
        session["active_asset_id"] = wo.get("asset_id")
        session["active_account_id"] = wo.get("account_key")


def _instructions(session: dict[str, Any]) -> str:
    state = {
        "active_work_order_id": session.get("active_work_order_id"),
        "active_asset_id": session.get("active_asset_id"),
        "active_account_id": session.get("active_account_id"),
        "recent_work_orders": session.get("recent_work_orders", []),
    }
    return f"""You are Meyora, a concise AI work assistant for Maya Iyer, a fictional Senior Field Service Engineer in a synthetic enterprise demo.

The field-service system presented in this demo is C4C. Never call it Dynamics 365, Dynamics, Salesforce Field Service, or ServiceNow.
Connected demo systems are exactly: C4C, Microsoft Outlook, Microsoft Teams, and Outlook Calendar.

This is a static authored demo snapshot, not a simulator. Relative terms such as today, this morning, and later today refer to the demo date returned by get_my_day, not the wall-clock date.

Current conversation entity state:
{json.dumps(state, default=str)}

Rules:
- For operational questions, use tools instead of guessing.
- For a daily briefing, call get_my_day and present information in this order: appointments/work orders first, then reminders, then important Outlook email, then important Teams messages. Mention calendar blocks only when useful.
- Be conversational, not dashboard-like.
- When Maya says the first one, that instrument, them, or similar, resolve it from the current conversation state.
- For prepare me or brief me, call get_work_order_context and synthesize customer/site, issue, asset, relevant history, recent customer communication, team context, parts, and commercial context when relevant.
- Distinguish facts retrieved from demo records from your own inference. Do not invent missing service events.
- Keep answers concise enough for a mobile chat, but include the details needed to act.
- Do not perform writes yet. If Maya asks to send/update/create something, say the action can be drafted but write-confirmation tools are not enabled in this build.
""".strip()


def _speechify(text: str) -> str:
    text = re.sub(r"[*_#`>]+", "", text)
    text = re.sub(r"\n{2,}", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:1800]


def _ui_blocks_from_trace(trace: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for item in trace:
        if item["tool"] == "get_my_day":
            for row in (item.get("result") or {}).get("work_orders", [])[:3]:
                blocks.append({
                    "type": "service_appointment",
                    "source": "C4C",
                    "work_order": row.get("work_order"),
                    "account": row.get("account"),
                    "site": row.get("site"),
                    "asset": row.get("asset"),
                })
        elif item["tool"] == "get_work_order_context":
            result = item.get("result") or {}
            blocks.append({
                "type": "work_order",
                "source": "C4C",
                "work_order": result.get("work_order"),
                "account": result.get("account"),
                "site": result.get("site"),
                "asset": result.get("asset"),
            })
    return blocks


def chat(database_url: str, session_id: str, message: str) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    session = get_session(session_id)
    client = OpenAI(api_key=api_key, timeout=30.0, max_retries=1)
    instructions = _instructions(session)

    request_args: dict[str, Any] = {
        "model": MODEL,
        "instructions": instructions,
        "input": message,
        "tools": TOOLS,
    }
    if session.get("openai_response_id"):
        request_args["previous_response_id"] = session["openai_response_id"]

    response = client.responses.create(**request_args)
    trace: list[dict[str, Any]] = []

    for _ in range(6):
        calls = [item for item in response.output if getattr(item, "type", None) == "function_call"]
        if not calls:
            break

        tool_outputs = []
        for call in calls:
            args = json.loads(call.arguments or "{}")
            result = execute_tool(database_url, call.name, args)
            _remember_tool_result(session, call.name, result)
            trace.append({"tool": call.name, "arguments": args, "result": result})
            tool_outputs.append({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": json.dumps(result, default=str),
            })

        response = client.responses.create(
            model=MODEL,
            instructions=_instructions(session),
            previous_response_id=response.id,
            input=tool_outputs,
            tools=TOOLS,
        )
    else:
        raise RuntimeError("Tool loop exceeded maximum iterations")

    text = (response.output_text or "").strip()
    if not text:
        text = "I found the records, but I couldn't produce a clean response. Try asking that again."

    session["openai_response_id"] = response.id
    active_context = {
        "active_work_order_id": session.get("active_work_order_id"),
        "active_asset_id": session.get("active_asset_id"),
        "active_account_id": session.get("active_account_id"),
        "recent_work_orders": session.get("recent_work_orders", []),
    }

    return {
        "session_id": session_id,
        "display_text": text,
        "speech_text": _speechify(text),
        "conversation_text": text,
        "ui_blocks": _ui_blocks_from_trace(trace),
        "pending_actions": [],
        "active_context": active_context,
        "tool_trace": [{"tool": t["tool"], "arguments": t["arguments"]} for t in trace],
        "model": MODEL,
    }
