-- Requires 007-010. Only confirmed administrators create or inspect push jobs.
begin;
create table if not exists public.lv_push_jobs(
 id uuid primary key,message_id uuid references public.lv_messages(id) on delete set null,
 message_version bigint not null,actor uuid not null,actor_session uuid not null,
 canceled_at timestamptz,created_at timestamptz not null default now(),expires_at timestamptz not null,
 worker_id uuid,worker_until timestamptz,last_error text
);
create table if not exists private.lv_push_deliveries(
 id uuid primary key default gen_random_uuid(),job_id uuid not null references public.lv_push_jobs(id) on delete cascade,
 device_id uuid not null references public.lv_devices(id),
 state text not null check(state in ('queued','sending','accepted','rejected','uncertain','no_registration','old_client','canceled')),
 vendor_code integer,task_id text,updated_at timestamptz not null default now(),unique(job_id,device_id)
);
alter table public.lv_push_jobs enable row level security;
alter table private.lv_push_deliveries enable row level security;
revoke all on public.lv_push_jobs,private.lv_push_deliveries from public,anon,authenticated,service_role;
grant select on public.lv_push_jobs to authenticated;
drop policy if exists push_job_read on public.lv_push_jobs;
create policy push_job_read on public.lv_push_jobs for select to authenticated using(public.lv_admin_session_ready());

create or replace function public.lv_push_begin(p_id uuid,p_message uuid,p_version bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare m public.lv_messages;j public.lv_push_jobs;n integer;
begin
 perform private.require_admin();
 select * into m from public.lv_messages where id=p_message for update;
 if not found or m.deleted_at is not null or not m.enabled or now()<m.starts_at or m.ends_at<now()+interval '60 seconds' then raise exception '只可立即推送仍在投放期、至少剩余一分钟的消息';end if;
 if m.edit_version is distinct from p_version then raise exception '消息已修改，请刷新' using errcode='40001';end if;
 select * into j from public.lv_push_jobs where id=p_id;
 if found then
  if j.actor<>auth.uid() or j.message_id<>p_message or j.message_version<>p_version then raise exception '推送操作编号冲突';end if;
  return p_id;
 end if;
 if exists(select 1 from public.lv_push_jobs where message_id=p_message and created_at>now()-interval '60 seconds') then raise exception '此消息刚刚提交过推送，请查看原任务结果';end if;
 select count(*) into n from public.lv_devices where (m.all_devices or id=any(m.target_ids)) and not blocked;
 if n>1000 then raise exception '即时推送每次最多 1000 台，请指定设备分批发送';end if;
 insert into public.lv_push_jobs(id,message_id,message_version,actor,actor_session,expires_at)
 values(p_id,p_message,p_version,auth.uid(),(auth.jwt()->>'session_id')::uuid,least(m.ends_at,now()+interval '15 minutes'));
 insert into private.lv_push_deliveries(job_id,device_id,state)
 select p_id,d.id,case when r.token is null then 'no_registration' when not(case when d.app_version ~ '^[0-9]{1,9}$' then d.app_version::integer>=621 else false end) then 'old_client' else 'queued' end
 from public.lv_devices d left join lateral(
  select r.token from private.lv_push_registrations r join private.lv_installations i on i.user_id=r.user_id and i.device_id=r.device_id
  join auth.users u on u.id=r.user_id left join private.lv_account_controls c on c.user_id=u.id
  where r.device_id=d.id and r.provider='vivo' and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false)
  order by r.updated_at desc limit 1
 ) r on true where (m.all_devices or d.id=any(m.target_ids)) and not d.blocked;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'push_begin',n);return p_id;
