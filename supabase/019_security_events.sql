begin;

create table if not exists private.lv_security_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  account_id uuid references auth.users(id) on delete set null,
  device_id uuid references public.lv_devices(id) on delete set null,
  rule text not null check(rule in ('r1','r2','r3')),
  origin text not null check(origin in ('client','server')),
  build integer not null check(build between 1 and 2147483647),
  client_at timestamptz,
  received_at timestamptz not null default now(),
  state text not null default 'pending' check(state in ('pending','confirmed','dismissed','handled')),
  note text not null default '' check(length(note)<=2000),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  unique(actor_id,event_id)
);
create index if not exists lv_security_events_recent on private.lv_security_events(received_at desc,id desc);
alter table private.lv_security_events enable row level security;
revoke all on private.lv_security_events from public,anon,authenticated,service_role;

create or replace function public.lv_record_security_event(p_actor uuid,p_event uuid,p_rule text,p_origin text,p_build integer,p_client_at timestamptz,p_installation uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare device uuid; account uuid;
begin
  if p_event is null or p_rule not in ('r1','r2','r3') or p_origin not in ('client','server')
    or p_build is null or p_build<1 or p_rule is null or p_origin is null then return false;end if;
  if not exists(select 1 from auth.users where id=p_actor) then return false;end if;
  delete from private.lv_security_events where received_at<now()-interval '30 days';
  perform pg_advisory_xact_lock(hashtextextended('lv_event:'||p_actor::text,0));
  if exists(select 1 from private.lv_security_events where actor_id=p_actor and event_id=p_event) then return true;end if;
  if (select count(*) from private.lv_security_events where actor_id=p_actor and received_at>now()-interval '1 day')>=10
    or exists(select 1 from private.lv_security_events where actor_id=p_actor and rule=p_rule and origin=p_origin and received_at>now()-interval '1 hour')
    then return false;end if;
  if (select count(*) from private.lv_security_events where received_at>now()-interval '1 day')>=10000 then return false;end if;
  select id into account from auth.users where id=p_actor and is_anonymous is false and email_confirmed_at is not null;
  if account is not null then
    select d.id into device from public.lv_devices d join private.lv_installations i on i.device_id=d.id
      where d.owner_id=account and i.user_id=p_installation;
  else
    select device_id into device from private.lv_installations where user_id=p_actor;
  end if;
  insert into private.lv_security_events(actor_id,event_id,account_id,device_id,rule,origin,build,client_at)
    values(p_actor,p_event,account,device,p_rule,p_origin,p_build,p_client_at);
  return true;
end $$;
revoke all on function public.lv_record_security_event(uuid,uuid,text,text,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.lv_record_security_event(uuid,uuid,text,text,integer,timestamptz,uuid) to service_role;

create or replace function public.lv_admin_security_events(p_before timestamptz default null,p_before_id uuid default null,p_state text default 'all')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  delete from private.lv_security_events where received_at<now()-interval '30 days';
  if p_state not in ('all','pending','confirmed','dismissed','handled') then raise exception 'Invalid filter';end if;
  return coalesce((select jsonb_agg(to_jsonb(x)) from (
    select e.id,e.account_id,e.device_id,
      coalesce(d.device_hash,encode(extensions.digest('LiquidVivo/event-installation/v1'||chr(10)||e.actor_id::text,'sha256'),'hex')) as device_hash,
      e.rule,e.origin,e.build,e.client_at,e.received_at,e.state,e.note
    from private.lv_security_events e left join public.lv_devices d on d.id=e.device_id
    where (p_state='all' or e.state=p_state)
      and (p_before is null or (e.received_at,e.id)<(p_before,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by e.received_at desc,e.id desc limit 10
  ) x),'[]'::jsonb);
end $$;

create or replace function public.lv_admin_security_review(p_id uuid,p_state text,p_note text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  if p_state is null or p_state not in ('pending','confirmed','dismissed','handled') or p_note is null or length(p_note)>2000 then raise exception 'Invalid review';end if;
  update private.lv_security_events set state=p_state,note=p_note,reviewed_by=auth.uid(),reviewed_at=now() where id=p_id;
  if not found then return false;end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'security_review',1);
  return true;
end $$;
revoke all on function public.lv_admin_security_events(timestamptz,uuid,text),public.lv_admin_security_review(uuid,text,text) from public,anon;
grant execute on function public.lv_admin_security_events(timestamptz,uuid,text),public.lv_admin_security_review(uuid,text,text) to authenticated;

create or replace function public.lv_prune_security_events()
returns void language sql security definer set search_path='' as $$
  delete from private.lv_security_events where received_at<now()-interval '30 days'
$$;
revoke all on function public.lv_prune_security_events() from public,anon,authenticated;
grant execute on function public.lv_prune_security_events() to service_role;
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname='lv-security-retention';
    perform cron.schedule('lv-security-retention','17 * * * *','select public.lv_prune_security_events()');
  end if;
end $$;
notify pgrst,'reload schema';
commit;
