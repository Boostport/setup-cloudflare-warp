import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import { backOff } from "exponential-backoff";

async function install(version) {
  const gpgKeyPath = await tc.downloadTool(
    "https://pkg.cloudflareclient.com/pubkey.gpg"
  );
  await exec.exec(
    `/bin/bash -c "cat ${gpgKeyPath} | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg"`
  );
  await exec.exec(
    '/bin/bash -c "echo \\"deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main\\" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list"'
  );
  await exec.exec("sudo apt update");

  if (version === "") {
    await exec.exec("sudo apt install -y cloudflare-warp");
  } else {
    await exec.exec(`sudo apt install -y cloudflare-warp=${version}*`);
  }
}

async function installRootCertificate() {
  const rootCertificatePath = await tc.downloadTool(
    "https://developers.cloudflare.com/cloudflare-one/static/documentation/connections/Cloudflare_CA.pem"
  );

  await exec.exec(
    `sudo cp ${rootCertificatePath} /usr/local/share/ca-certificates/Cloudflare_CA.crt`
  );

  await exec.exec("sudo update-ca-certificates");
}

async function writeConfiguration(
  organization,
  auth_client_id,
  auth_client_secret
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
  await io.mkdirP("/var/lib/cloudflare-warp/");
  fs.writeFileSync("/tmp/mdm.xml", config);
  await exec.exec("sudo mv /tmp/mdm.xml /var/lib/cloudflare-warp/");
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
  if (process.platform !== "linux") {
    throw new Error(
      "Only Linux is supported. Pull requests for other platforms are welcome."
    );
  }

  try {
    const version = core.getInput("version", { required: false });
    const organization = core.getInput("organization", { required: true });
    const auth_client_id = core.getInput("auth_client_id", { required: true });
    const auth_client_secret = core.getInput("auth_client_secret", {
      required: true,
    });
    const install_root_certificate = core.getBooleanInput(
      "install_root_certificate",
      { required: false }
    );

    await install(version);

    if (install_root_certificate) {
      await installRootCertificate();
    }

    await writeConfiguration(organization, auth_client_id, auth_client_secret);
    await exec.exec("warp-cli", ["--accept-tos", "register"]);
    await exec.exec("warp-cli", ["--accept-tos", "connect"]);
    await backOff(() => checkWARPConnected());
  } catch (error) {
    core.error(error);
    throw error;
  }
}
