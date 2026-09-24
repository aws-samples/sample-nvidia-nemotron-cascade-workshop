// Optional collector preload: keep this process below 25 Jev requests/minute.
// It affects only the exact evaluation endpoint, including retries. It does not
// coordinate with other processes or guarantee sufficient account/provider quota.
const originalFetch = globalThis.fetch;
let previousStart = 0;
let queue = Promise.resolve();
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://ai-gateway.vercel.sh/v1/evaluate") return originalFetch(input, init);
  const turn = queue.then(async () => {
    const delay = Math.max(0, previousStart + 2400 - performance.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    (init?.signal ?? (input instanceof Request ? input.signal : undefined))?.throwIfAborted();
    previousStart = performance.now();
  });
  queue = turn.catch(() => {});
  await turn;
  return originalFetch(input, init);
};
