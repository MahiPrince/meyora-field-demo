from __future__ import annotations
import base64, gzip, json, os
from datetime import timedelta
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb
from cryptography.fernet import Fernet

BASE = Path(__file__).resolve().parent
SCHEMA = BASE / 'render_postgres_schema_v1_1.sql'
SEED_PARTS = BASE / 'data'


def load_seed_data():
    key = os.environ.get('MEYORA_SEED_KEY')
    if not key:
        raise RuntimeError('MEYORA_SEED_KEY is not configured')
    single = SEED_PARTS / 'seed.encrypted.b64'
    if single.exists():
        b64 = single.read_text(encoding='ascii').strip()
    else:
        b64 = ''.join(p.read_text(encoding='ascii') for p in sorted(SEED_PARTS.glob('seed.b64.part*.txt')))
    if not b64:
        raise RuntimeError('Encrypted seed payload is missing')
    token = base64.b64decode(b64)
    packed = Fernet(key.encode('ascii')).decrypt(token)
    data = json.loads(gzip.decompress(packed).decode('utf-8'))

    # Demo branding override: the authored service dataset was initially generated
    # with Dynamics 365 labels, but the Field Service demo should surface C4C.
    def rebrand(value):
        if isinstance(value, dict):
            return {k: rebrand(v) for k, v in value.items()}
        if isinstance(value, list):
            return [rebrand(v) for v in value]
        if value in ('Dynamics 365 Field Service', 'Microsoft Dynamics 365 Field Service'):
            return 'C4C'
        if value == 'conn_dynamics_fs':
            return 'conn_c4c'
        return value

    return rebrand(data)


def upsert(conn, table, records, id_key, extra_map=None):
    extra_map = extra_map or []
    for r in records or []:
        cols = ['id'] + [c for c, _ in extra_map] + ['data']
        vals = [r[id_key]] + [r.get(k) for _, k in extra_map] + [Jsonb(r)]
        ph = ','.join(['%s'] * len(cols))
        updates = ','.join([f'{c}=EXCLUDED.{c}' for c in cols[1:]])
        conn.execute(
            f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph}) "
            f"ON CONFLICT (id) DO UPDATE SET {updates}", vals
        )
    return len(records or [])


def upsert_composite(conn, table, records, key_cols, data_cols):
    for r in records or []:
        cols = key_cols + [c for c, _ in data_cols] + ['data']
        vals = [r[k] for k in key_cols] + [r.get(k) for _, k in data_cols] + [Jsonb(r)]
        ph = ','.join(['%s'] * len(cols))
        updates = ','.join([f'{c}=EXCLUDED.{c}' for c in cols if c not in key_cols])
        conn.execute(
            f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph}) "
            f"ON CONFLICT ({','.join(key_cols)}) DO UPDATE SET {updates}", vals
        )
    return len(records or [])


def meta(conn, key, value):
    conn.execute(
        'INSERT INTO demo_meta(key,value) VALUES (%s,%s) '
        'ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        (key, Jsonb(value)),
    )


