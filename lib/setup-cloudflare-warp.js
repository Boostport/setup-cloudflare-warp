import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as tc from "@actions/tool-cache";
import { backOff } from "exponential-backoff";

const backoffOptions = {
  numOfAttempts: 10,
  maxDelay: 4000,
};

function jsonToXml(config) {
  let xml = '';
  
  for (const [key, value] of Object.entries(config)) {
    // Skip null, undefined values and empty strings
    if (value === undefined || value === null || value === '') continue;    

    if (typeof value === 'boolean') {
      xml += `<key>${key}</key>\n<${value} />\n`;
    } else if (typeof value === 'number') {
      xml += `<key>${key}</key>\n<integer>${value}</integer>\n`;
    } else if (typeof value === 'string') {
      xml += `<key>${key}</key>\n<string>${value}</string>\n`;
    }
  }
  
  return xml;
}

async function installLinuxClient(version) {
  const gpgKeyPath = await tc.downloadTool(
    "https://pkg.cloudflareclient.com/pubkey.gpg",
  );
  await exec.exec(
    `/bin/bash -c "cat ${gpgKeyPath} | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg"`,
  );
  await exec.exec(
    '/bin/bash -c "echo \\"deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main\\" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list"',
  );
  await exec.exec("sudo apt update");

  if (version === "") {
    await exec.exec("sudo apt install -y cloudflare-warp");
  } else {
    await exec.exec(`sudo apt install -y cloudflare-warp=${version}*`);
  }
}

async function installMacOSClient(version) {
  await exec.exec("brew update");
  if (version === "") {
    await exec.exec("brew install --cask cloudflare-warp");
  } else {
    await exec.exec(`brew install --cask cloudflare-warp@${version}`);
  }
}

async function installWindowsClient(version) {
  if (version) {
    await exec.exec(`choco install -y warp --no-progress --version=${version}`);
  } else {
    await exec.exec("choco install -y --no-progress warp");
  }
  core.addPath("C:\\Program Files\\Cloudflare\\Cloudflare WARP\\");
}

async function writeLinuxConfiguration(
  organization,
  auth_client_id,
  auth_client_secret,
  unique_client_id,
) {
  const configObj = {
    organization,
    auth_client_id,
    auth_client_secret,
    unique_client_id
  };
  
  const xmlContent = jsonToXml(configObj);
  const config = `
  <dict>
    ${xmlContent}
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
  unique_client_id,
) {
  const configObj = {
    enable: true,
    organization,
    auth_client_id,
    auth_client_secret,
    unique_client_id,
    service_mode: "warp",
    auto_connect: 1
  };
  
  const xmlContent = jsonToXml(configObj);
  const config = `
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
    <dict>
      ${xmlContent}
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

async function writeWindowsConfiguration(
  organization,
  auth_client_id,
  auth_client_secret,
  unique_client_id,
) {
  const configObj = {
    organization,
    auth_client_id,
    auth_client_secret,
    unique_client_id
  };

  const xmlContent = jsonToXml(configObj);
  const config = `
  <dict>
    ${xmlContent}
  </dict>
  `;
  
  if (!fs.existsSync("C:\\ProgramData\\Cloudflare")) {
    fs.mkdirSync("C:\\ProgramData\\Cloudflare");
  }
  fs.writeFileSync("C:\\ProgramData\\Cloudflare\\mdm.xml", config);
}

async function configureLinuxDockerDNS() {
  // Set up resolved DNS stub listener on alternative IP as docker does not support DNS servers on 127.x.x.x
  await fs.stat("/etc/docker/daemon.json", function (err) {
    if (err.code === "ENOENT") {
      exec.exec(`/bin/bash -c "echo '{}' | sudo tee /etc/docker/daemon.json"`);
    }
  });
  await exec.exec(
    `/bin/bash -c "echo "DNSStubListenerExtra=172.17.0.1" | sudo tee -a /etc/systemd/resolved.conf"`,
  );
  await exec.exec(
    `/bin/bash -c "cat /etc/docker/daemon.json | jq '.dns=[\\"172.17.0.1\\"]' | sudo tee /etc/docker/daemon.json"`,
  );
  await exec.exec("sudo systemctl restart systemd-resolved");
  await exec.exec("sudo systemctl restart docker");
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

  // Retry connect on missing registration
  if (output.includes("Reason: Registration Missing")) {
    await exec.exec("warp-cli", ["--accept-tos", "connect"]);
    await exec.exec("warp-cli", ["--accept-tos", "status"], options);
  }

  if (!output.includes("Status update: Connected")) {
    throw new Error("WARP is not connected");
  }
}

export async function run() {
  if (!["linux", "darwin", "win32"].includes(process.platform)) {
    throw new Error(
      "Only Windows, Linux and macOS are supported. Pull requests for other platforms are welcome. (Platform is " +
        process.platform +
        ")",
    );
  }

  const version = core.getInput("version", { required: false });
  const organization = core.getInput("organization", { required: true });
  const auth_client_id = core.getInput("auth_client_id", { required: true });
  const auth_client_secret = core.getInput("auth_client_secret", {
    required: true,
  });
  const unique_client_id = core.getInput("unique_client_id", { 
    required: false 
  });
  const configure_docker_dns = core.getBooleanInput("configure_docker_dns", {
    required: false,
  });
  const vnet = core.getInput("vnet", { required: false });

  switch (process.platform) {
    case "linux":
      if (configure_docker_dns) {
        await configureLinuxDockerDNS();
      }
      await writeLinuxConfiguration(
        organization,
        auth_client_id,
        auth_client_secret,
        unique_client_id,
      );
      await installLinuxClient(version);
      break;
    case "darwin":
      await writeMacOSConfiguration(
        organization,
        auth_client_id,
        auth_client_secret,
        unique_client_id,
      );
      await installMacOSClient(version);
      break;
    case "win32":
      await writeWindowsConfiguration(
        organization,
        auth_client_id,
        auth_client_secret,
        unique_client_id,
      );
      await installWindowsClient(version);
      break;
  }

  await backOff(
    () => checkWARPRegistration(organization, true),
    backoffOptions,
  );
  await exec.exec("warp-cli", ["--accept-tos", "connect"]);
  await backOff(() => checkWARPConnected(), backoffOptions);
  core.saveState("connected", "true");
  if (vnet !== "") {
    await exec.exec("warp-cli", ["--accept-tos", "vnet", vnet]);
  }
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
    case "win32":
      await exec.exec("rm C:\\ProgramData\\Cloudflare\\mdm.xml");
      break;
  }

  const connected = !!core.getState("connected");
  if (connected) {
    const organization = core.getInput("organization", { required: true });
    await backOff(
      () => checkWARPRegistration(organization, false),
      backoffOptions,
    );
  }
}
