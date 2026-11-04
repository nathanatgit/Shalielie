// Secure transport is a prerequisite: a service worker cannot repair LAN HTTP.
export const ISOLATION_BUILD = "0.6.0-web";

export function waitForController(container, scriptURL, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (container.controller?.scriptURL === scriptURL) finish();
    };
    const finish = (error) => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", check);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("Updated service worker did not take control")), timeout);
    container.addEventListener("controllerchange", check);
    check();
  });
}

export async function prepareIsolation(env = globalThis) {
  if (env.isSecureContext === false || !env.navigator?.serviceWorker) return;
  const container = env.navigator.serviceWorker;
  const scriptURL = new URL(`./sw.js?v=${ISOLATION_BUILD}`, env.location.href).href;
  try {
    await container.register(scriptURL, { scope: "./", updateViaCache: "none" });
    // ready can resolve to the previous active worker. Wait for this build's controller.
    await waitForController(container, scriptURL);
    if (env.crossOriginIsolated) return;
    const response = await env.fetch(env.location.href, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const ready = response.headers.get("Cross-Origin-Opener-Policy") === "same-origin"
      && response.headers.get("Cross-Origin-Embedder-Policy") === "require-corp";
    const key = `pwa-isolation-reloaded-${ISOLATION_BUILD}`;
    if (ready && !env.sessionStorage.getItem(key)) {
      env.sessionStorage.setItem(key, "1");
      env.location.reload();
    }
  } catch (error) {
    console.warn("Service worker setup unavailable:", error);
  }
}
