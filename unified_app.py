from __future__ import annotations

import os
import threading
import uuid
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from unified_identity import Principal, get_principal


app = FastAPI(title="Meyora Unified API", version="0.2.0")

SALES_BACKEND_URL = os.getenv(
    "SALES_BACKEND_URL", "https://cloudaiapi01.onrender.com"
).rstrip("/")
FIELD_BACKEND_URL = os.getenv(
    "FIELD_BACKEND_URL", "https://meyora-field-demo-api.onrender.com"
).rstrip("/")
HTTP_TIMEOUT = float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "180"))

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


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


def _replace_branding(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("CMD Sally", "Meyora").replace("Sally", "Meyora")
    if isinstance(value, list):
        return [_replace_branding(v) for v in value]
    if isinstance(value, dict):
        return {k: _replace_branding(v) for k, v in value.items()}
    return value


def _request(
    base_url: str,
    method: str,
    path: str,
    authorization: str | None = None,
    *,
    json_body: dict[str, Any] | None = None,
    require_auth: bool = False,
) -> Any:
    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    elif require_auth:
        raise HTTPException(401, "Microsoft access token is required")

    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            response = client.request(
                method,
                f"{base_url}{path}",
                headers=headers,
                json=json_body,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            503, f"Upstream Meyora service unavailable: {type(exc).__name__}"
        ) from exc

    try:
        body = response.json()
    except Exception:
        body = {"message": response.text}

    if response.status_code >= 400:
        detail = None
        if isinstance(body, dict):
            detail = body.get("detail") or body.get("error") or body.get("message")
        raise HTTPException(response.status_code, detail or "Upstream request failed")
    return _replace_branding(body)


def _sales(
    method: str,
    path: str,
    authorization: str | None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    return _request(
        SALES_BACKEND_URL,
        method,
        path,
        authorization,
        json_body=json_body,
        require_auth=True,
    )


def _field(
    method: str,
    path: str,
    json_body: dict[str, Any] | None = None,
) -> Any:
    return _request(
        FIELD_BACKEND_URL,
        method,
        path,
        None,
        json_body=json_body,
        require_auth=False,
    )


def _field_session(principal: Principal) -> str:
    # Stable session means conversational references survive separate V4.2 jobs.
    return f"ios-{principal.principal_id}"


def _run_field_job(
    job_id: str,
    principal: Principal,
    message: str,
) -> None:
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "state": "running",
            "current_status": "Reviewing your field-service context…",
            "events": [
                {"status": "Connecting to C4C, Outlook, Teams and Calendar…"}
            ],
        }
    try:
        result = _field(
            "POST",
            "/chat",
            {
                "message": message,
                "session_id": _field_session(principal),
            },
        )
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


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "Meyora Unified API",
        "version": "0.2.0",
        "architecture": "Microsoft principal -> authorized domain -> proven backend",
        "domains": {
            "sales": SALES_BACKEND_URL,
            "field_service": FIELD_BACKEND_URL,
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "sales_backend": SALES_BACKEND_URL,
        "field_backend": FIELD_BACKEND_URL,
        "alice_identity_configured": bool(os.getenv("ALICE_ENTRA_OID")),
        "maya_identity_configured": bool(
            os.getenv("MAYA_ENTRA_OID") or os.getenv("MAYA_ENTRA_LOGIN")
        ),
    }


@app.get("/me")
def me(
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        upstream = _sales("GET", "/me", authorization)
        return {
            **principal.public(),
            "name": upstream.get("name") or principal.display_name,
            "email": upstream.get("email") or upstream.get("preferred_username"),
            "upstream_profile": upstream,
        }

    upstream = _field("GET", "/me")
    return {
        **principal.public(),
        "name": upstream.get("display_name")
        or upstream.get("name")
        or principal.display_name,
        "email": principal.claims.get("preferred_username")
        or principal.claims.get("upn"),
        "upstream_profile": upstream,
    }


@app.get("/capabilities")
def capabilities(
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        try:
            body = _sales("GET", "/capabilities", authorization)
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
            "speech_context": [
                "Salesforce",
                "opportunity",
                "account",
                "contact",
                "forecast",
            ],
        }

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


@app.get("/connectors")
def connectors(
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        return {
            "domain": "sales",
            "connections": [
                {
                    "id": "salesforce",
                    "display_name": "Salesforce",
                    "mode": "real",
                    "status": "connected",
                },
                {
                    "id": "outlook",
                    "display_name": "Microsoft Outlook",
                    "mode": "graph_planned",
                    "status": "not_configured",
                },
                {
                    "id": "teams",
                    "display_name": "Microsoft Teams",
                    "mode": "graph_planned",
                    "status": "not_configured",
                },
                {
                    "id": "calendar",
                    "display_name": "Outlook Calendar",
                    "mode": "graph_planned",
                    "status": "not_configured",
                },
            ],
        }

    raw = _field("GET", "/connectors")
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
        return _sales(
            "POST",
            "/chat",
            authorization,
            {
                "message": request.message,
                "history": request.history,
                "client_context": request.client_context or {},
            },
        )

    return _field(
        "POST",
        "/chat",
        {
            "message": request.message,
            "session_id": request.session_id or _field_session(principal),
        },
    )


@app.post("/chat/start")
def chat_start(
    request: LegacyChatStartRequest,
    principal: Principal = Depends(get_principal),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if principal.primary_domain == "sales":
        remote = _sales(
            "POST",
            "/chat/start",
            authorization,
            {
                "message": request.message,
                "history": request.history,
                "client_context": request.client_context or {},
            },
        )
        remote_job_id = remote.get("job_id")
        if not remote_job_id:
            raise HTTPException(502, "Sales backend did not return a job id")
        return {**remote, "job_id": f"sales:{remote_job_id}"}

    local_id = uuid.uuid4().hex
    job_id = f"field:{local_id}"
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "state": "queued",
            "current_status": "Understanding your request…",
            "events": [],
        }
    threading.Thread(
        target=_run_field_job,
        args=(job_id, principal, request.message),
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
        body = _sales("GET", f"/chat/jobs/{remote_id}", authorization)
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
        return _sales("POST", "/confirm", authorization, payload)
    raise HTTPException(
        409,
        "Field Service actions use native Meyora action previews.",
    )


@app.post("/actions/{action_id}/confirm")
def confirm_field_action(
    action_id: str,
    decision: ActionDecision,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain != "field_service":
        raise HTTPException(
            409, "Sales actions use the Salesforce confirmation contract"
        )
    return _field(
        "POST",
        f"/actions/{action_id}/confirm",
        {"session_id": decision.session_id},
    )


@app.post("/actions/{action_id}/cancel")
def cancel_field_action(
    action_id: str,
    decision: ActionDecision,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    if principal.primary_domain != "field_service":
        raise HTTPException(
            409, "Sales actions use the Salesforce confirmation contract"
        )
    return _field(
        "POST",
        f"/actions/{action_id}/cancel",
        {"session_id": decision.session_id},
    )
