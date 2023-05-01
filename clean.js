import * as core from "@actions/core";
import { cleanup } from "./lib/setup-cloudflare-warp";

(async () => {
  try {
    await cleanup();
  } catch (error) {
    core.setFailed(error.message);
  }
})();
