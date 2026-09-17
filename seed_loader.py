from __future__ import annotations
import base64, gzip, json, os
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


def ensure_seeded(database_url: str):
    with psycopg.connect(database_url, sslmode='require') as conn:
        exists = conn.execute("SELECT to_regclass('public.demo_meta')").fetchone()[0]
        if exists:
            row = conn.execute("SELECT value FROM demo_meta WHERE key='seed_status'").fetchone()
            if row and row[0].get('ok'):
                return row[0]
    return seed_database(database_url)
