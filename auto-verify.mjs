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

async function autoVerifyUsers() {
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error('Error listing users:', error);
    return;
  }
  
  console.log(`Found ${users.length} total users in auth.`);
  
  let verifiedCount = 0;
  for (const user of users) {
    if (!user.email_confirmed_at) {
      console.log(`Auto-verifying user: ${user.email}`);
      const { data, error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        { email_confirm: true }
      );
      if (updateError) {
        console.error(`Failed to verify ${user.email}:`, updateError);
      } else {
        verifiedCount++;
      }
    }
  }
  console.log(`Successfully verified ${verifiedCount} unverified users.`);
}

autoVerifyUsers().catch(console.error);
