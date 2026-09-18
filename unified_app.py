from __future__ import annotations

import json
import os
import threading
import uuid
from typing import Any

import httpx
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from actions import cancel_action, confirm_action, ensure_action_schema
from orchestrator import chat as field_chat
from seed_loader import ensure_seeded
from unified_identity import Principal, get_principal


app = FastAPI(title="Meyora Unified API", version="0.1.0")

FIELD_DB = os.getenv("DATABASE_URL")
SALES_BACKEND_URL = os.getenv("SALES_BACKEND_URL", "https://cloudaiapi01.onrender.com").rstrip("/")
HTTP_TIMEOUT = float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "180"))

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()
STARTUP_ERROR: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str = Field(default="meyora-ios", min_length=1, max_length=120)
    history: list[dict[str, Any]] = Field(default_factory=list)
    client_context: dict[str, Any] | None = None


class LegacyChatStartRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, Any]] = Field(default_factory=list)
    client_context: dict[str, Any] | None = None


class ActionDecision(BaseModel):
    session_id: str = Field(min_length=1, max_length=120)


def _conn():
    if not FIELD_DB:
        raise HTTPException(503, "DATABASE_URL is not configured")
    return psycopg.connect(FIELD_DB, sslmode="require")


def _auth_header(authorization: str | None) -> dict[str, str]:
    if not authorization:
        raise HTTPException(401, "Microsoft access token is required")
    return {"Authorization": authorization}


def _replace_branding(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("CMD Sally", "Meyora").replace("Sally", "Meyora")
    if isinstance(value, list):
        return [_replace_branding(v) for v in value]
    if isinstance(value, dict):
        return {k: _replace_branding(v) for k, v in value.items()}
    return value


def _sales_request(
    method: str,
    path: str,
    authorization: str | None,
    *,
    json_body: dict[str, Any] | None = None,
) -> Any:
    url = f"{SALES_BACKEND_URL}{path}"
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            response = client.request(
                method,
                url,
                headers={**_auth_header(authorization), "Content-Type": "application/json"},
                json=json_body,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"Sales backend unavailable: {type(exc).__name__}") from exc

    try:
        body = response.json()
    except Exception:
        body = {"message": response.text}

    if response.status_code >= 400:
        detail = body.get("error") if isinstance(body, dict) else None
        detail = detail or body.get("message") if isinstance(body, dict) else detail
        raise HTTPException(response.status_code, detail or "Sales backend request failed")
    return _replace_branding(body)


def _maya_employee() -> dict[str, Any]:
    with _conn() as conn:
        row = conn.execute("SELECT data FROM employees WHERE id='emp_maya_iyer'").fetchone()
        if not row:
            raise HTTPException(404, "Maya demo employee is not loaded")
        return row[0]


def _maya_connectors() -> dict[str, Any]:
    with _conn() as conn:
        row = conn.execute("SELECT value FROM demo_meta WHERE key='connectors'").fetchone()
        return row[0] if row else {}


def _principal_me(principal: Principal, authorization: str | None) -> dict[str, Any]:
    public = principal.public()
    if principal.primary_domain == "sales":
        upstream = _sales_request("GET", "/me", authorization)
        return {
            **public,
            "name": upstream.get("name") or principal.display_name,
            "email": upstream.get("email") or upstream.get("preferred_username"),
            "upstream_profile": upstream,
        }

    employee = _maya_employee()
    return {
        **public,
        "name": employee.get("display_name") or employee.get("name") or principal.display_name,
        "email": principal.claims.get("preferred_username") or principal.claims.get("upn"),
        "employee": employee,
    }


def _sales_capabilities(authorization: str | None) -> dict[str, Any]:
    try:
        body = _sales_request("GET", "/capabilities", authorization)
        if isinstance(body, dict):
            body["domain"] = "sales"
            body["connector"] = "salesforce"
            return body
    except HTTPException as exc:
        if exc.status_code not in (404, 405):
            raise
    return {
        "domain": "sales",
        "connector": "salesforce",
        "capabilities": [
            "search_opportunities",
            "get_opportunity_context",
            "search_accounts",
            "search_contacts",
            "search_events",
            "search_tasks",
            "governed_salesforce_writes",
        ],
        "speech_context": ["Salesforce", "opportunity", "account", "contact", "forecast"],
    }


def _field_capabilities() -> dict[str, Any]:
    return {
        "domain": "field_service",
        "connector": "c4c",
        "capabilities": [
            "get_my_day",
            "get_work_order_context",
            "search_work_orders",
            "search_emails",
            "search_teams_messages",
            "governed_email_reply",
            "governed_teams_reply",
            "governed_meeting_create",
        ],
        "speech_context": [
            "C4C",
            "work order",
            "service appointment",
            "asset",
            "Orbitrap",
            "Astral",
            "Vanquish",
        ],
    }


def _run_field_job(job_id: str, session_id: str, message: str) -> None:
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "state": "running",
            "current_status": "Reviewing your field-service context…",
            "events": [{"status": "Connecting to C4C, Outlook, Teams and Calendar…"}],
        }
    try:
        result = field_chat(FIELD_DB, session_id, message)
        with _JOBS_LOCK:
            _JOBS[job_id] = {
                "state": "completed",
                "current_status": "Ready",
                "events": [],
                "result": result,
            }
    except Exception as exc:
        with _JOBS_LOCK:
            _JOBS[job_id] = {
                "state": "failed",
                "current_status": "Request failed",
                "events": [],
                "error": {"message": f"{type(exc).__name__}: {exc}"},
            }


