from __future__ import annotations

import json
import os
import threading
import secrets

from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import psycopg

from actions import cancel_action, confirm_action, ensure_action_schema
from orchestrator import chat as run_chat, execute_tool, get_session
from seed_loader import ensure_seeded


app = FastAPI(title="Meyora Field Demo API", version="0.4.0")
DB = os.getenv("DATABASE_URL")
STARTUP_ERROR = None
WEB_INDEX = os.path.join(os.path.dirname(__file__), "web", "index.html")


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str = Field(default="maya-demo", min_length=1, max_length=120)


class ActionDecision(BaseModel):
    session_id: str = Field(min_length=1, max_length=120)


class AdapterToolRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    arguments: dict = Field(default_factory=dict)
    session_id: str = Field(default="meyora-core", min_length=1, max_length=160)



def _require_adapter_token(authorization: str | None) -> None:
    expected = (os.getenv("MEYORA_ADAPTER_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="MEYORA_ADAPTER_TOKEN is not configured")
    supplied = ""
    if authorization and authorization.startswith("Bearer "):
        supplied = authorization.split(" ", 1)[1].strip()
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid_adapter_token")


def _date_range_clause(column: str, args: dict, params: list):
    clauses = []
    date_from = args.get("date_from")
    date_to = args.get("date_to")
    date_value = args.get("date")
    if date_value:
        clauses.append(f"{column}::date=%s::date")
        params.append(date_value)
    else:
        if date_from:
            clauses.append(f"{column}::date >= %s::date")
            params.append(date_from)
        if date_to:
            clauses.append(f"{column}::date <= %s::date")
            params.append(date_to)
    return clauses


def _adapter_execute(name: str, args: dict, session_id: str):
    args = args or {}
    limit = max(1, min(int(args.get("limit") or 20), 100))

    if name == "work.search":
        params = []
        where = []
        query = str(args.get("query") or "").strip()
        if query:
            where.append("(wo.data::text ILIKE %s OR a.data::text ILIKE %s OR ast.data::text ILIKE %s)")
            pattern = f"%{query}%"
            params.extend([pattern, pattern, pattern])
        where += _date_range_clause("wo.scheduled_start", args, params)
        if args.get("status"):
            where.append("lower(COALESCE(wo.status,''))=lower(%s)")
            params.append(str(args["status"]))
        dataset_user = None
        with _conn() as conn:
            meta = conn.execute("SELECT value FROM demo_meta WHERE key='dataset'").fetchone()
            if meta:
                dataset_user = (meta[0] or {}).get("logged_in_user_id")
            if dataset_user:
                where.append("wo.assigned_engineer_id=%s")
                params.append(dataset_user)
            sql = """
                SELECT wo.data, a.data, s.data, ast.data
                FROM work_orders wo
                LEFT JOIN accounts a ON a.id=wo.account_id
                LEFT JOIN sites s ON s.id=wo.site_id
                LEFT JOIN assets ast ON ast.id=wo.asset_id
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY wo.scheduled_start ASC NULLS LAST LIMIT %s"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        items = [{"work_order": r[0], "account": r[1], "site": r[2], "asset": r[3]} for r in rows]
        return {"ok": True, "count": len(items), "items": items}

    if name == "work.context":
        result = execute_tool(DB, session_id, get_session(session_id), "get_work_order_context", {
            "work_order_id": args.get("work_order_id")
        })
        return {"ok": not bool(isinstance(result, dict) and result.get("error")), "context": result}

    if name == "calendar.search":
        params = []
        where = []
        where += _date_range_clause("start_at", args, params)
        query = str(args.get("query") or "").strip()
        if query:
            where.append("data::text ILIKE %s")
            params.append(f"%{query}%")
        with _conn() as conn:
            sql = "SELECT data FROM calendar_events"
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY start_at ASC NULLS LAST LIMIT %s"
            params.append(limit)
            items = [r[0] for r in conn.execute(sql, params).fetchall()]
        return {"ok": True, "count": len(items), "items": items}

    if name == "mail.search":
        params = []
        where = ["status <> 'draft'"]
        query = str(args.get("query") or "").strip()
        if query:
            where.append("data::text ILIKE %s")
            params.append(f"%{query}%")
        where += _date_range_clause("COALESCE(received_at,sent_at)", args, params)
        if args.get("unread_only"):
            where.append("is_read=false")
        with _conn() as conn:
            sql = "SELECT data FROM emails WHERE " + " AND ".join(where)
            sql += " ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST LIMIT %s"
            params.append(limit)
            items = [r[0] for r in conn.execute(sql, params).fetchall()]
        return {"ok": True, "count": len(items), "items": items}

    if name == "teams.search":
        params = []
        where = []
        query = str(args.get("query") or "").strip()
        if query:
            pattern = f"%{query}%"
            where.append("(tm.data::text ILIKE %s OR COALESCE(d.display_name,'') ILIKE %s OR COALESCE(tc.title,'') ILIKE %s)")
            params.extend([pattern, pattern, pattern])
        where += _date_range_clause("tm.sent_at", args, params)
        with _conn() as conn:
            sql = """
                SELECT tm.data, d.display_name, tc.title
                FROM teams_messages tm
                LEFT JOIN identity_directory d ON d.id=tm.sender_person_id
                LEFT JOIN teams_conversations tc ON tc.id=tm.conversation_id
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY tm.sent_at DESC NULLS LAST LIMIT %s"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        items = []
        for data, sender, title in rows:
            item = dict(data or {})
            if sender:
                item["sender_name"] = sender
            if title:
                item["conversation_title"] = title
            items.append(item)
        return {"ok": True, "count": len(items), "items": items}

    if name == "inventory.search":
        query = str(args.get("query") or "").strip()
        params = []
        where = []
        if query:
            where.append("(p.data::text ILIKE %s OR p.id ILIKE %s)")
            pattern = f"%{query}%"
            params.extend([pattern, pattern])
        with _conn() as conn:
            sql = """
                SELECT p.data,
                       COALESCE(SUM(s.quantity_on_hand),0) AS on_hand,
                       COALESCE(SUM(s.quantity_reserved),0) AS reserved
                FROM parts p
                LEFT JOIN inventory_stock s ON s.part_id=p.id
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " GROUP BY p.id,p.data ORDER BY p.id LIMIT %s"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        items = [{"part": r[0], "quantity_on_hand": r[1], "quantity_reserved": r[2]} for r in rows]
        return {"ok": True, "count": len(items), "items": items}

    legacy_map = {
        "mail.reply.propose": "propose_email_reply",
        "teams.message.propose": "propose_teams_reply",
        "meeting.propose": "propose_meeting",
    }
    if name in legacy_map:
        result = execute_tool(DB, session_id, get_session(session_id), legacy_map[name], args)
        ok = not bool(isinstance(result, dict) and result.get("error"))
        return {"ok": ok, **(result if isinstance(result, dict) else {"result": result})}

    raise HTTPException(status_code=400, detail=f"unsupported_adapter_tool: {name}")


def _conn():
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    return psycopg.connect(DB, sslmode="require")


def _json(row):
    return row[0] if row else None


def _run_chat_selftest() -> None:
    action_id = None
    confirmed = None
    try:
        session_id = "startup-selftest-v2"
        first = run_chat(DB, session_id, "Hey, what do we have for today?")
        second = run_chat(DB, session_id, "Yeah, prepare me for the first one.")
        third = run_chat(DB, session_id, "Reply to the customer saying I'm on my way and I'll start with diagnostics when I arrive.")
        pending = third.get("pending_actions") or []
        if not pending:
            raise RuntimeError("Natural-language action did not create a pending action")
        action = pending[0]
        action_id = action["id"]
        if action.get("action_type") != "send_email":
            raise RuntimeError(f"Expected send_email pending action, got {action.get('action_type')}")

        confirmed = confirm_action(DB, action_id, session_id)
        if not confirmed.get("ok"):
            raise RuntimeError(f"Pending action confirmation failed: {confirmed}")
        result = confirmed.get("result") or {}
        record = result.get("record") or {}
        email_id = record.get("email_id")
        if not email_id:
            raise RuntimeError("Confirmed email action did not return a read-back email_id")

        summary = {
            "first_trace": first.get("tool_trace") or [],
            "second_trace": second.get("tool_trace") or [],
            "action_trace": third.get("tool_trace") or [],
            "pending_preview": action.get("preview") or {},
            "confirmed": {"ok": confirmed.get("ok"), "action_type": confirmed.get("action_type"), "result_message": result.get("message"), "email_id": email_id},
            "session_id": session_id,
        }
        print("MEYORA_CHAT_SELFTEST_OK " + json.dumps(summary, default=str), flush=True)
    except Exception as e:
        print("MEYORA_CHAT_SELFTEST_ERROR " + f"{type(e).__name__}: {e}", flush=True)
    finally:
        if action_id:
            try:
                with _conn() as conn:
                    if confirmed and confirmed.get("result", {}).get("kind") == "email":
                        record = confirmed["result"].get("record") or {}
                        if record.get("email_id"):
                            conn.execute("DELETE FROM emails WHERE id=%s", (record["email_id"],))
                    conn.execute("DELETE FROM audit_log WHERE metadata->>'pending_action_id'=%s", (action_id,))
                    conn.execute("DELETE FROM pending_actions WHERE id=%s", (action_id,))
                    conn.commit()
                print("MEYORA_CHAT_SELFTEST_CLEANUP_OK " + action_id, flush=True)
            except Exception as cleanup_error:
                print("MEYORA_CHAT_SELFTEST_CLEANUP_ERROR " + f"{type(cleanup_error).__name__}: {cleanup_error}", flush=True)


@app.on_event("startup")
def startup():
    global STARTUP_ERROR
    if not DB:
        STARTUP_ERROR = "DATABASE_URL is not configured"
        print("MEYORA_STARTUP_ERROR", STARTUP_ERROR, flush=True)
        return
    try:
        seed_status = ensure_seeded(DB)
        ensure_action_schema(DB)
        STARTUP_ERROR = None
        print("MEYORA_SEED_READY " + json.dumps(seed_status, sort_keys=True, default=str), flush=True)
        print("MEYORA_ACTIONS_READY", flush=True)
        with _conn() as conn:
            connectors_row = conn.execute("SELECT value FROM demo_meta WHERE key='connectors'").fetchone()
            connectors = connectors_row[0] if connectors_row else {}
            print("MEYORA_CONNECTORS " + json.dumps(connectors, sort_keys=True, default=str), flush=True)

        if os.getenv("MEYORA_CHAT_SELFTEST") == "1":
            threading.Thread(target=_run_chat_selftest, daemon=True, name="meyora-chat-selftest").start()
    except Exception as e:
        STARTUP_ERROR = f"{type(e).__name__}: {e}"
        print("MEYORA_STARTUP_ERROR " + STARTUP_ERROR, flush=True)


@app.get("/")
def root():
    return {
        "name": "Meyora Field Demo API",
        "version": "0.4.0",
        "demo": "/demo",
        "chat": "/chat",
        "actions": "/actions/{action_id}/confirm",
        "docs": "/docs",
        "field_service_system": "C4C",
    }


@app.get("/demo", include_in_schema=False)
def demo():
    if not os.path.exists(WEB_INDEX):
        raise HTTPException(404, "Demo client not found")
    return FileResponse(WEB_INDEX, media_type="text/html")


@app.get("/health")
def health():
    if not DB:
        return {"ok": False, "database": "not_configured", "error": STARTUP_ERROR}
    try:
        with _conn() as conn:
            seed = conn.execute("SELECT value FROM demo_meta WHERE key='seed_status'").fetchone()
            actions_ready = conn.execute("SELECT to_regclass('public.pending_actions')").fetchone()[0]
            return {
                "ok": bool(seed and seed[0].get("ok")),
                "database": "connected",
                "seed_status": _json(seed),
                "actions_ready": bool(actions_ready),
                "startup_error": STARTUP_ERROR,
                "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
                "openai_model": os.getenv("OPENAI_MODEL", "gpt-5.6-luna"),
            }
    except Exception as e:
        return {"ok": False, "database": "error", "error": f"{type(e).__name__}: {e}", "startup_error": STARTUP_ERROR}


@app.get("/connectors")
def connectors():
    with _conn() as conn:
        row = conn.execute("SELECT value FROM demo_meta WHERE key='connectors'").fetchone()
        if not row:
            raise HTTPException(404, "Connector metadata not found")
        return row[0]


@app.get("/me")
def me():
    with _conn() as conn:
        meta = conn.execute("SELECT value FROM demo_meta WHERE key='dataset'").fetchone()
        user_id = meta[0]["logged_in_user_id"]
        row = conn.execute("SELECT data FROM employees WHERE id=%s", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Maya not found")
        return row[0]


@app.get("/my-day")
def my_day():
    with _conn() as conn:
        ctx = conn.execute("SELECT value FROM demo_meta WHERE key='demo_context'").fetchone()[0]
        dataset = conn.execute("SELECT value FROM demo_meta WHERE key='dataset'").fetchone()[0]
        day = ctx["demo_date"]
        asof = ctx["demo_as_of"]
        maya = dataset["logged_in_user_id"]

        work_orders = [r[0] for r in conn.execute(
            "SELECT data FROM work_orders WHERE assigned_engineer_id=%s AND scheduled_start::date=%s::date ORDER BY scheduled_start",
            (maya, day),
        ).fetchall()]
        calendar = [r[0] for r in conn.execute(
            "SELECT data FROM calendar_events WHERE start_at::date=%s::date ORDER BY start_at", (day,)
        ).fetchall()]
        reminders = [r[0] for r in conn.execute(
            "SELECT data FROM notifications WHERE status='unread' AND created_at <= %s::timestamp ORDER BY CASE lower(severity) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC",
            (asof,),
        ).fetchall()]
        emails = [r[0] for r in conn.execute(
            "SELECT data FROM emails WHERE is_read=false AND status <> 'draft' AND COALESCE(received_at,sent_at) <= %s::timestamp ORDER BY COALESCE(received_at,sent_at) DESC",
            (asof,),
        ).fetchall()]
        teams = [r[0] for r in conn.execute(
            "SELECT data FROM teams_messages WHERE is_read=false AND sent_at <= %s::timestamp ORDER BY sent_at DESC",
            (asof,),
        ).fetchall()]

        return {
            "demo_date": day,
            "as_of": asof,
            "work_orders": work_orders,
            "calendar": calendar,
            "reminders": reminders,
            "unread_emails": emails,
            "unread_teams_messages": teams,
            "response_order": ["work_orders", "reminders", "unread_emails", "unread_teams_messages"],
        }


@app.get("/context/work-order/{work_order_id}")
def work_order_context(work_order_id: str):
    with _conn() as conn:
        wo = conn.execute("SELECT data FROM work_orders WHERE id=%s", (work_order_id,)).fetchone()
        if not wo:
            raise HTTPException(404, "Work order not found")
        d = wo[0]
        aid = d.get("asset_id")
        acct = d.get("account_key")
        asset = conn.execute("SELECT data FROM assets WHERE id=%s", (aid,)).fetchone() if aid else None
        history = [r[0] for r in conn.execute(
            "SELECT data FROM work_orders WHERE asset_id=%s AND id<>%s ORDER BY scheduled_start DESC LIMIT 10",
            (aid, work_order_id),
        ).fetchall()] if aid else []
        emails = [r[0] for r in conn.execute(
            "SELECT data FROM emails WHERE work_order_id=%s OR asset_id=%s ORDER BY COALESCE(received_at,sent_at) DESC LIMIT 20",
            (work_order_id, aid),
        ).fetchall()]
        teams = [r[0] for r in conn.execute(
            "SELECT data FROM teams_messages WHERE work_order_id=%s OR asset_id=%s ORDER BY sent_at DESC LIMIT 20",
            (work_order_id, aid),
        ).fetchall()]
        parts = [r[0] for r in conn.execute(
            "SELECT data FROM part_reservations WHERE work_order_id=%s", (work_order_id,)
        ).fetchall()]
        opps = [r[0] for r in conn.execute(
            "SELECT data FROM opportunities WHERE account_id=%s", (acct,)
        ).fetchall()] if acct else []
        return {"work_order": d, "asset": _json(asset), "history": history, "emails": emails, "teams": teams, "parts": parts, "opportunities": opps}



@app.get("/adapter/capabilities")
def adapter_capabilities(authorization: str | None = Header(default=None)):
    _require_adapter_token(authorization)
    return {
        "adapter": "field_service_render",
        "domain": "field_service",
        "connector_modes": {
            "c4c": "mock",
            "outlook": "mock",
            "teams": "mock",
            "calendar": "mock",
            "inventory": "mock",
        },
        "tools": [
            "work.search",
            "work.context",
            "calendar.search",
            "mail.search",
            "teams.search",
            "inventory.search",
            "mail.reply.propose",
            "teams.message.propose",
            "meeting.propose",
        ],
    }


@app.post("/adapter/tool")
def adapter_tool(request: AdapterToolRequest, authorization: str | None = Header(default=None)):
    _require_adapter_token(authorization)
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        return _adapter_execute(request.name, request.arguments, request.session_id)
    except HTTPException:
        raise
    except Exception as e:
        print("MEYORA_ADAPTER_TOOL_ERROR " + f"{request.name}: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


@app.get("/adapter/coverage")
def adapter_coverage(authorization: str | None = Header(default=None)):
    _require_adapter_token(authorization)
    with _conn() as conn:
        def span(table: str, column: str):
            row = conn.execute(
                f"SELECT min({column})::text, max({column})::text, count(*) FROM {table}"
            ).fetchone()
            return {"min": row[0], "max": row[1], "count": row[2]}

        daily = [
            {"date": r[0].isoformat(), "work_orders": r[1]}
            for r in conn.execute("""
                SELECT scheduled_start::date, count(*)
                FROM work_orders
                WHERE scheduled_start IS NOT NULL
                GROUP BY 1 ORDER BY 1
            """).fetchall()
        ]
        return {
            "work_orders": span("work_orders", "scheduled_start"),
            "calendar_events": span("calendar_events", "start_at"),
            "emails": span("emails", "COALESCE(received_at,sent_at)"),
            "teams_messages": span("teams_messages", "sent_at"),
            "daily_work_orders": daily,
        }


@app.post("/chat")
def chat_endpoint(request: ChatRequest):
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured")
    try:
        return run_chat(DB, request.session_id, request.message)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        print("MEYORA_CHAT_ERROR " + f"{type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e



@app.post("/adapter/actions/{action_id}/confirm")
def adapter_confirm_action(action_id: str, decision: ActionDecision, authorization: str | None = Header(default=None)):
    _require_adapter_token(authorization)
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        result = confirm_action(DB, action_id, decision.session_id)
        if not result.get("ok"):
            code = 404 if result.get("error") == "action_not_found" else 409
            raise HTTPException(code, result.get("error") or "Action could not be confirmed")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


@app.post("/adapter/actions/{action_id}/cancel")
def adapter_cancel_action(action_id: str, decision: ActionDecision, authorization: str | None = Header(default=None)):
    _require_adapter_token(authorization)
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        result = cancel_action(DB, action_id, decision.session_id)
        if not result.get("ok"):
            code = 404 if result.get("error") == "action_not_found" else 409
            raise HTTPException(code, result.get("error") or "Action could not be canceled")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


@app.post("/actions/{action_id}/confirm")
def confirm_pending_action(action_id: str, decision: ActionDecision):
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        result = confirm_action(DB, action_id, decision.session_id)
        if not result.get("ok"):
            code = 404 if result.get("error") == "action_not_found" else 409
            raise HTTPException(code, result.get("error") or "Action could not be confirmed")
        return result
    except HTTPException:
        raise
    except Exception as e:
        print("MEYORA_ACTION_CONFIRM_ERROR " + f"{type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


@app.post("/actions/{action_id}/cancel")
def cancel_pending_action(action_id: str, decision: ActionDecision):
    if not DB:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        result = cancel_action(DB, action_id, decision.session_id)
        if not result.get("ok"):
            code = 404 if result.get("error") == "action_not_found" else 409
            raise HTTPException(code, result.get("error") or "Action could not be canceled")
        return result
    except HTTPException:
        raise
    except Exception as e:
        print("MEYORA_ACTION_CANCEL_ERROR " + f"{type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e
