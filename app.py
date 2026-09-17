from __future__ import annotations
import json
import os
from datetime import datetime
from fastapi import FastAPI, HTTPException
import psycopg
from seed_loader import ensure_seeded

app = FastAPI(title='Meyora Field Demo API', version='0.1.0')
DB = os.getenv('DATABASE_URL')
STARTUP_ERROR = None


def _conn():
    if not DB:
        raise HTTPException(status_code=503, detail='DATABASE_URL is not configured')
    return psycopg.connect(DB, sslmode='require')


def _json(row):
    return row[0] if row else None


@app.on_event('startup')
def startup():
    global STARTUP_ERROR
    if not DB:
        STARTUP_ERROR = 'DATABASE_URL is not configured'
        print('MEYORA_STARTUP_ERROR', STARTUP_ERROR, flush=True)
        return
    try:
        seed_status = ensure_seeded(DB)
        STARTUP_ERROR = None
        print('MEYORA_SEED_READY ' + json.dumps(seed_status, sort_keys=True, default=str), flush=True)
        with _conn() as conn:
            connectors_row = conn.execute("SELECT value FROM demo_meta WHERE key='connectors'").fetchone()
            connectors = connectors_row[0] if connectors_row else {}
            print('MEYORA_CONNECTORS ' + json.dumps(connectors, sort_keys=True, default=str), flush=True)
    except Exception as e:
        STARTUP_ERROR = f'{type(e).__name__}: {e}'
        print('MEYORA_STARTUP_ERROR ' + STARTUP_ERROR, flush=True)


@app.get('/health')
def health():
    if not DB:
        return {'ok': False, 'database': 'not_configured', 'error': STARTUP_ERROR}
    try:
        with _conn() as conn:
            seed = conn.execute("SELECT value FROM demo_meta WHERE key='seed_status'").fetchone()
            return {'ok': bool(seed and seed[0].get('ok')), 'database': 'connected', 'seed_status': _json(seed), 'startup_error': STARTUP_ERROR}
    except Exception as e:
        return {'ok': False, 'database': 'error', 'error': f'{type(e).__name__}: {e}', 'startup_error': STARTUP_ERROR}


@app.get('/connectors')
def connectors():
    with _conn() as conn:
        row = conn.execute("SELECT value FROM demo_meta WHERE key='connectors'").fetchone()
        if not row:
            raise HTTPException(404, 'Connector metadata not found')
        return row[0]


@app.get('/me')
def me():
    with _conn() as conn:
        meta = conn.execute("SELECT value FROM demo_meta WHERE key='dataset'").fetchone()
        user_id = meta[0]['logged_in_user_id']
        row = conn.execute('SELECT data FROM employees WHERE id=%s', (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Maya not found')
        return row[0]


@app.get('/my-day')
def my_day():
    with _conn() as conn:
        ctx = conn.execute("SELECT value FROM demo_meta WHERE key='demo_context'").fetchone()[0]
        dataset = conn.execute("SELECT value FROM demo_meta WHERE key='dataset'").fetchone()[0]
        day = ctx['demo_date']; asof = ctx['demo_as_of']; maya = dataset['logged_in_user_id']

        work_orders = [r[0] for r in conn.execute(
            "SELECT data FROM work_orders WHERE assigned_engineer_id=%s AND scheduled_start::date=%s::date ORDER BY scheduled_start",
            (maya, day)
        ).fetchall()]
        calendar = [r[0] for r in conn.execute(
            "SELECT data FROM calendar_events WHERE start_at::date=%s::date ORDER BY start_at", (day,)
        ).fetchall()]
        reminders = [r[0] for r in conn.execute(
            "SELECT data FROM notifications WHERE status='unread' AND created_at <= %s::timestamp ORDER BY CASE severity WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, created_at DESC",
            (asof,)
        ).fetchall()]
        emails = [r[0] for r in conn.execute(
            "SELECT data FROM emails WHERE is_read=false AND status <> 'draft' AND COALESCE(received_at,sent_at) <= %s::timestamp ORDER BY COALESCE(received_at,sent_at) DESC",
            (asof,)
        ).fetchall()]
        teams = [r[0] for r in conn.execute(
            "SELECT data FROM teams_messages WHERE is_read=false AND sent_at <= %s::timestamp ORDER BY sent_at DESC",
            (asof,)
        ).fetchall()]

        return {
            'demo_date': day,
            'as_of': asof,
            'work_orders': work_orders,
            'calendar': calendar,
            'reminders': reminders,
            'unread_emails': emails,
            'unread_teams_messages': teams,
            'response_order': ['work_orders','reminders','unread_emails','unread_teams_messages'],
        }


@app.get('/context/work-order/{work_order_id}')
def work_order_context(work_order_id: str):
    with _conn() as conn:
        wo = conn.execute('SELECT data FROM work_orders WHERE id=%s',(work_order_id,)).fetchone()
        if not wo:
            raise HTTPException(404,'Work order not found')
        d=wo[0]; aid=d.get('asset_id'); acct=d.get('account_key')
        asset = conn.execute('SELECT data FROM assets WHERE id=%s',(aid,)).fetchone() if aid else None
        history = [r[0] for r in conn.execute('SELECT data FROM work_orders WHERE asset_id=%s AND id<>%s ORDER BY scheduled_start DESC LIMIT 10',(aid,work_order_id)).fetchall()] if aid else []
        emails = [r[0] for r in conn.execute('SELECT data FROM emails WHERE work_order_id=%s OR asset_id=%s ORDER BY COALESCE(received_at,sent_at) DESC LIMIT 20',(work_order_id,aid)).fetchall()]
        teams = [r[0] for r in conn.execute('SELECT data FROM teams_messages WHERE work_order_id=%s OR asset_id=%s ORDER BY sent_at DESC LIMIT 20',(work_order_id,aid)).fetchall()]
        parts = [r[0] for r in conn.execute('SELECT data FROM part_reservations WHERE work_order_id=%s',(work_order_id,)).fetchall()]
        opps = [r[0] for r in conn.execute('SELECT data FROM opportunities WHERE account_id=%s',(acct,)).fetchall()] if acct else []
        return {'work_order':d,'asset':_json(asset),'history':history,'emails':emails,'teams':teams,'parts':parts,'opportunities':opps}
