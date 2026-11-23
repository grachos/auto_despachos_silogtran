// Step timings for slow-turn diagnosis: logs only the step label and milliseconds (never any data). Failures are timed too.
export async function timed(label, fn) {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[perf] ${label} ${Date.now() - t}ms`);
  }
}
