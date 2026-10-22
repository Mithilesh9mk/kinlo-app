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

// Usage: node reset-pass.mjs <email> <new-password>
// Never hardcode either value here; this file is committed.
const [targetEmail, newPassword] = process.argv.slice(2);
if (!targetEmail || !newPassword) {
  console.error('Usage: node reset-pass.mjs <email> <new-password>');
  process.exit(1);
}

async function resetPassword() {
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error('Error:', error);
    return;
  }

  const user = users.find(u => u.email === targetEmail);
  if (user) {
    console.log('Resetting password for:', user.email);
    const { data, error: updateError } = await supabase.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );
    if (updateError) {
      console.error('Failed to update password:', updateError);
    } else {
      console.log('Successfully updated password!');
    }
  }
}

resetPassword().catch(console.error);