def seed_database(database_url: str):
    data = load_seed_data()
    counts = {}
    with psycopg.connect(database_url, sslmode='require') as conn:
        conn.execute(SCHEMA.read_text(encoding='utf-8'))
        meta(conn, 'dataset', data['metadata'])
        meta(conn, 'demo_context', data.get('demo_context', {}))
        meta(conn, 'connectors', data['connectors'])

        s = data['source_sales_seed']; w = data['workforce']; p = data['physical_world']
        counts['products'] = upsert(conn,'products',s['products'],'key')
        counts['skills'] = upsert(conn,'skills',w['skills'],'id')
        counts['territories'] = upsert(conn,'territories',w['territories'],'id')
        counts['employees'] = upsert(conn,'employees',w['employees'],'id')
        counts['account_assignments'] = upsert(conn,'account_assignments',w['account_assignments'],'account_key')
        counts['accounts'] = upsert(conn,'accounts',s['accounts'],'key')
        counts['contacts'] = upsert(conn,'contacts',s['contacts'],'key',[('account_id','account_key')])
        counts['opportunities'] = upsert(conn,'opportunities',s['opportunities'],'key',[('account_id','account_key')])
        counts['opportunity_contact_roles'] = upsert(conn,'opportunity_contact_roles',s['opportunity_contact_roles'],'key',[('opportunity_id','opportunity_key'),('contact_id','contact_key')])
        counts['crm_events'] = upsert(conn,'crm_events',s['events'],'key',[('opportunity_id','opportunity_key'),('contact_id','contact_key'),('start_at','start_local'),('end_at','end_local')])
        counts['crm_tasks'] = upsert(conn,'crm_tasks',s['tasks'],'key',[('opportunity_id','opportunity_key'),('contact_id','contact_key'),('activity_date','activity_date')])

        counts['sites'] = upsert(conn,'sites',p['sites'],'site_id',[('account_id','account_key')])
        counts['contact_site_links'] = upsert(conn,'contact_site_links',p['contact_site_links'],'contact_key',[('site_id','site_id'),('account_id','account_key')])
        counts['assets'] = upsert(conn,'assets',p['assets'],'asset_id',[('account_id','account_key'),('site_id','site_id'),('health_status','health_status'),('lifecycle_status','lifecycle_status'),('next_pm_due','next_pm_due')])
        counts['asset_relationships'] = upsert(conn,'asset_relationships',p['asset_relationships'],'relationship_id',[('from_asset_id','from_asset_id'),('to_asset_id','to_asset_id'),('relationship_type','relationship_type')])

        h=data['historical_service']; m=data['september_workload']
        cases=h['cases']+m['cases']; work_orders=h['work_orders']+m['work_orders']; appts=h['service_appointments']+m['service_appointments']; tasks=h['service_tasks']+m['service_tasks']; meas=h['measurements']+m['measurements']; notes=h['notes']+m['notes']
        counts['cases']=upsert(conn,'cases',cases,'case_id',[('account_id','account_key'),('asset_id','asset_id'),('opened_at','opened_at'),('closed_at','closed_at'),('priority','priority'),('status','status')])
        counts['work_orders']=upsert(conn,'work_orders',work_orders,'work_order_id',[('account_id','account_key'),('site_id','site_id'),('asset_id','asset_id'),('case_id','case_id'),('contact_id','contact_key'),('assigned_engineer_id','assigned_engineer_id'),('scheduled_start','scheduled_start'),('scheduled_end','scheduled_end'),('priority','priority'),('status','status'),('work_type','work_type')])
        counts['service_appointments']=upsert(conn,'service_appointments',appts,'appointment_id',[('work_order_id','work_order_id'),('engineer_id','engineer_id'),('site_id','site_id'),('start_at','start_at'),('end_at','end_at'),('status','status')])
        counts['service_tasks']=upsert(conn,'service_tasks',tasks,'task_id',[('work_order_id','work_order_id'),('status','status'),('sequence','sequence')])
        counts['measurements']=upsert(conn,'measurements',meas,'measurement_id',[('work_order_id','work_order_id'),('asset_id','asset_id'),('recorded_at','recorded_at')])
        counts['service_notes']=upsert(conn,'service_notes',notes,'note_id',[('work_order_id','work_order_id'),('author_employee_id','author_employee_id'),('created_at','created_at')])

        pi=data['parts_inventory']
        counts['parts']=upsert(conn,'parts',pi['parts'],'part_id')
        counts['inventory_locations']=upsert(conn,'inventory_locations',pi['inventory_locations'],'location_id')
        counts['inventory_stock']=upsert_composite(conn,'inventory_stock',pi['stock'],['location_id','part_id'],[('quantity_on_hand','quantity_on_hand'),('quantity_reserved','quantity_reserved')])
        counts['part_reservations']=upsert(conn,'part_reservations',pi['reservations'],'reservation_id',[('work_order_id','work_order_id'),('part_id','part_id'),('location_id','preferred_location_id'),('status','status'),('needed_by','needed_by')])
        counts['part_movements']=upsert(conn,'part_movements',pi['movements'],'movement_id',[('work_order_id','work_order_id'),('part_id','part_id'),('occurred_at','occurred_at')])

        o=data['microsoft365']
        counts['identity_directory']=upsert(conn,'identity_directory',o['identity_directory'],'person_id',[('display_name','display_name'),('person_type','person_type'),('email','email'),('teams_user_id','teams_user_id')])
        counts['email_threads']=upsert(conn,'email_threads',o['email_threads'],'thread_id',[('account_id','account_key'),('asset_id','asset_id'),('work_order_id','work_order_id'),('opportunity_id','linked_opportunity_key'),('subject','subject'),('status','status')])
        counts['emails']=upsert(conn,'emails',o['emails'],'email_id',[('thread_id','thread_id'),('direction','direction'),('sender','sender'),('sent_at','sent_at'),('received_at','received_at'),('status','status'),('is_read','is_read'),('flagged','flagged'),('account_id','account_key'),('asset_id','asset_id'),('work_order_id','work_order_id'),('subject','subject'),('body_text','body_text')])
        counts['email_attachments']=upsert(conn,'email_attachments',o['email_attachments'],'attachment_id',[('thread_id','thread_id'),('email_id','email_id')])
        counts['teams_channels']=upsert(conn,'teams_channels',o['teams_channels'],'channel_id',[('name','name')])
        counts['teams_conversations']=upsert(conn,'teams_conversations',o['teams_conversations'],'conversation_id',[('channel_id','channel_id'),('conversation_type','conversation_type'),('title','title')])
        counts['teams_messages']=upsert(conn,'teams_messages',o['teams_messages'],'message_id',[('conversation_id','conversation_id'),('channel_id','channel_id'),('sender_person_id','sender_person_id'),('sent_at','sent_at'),('is_read','is_read'),('status','status'),('work_order_id','linked_work_order_id'),('asset_id','linked_asset_id'),('body_text','body_text')])
        counts['meetings']=upsert(conn,'meetings',o['meetings'],'meeting_id',[('start_at','start_at'),('end_at','end_at'),('work_order_id','work_order_id'),('account_id','account_key'),('status','status')])
        counts['meeting_participants']=upsert_composite(conn,'meeting_participants',o['meeting_participants'],['meeting_id','person_id'],[('role','role'),('attendance','attendance')])
        counts['meeting_transcripts']=upsert(conn,'meeting_transcripts',o['meeting_transcripts'],'transcript_id',[('meeting_id','meeting_id')])
        counts['calendar_events']=upsert(conn,'calendar_events',o['calendar_events'],'calendar_event_id',[('source','source'),('event_type','event_type'),('start_at','start_at'),('end_at','end_at'),('status','status'),('work_order_id','work_order_id'),('meeting_id','meeting_id'),('account_id','account_key'),('subject','subject'),('location','location')])

        i=data['intelligence']
        counts['notifications']=upsert(conn,'notifications',i['notifications'],'notification_id',[('created_at','created_at'),('source','source'),('severity','severity'),('status','status'),('account_id','account_key'),('asset_id','asset_id'),('work_order_id','work_order_id')])
        counts['signals']=upsert(conn,'signals',i['cross_domain_signals'],'signal_id',[('created_at','created_at'),('signal_type','type'),('status','status'),('account_id','account_key'),('asset_id','asset_id'),('work_order_id','work_order_id'),('opportunity_id','linked_opportunity_key')])
        counts['timeline_events']=upsert(conn,'timeline_events',i['timeline_events'],'timeline_id',[('occurred_at','occurred_at'),('event_type','event_type'),('source','source'),('account_id','account_key'),('asset_id','asset_id'),('work_order_id','work_order_id'),('source_record_id','source_record_id')])
        conn.commit()

        demo_date=data['demo_context']['demo_date']; maya=data['metadata']['logged_in_user_id']
        maya_count=conn.execute('SELECT count(*) FROM work_orders WHERE assigned_engineer_id=%s AND scheduled_start::date=%s::date',(maya,demo_date)).fetchone()[0]
        if maya_count != 3:
            raise RuntimeError(f'Expected 3 Maya demo-day work orders, found {maya_count}')
        meta(conn,'seed_status',{'ok':True,'counts':counts,'maya_demo_day_work_orders':maya_count})
        conn.commit()
    return {'ok': True, 'counts': counts, 'maya_demo_day_work_orders': maya_count}



