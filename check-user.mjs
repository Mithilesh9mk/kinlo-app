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

const [email] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node check-user.mjs <email>');
  process.exit(1);
}

async function checkUser() {
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  const user = users.find(u => u.email === email);
  if (user) {
    console.log('User found:', user.email);
    console.log('Confirmed At:', user.email_confirmed_at);
    console.log('Created At:', user.created_at);
    
    // Auto verify just in case
    if (!user.email_confirmed_at) {
      await supabase.auth.admin.updateUserById(user.id, { email_confirm: true });
      console.log('Verified user now!');
    }
  } else {
    console.log(`User ${email} NOT found in Supabase Auth.`);
  }
}

checkUser().catch(console.error);
