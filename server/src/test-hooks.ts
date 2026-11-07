// Test-only routes (#216): POST /api/test/rating puts an account at a rating so CI can search from any league. It
// answers only when both hold: the Worker was started with TEST_HOOKS=1 (CI passes it to wrangler dev; no
// environment in wrangler.jsonc sets it), and the request is to localhost (wrangler dev on the runner). Anywhere
// else it doesn't exist (404). Pure, tested in tests/online-room.test.ts.

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether the test hooks answer this request. */
export function testHooksAllowed(env: { TEST_HOOKS?: string }, url: string): boolean {
  if (env.TEST_HOOKS !== '1') return false;
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
