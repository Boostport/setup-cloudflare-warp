import * as core from "@actions/core";
import { cleanup, run } from "./lib/setup-cloudflare-warp";

(async () => {
  const isPost = !!core.getState("isPost");

  // Main
  if (!isPost) {
    try {
      await run();
    } catch (error) {
      core.setFailed(error.message);
    }
  }
  // Post
  else {
    try {
      await cleanup();
    } catch {
      // Silently ignore cleanup errors
    }
  }

  if (!isPost) {
    core.saveState("isPost", "true");
  }
})();
