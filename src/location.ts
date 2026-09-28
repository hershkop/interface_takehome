/**
 * Where a session currently is, for surfaces whose locations are not URLs.
 *
 * A browser reports an http(s) URL and the origin allowlist polices it. A desktop session has
 * no such thing — it is in an application, in a window — so it reports a location in this
 * scheme instead:
 *
 *     app://com.apple.Calculator/Main%20Window
 *
 * Two properties are deliberate. It parses with `new URL()`, so everything that merely carries
 * a location around — evidence, run records, failure messages — needs no special case. And the
 * application is the *host*, which is the part an allowlist matches on, so containment does not
 * depend on parsing a window title that the application itself controls.
 */

export const DESKTOP_LOCATION_PROTOCOL = "app:";

/** Builds the location string a desktop surface reports from `currentUrl()`. */
export function desktopLocation(application: string, window?: string): string {
  const base = `app://${encodeURIComponent(application)}`;
  return window === undefined || window === "" ? base : `${base}/${encodeURIComponent(window)}`;
}

/**
 * The application a location names, or `undefined` if it does not name one.
 *
 * Returns `undefined` rather than throwing or guessing: a caller that cannot identify the
 * application must refuse the location, and a thrown error somewhere inside a policy check is
 * far too easy to catch and treat as "allowed".
 */
export function applicationOf(location: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== DESKTOP_LOCATION_PROTOCOL) return undefined;
  const host = decodeURIComponent(parsed.host);
  return host === "" ? undefined : host;
}

/** The window a location names, if it names one. Never used for policy — only for evidence. */
export function windowOf(location: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== DESKTOP_LOCATION_PROTOCOL) return undefined;
  const path = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return path === "" ? undefined : path;
}
