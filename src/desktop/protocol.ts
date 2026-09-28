/**
 * The contract between `DesktopSurface` and a platform helper.
 *
 * No Node binding exposes macOS `AXUIElement`, Windows UI Automation or AT-SPI2 well enough to
 * drive from TypeScript, so the platform half is a separate process — Swift, C#, Python,
 * whatever the platform prefers — speaking newline-delimited JSON over stdio. This file is the
 * whole of what that process must implement, and it is deliberately small: seven requests, each
 * one shaped so the helper reports *what it saw* and this side decides what it means.
 *
 * Two rules the helper must follow, because the guarantees above it depend on them:
 *
 * **Report matches, do not pick one.** `resolve` returns every node matching a query. Choosing
 * among several is the caller's job — replay requires exactly one visible match and refuses
 * ambiguity, and a helper that helpfully returned "the first one" would turn a refusal into a
 * wrong click.
 *
 * **Mutations address a handle, never a query.** `resolve` issues an opaque handle per match
 * and `click`/`fill` consume it. Re-sending the query would reopen the gap the uniqueness check
 * exists to close: the tree can change between the two requests, and the helper would then act
 * on whatever matches *now* — turning a refusal to guess into a wrong click by a different
 * route. A handle whose node is gone must be refused, not re-matched.
 *
 * **Mutations report where they left the session.** Every request that can change the screen
 * returns the resulting window, so the caller's idea of which application it is in is never
 * older than its last action. The landing check that keeps a run inside its allowlist reads
 * that value, and one action of staleness is one action executed in an unchecked application.
 *
 * **Report the tree as it is.** `observe` returns the accessibility tree with no filtering
 * beyond visibility. What a model is allowed to see is decided above, by the redactor.
 */

/** One node in the platform's accessibility tree. */
export interface AxNode {
  /**
   * Opaque identifier for this node, issued by `resolve` and consumed by `click` and `fill`.
   *
   * Opaque on purpose: a caller that could construct one would be sending a query by another
   * name. A helper invalidates handles whenever the tree changes, so a stale handle is an
   * error rather than a fresh match against a screen the caller has not checked.
   */
  handle?: string;
  /** Platform role, normalised to the web vocabulary: button, textbox, link, heading… */
  role: string;
  /** The accessible name — what a screen reader would announce. */
  name?: string;
  /** Current value, for controls that have one. */
  value?: string;
  /** False for nodes that exist but are off-screen, collapsed, or hidden. */
  visible?: boolean;
  /** True when the platform marks this as a secure text entry (macOS) or password field. */
  sensitive?: boolean;
  /** Screen coordinates, used only by discovery's coordinate escape hatch and for masking. */
  bounds?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
}

/** What the helper reports about where the session currently is. */
export interface DesktopWindow {
  /** Platform identity of the application: a macOS bundle id, a Windows process name. */
  application: string;
  /** Title of the focused window. Evidence only — never used for policy. */
  window: string;
}

/**
 * The requests a helper must serve.
 *
 * Keyed by method name so the transport stays a single `request(method, params)` call and
 * adding a capability is one entry here plus one branch in the helper.
 */
export interface DesktopRequests {
  /** Bring an application to the front, launching it if it is not running. */
  focus: { params: { application: string }; result: DesktopWindow };
  /** The current window, and its accessibility tree. */
  observe: { params: Record<string, never>; result: { window: DesktopWindow; tree: AxNode } };
  /**
   * Every node matching a query, each carrying a handle. See "report matches" above.
   *
   * `exact` mirrors the artifact's own locator semantics: a recorded name matches as a
   * substring by default and by equality when the candidate says so. A helper that always
   * compared exactly would silently narrow every locator ever recorded.
   */
  resolve: {
    params: { role?: string; name?: string; text?: string; exact?: boolean; visibleOnly: boolean };
    result: { matches: AxNode[] };
  };
  /** Click the node a handle names. Reports the window the click left the session in. */
  click: { params: { handle: string }; result: { window: DesktopWindow } };
  /** Set a control's value. The helper types it; it does not paste, so the app sees key events. */
  fill: { params: { handle: string; value: string }; result: { window: DesktopWindow } };
  /** Click raw screen coordinates and report what was under the cursor. */
  clickAt: { params: { x: number; y: number }; result: { hit?: AxNode; window: DesktopWindow } };
  /**
   * A PNG of the focused window, with the listed regions already painted over.
   *
   * Masking is done by the helper, before the bytes exist, because a rendered pixel cannot be
   * redacted afterwards — the same reason the browser surface masks at capture time.
   */
  screenshot: { params: { maskRoles: readonly string[] }; result: { pngBase64: string } };
}

export type DesktopMethod = keyof DesktopRequests;

/** A request as it goes over the wire. */
export interface DesktopRequest<M extends DesktopMethod = DesktopMethod> {
  id: number;
  method: M;
  params: DesktopRequests[M]["params"];
}

/**
 * A response as it comes back. Exactly one of `result` or `error` is present.
 *
 * Errors are values rather than a dropped connection: a control that was not found is an
 * ordinary outcome this system knows how to report, and it must not look like a crashed helper.
 */
export interface DesktopResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

/**
 * How `DesktopSurface` talks to a helper.
 *
 * An interface rather than a concrete child process, for the same reason `Surface` is one: the
 * tests drive a helper written in Node against a canned application, and the production path
 * spawns a platform binary. Neither knows about the other.
 */
export interface DesktopTransport {
  request<M extends DesktopMethod>(
    method: M,
    params: DesktopRequests[M]["params"],
  ): Promise<DesktopRequests[M]["result"]>;
  close(): Promise<void>;
}
