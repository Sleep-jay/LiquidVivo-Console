-- Integration test: ALL fixtures and receipt changes roll back; no users or sessions are created.
-- No test message can be read outside this transaction; it is disabled and future-dated.
begin;
do $test$
declare aid uuid; sid uuid; mid uuid; did uuid; r jsonb; previous jsonb;
        accepted boolean; original_count integer; n integer;
begin
  select count(*) into original_count from public.lv_messages;
  if exists(select 1 from public.lv_messages where deleted_at<=now()-interval '7 days') then
    raise exception 'Test would encounter existing expired trash; refusing to run purge fixture';end if;
  select s.user_id,s.session_id into aid,sid from private.lv_admin_email_sessions s join public.lv_admins a on a.user_id=s.user_id where s.verified_until>now() order by s.verified_until desc limit 1;
  if aid is null then raise exception 'No currently confirmed administrator session for transaction test';end if;
  perform set_config('request.jwt.claims','{}',true);
  accepted=true;
  begin perform public.lv_message_manage('trash',gen_random_uuid(),'{}',1);
  exception when insufficient_privilege then accepted=false;end;
  if accepted then raise exception 'Unconfirmed actor was accepted';end if;

  -- PostgreSQL-owner-only request context from an existing confirmed session; no bearer is exported.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',aid,'session_id',sid,'role','authenticated')::text,true);
  insert into public.lv_messages(title,body,kind,all_devices,target_ids,starts_at,ends_at,enabled)
    values('TRANSACTION TEST','No device delivery','dialog',true,'{}','2099-01-01','2100-01-01',false) returning id into mid;
  r=public.lv_message_manage('edit',mid,jsonb_build_object('title','Edited fixture','body','Body','kind','dialog',
    'all_devices',true,'target_ids','[]'::jsonb,'link','','version_code',null,'starts_at','2099-01-01T00:00:00Z','ends_at','2100-01-01T00:00:00Z','enabled',false),1);
  if r->>'title'<>'Edited fixture' or (r->>'edit_version')::bigint<>2 then raise exception 'Edit failed';end if;
  accepted=true;
  begin perform public.lv_message_manage('stop',mid,'{}',1);
  exception when serialization_failure then accepted=false;end;
  if accepted then raise exception 'Stale update accepted';end if;
  r=public.lv_message_manage('trash',mid,'{}',(r->>'edit_version')::bigint);
  if r->>'deleted_at' is null or (r->>'enabled')::boolean then raise exception 'Trash did not stop delivery';end if;
  -- Repeated deletion must preserve both its deadline and its version.
  previous=r;r=public.lv_message_manage('trash',mid,'{}',1);
  if r is distinct from previous then raise exception 'Repeated deletion changed retention';end if;
  r=public.lv_message_manage('restore',mid,'{}',(r->>'edit_version')::bigint);
  if r->>'deleted_at' is not null or (r->>'enabled')::boolean then raise exception 'Restore unexpectedly enabled delivery';end if;
  previous=r;r=public.lv_message_manage('restore',mid,'{}',1);
  if r is distinct from previous then raise exception 'Repeated restore was not idempotent';end if;
  update public.lv_messages set deleted_at=now()-interval '7 days',enabled=false where id=mid returning to_jsonb(lv_messages) into r;
  accepted=true;
  begin perform public.lv_message_manage('restore',mid,'{}',(r->>'edit_version')::bigint);
  exception when raise_exception then accepted=false;end;
  if accepted then raise exception 'Expired trash restored';end if;
  select id into did from public.lv_devices order by created_at limit 1;
  if did is not null then insert into public.lv_receipts(message_id,device_id,received_at) values(mid,did,now());end if;
  n=private.lv_purge_deleted_messages();
  if n<>1 or exists(select 1 from public.lv_messages where id=mid) or exists(select 1 from public.lv_receipts where message_id=mid) then raise exception 'Purge/receipt cleanup failed';end if;
  if (select count(*) from public.lv_messages)<>original_count then raise exception 'Existing messages changed';end if;

  -- A separate hidden row for a real authenticated-role RLS check.
  insert into public.lv_messages(title,body,kind,all_devices,target_ids,starts_at,ends_at,enabled,deleted_at)
    values('RLS TRANSACTION TEST','Never delivered','dialog',true,'{}','2099-01-01','2100-01-01',false,now()) returning id into mid;
  perform set_config('lv.test_message_id',mid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'session_id',gen_random_uuid(),'role','authenticated')::text,true);
end $test$;
set local role authenticated;
do $rls$
declare accepted boolean=true;
begin
  if exists(select 1 from public.lv_messages where id=current_setting('lv.test_message_id')::uuid) then raise exception 'RLS exposed deleted message';end if;
  begin perform public.lv_message_manage('restore',current_setting('lv.test_message_id')::uuid,'{}',1);
  exception when insufficient_privilege then accepted=false;end;
  if accepted then raise exception 'Ordinary user restored deleted message';end if;
end $rls$;
reset role;
rollback;
select 'PASS: edit, stale-version rejection, trash, idempotency, stopped restore, seven-day expiry, receipt purge and ordinary-user RLS; fixtures rolled back' as result;
select jobname,schedule,active from cron.job where jobname='liquidvivo-message-trash-purge';
