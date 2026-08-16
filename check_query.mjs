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
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);

async function testQuery() {
  const userId = '<user-id>'; // a user ID from check-balances
  console.log('Testing explicit OR query for user:', userId);

  const { data: txs, error } = await supabase
    .from('transactions')
    .select(`
      id,
      amount,
      description,
      category,
      paid_by,
      group_id,
      created_at,
      status,
      transaction_splits!inner (user_id, share_amount)
    `)
    .or(`paid_by.eq.${userId},transaction_splits.user_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Query error:', error);
  } else {
    console.log('Query success! Count:', txs?.length);
    console.log(txs);
  }
}

testQuery().catch(console.error);