@app.on_event("startup")
def startup() -> None:
    global STARTUP_ERROR
    if not FIELD_DB:
        STARTUP_ERROR = "DATABASE_URL is not configured"
        print("MEYORA_UNIFIED_STARTUP_WARNING " + STARTUP_ERROR, flush=True)
        return
    try:
        status = ensure_seeded(FIELD_DB)
        ensure_action_schema(FIELD_DB)
        STARTUP_ERROR = None
        print("MEYORA_UNIFIED_READY " + json.dumps(status, default=str), flush=True)
    except Exception as exc:
        STARTUP_ERROR = f"{type(exc).__name__}: {exc}"
        print("MEYORA_UNIFIED_STARTUP_ERROR " + STARTUP_ERROR, flush=True)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "Meyora Unified API",
        "version": "0.1.0",
        "architecture": "principal -> domain -> allowed connectors",
        "domains": ["sales", "field_service"],
        "sales_backend": SALES_BACKEND_URL,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": STARTUP_ERROR is None,
        "startup_error": STARTUP_ERROR,
        "field_database_configured": bool(FIELD_DB),
        "sales_backend": SALES_BACKEND_URL,
        "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
        "maya_identity_configured": bool(
            os.getenv("MAYA_ENTRA_OID") or os.getenv("MAYA_ENTRA_LOGIN")
        ),
    }


@app.get("/me")
def me(
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    return _principal_me(principal, authorization)


@app.get("/capabilities")
def capabilities(
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        return _sales_capabilities(authorization)
    return _field_capabilities()


@app.get("/connectors")
def connectors(
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        return {
            "domain": "sales",
            "connections": [
                {"id": "salesforce", "display_name": "Salesforce", "mode": "real", "status": "connected"},
                {"id": "outlook", "display_name": "Microsoft Outlook", "mode": "graph_planned", "status": "not_configured"},
                {"id": "teams", "display_name": "Microsoft Teams", "mode": "graph_planned", "status": "not_configured"},
                {"id": "calendar", "display_name": "Outlook Calendar", "mode": "graph_planned", "status": "not_configured"},
            ],
        }

    raw = _maya_connectors()
    return {
        "domain": "field_service",
        "connections": raw.get("connections", []),
        "capabilities": raw.get("capabilities", []),
        "demo_backend": raw.get("demo_backend", {}),
    }


@app.post("/chat")
def chat(
    request: ChatRequest,
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        body = {
            "message": request.message,
            "history": request.history,
            "client_context": request.client_context or {},
        }
        return _sales_request("POST", "/chat", authorization, json_body=body)

    if not FIELD_DB:
        raise HTTPException(503, "Field Service database is not configured")
    return field_chat(FIELD_DB, request.session_id, request.message)


@app.post("/chat/start")
def chat_start(
    request: LegacyChatStartRequest,
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        remote = _sales_request(
            "POST",
            "/chat/start",
            authorization,
            json_body={
                "message": request.message,
                "history": request.history,
                "client_context": request.client_context or {},
            },
        )
        remote_job_id = remote.get("job_id")
        if not remote_job_id:
            raise HTTPException(502, "Sales backend did not return a job id")
        return {
            **remote,
            "job_id": f"sales:{remote_job_id}",
        }

    if not FIELD_DB:
        raise HTTPException(503, "Field Service database is not configured")
    local_id = uuid.uuid4().hex
    job_id = f"field:{local_id}"
    session_id = f"ios-{principal.principal_id}-{local_id[:12]}"
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "state": "queued",
            "current_status": "Understanding your request…",
            "events": [],
        }
    threading.Thread(
        target=_run_field_job,
        args=(job_id, session_id, request.message),
        daemon=True,
        name=f"meyora-field-{local_id[:8]}",
    ).start()
    return {
        "job_id": job_id,
        "state": "queued",
        "current_status": "Understanding your request…",
        "events": [],
    }


@app.get("/chat/jobs/{job_id:path}")
def chat_job(
    job_id: str,
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if job_id.startswith("sales:"):
        if principal.primary_domain != "sales":
            raise HTTPException(403, "This job belongs to the Sales domain")
        remote_id = job_id.split(":", 1)[1]
        body = _sales_request("GET", f"/chat/jobs/{remote_id}", authorization)
        if isinstance(body, dict):
            body["job_id"] = job_id
        return body

    if job_id.startswith("field:"):
        if principal.primary_domain != "field_service":
            raise HTTPException(403, "This job belongs to the Field Service domain")
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Chat job not found")
        return job

    raise HTTPException(404, "Unknown chat job")


@app.post("/confirm")
def legacy_confirm(
    payload: dict[str, Any],
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        return _sales_request("POST", "/confirm", authorization, json_body=payload)
    raise HTTPException(
        409,
        "Field Service actions use action previews and /actions/{id}/confirm",
    )


@app.post("/actions/{action_id}/confirm")
def confirm_field_action(
    action_id: str,
    decision: ActionDecision,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain != "field_service":
        raise HTTPException(409, "Sales actions use the Salesforce confirmation contract")
    result = confirm_action(FIELD_DB, action_id, decision.session_id)
    if not result.get("ok"):
        code = 404 if result.get("error") == "action_not_found" else 409
        raise HTTPException(code, result.get("error") or "Action could not be confirmed")
    return result


@app.post("/actions/{action_id}/cancel")
def cancel_field_action(
    action_id: str,
    decision: ActionDecision,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain != "field_service":
        raise HTTPException(409, "Sales actions use the Salesforce confirmation contract")
    result = cancel_action(FIELD_DB, action_id, decision.session_id)
    if not result.get("ok"):
        code = 404 if result.get("error") == "action_not_found" else 409
        raise HTTPException(code, result.get("error") or "Action could not be canceled")
    return result
