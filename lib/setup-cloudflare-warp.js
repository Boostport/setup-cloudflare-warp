import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import * as tc from "@actions/tool-cache";
import { isIPv4 } from "net";
import { backOff } from "exponential-backoff";

const backoffOptions = {
  numOfAttempts: 10,
  maxDelay: 4000,
};

function jsonToXml(config) {
  let xml = "";

  for (const [key, value] of Object.entries(config)) {
    // Skip null, undefined values and empty strings
    if (value === undefined || value === null || value === "") continue;

    if (typeof value === "boolean") {
      xml += `<key>${key}</key>\n<${value} />\n`;
    } else if (typeof value === "number") {
      xml += `<key>${key}</key>\n<integer>${value}</integer>\n`;
    } else if (typeof value === "string") {
      xml += `<key>${key}</key>\n<string>${value}</string>\n`;
    }
  }

  return xml;
}

async function checkWarpCliExists() {
  try {
    if (process.platform === "win32") {
      await exec.exec("where warp-cli");
    } else {
      await exec.exec("which warp-cli");
    }
    core.info("warp-cli already exists, skipping installation");
    return true;
  } catch {
    core.info("warp-cli not found, proceeding with installation");
    return false;
  }
}

/**
 * Install deb from downloads.cloudflareclient.com
 * Ref: https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/download-warp/#linux
*/
async function installLinuxDeb(version) {
  const archMap = {
    x64: "intel",
    arm64: "arm",
  }
  const distroCodeName = (await exec.getExecOutput("lsb_release", ["-c"])).stdout.split(":")[1].trim();
  const distroAndArch = `${distroCodeName}-${archMap[process.arch]}`;
  const url = `https://downloads.cloudflareclient.com/v1/download/${distroAndArch}/version/${version}`;
  core.info(`Downloading from url=${url}`);
  const debPath = await tc.downloadTool(url, "warp.deb");
  if (!debPath) {
    throw new Error(`Failed to download Cloudflare WARP version ${version}`);
  }

  // Disable man-page processing
  await exec.exec(`bash -c "echo 'set man-db/auto-update false' | sudo debconf-communicate"`);
  await exec.exec("sudo rm -f /var/lib/man-db/auto-update");

  await exec.exec("sudo apt-get update");
  await exec.exec(`sudo apt-get install -y --no-install-recommends ./${debPath}`);
}

async function installLinuxClient(version) {
  if (await checkWarpCliExists()) {
    return;
  }

  if (version !== "") {
    await installLinuxDeb(version);
    return;
  }

  const gpgKeyPath = await tc.downloadTool(
    "https://pkg.cloudflareclient.com/pubkey.gpg",
  );
  await exec.exec(
    `/bin/bash -c "cat ${gpgKeyPath} | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg"`,
  );
  await exec.exec(
    '/bin/bash -c "echo \\"deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main\\" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list"',
  );
  await exec.exec("sudo apt-get update");
  await exec.exec("sudo apt-get install -y cloudflare-warp");
}

async function installMacOSClient(version) {
  if (await checkWarpCliExists()) {
    return;
  }

  await exec.exec("brew update");
  if (version === "") {
    await exec.exec("brew install --cask cloudflare-warp");
  } else {
    await exec.exec(`brew install --cask cloudflare-warp@${version}`);
  }
}

async function installWindowsClient(version) {
  if (await checkWarpCliExists()) {
    return;
  }

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
    unique_client_id,
  };

  const xmlContent = jsonToXml(configObj);
  const config = `
  <dict>
    ${xmlContent}
  </dict>
  `;

  await exec.exec("sudo mkdir -p /var/lib/cloudflare-warp/");
  await fs.writeFile("/tmp/mdm.xml", config);
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
    auto_connect: 1,
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
  await fs.writeFile("/tmp/com.cloudflare.warp.plist", config);
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
    unique_client_id,
  };

  const xmlContent = jsonToXml(configObj);
  const config = `
  <dict>
    ${xmlContent}
  </dict>
  `;

  try {
    await fs.stat("C:\\ProgramData\\Cloudflare");
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.mkdir("C:\\ProgramData\\Cloudflare");
    }
  }
  await fs.writeFile("C:\\ProgramData\\Cloudflare\\mdm.xml", config);
}

