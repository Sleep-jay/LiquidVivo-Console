-- Read-only permission checks in a rollback transaction. No users, sessions,
-- passwords, messages, bindings or email confirmations are created/modified.
begin;
do $test$
declare aid uuid; sid uuid; r jsonb; accepted boolean;
begin
 select e.user_id,e.session_id into aid,sid from private.lv_admin_email_sessions e
 join auth.sessions s on s.id=e.session_id and s.user_id=e.user_id
 join public.lv_admins a on a.user_id=e.user_id where e.verified_until>now() order by e.verified_until desc limit 1;
 if aid is null then raise exception 'No currently confirmed administrator session';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',aid,'session_id',sid,'role','authenticated')::text,true);
 if not public.lv_user_session_active() or not public.lv_admin_session_ready() then raise exception 'Current administrator session rejected';end if;
 r=public.lv_admin_accounts();
 if jsonb_typeof(r->'items')<>'array' then raise exception 'Account list shape incorrect';end if;
 if exists(select 1 from jsonb_array_elements(r->'items') x where x ? 'encrypted_password' or x ? 'password' or x ? 'recovery_token') then raise exception 'Credential fields exposed';end if;
 if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=aid::text and (x->>'is_admin')::boolean) then raise exception 'Administrator listing missing';end if;
 accepted=true;
 begin perform public.lv_admin_account_begin('block',aid,gen_random_uuid());exception when raise_exception then accepted=false;end;
 if accepted then raise exception 'Administrator protection failed';end if;
 perform set_config('lv.test_admin',aid::text,true);
end $test$;
set local role authenticated;
do $admin$
begin
 if not public.lv_admin_session_ready() then raise exception 'Administrator role/session check failed';end if;
 if not exists(select 1 from public.lv_admin_accounts()) then raise exception 'Administrator list RPC denied';end if;
end $admin$;
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'session_id',gen_random_uuid(),'role','authenticated')::text,true) is not null as test_claims_set;
set local role authenticated;
do $ordinary$
declare accepted boolean;
begin
 if public.lv_user_session_active() or public.lv_admin_session_ready() then raise exception 'Unknown session accepted';end if;
 if exists(select 1 from public.lv_devices) then raise exception 'Unknown session read inventory';end if;
 accepted=true;begin perform public.lv_admin_accounts();exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Ordinary role read account list';end if;
 accepted=true;begin perform public.lv_admin_registration_policy();exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Ordinary role read registration settings';end if;
 accepted=true;begin perform public.lv_admin_account_begin('block',current_setting('lv.test_admin')::uuid,gen_random_uuid());exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Ordinary role began account mutation';end if;
 accepted=true;begin perform public.lv_admin_account_finish(gen_random_uuid(),true);exception when insufficient_privilege then accepted=false;end;
 if accepted then raise exception 'Ordinary role completed privileged mutation';end if;
end $ordinary$;
reset role;
rollback;
select 'PASS: hosted schema, current admin session, account list without credentials, administrator protection and ordinary-role denial; all checks rolled back, no real account changed' as result;
