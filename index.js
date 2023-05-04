import * as core from "@actions/core";
import { cleanup, run } from "./lib/setup-cloudflare-warp";

(async () => {
  const isPost = !!core.getState("isPost");

  try {
    // Main
    if (!isPost) {
      await run();
      core.saveState("isPost", "true");
    }
    // Post
    else {
      await cleanup();
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();
