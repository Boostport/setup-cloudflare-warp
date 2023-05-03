import * as core from "@actions/core";
import { cleanup, run } from "./lib/setup-cloudflare-warp";

export const IsPost = !!core.getState("isPost");

(async () => {
  try {
    // Main
    if (!IsPost) {
      await run();
    }
    // Post
    else {
      await cleanup();
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();