def ensure_monthly_teams_extension(database_url: str):
    """Fill the second half of September with deterministic synthetic Teams context.

    The encrypted authored seed already contains a full month of work orders/calendar
    and email, but its Teams timeline ends mid-month. This extension derives
    additional mock Teams messages from the existing Maya work orders so date-based
    questions remain useful across the full month without hard-coded chat answers.
    It is idempotent and never touches user-created/action-generated messages.
    """
    inserted = 0
    with psycopg.connect(database_url, sslmode='require') as conn:
        dataset_row = conn.execute(
            "SELECT value FROM demo_meta WHERE key='dataset'"
        ).fetchone()
        maya = (dataset_row[0] or {}).get('logged_in_user_id') if dataset_row else None
        if not maya:
            return {'ok': False, 'reason': 'maya_principal_missing', 'inserted': 0}

        sender_rows = conn.execute("""
            SELECT DISTINCT ON (lower(d.display_name))
                   d.id, d.display_name, tm.conversation_id, tm.channel_id
            FROM teams_messages tm
            JOIN identity_directory d ON d.id=tm.sender_person_id
            WHERE (
                lower(d.display_name) LIKE 'nikhil%%'
                OR lower(d.display_name) LIKE 'hannah%%'
                OR lower(d.display_name) LIKE 'david%%'
            )
            ORDER BY lower(d.display_name), tm.sent_at DESC NULLS LAST
        """).fetchall()

        senders = [
            {
                'person_id': row[0],
                'display_name': row[1],
                'conversation_id': row[2],
                'channel_id': row[3],
            }
            for row in sender_rows
            if row[0] and row[2]
        ]
        if not senders:
            fallback = conn.execute("""
                SELECT tm.sender_person_id, COALESCE(d.display_name,'Field Support'),
                       tm.conversation_id, tm.channel_id
                FROM teams_messages tm
                LEFT JOIN identity_directory d ON d.id=tm.sender_person_id
                WHERE tm.sender_person_id IS NOT NULL AND tm.conversation_id IS NOT NULL
                ORDER BY tm.sent_at DESC NULLS LAST
                LIMIT 3
            """).fetchall()
            senders = [
                {
                    'person_id': row[0],
                    'display_name': row[1],
                    'conversation_id': row[2],
                    'channel_id': row[3],
                }
                for row in fallback
            ]
        if not senders:
            return {'ok': False, 'reason': 'teams_sender_context_missing', 'inserted': 0}

        work = conn.execute("""
            SELECT wo.id, wo.asset_id, wo.scheduled_start, wo.data, a.data, ast.data
            FROM work_orders wo
            LEFT JOIN accounts a ON a.id=wo.account_id
            LEFT JOIN assets ast ON ast.id=wo.asset_id
            WHERE wo.assigned_engineer_id=%s
              AND wo.scheduled_start::date BETWEEN DATE '2026-09-16' AND DATE '2026-09-30'
            ORDER BY wo.scheduled_start
        """, (maya,)).fetchall()

        templates = {
            'nikhil': [
                "Morning Maya — I saw the {account} job on your schedule. Ping me after diagnostics if you want a second set of eyes.",
                "I can cover anything that moves while you're at {account}. Send me the first diagnostic readout when you have it.",
                "Quick check-in on {account}: if the visit runs long, I can pick up the next remote call.",
            ],
            'hannah': [
                "Parts update for {account}: common service stock is available regionally. I can reserve what you need after inspection.",
                "For the {asset} at {account}, let me know the diagnostic result before I move any parts into reserved status.",
                "I checked parts availability for today's route. Nothing is blocked right now; message me if {account} needs an expedited kit.",
            ],
            'david': [
                "Quick heads-up on {account}: I saw a similar {asset} symptom recently. Check the baseline diagnostics before replacing parts.",
                "For {account}, compare the current readings with the last service baseline before you close the diagnosis.",
                "I reviewed the {account} context. If the first checks are clean, look at the recent service history before escalating.",
            ],
        }

        for index, row in enumerate(work):
            work_order_id, asset_id, scheduled_start, wo_data, account_data, asset_data = row
            if not scheduled_start:
                continue
            account = (
                (account_data or {}).get('name')
                or (account_data or {}).get('account_name')
                or (wo_data or {}).get('account_name')
                or 'the customer'
            )
            asset = (
                (asset_data or {}).get('product_name')
                or (asset_data or {}).get('name')
                or (wo_data or {}).get('product_name')
                or 'instrument'
            )

            # Two contextual messages per Maya workday: one before the first visit,
            # another later in the day. Sender/context are reused from authored DMs.
            for slot in range(2):
                sender = senders[(index * 2 + slot) % len(senders)]
                sender_key = str(sender['display_name']).split()[0].lower()
                choices = templates.get(sender_key, templates['nikhil'])
                body_text = choices[(index + slot) % len(choices)].format(
                    account=account, asset=asset
                )
                sent_at = scheduled_start - timedelta(minutes=45) if slot == 0 else scheduled_start + timedelta(hours=3, minutes=20)
                message_id = f"syn_teams_{sent_at:%Y%m%d}_{index:02d}_{slot}_{sender['person_id']}"
                payload = {
                    'message_id': message_id,
                    'conversation_id': sender['conversation_id'],
                    'channel_id': sender['channel_id'],
                    'sender_person_id': sender['person_id'],
                    'sender_name': sender['display_name'],
                    'sent_at': sent_at.isoformat(),
                    'is_read': bool(slot == 0),
                    'status': 'sent',
                    'linked_work_order_id': work_order_id,
                    'linked_asset_id': asset_id,
                    'body_text': body_text,
                    'synthetic_extension': 'september_2026_v1',
                }
                result = conn.execute("""
                    INSERT INTO teams_messages(
                        id, conversation_id, channel_id, sender_person_id, sent_at,
                        is_read, status, work_order_id, asset_id, body_text, data
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT(id) DO NOTHING
                    RETURNING id
                """, (
                    message_id, sender['conversation_id'], sender['channel_id'],
                    sender['person_id'], sent_at, bool(slot == 0), 'sent',
                    work_order_id, asset_id, body_text, Jsonb(payload),
                )).fetchone()
                if result:
                    inserted += 1

        status = {
            'ok': True,
            'extension': 'september_2026_v1',
            'inserted_this_run': inserted,
            'target_start': '2026-09-16',
            'target_end': '2026-09-30',
        }
        meta(conn, 'monthly_extension_status', status)
        conn.commit()
        return status


def ensure_seeded(database_url: str):
    seed_status = None
    with psycopg.connect(database_url, sslmode='require') as conn:
        exists = conn.execute("SELECT to_regclass('public.demo_meta')").fetchone()[0]
        if exists:
            row = conn.execute("SELECT value FROM demo_meta WHERE key='seed_status'").fetchone()
            if row and row[0].get('ok'):
                seed_status = row[0]

    if seed_status is None:
        seed_status = seed_database(database_url)

    extension = ensure_monthly_teams_extension(database_url)
    return {**seed_status, 'monthly_extension': extension}
