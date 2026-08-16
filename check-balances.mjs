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

async function checkBalances() {
  const { data: users } = await supabase.from('users').select('id, full_name');
  
  const { data: txs } = await supabase
    .from('transactions')
    .select(`id, amount, paid_by, status, description, transaction_splits (user_id, share_amount)`);

  const userId = users[0].id; // assume first user is me
  console.log('My User ID:', userId, users[0].full_name);

  const friendBalances = {};
  
  if (txs) {
    for (const tx of txs) {
      console.log(`\nTX ${tx.id} | Amount: ${tx.amount} | Paid by: ${tx.paid_by} | Status: ${tx.status} | Desc: ${tx.description}`);
      const splits = tx.transaction_splits || [];
      const isPayerMe = tx.paid_by === userId;
      const hasMe = splits.some(s => s.user_id === userId);
      
      console.log(`isPayerMe: ${isPayerMe}, hasMe: ${hasMe}, splits:`, splits);

      if (isPayerMe) {
        for (const s of splits) {
          if (s.user_id !== userId) {
            friendBalances[s.user_id] = (friendBalances[s.user_id] || 0) + Number(s.share_amount);
            console.log(`Added +${s.share_amount} to ${s.user_id}`);
          }
        }
      } else if (hasMe) {
        const mySplit = splits.find(s => s.user_id === userId);
        if (mySplit) {
          friendBalances[tx.paid_by] = (friendBalances[tx.paid_by] || 0) - Number(mySplit.share_amount);
          console.log(`Added -${mySplit.share_amount} to ${tx.paid_by}`);
        }
      }
    }
  }

  console.log('\n--- Final Balances ---');
  for (const [fId, bal] of Object.entries(friendBalances)) {
    const friend = users.find(u => u.id === fId);
    console.log(`Friend ${friend ? friend.full_name : fId}: ${bal}`);
  }
}

checkBalances().catch(console.error);
