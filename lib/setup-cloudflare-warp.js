import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as tc from "@actions/tool-cache";
import { backOff } from "exponential-backoff";

async function installLinuxClient(version) {
  const gpgKeyPath = await tc.downloadTool(
    "https://pkg.cloudflareclient.com/pubkey.gpg",
  );
  await exec.exec(
    `/bin/bash -c "cat ${gpgKeyPath} | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg"`,
  );
  await exec.exec(
    '/bin/bash -c "echo \\"deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main\\" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list"',
  );
  await exec.exec("sudo apt update");

  if (version === "") {
    await exec.exec("sudo apt install -y cloudflare-warp");
  } else {
    await exec.exec(`sudo apt install -y cloudflare-warp=${version}*`);
  }
}

async function installMacOSClient(version) {
  if (version === "") {
    await exec.exec("brew install --cask cloudflare-warp");
  } else {
    await exec.exec(`brew install --cask cloudflare-warp@${version}`);
  }
}

async function writeLinuxConfiguration(
  organization,
  auth_client_id,
  auth_client_secret,
) {
  const config = `
<dict>
  <key>organization</key>
  <string>${organization}</string>
  <key>auth_client_id</key>
  <string>${auth_client_id}</string>
  <key>auth_client_secret</key>
  <string>${auth_client_secret}</string>
</dict>
  `;
  await exec.exec("sudo mkdir -p /var/lib/cloudflare-warp/");
  fs.writeFileSync("/tmp/mdm.xml", config);
  await exec.exec("sudo mv /tmp/mdm.xml /var/lib/cloudflare-warp/");
}

async function writeMacOSConfiguration(
  organization,
  auth_client_id,
  auth_client_secret,
) {
  const config = `
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
      <key>enable</key>
      <true />
      <key>organization</key>
      <string>${organization}</string>
      <key>auth_client_id</key>
      <string>${auth_client_id}</string>
      <key>auth_client_secret</key>
      <string>${auth_client_secret}</string>
      <key>service_mode</key>
      <string>warp</string>
      <key>auto_connect</key>
      <integer>1</integer>
    </dict>
    </plist>
  `;
  await exec.exec('sudo mkdir -p "/Library/Managed Preferences/"');
  fs.writeFileSync("/tmp/com.cloudflare.warp.plist", config);
  await exec.exec("plutil -convert binary1 /tmp/com.cloudflare.warp.plist");
  await exec.exec(
    'sudo mv /tmp/com.cloudflare.warp.plist "/Library/Managed Preferences/"',
  );
}

async function checkWARPRegistration(organization, is_registered) {
  let output = "";
  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
  };

  await exec.exec("warp-cli", ["--accept-tos", "settings"], options);

  const registered = output.includes(`Organization: ${organization}`);
  if (is_registered && !registered) {
    throw new Error("WARP is not registered");
  } else if (!is_registered && registered) {
    throw new Error("WARP is still registered");
  }
}

async function checkWARPConnected() {
  let output = "";
  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
  };

  await exec.exec("warp-cli", ["--accept-tos", "status"], options);

  if (!output.includes("Status update: Connected")) {
    throw new Error("WARP is not connected");
  }
}

export async function run() {
  if (!["linux", "darwin"].includes(process.platform)) {
    throw new Error(
      "Only Linux and macOS are supported. Pull requests for other platforms are welcome.",
    );
  }

  const version = core.getInput("version", { required: false });
  const organization = core.getInput("organization", { required: true });
  const auth_client_id = core.getInput("auth_client_id", { required: true });
  const auth_client_secret = core.getInput("auth_client_secret", {
    required: true,
  });

  switch (process.platform) {
    case "linux":
      await writeLinuxConfiguration(
        organization,
        auth_client_id,
        auth_client_secret,
      );
      await installLinuxClient(version);
      break;
    case "darwin":
      await writeMacOSConfiguration(
        organization,
        auth_client_id,
        auth_client_secret,
      );
      await installMacOSClient(version);
      break;
  }

  await backOff(() => checkWARPRegistration(organization, true), {
    numOfAttempts: 20,
  });
  await exec.exec("warp-cli", ["--accept-tos", "connect"]);
  await backOff(() => checkWARPConnected(), { numOfAttempts: 20 });
  core.saveState("connected", "true");
}

export async function cleanup() {
  switch (process.platform) {
    case "linux":
      await exec.exec("sudo rm /var/lib/cloudflare-warp/mdm.xml");
      break;
    case "darwin":
      await exec.exec(
        'sudo rm "/Library/Managed Preferences/com.cloudflare.warp.plist"',
      );
      break;
  }

  const connected = !!core.getState("connected");
  if (connected) {
    const organization = core.getInput("organization", { required: true });
    await backOff(() => checkWARPRegistration(organization, false));
  }
}
