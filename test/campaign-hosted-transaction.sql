-- All fixtures are private to this transaction and roll back. No users,
-- Auth credentials, real devices, existing campaigns or messages are changed.
begin;
do $test$
declare aid uuid; sid uuid; did uuid; cid uuid; codeid uuid; gid uuid; txt text; devicecode text;
 r jsonb; cloud jsonb; v bigint; accepted boolean; cfg jsonb;
begin
 select e.user_id,e.session_id into aid,sid from private.lv_admin_email_sessions e join auth.sessions s on s.id=e.session_id
 join public.lv_admins a on a.user_id=e.user_id where e.verified_until>now() order by e.verified_until desc limit 1;
 if aid is null then raise exception 'No confirmed administrator session';end if;
 if exists(select 1 from public.lv_devices where owner_id=aid) or exists(select 1 from private.lv_installations where user_id=aid) then
  raise exception 'Administrator already owns a device/installation; refusing to alter it for fixture';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',aid,'session_id',sid,'role','authenticated')::text,true);
 devicecode='LV2-'||repeat('A',51)||'Q';txt='TX-'||encode(extensions.gen_random_bytes(16),'hex');
 insert into public.lv_devices(device_hash,owner_id,label) values(encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||devicecode,'sha256'),'hex'),aid,'TRANSACTION FIXTURE') returning id into did;
 insert into public.lv_campaigns(title,features,starts_at,ends_at) values('TRANSACTION CODE TEST',array['status_bar'],now()-interval '1 hour',now()+interval '1 day') returning id into cid;
 cfg=jsonb_build_object('code',txt,'enabled',true,'max_uses',1,'expires_at',now()+interval '1 hour');
 codeid=public.lv_campaign_code_save(null,cid,cfg,null);
 cloud=public.lv_cloud_exchange(aid,devicecode,'','1','Transaction fixture','[]');
 if exists(select 1 from jsonb_array_elements(cloud->'grants') g where g->>'id'=cid::text) then raise exception 'Unredeemed campaign auto-granted';end if;
 r=public.lv_campaign_redeem(txt,did);if not (r->>'ok')::boolean then raise exception 'Redemption failed';end if;
 r=public.lv_campaign_redeem(txt,did);if not (r->>'duplicate')::boolean then raise exception 'Duplicate not idempotent';end if;
 if (select used_count from public.lv_campaign_codes where id=codeid)<>1 then raise exception 'Duplicate consumed quota';end if;
 select id into gid from public.lv_campaign_claims where device_id=did and campaign_id=cid;
 cloud=public.lv_cloud_exchange(aid,devicecode,'','1','Transaction fixture','[]');
 if not exists(select 1 from jsonb_array_elements(cloud->'grants') g where g->>'id'=gid::text and g->>'ends_at' is not null) then raise exception 'Claim missing from cloud grants';end if;
 accepted=true;begin perform public.lv_campaign_code_save(codeid,cid,cfg,1);exception when serialization_failure then accepted=false;end;
 if accepted then raise exception 'Stale code edit accepted';end if;
 select edit_version into v from public.lv_campaign_codes where id=codeid;
 perform public.lv_campaign_code_save(codeid,cid,cfg||'{"enabled":false}',v);
 cloud=public.lv_cloud_exchange(aid,devicecode,'','1','Transaction fixture','[]');
 if not exists(select 1 from jsonb_array_elements(cloud->'grants') g where g->>'id'=gid::text) then raise exception 'Code stop wrongly revoked claim';end if;
 perform public.lv_campaign_members_manage(cid,array[did],'revoke');
 cloud=public.lv_cloud_exchange(aid,devicecode,'','1','Transaction fixture','[]');
 if exists(select 1 from jsonb_array_elements(cloud->'grants') g where g->>'id'=gid::text) or not (cloud->'revoked_license_ids' ? gid::text) then raise exception 'Claim revocation failed';end if;
 perform public.lv_campaign_members_manage(cid,array[did],'restore');
 update public.lv_campaigns set enabled=false where id=cid;
 cloud=public.lv_cloud_exchange(aid,devicecode,'','1','Transaction fixture','[]');
 if exists(select 1 from jsonb_array_elements(cloud->'grants') g where g->>'id'=gid::text) then raise exception 'Stopped campaign granted';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'session_id',gen_random_uuid(),'role','authenticated')::text,true);
 perform set_config('lv.test_campaign',cid::text,true);
end $test$;
set local role authenticated;
do $rls$
declare accepted boolean=true;
begin
 if exists(select 1 from public.lv_campaign_codes) or exists(select 1 from public.lv_campaign_claims) then raise exception 'Unknown session read codes or claims';end if;
 begin perform public.lv_campaign_code_save(null,current_setting('lv.test_campaign')::uuid,'{}',null);exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Unknown session edited codes';end if;
 accepted=true;begin perform public.lv_campaign_redeem('invalid',gen_random_uuid());exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Unknown session redeemed';end if;
end $rls$;
reset role;
rollback;
select 'PASS: hosted redemption, quota/idempotency, named device claims in cloud exchange, code edit conflict, stop/revoke/restore separation and RLS. All fixtures rolled back.' as result;