function validateIPv4Cidr(cidr) {
  const parts = cidr.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [address, prefix] = parts;
  return (
    isIPv4(address) &&
    /^\d{1,2}$/.test(prefix) &&
    Number(prefix) >= 1 &&
    Number(prefix) <= 32
  );
}

// Parses semicolon-separated "<base-cidr>,<subnet-size>" pools (e.g. "192.168.204.0/22,24") into [{ base, size }], or returns null if invalid
function parseDockerAddressPools(input) {
  const pools = [];
  for (const pool of input.split(";")) {
    const parts = pool.split(",");
    if (parts.length !== 2) {
      return null;
    }
    const base = parts[0].trim();
    const size = Number(parts[1].trim());
    if (!validateIPv4Cidr(base) || !Number.isInteger(size)) {
      return null;
    }
    const basePrefix = Number(base.split("/")[1]);
    if (size < basePrefix || size > 32) {
      return null;
    }
    pools.push({ base, size });
  }
  return pools;
}

async function configureLinuxDockerDNS(docker_bip, dockerAddressPools) {
  // Set up resolved DNS stub listener on alternative IP as docker does not support DNS servers on 127.x.x.x
  // The listener IP is the default docker bridge gateway, which is derived from the bip when one is set
  const dnsIP = docker_bip === "" ? "172.17.0.1" : docker_bip.split("/")[0];
  let daemonConfig = {};
  try {
    daemonConfig = JSON.parse(
      await fs.readFile("/etc/docker/daemon.json", "utf8"),
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  if (docker_bip !== "") {
    daemonConfig.bip = docker_bip;
  }
  if (dockerAddressPools) {
    daemonConfig["default-address-pools"] = dockerAddressPools;
  }
  daemonConfig.dns = [dnsIP];
  await fs.writeFile("/tmp/daemon.json", JSON.stringify(daemonConfig, null, 2));
  await exec.exec("sudo mv /tmp/daemon.json /etc/docker/daemon.json");
  await exec.exec(
    `/bin/bash -c "echo "DNSStubListenerExtra=${dnsIP}" | sudo tee -a /etc/systemd/resolved.conf"`,
  );
  // Restart docker first so the bridge IP exists before resolved binds the stub listener to it
  await exec.exec("sudo systemctl restart docker");
  await exec.exec("sudo systemctl restart systemd-resolved");
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
    required: false,
  });
  const configure_docker_dns = core.getBooleanInput("configure_docker_dns", {
    required: false,
  });
  const docker_bip = core.getInput("docker_bip", { required: false });
  const docker_default_address_pools = core.getInput(
    "docker_default_address_pools",
    { required: false },
  );
  const vnet = core.getInput("vnet", { required: false });

  if (docker_bip !== "" && !validateIPv4Cidr(docker_bip)) {
    throw new Error(
      `docker_bip must be an IPv4 address in CIDR notation (e.g. 192.168.200.1/24), got: ${docker_bip}`,
    );
  }

  let dockerAddressPools = null;
  if (docker_default_address_pools !== "") {
    dockerAddressPools = parseDockerAddressPools(docker_default_address_pools);
    if (!dockerAddressPools) {
      throw new Error(
        `docker_default_address_pools must be one or more "<base-cidr>,<subnet-size>" pools separated by semicolons (e.g. 192.168.204.0/22,24), got: ${docker_default_address_pools}`,
      );
    }
  }

  switch (process.platform) {
    case "linux":
      if (configure_docker_dns) {
        await configureLinuxDockerDNS(docker_bip, dockerAddressPools);
      } else if (docker_bip !== "" || dockerAddressPools) {
        core.warning(
          "docker_bip and docker_default_address_pools have no effect because configure_docker_dns is not enabled",
        );
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
  await exec.exec("warp-cli", ["--accept-tos", "disconnect"]);
  switch (process.platform) {
    case "linux":
      await exec.exec("sudo warp-cli", [
        "--accept-tos",
        "registration",
        "delete",
      ]);
      await exec.exec("sudo rm /var/lib/cloudflare-warp/mdm.xml");
      break;
    case "darwin":
      await exec.exec("sudo warp-cli", [
        "--accept-tos",
        "registration",
        "delete",
      ]);
      await exec.exec(
        'sudo rm "/Library/Managed Preferences/com.cloudflare.warp.plist"',
      );
      break;
    case "win32":
      await exec.exec("warp-cli", ["--accept-tos", "registration", "delete"]);
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
