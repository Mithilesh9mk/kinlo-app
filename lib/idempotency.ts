/**
 * Idempotency keys for money-writing screens.
 *
 * Every screen that creates a transaction mints one key when it mounts and
 * reuses it for every submit attempt, so a double-tap or a retry after a
 * dropped connection targets the *same* row instead of creating a second
 * expense. The key doubles as `transactions.id`, which means the primary key
 * constraint is what actually enforces idempotency server-side — there is no
 * separate dedupe column to keep in sync.
 *
 * Because of that, writes must use `upsert`, not `insert`: a retry after a
 * partially-failed attempt should overwrite the half-written row rather than
 * fail on a duplicate primary key and strand the user.
 *
 * After a successful save the key must be *rotated* (see `newTransactionId`
 * callers). The screen stays mounted behind the success route, so without
 * rotation a second submit would silently overwrite the transaction that was
 * just written.
 *
 * Randomness: this is a v4-shaped UUID from Math.random(), not a CSPRNG.
 * That is deliberate — the key needs to be unique, not unguessable, and
 * uniqueness is backstopped by the primary key. Pulling in `expo-crypto` (a
 * native module, currently not a dependency) to harden a value that is never
 * used as a secret would not buy anything.
 */
export const newTransactionId = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
