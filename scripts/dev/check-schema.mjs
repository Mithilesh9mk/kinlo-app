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
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'] || env['EXPO_PUBLIC_SUPABASE_ANON_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
  const { data: row, error: e2 } = await supabase.from('transactions').select('*').limit(1);
  if (e2) {
    console.error('Error fetching transactions:', e2);
  } else if (row && row.length > 0) {
    console.log('Transactions columns:', Object.keys(row[0]));
  } else {
    console.log('Transactions table is empty, trying to query from information_schema via RPC or checking splits instead.');
    // Let's query transaction_splits too
    const { data: splitRow, error: e3 } = await supabase.from('transaction_splits').select('*').limit(1);
    console.log('Transaction splits columns:', splitRow && splitRow.length > 0 ? Object.keys(splitRow[0]) : e3 || 'empty');
  }
}

checkSchema().catch(console.error);
