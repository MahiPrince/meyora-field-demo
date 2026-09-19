from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb


RUNTIME_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_actions (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  actor_id text NOT NULL,
  action_type text NOT NULL,
  status text NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload jsonb NOT NULL,
  preview jsonb NOT NULL,
  result jsonb
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id, created_at DESC);
"""


def _conn(database_url: str):
    return psycopg.connect(database_url, sslmode="require")


def ensure_action_schema(database_url: str) -> None:
    with _conn(database_url) as conn:
        conn.execute(RUNTIME_SCHEMA)
        conn.commit()


def _demo_now(conn) -> str:
    row = conn.execute("SELECT value FROM demo_meta WHERE key='demo_context'").fetchone()
    value = (row[0] if row else {}).get("demo_as_of") or "2026-09-15T07:15:00"
    return value


def _insert_pending(conn, session_id: str, action_type: str, payload: dict[str, Any], preview: dict[str, Any]) -> dict[str, Any]:
    action_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO pending_actions(id,session_id,actor_id,action_type,status,payload,preview) VALUES (%s,%s,%s,%s,'pending',%s,%s)",
        (action_id, session_id, "emp_maya_iyer", action_type, Jsonb(payload), Jsonb(preview)),
    )
    conn.commit()
    return {
        "id": action_id,
        "action_type": action_type,
        "status": "pending",
        "preview": preview,
    }


def propose_email_reply(database_url: str, session_id: str, body_text: str, thread_id: str | None = None, work_order_id: str | None = None) -> dict[str, Any]:
    with _conn(database_url) as conn:
        if not thread_id and work_order_id:
            row = conn.execute(
                "SELECT thread_id FROM emails WHERE work_order_id=%s ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST LIMIT 1",
                (work_order_id,),
            ).fetchone()
            thread_id = row[0] if row else None
        if not thread_id:
            return {"error": "email_thread_required", "message": "I need an Outlook thread before I can draft that reply."}

        thread = conn.execute("SELECT subject,data FROM email_threads WHERE id=%s", (thread_id,)).fetchone()
        latest = conn.execute(
            "SELECT sender,subject,data FROM emails WHERE thread_id=%s ORDER BY COALESCE(received_at,sent_at) DESC NULLS LAST LIMIT 1",
            (thread_id,),
        ).fetchone()
        if not thread:
            return {"error": "email_thread_not_found", "thread_id": thread_id}

        subject = thread[0] or (latest[1] if latest else "")
        recipient = latest[0] if latest else "Customer"
        payload = {"thread_id": thread_id, "work_order_id": work_order_id, "body_text": body_text, "subject": subject, "recipient": recipient}
        preview = {
            "kind": "email",
            "source": "Microsoft Outlook",
            "title": f"Reply: {subject}",
            "recipient": recipient,
            "body_text": body_text,
            "confirm_label": "Send email",
        }
        return {"pending_action": _insert_pending(conn, session_id, "send_email", payload, preview)}


def propose_teams_reply(database_url: str, session_id: str, body_text: str, conversation_id: str | None = None, work_order_id: str | None = None) -> dict[str, Any]:
    with _conn(database_url) as conn:
        if not conversation_id and work_order_id:
            row = conn.execute(
                "SELECT conversation_id FROM teams_messages WHERE work_order_id=%s ORDER BY sent_at DESC NULLS LAST LIMIT 1",
                (work_order_id,),
            ).fetchone()
            conversation_id = row[0] if row else None
        if not conversation_id:
            return {"error": "teams_conversation_required", "message": "I need a Teams conversation before I can draft that message."}

        convo = conn.execute("SELECT title,data FROM teams_conversations WHERE id=%s", (conversation_id,)).fetchone()
        latest = conn.execute(
            "SELECT sender_person_id,data FROM teams_messages WHERE conversation_id=%s ORDER BY sent_at DESC NULLS LAST LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if not convo:
            return {"error": "teams_conversation_not_found", "conversation_id": conversation_id}

        title = convo[0] or "Teams conversation"
        recipient = "Teams conversation"
        if latest and latest[0]:
            who = conn.execute("SELECT display_name FROM identity_directory WHERE id=%s", (latest[0],)).fetchone()
            if who and who[0]:
                recipient = who[0]
        payload = {"conversation_id": conversation_id, "work_order_id": work_order_id, "body_text": body_text, "title": title}
        preview = {
            "kind": "teams",
            "source": "Microsoft Teams",
            "title": title,
            "recipient": recipient,
            "body_text": body_text,
            "confirm_label": "Send Teams message",
        }
        return {"pending_action": _insert_pending(conn, session_id, "send_teams_message", payload, preview)}


def propose_meeting(database_url: str, session_id: str, title: str, start_at: str, end_at: str, attendee_names: list[str], work_order_id: str | None = None, account_id: str | None = None) -> dict[str, Any]:
    with _conn(database_url) as conn:
        resolved = []
        for name in attendee_names or []:
            row = conn.execute(
                "SELECT id,display_name,email FROM identity_directory WHERE display_name ILIKE %s ORDER BY CASE WHEN lower(display_name)=lower(%s) THEN 0 ELSE 1 END LIMIT 1",
                (f"%{name}%", name),
            ).fetchone()
            if row:
                resolved.append({"person_id": row[0], "display_name": row[1], "email": row[2]})
            else:
                resolved.append({"person_id": None, "display_name": name, "email": None})

        payload = {
            "title": title,
            "start_at": start_at,
            "end_at": end_at,
            "attendees": resolved,
            "work_order_id": work_order_id,
            "account_id": account_id,
        }
        preview = {
            "kind": "meeting",
            "source": "Outlook Calendar + Microsoft Teams",
            "title": title,
            "start_at": start_at,
            "end_at": end_at,
            "attendees": [x["display_name"] for x in resolved],
            "confirm_label": "Create meeting",
        }
        return {"pending_action": _insert_pending(conn, session_id, "create_meeting", payload, preview)}


def _audit(conn, action: str, object_type: str, object_id: str, after_state: dict[str, Any], metadata: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO audit_log(actor_id,action,object_type,object_id,after_state,metadata) VALUES (%s,%s,%s,%s,%s,%s)",
        ("emp_maya_iyer", action, object_type, object_id, Jsonb(after_state), Jsonb(metadata)),
    )


def confirm_action(database_url: str, action_id: str, session_id: str | None = None) -> dict[str, Any]:
    with _conn(database_url) as conn:
        row = conn.execute(
            "SELECT session_id,action_type,status,payload,preview FROM pending_actions WHERE id=%s FOR UPDATE",
            (action_id,),
        ).fetchone()
        if not row:
            return {"ok": False, "error": "action_not_found"}
        stored_session, action_type, status, payload, preview = row
        if session_id and stored_session != session_id:
            return {"ok": False, "error": "session_mismatch"}
        if status != "pending":
            existing = conn.execute("SELECT result FROM pending_actions WHERE id=%s", (action_id,)).fetchone()
            return {"ok": status == "confirmed", "status": status, "result": existing[0] if existing else None}

        now = _demo_now(conn)
        result: dict[str, Any]

        if action_type == "send_email":
            email_id = "email_action_" + uuid.uuid4().hex[:12]
            data = {
                "email_id": email_id,
                "thread_id": payload["thread_id"],
                "direction": "outbound",
                "sender": "Maya Iyer",
                "sent_at": now,
                "status": "sent",
                "is_read": True,
                "flagged": False,
                "work_order_id": payload.get("work_order_id"),
                "subject": payload.get("subject"),
                "body_text": payload["body_text"],
                "synthetic_demo_action": True,
            }
            conn.execute(
                "INSERT INTO emails(id,thread_id,direction,sender,sent_at,status,is_read,flagged,work_order_id,subject,body_text,data) VALUES (%s,%s,'outbound',%s,%s,'sent',true,false,%s,%s,%s,%s)",
                (email_id, payload["thread_id"], "Maya Iyer", now, payload.get("work_order_id"), payload.get("subject"), payload["body_text"], Jsonb(data)),
            )
            readback = conn.execute("SELECT data FROM emails WHERE id=%s", (email_id,)).fetchone()[0]
            result = {"kind": "email", "message": "Email sent", "record": readback}
            _audit(conn, "send_email", "email", email_id, readback, {"pending_action_id": action_id})

        elif action_type == "send_teams_message":
            message_id = "teams_action_" + uuid.uuid4().hex[:12]
            data = {
                "message_id": message_id,
                "conversation_id": payload["conversation_id"],
                "sender_person_id": "emp_maya_iyer",
                "sent_at": now,
                "is_read": True,
                "status": "sent",
                "linked_work_order_id": payload.get("work_order_id"),
                "body_text": payload["body_text"],
                "synthetic_demo_action": True,
            }
            conn.execute(
                "INSERT INTO teams_messages(id,conversation_id,sender_person_id,sent_at,is_read,status,work_order_id,body_text,data) VALUES (%s,%s,%s,%s,true,'sent',%s,%s,%s)",
                (message_id, payload["conversation_id"], "emp_maya_iyer", now, payload.get("work_order_id"), payload["body_text"], Jsonb(data)),
            )
            readback = conn.execute("SELECT data FROM teams_messages WHERE id=%s", (message_id,)).fetchone()[0]
            result = {"kind": "teams", "message": "Teams message sent", "record": readback}
            _audit(conn, "send_teams_message", "teams_message", message_id, readback, {"pending_action_id": action_id})

        elif action_type == "create_meeting":
            meeting_id = "meeting_action_" + uuid.uuid4().hex[:12]
            event_id = "calendar_action_" + uuid.uuid4().hex[:12]
            meeting_data = {
                "meeting_id": meeting_id,
                "title": payload["title"],
                "start_at": payload["start_at"],
                "end_at": payload["end_at"],
                "work_order_id": payload.get("work_order_id"),
                "account_key": payload.get("account_id"),
                "status": "scheduled",
                "provider": "Microsoft Teams",
                "synthetic_demo_action": True,
            }
            conn.execute(
                "INSERT INTO meetings(id,start_at,end_at,work_order_id,account_id,status,data) VALUES (%s,%s,%s,%s,%s,'scheduled',%s)",
                (meeting_id, payload["start_at"], payload["end_at"], payload.get("work_order_id"), payload.get("account_id"), Jsonb(meeting_data)),
            )
            for person in payload.get("attendees") or []:
                if person.get("person_id"):
                    pdata = {"meeting_id": meeting_id, "person_id": person["person_id"], "role": "attendee", "attendance": "invited"}
                    conn.execute(
                        "INSERT INTO meeting_participants(meeting_id,person_id,role,attendance,data) VALUES (%s,%s,'attendee','invited',%s) ON CONFLICT(meeting_id,person_id) DO NOTHING",
                        (meeting_id, person["person_id"], Jsonb(pdata)),
                    )
            event_data = {
                "calendar_event_id": event_id,
                "source": "Outlook Calendar",
                "event_type": "teams_meeting",
                "start_at": payload["start_at"],
                "end_at": payload["end_at"],
                "status": "scheduled",
                "work_order_id": payload.get("work_order_id"),
                "meeting_id": meeting_id,
                "account_key": payload.get("account_id"),
                "subject": payload["title"],
                "synthetic_demo_action": True,
            }
            conn.execute(
                "INSERT INTO calendar_events(id,source,event_type,start_at,end_at,status,work_order_id,meeting_id,account_id,subject,data) VALUES (%s,'Outlook Calendar','teams_meeting',%s,%s,'scheduled',%s,%s,%s,%s,%s)",
                (event_id, payload["start_at"], payload["end_at"], payload.get("work_order_id"), meeting_id, payload.get("account_id"), payload["title"], Jsonb(event_data)),
            )
            readback = conn.execute("SELECT data FROM meetings WHERE id=%s", (meeting_id,)).fetchone()[0]
            result = {"kind": "meeting", "message": "Meeting created", "record": readback, "calendar_event_id": event_id}
            _audit(conn, "create_meeting", "meeting", meeting_id, readback, {"pending_action_id": action_id})
        else:
            return {"ok": False, "error": "unsupported_action_type", "action_type": action_type}

        conn.execute("UPDATE pending_actions SET status='confirmed', result=%s WHERE id=%s", (Jsonb(result), action_id))
        conn.commit()
        return {"ok": True, "status": "confirmed", "action_id": action_id, "action_type": action_type, "preview": preview, "result": result}


def cancel_action(database_url: str, action_id: str, session_id: str | None = None) -> dict[str, Any]:
    with _conn(database_url) as conn:
        row = conn.execute("SELECT session_id,status,action_type FROM pending_actions WHERE id=%s FOR UPDATE", (action_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "action_not_found"}
        stored_session, status, action_type = row
        if session_id and stored_session != session_id:
            return {"ok": False, "error": "session_mismatch"}
        if status != "pending":
            return {"ok": status == "canceled", "status": status}
        result = {"message": "Action canceled", "action_type": action_type}
        conn.execute("UPDATE pending_actions SET status='canceled', result=%s WHERE id=%s", (Jsonb(result), action_id))
        conn.commit()
        return {"ok": True, "status": "canceled", "action_id": action_id, "result": result}
