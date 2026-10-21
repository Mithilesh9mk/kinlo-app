// Switches for UI that exists in the code but is not backed by anything yet.
// Kept (not deleted) so a later stage can turn them on without rewriting them.
// Each one must stay false until the matching server/device work is real —
// a switch that looks live but does nothing is worse than no switch.

/**
 * Profile → Security Center: "SMS Backup Codes", "Biometric Unlock",
 * "Allow Search by Phone", "Circle Directory Visibility". None of them is read
 * by the server or the app today. (Owner decision 21 Oct: no biometric lock
 * for this app; the rest are parked for a later stage.)
 */
export const SHOW_UNBUILT_SETTINGS = false;
