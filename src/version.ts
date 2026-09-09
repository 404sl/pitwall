/** Kept in step with package.json, and a test asserts it - the compiled CLI ships without
 *  its manifest, so this cannot be read at runtime and drifts silently if nobody checks.
 *  Published 0.1.1 reported itself as 0.1.0 for exactly that reason. */
export const VERSION = "0.1.2";
