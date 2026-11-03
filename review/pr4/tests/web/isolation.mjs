import assert from "node:assert/strict";
import { prepareIsolation, waitForController, ISOLATION_BUILD } from "../../web/src/isolation.js";

// Documentation-only address for a simulated non-local HTTP origin.
const insecure = { isSecureContext: false, location: { origin: "http://192.0.2.10:8000" } };
await prepareIsolation(insecure); // LAN HTTP must neither register nor reload.

class Container extends EventTarget {
  controller = { scriptURL: "https://example.test/app/sw.js?v=old" };
  async register(url, options) {
    this.options = options;
    this.registrationURL = url;
    // Simulate ready already resolved to an old worker, then a delayed new controller.
    setTimeout(() => {
      this.controller = { scriptURL: url };
      this.dispatchEvent(new Event("controllerchange"));
    }, 15);
    return {};
  }
}
const storage = new Map([["pwa-isolation-reloaded-old", "1"]]);
let reloads = 0, fetches = 0;
const env = {
  isSecureContext: true, crossOriginIsolated: false,
  navigator: { serviceWorker: new Container() },
  location: { href: "https://example.test/app/", reload: () => reloads++ },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  fetch: async () => {
    fetches++;
    assert.equal(env.navigator.serviceWorker.controller.scriptURL, `https://example.test/app/sw.js?v=${ISOLATION_BUILD}`);
    return { headers: new Headers({ "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }) };
  }
};
await prepareIsolation(env);
assert.equal(reloads, 1, "stale previous-build reload flag cannot prevent current-build isolation");
assert.equal(env.navigator.serviceWorker.options.updateViaCache, "none");
await prepareIsolation(env);
assert.equal(reloads, 1, "do not reload forever if the browser still refuses isolation");
storage.clear();
env.fetch = async () => ({ headers: new Headers() });
await prepareIsolation(env);
assert.equal(reloads, 1, "do not reload when isolation headers are missing");
env.crossOriginIsolated = true;
env.fetch = async () => { throw new Error("already isolated must not fetch"); };
await prepareIsolation(env);
await assert.rejects(waitForController(new Container(), "never", 10), /did not take control/);
assert.equal(fetches, 2);
console.log("LAN HTTP skip, old-controller upgrade, header verification and bounded reload passed");
