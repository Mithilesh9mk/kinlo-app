import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Deletes the caller's account.
//
// Three steps, in this order, because each depends on the previous still
// being possible:
//   1. anonymize_my_account() — runs as the CALLER, strips their identity
//      and destroys their private rows (see 0044).
//   2. Delete receipts/{user_id}/ from Storage — needs service_role, since
//      an object delete is not something the caller's own policies express
//      well in bulk, and 0037's header flags this sweep as an open gap.
//   3. Delete the auth login — needs service_role (auth.admin). Without
//      this the account is anonymised but still signs in, which is not
//      "deleted" by either store's definition.
//
// SERVICE ROLE IS SCOPED TO THE CALLER, ALWAYS.
//
// The user id is taken from the verified JWT and NEVER from the request
// body. There is no parameter to aim this at another account — that is the
// entire safety property of this function, and any future edit that
// introduces a user-id argument breaks it.

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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ ok: false, code: 'unauthorized', error: 'Missing Authorization header' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!serviceKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set')
      return json({ ok: false, code: 'not_configured', error: 'Deletion is not configured' }, 500)
    }

    // Scoped to the caller. This client is what establishes WHO is being
    // deleted; everything below uses the id it returns.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: authError } = await callerClient.auth.getUser()
    if (authError || !user) {
      return json({ ok: false, code: 'unauthorized', error: 'Invalid or expired session' }, 401)
    }

    const userId = user.id

    // 3 calls / rolling 1h per user (0046_delete_account_rate_limit.sql).
    // Checked before step 1 — this is a destructive flow, not something a
    // scripted loop should get to retry unboundedly. Atomic on the DB side.
    const { data: rateLimit, error: rateLimitError } = await callerClient
      .rpc('check_and_increment_delete_account_rate_limit')
      .single()
    if (rateLimitError) {
      console.error('Rate limit check failed:', rateLimitError.message)
      return json({ ok: false, code: 'error', error: 'Could not process request right now' }, 500)
    }
    if (!rateLimit.allowed) {
      return json({ ok: false, code: 'rate_limited', error: 'Too many attempts — try again later' }, 429)
    }

    // 1. Anonymise + purge, as the caller. Runs first so that if it fails,
    //    the login still exists and the user can retry — the reverse order
    //    would strand data belonging to an account that can no longer sign in.
    const { error: rpcError } = await callerClient.rpc('anonymize_my_account')
    if (rpcError) {
      console.error('anonymize_my_account failed:', rpcError.message)
      return json({ ok: false, code: 'anonymize_failed', error: 'Could not remove your data' }, 500)
    }

    const admin = createClient(supabaseUrl, serviceKey)

    // 2. Receipt images. Best-effort: the account data is already gone, and
    //    failing the whole deletion over leftover files would leave the user
    //    unable to complete a statutory request. Counted and logged instead.
    //
    //    Paged: one list() call returns at most PAGE_SIZE entries, so a user
    //    with more files than that used to keep the rest forever. Each pass
    //    lists, removes what it listed, and moves on. `skip` is the number of
    //    entries that are still there after a pass (failed removals, folder
    //    placeholders) so the next list starts after them and a stubborn
    //    object cannot make this loop forever. MAX_PASSES is a second backstop.
    //    Only counts are logged: no file names, no user ids.
    //    'receipts' is the only bucket the app writes per-user (0037).
    const PAGE_SIZE = 500
    const MAX_PASSES = 200
    let storageRemoved = 0
    let storageFailed = 0
    try {
      let skip = 0
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { data: files, error: listError } = await admin.storage
          .from('receipts')
          .list(userId, { limit: PAGE_SIZE, offset: skip })

        if (listError) {
          storageFailed += 1
          console.error('Receipt cleanup: list failed:', listError.message)
          break
        }
        if (!files || files.length === 0) break

        // Entries with a null id are folder placeholders, not objects.
        const objects = files.filter((f) => f.id !== null)
        const folders = files.length - objects.length

        if (objects.length > 0) {
          const paths = objects.map((f) => `${userId}/${f.name}`)
          const { error: removeError } = await admin.storage.from('receipts').remove(paths)
          if (removeError) {
            // Keep going: the next page may still be removable.
            storageFailed += objects.length
            skip += objects.length
            console.error('Receipt cleanup: batch remove failed:', removeError.message)
          } else {
            storageRemoved += objects.length
          }
        }
        skip += folders
      }
    } catch (storageError) {
      storageFailed += 1
      console.error('Receipt cleanup threw:', (storageError as Error).message)
    }
    console.log(`Receipt cleanup finished: removed=${storageRemoved} failed=${storageFailed}`)

    // 3. The login itself. After this the JWT the caller used is dead.
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
    if (deleteError) {
      console.error('auth.admin.deleteUser failed:', deleteError.message)
      // Data is already anonymised, so report partial success honestly
      // rather than implying nothing happened.
      return json({
        ok: false,
        code: 'auth_delete_failed',
        error: 'Your data was removed, but the login could not be deleted. Please contact support.',
      }, 500)
    }

    return json({ ok: true, storage_removed: storageRemoved, storage_failed: storageFailed })
  } catch (error) {
    console.error('delete-account error:', error)
    return json({ ok: false, code: 'error', error: (error as Error).message }, 500)
  }
})