end $$;
create or replace function public.lv_push_status(p_id uuid,p_cancel boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.lv_push_jobs;counts jsonb;
begin
 perform private.require_admin();select * into j from public.lv_push_jobs where id=p_id for update;if not found then raise exception '推送任务不存在';end if;
 update private.lv_push_deliveries set state='uncertain',updated_at=now() where job_id=p_id and state='sending' and updated_at<now()-interval '45 seconds';
 if p_cancel then
  update public.lv_push_jobs set canceled_at=coalesce(canceled_at,now()) where id=p_id;
  update private.lv_push_deliveries set state='canceled',updated_at=now() where job_id=p_id and state='queued';
 end if;
 select coalesce(jsonb_object_agg(state,n),'{}') into counts from (select state,count(*) n from private.lv_push_deliveries where job_id=p_id group by state) x;
 return jsonb_build_object('id',j.id,'message_id',j.message_id,'created_at',j.created_at,'expires_at',j.expires_at,'canceled',p_cancel or j.canceled_at is not null,'counts',counts,'last_error',j.last_error,
 'items',(select coalesce(jsonb_agg(jsonb_build_object('device_id',x.device_id,'label',d.label,'state',x.state,'code',x.vendor_code)),'[]') from private.lv_push_deliveries x join public.lv_devices d on d.id=x.device_id where x.job_id=p_id));
end $$;
create or replace function public.lv_push_release(p_id uuid,p_worker uuid) returns void
language sql security definer set search_path='' as $$
 update public.lv_push_jobs set worker_until=now() where id=p_id and worker_id=p_worker
$$;
create or replace function public.lv_push_problem(p_id uuid,p_error text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_error is not null and p_error not in ('vendor_auth_or_connection_failed') then raise exception 'Invalid diagnostic';end if;
 update public.lv_push_jobs set last_error=p_error where id=p_id;
end $$;

create or replace function public.lv_push_claim(p_id uuid,p_worker uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.lv_push_jobs;m public.lv_messages;items jsonb;
begin
 select * into j from public.lv_push_jobs where id=p_id for update;if not found then return '[]';end if;
 select * into m from public.lv_messages where id=j.message_id;
 if j.canceled_at is not null or j.expires_at<=now() or m.id is null or m.deleted_at is not null or not m.enabled or m.edit_version<>j.message_version or m.ends_at<=now() or
 not exists(select 1 from public.lv_admins where user_id=j.actor) or not exists(
  select 1 from private.lv_admin_email_sessions e join auth.sessions s on s.id=e.session_id and s.user_id=e.user_id
  join auth.users u on u.id=e.user_id left join private.lv_account_controls c on c.user_id=u.id
  where e.user_id=j.actor and e.session_id=j.actor_session and e.verified_until>now()
  and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false) and s.created_at>coalesce(c.invalid_before,'-infinity'::timestamptz)) then
  update private.lv_push_deliveries set state='canceled',updated_at=now() where job_id=p_id and state='queued';return '[]';
 end if;
 if j.worker_until>now() and j.worker_id<>p_worker then return '[]';end if;
 update public.lv_push_jobs set worker_id=p_worker,worker_until=now()+interval '45 seconds' where id=p_id;
 -- Sending without a recorded outcome is uncertain, never blindly retransmit.
 update private.lv_push_deliveries set state='uncertain',updated_at=now() where job_id=p_id and state='sending' and updated_at<now()-interval '45 seconds';
 with picked as (select id from private.lv_push_deliveries where job_id=p_id and state='queued' order by id limit 6 for update skip locked),
 claimed as (update private.lv_push_deliveries set state='sending',updated_at=now() where id in(select id from picked) returning *)
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'device_id',x.device_id,'device_code',ci.device_code,'token',r.token,
 'title',m.title,'body',m.body,'expires_at',least(j.expires_at,m.ends_at))),'[]') into items
 from claimed x left join private.lv_cloud_identity ci on ci.device_id=x.device_id
 left join lateral(select r.token from private.lv_push_registrations r join private.lv_installations i on i.user_id=r.user_id and i.device_id=r.device_id
 join public.lv_devices d on d.id=r.device_id join auth.users u on u.id=r.user_id left join private.lv_account_controls c on c.user_id=u.id
 where r.device_id=x.device_id and not d.blocked and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false) order by r.updated_at desc limit 1) r on true;
 return items;
end $$;
create or replace function public.lv_push_finish(p_id uuid,p_worker uuid,p_state text,p_code integer default null,p_task text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_state is null or p_state not in ('accepted','rejected','uncertain','no_registration') then raise exception 'Invalid push outcome';end if;
 update private.lv_push_deliveries d set state=p_state,vendor_code=p_code,task_id=left(p_task,128),updated_at=now()
 from public.lv_push_jobs j where d.id=p_id and d.job_id=j.id and j.worker_id=p_worker and d.state='sending';
 if not found then raise exception 'Push lease no longer owned';end if;
end $$;
revoke all on function public.lv_push_begin(uuid,uuid,bigint),public.lv_push_status(uuid,boolean) from public,anon;
grant execute on function public.lv_push_begin(uuid,uuid,bigint),public.lv_push_status(uuid,boolean) to authenticated;
revoke all on function public.lv_push_claim(uuid,uuid),public.lv_push_finish(uuid,uuid,text,integer,text),public.lv_push_release(uuid,uuid),public.lv_push_problem(uuid,text) from public,anon,authenticated;
grant execute on function public.lv_push_claim(uuid,uuid),public.lv_push_finish(uuid,uuid,text,integer,text),public.lv_push_release(uuid,uuid),public.lv_push_problem(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
