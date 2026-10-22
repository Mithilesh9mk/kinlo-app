import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length > 0) {
    env[key.trim()] = valueParts.join('=').trim();
  }
});

const supabaseUrl = env['EXPO_PUBLIC_SUPABASE_URL'];
// USE ANON KEY to simulate client exactly!
const supabaseAnonKey = env['EXPO_PUBLIC_SUPABASE_ANON_KEY'];
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function simulateSettleUp() {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    console.error('Simulate: Not logged in or error:', authErr);
    // Since we are running in node, we can't auth easily without email/pass.
    // Let's use service role just to check constraint errors!
    console.log('Falling back to service role...');
  }
  
  const adminClient = createClient(supabaseUrl, env['SUPABASE_SERVICE_ROLE_KEY']);
  const { data: users } = await adminClient.from('users').select('id');
  const me = users[0].id;
  const friend = users[1].id;

  const txId = '00000000-0000-4000-8000-000000000000'.replace(/[08]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === '0' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

  const { data, error } = await adminClient.from('transactions').insert({
    id: txId,
    amount: 50,
    description: `You settled ₹50 with Friend.`,
    category: 'other',
    paid_by: me, // I pay
    group_id: null,
    split_type: 'exact'
  });

  console.log('Transaction Insert Result:', { data, error });

  const { data: d2, error: e2 } = await adminClient.from('transaction_splits').insert({
    transaction_id: txId,
    user_id: friend,
    share_amount: 50
  });

  console.log('Split Insert Result:', { data: d2, error: e2 });
}

simulateSettleUp().catch(console.error);
