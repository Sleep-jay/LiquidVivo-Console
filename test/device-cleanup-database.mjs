import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const {pgcrypto}=await import(pathToFileURL(process.argv[2].replace(/index\.js$/,'contrib/pgcrypto.js')).href);
const db=new PGlite({extensions:{pgcrypto}});
const fixture=await readFile(new URL('./trial-database.mjs',import.meta.url),'utf8');
await db.exec(fixture.split('await db.exec(`')[1].split('`);')[0]);
for(const file of [
 '001_console','003_admin_email','004_sponsorship','005_app_connection','006_silent_resume','007_push_registration',
 '008_message_management','009_account_management','010_campaign_redemption','011_immediate_push','012_campaign_code_limits',
 '013_admin_email_week','014_campaign_trials','015_legacy_sponsor_claim','016_sponsor_feature_lease',
 '017_preserve_legacy_status_bar','018_app_account_connect','019_security_events','020_device_inventory_cleanup'
]){
 const sql=await readFile(new URL('../supabase/'+file+'.sql',import.meta.url),'utf8');
 // PGlite does not load pg_cron; the scheduled message purge is outside this test.
 await db.exec(sql.replace(/^create extension if not exists pg_cron.*$|^select cron\.schedule\(.*$/gm,''));
}
const admin='00000000-0000-4000-8000-000000000001',member='00000000-0000-4000-8000-000000000002',sid='10000000-0000-4000-8000-000000000001';
await db.exec(`
 insert into auth.users(id,email,email_confirmed_at) values('${admin}','a@example.test',now()),('${member}','b@example.test',now());
 insert into auth.sessions(id,user_id) values('${sid}','${admin}');
 insert into public.lv_admins(user_id) values('${admin}');
 insert into private.lv_admin_email_sessions values('${sid}','${admin}',now()+interval '1 hour');
 insert into public.lv_devices(device_hash,last_seen)
 select lpad(to_hex(i),64,'0'),now()-interval '8 days' from generate_series(1,1051) i;
 update public.lv_devices set blocked=true where device_hash=lpad('1',64,'0');
 update public.lv_devices set owner_id='${member}' where device_hash=lpad('2',64,'0');
 update public.lv_devices set last_seen=null where device_hash=lpad('3',64,'0');
 insert into public.lv_entitlements(device_id,features,starts_at,revoked_at)
 select id,array['notification_island'],now()-interval '2 days',now()-interval '1 day'
 from public.lv_devices where device_hash=lpad('4',64,'0');`);
const query=async(sql,args)=>(await db.query(sql,args)).rows[0]?.value;
const claims=async(sub)=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub,session_id:sid,role:'authenticated'})]);
await db.exec('set role authenticated');
await claims(member);
await assert.rejects(db.query('select public.lv_admin_device_page()'),/管理员/);
await assert.rejects(db.query('select public.lv_admin_cleanup_devices(array[gen_random_uuid()])'),/管理员/);
await claims(admin);
let rows=[],last;
do{
 const page=await query('select public.lv_admin_device_page($1,$2) as value',[last?.created_at??null,last?.id??null]);
 rows.push(...page);last=page.length===250?page.at(-1):null;
}while(last);
assert.equal(new Set(rows.map(d=>d.id)).size,1051);
assert.equal(rows.filter(d=>d.inactive_week).length,1050);
assert.equal(rows.filter(d=>d.cleanup_eligible).length,1047);
const [keep,remove]=rows.filter(d=>d.cleanup_eligible);
await db.exec('reset role');
await db.query('update public.lv_devices set last_seen=now() where id=$1',[keep.id]);
await db.exec('set role authenticated');
await assert.rejects(db.query('select public.lv_admin_cleanup_devices($1)',[[keep.id,remove.id]]),/未删除任何设备/);
assert.equal(await query('select count(*)::int as value from public.lv_devices'),1051);
assert.equal(await query('select public.lv_admin_cleanup_devices($1) as value',[[remove.id]]),1);
assert.equal(await query("select target_count as value from public.lv_audit where action='cleanup_inactive_devices'"),1);
await db.close();
console.log('Device inventory and cleanup database checks passed');
