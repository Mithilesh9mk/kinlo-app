/**
 * Deep-link interception for Expo Router.
 *
 * expo-sharing's Android share-target support does not hand the payload to JS
 * directly — when someone shares an image into Kinlo, the native side stashes
 * the payload and opens the app on `kinlo://expo-sharing` (see
 * `getShareIntentUri` in the package's ShareIntoUtils.kt, which builds
 * `"$scheme://expo-sharing"` from the `share_into_scheme` string resource its
 * config plugin writes). That host has no route of its own, so without any
 * redirect the share would land on a "route not found" screen.
 *
 * DELIBERATELY redirects to `/` here, NOT `/finance/share` — this used to
 * redirect straight to `/finance/share`, which caused a real bug: on cold
 * start, expo-router mounts THAT as the initial route via this function,
 * while app/_layout.tsx *separately* detects the same payload via
 * useIncomingShare() and pushes `/finance/share` again once it's ready. Both
 * fire, so two independent FinanceShareScreen instances mounted at once,
 * each with its own local "handled" ref, each independently
 * uploading/compressing/navigating the SAME shared image — a genuine race
 * (not a rendering glitch) where the second instance to finish could
 * router.replace() right over the first one's already-working screen,
 * landing on a blank/error state. Confirmed by re-tracing the whole
 * cold-start path after "still blank" kept recurring through several
 * image-processing fixes that couldn't have touched a routing-level bug.
 *
 * `/` is a safe, ordinary landing spot — it goes through the app's normal
 * auth/onboarding gating in app/_layout.tsx like any other cold start, and
 * that same file's useIncomingShare()-based effect (which does NOT depend on
 * URL parsing, and works for both cold start and resume) is left as the
 * SOLE mechanism that pushes to /finance/share, exactly once.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // Not every incoming path is a well-formed absolute URL (in-app links
    // arrive as bare paths like "/finance"), and this runs on cold start for
    // every deep link — a throw here would break launching the app from a
    // link entirely, so anything unrecognised passes straight through.
    // In `kinlo://expo-sharing`, "expo-sharing" is the URL *host*, not a
    // path segment — so the path component is empty and anything matching on
    // pathname alone silently misses it. A plain substring test catches
    // every shape the router might hand over; "expo-sharing" is distinctive
    // enough that a broad match cannot collide with a real route in this app.
    if (path.includes('expo-sharing')) {
      return '/';
    }
    return path;
  } catch {
    return path;
  }
}
