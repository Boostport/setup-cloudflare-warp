import * as core from "@actions/core";
import { run } from "./lib/setup-cloudflare-warp";

(async () => {
  try {
    await run();
  } catch (error) {
    core.setFailed(error.message);
  }
})();
