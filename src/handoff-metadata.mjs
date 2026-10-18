/**
 * Public handoff presentation metadata.
 *
 * Pure-data presentation helper: it only describes how a handoff should be
 * presented. It never grants permission, never inspects the environment and
 * never mutates its inputs.
 */

const KNOWN_EXECUTION_BACKENDS = new Set(['opencode', 'deepseek-harness']);

const SPLIT_REQUIRED_ACTION =
  'GPT must keep the critical core and route independent ordinary feature packages through GoFlow';

const DEFAULT_ACTION =
  'GPT should use existing GoFlow tools only for authorized bounded code tasks';

function isRouteObject(route) {
  return typeof route === 'object' && route !== null && !Array.isArray(route);
}

/**
 * Build the handoff presentation metadata.
 *
 * @param {unknown} status observed execution status value
 * @param {unknown} route observed routing metadata
 * @returns {{ executionBackend: string|null, splitRequired: boolean, nextAction: string }}
 */
export function handoffMetadata(status, route) {
  const executionBackend =
    typeof status === 'string' && KNOWN_EXECUTION_BACKENDS.has(status) ? status : null;

  const splitRequired = isRouteObject(route) && route.executor === 'gpt' && route.splitRequired === true;

  return {
    executionBackend,
    splitRequired,
    nextAction: splitRequired ? SPLIT_REQUIRED_ACTION : DEFAULT_ACTION,
  };
}
