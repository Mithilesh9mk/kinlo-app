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

async function checkConstraint() {
  const txId = '11111111-1111-4000-8000-000000000000';
  const { data: users } = await supabase.from('users').select('id');
  const me = users[0].id;
  
  // attempt to insert negative amount
  const { data, error } = await supabase.from('transactions').insert({
    id: txId,
    amount: -50,
    description: 'test negative',
    category: 'other',
    paid_by: me,
    group_id: null,
    split_type: 'exact',
    status: 'completed'
  });
  
  if (error) {
    console.error('Insert failed:', error);
  } else {
    console.log('Insert succeeded! Cleaning up...');
    await supabase.from('transactions').delete().eq('id', txId);
  }
}

checkConstraint().catch(console.error);
