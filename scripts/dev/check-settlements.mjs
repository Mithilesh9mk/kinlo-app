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

async function checkSettlements() {
  const { data: txs, error } = await supabase
    .from('transactions')
    .select(`id, amount, paid_by, description, created_at`)
    .like('description', '%settled%')
    .order('created_at', { ascending: false });

  if (error) console.error(error);
  console.log('Settlement Transactions:', txs);
}

checkSettlements().catch(console.error);
