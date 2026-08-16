import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

console.log("Hello from push-notify!")

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    // Scoped to the CALLER's own JWT, not the service role. auth.uid() and
    // every RLS policy below resolve against them, so the database — not
    // this function — is what decides who they're allowed to notify.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await callerClient.auth.getUser()
    if (authError || !user) {
      return json({ error: 'Invalid or expired session' }, 401)
    }

    const { userIds, title, body, data } = await req.json()

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return json({ error: 'No userIds provided' }, 400)
    }
    if (!title || !body) {
      return json({ error: 'title and body are required' }, 400)
    }

    // Ask the DB which of the requested recipients the caller may actually
    // see — this is the same boundary users_select_related enforces
    // everywhere else in the app (self, group members, friends, transaction
    // counterparties, migrations/0002_user_isolation.sql). Anyone outside
    // it is silently dropped rather than trusted because the client sent
    // their id — this is what closes the "notify any user" hole.
    const { data: allowedUsers, error: relatedError } = await callerClient
      .from('users')
      .select('id')
      .in('id', userIds)

    if (relatedError) throw relatedError

    const allowedIds = (allowedUsers ?? []).map((u: { id: string }) => u.id)

    if (allowedIds.length === 0) {
      return json({ message: 'No authorized recipients' }, 200)
    }

    // Service role from here on, and only to read tokens for recipients
    // already vetted above — never to widen who gets notified.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: users, error } = await supabaseClient
      .from('users')
      .select('push_token')
      .in('id', allowedIds)
      .not('push_token', 'is', null)

    if (error) throw error

    if (!users || users.length === 0) {
      return json({ message: 'No tokens found' }, 200)
    }

    const messages = users
      .filter(u => u.push_token && u.push_token.startsWith('ExponentPushToken'))
      .map(u => ({
        to: u.push_token,
        sound: 'default',
        title,
        body,
        data: data || {},
      }))

    if (messages.length === 0) {
      return json({ message: 'No valid expo tokens found' }, 200)
    }

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    })

    const expResponse = await response.json()

    return json({ success: true, messagesSent: messages.length, expResponse })
  } catch (error) {
    return json({ error: (error as Error).message }, 400)
  }
})
