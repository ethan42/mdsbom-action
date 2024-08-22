import { getInput, getBooleanInput, info, setFailed } from "@actions/core";
import { exec } from "@actions/exec";
import { downloadTool } from "@actions/tool-cache";

const mayhemUrl: string =
  getInput("mayhem-url") || "https://app.mayhem.security";

/**
 * Operating systems that an mdsbom CLI is available for, mapped to the URL path it can be
 * downloaded from on a recent Mayhem cluster.
 */
enum CliOsPath {
  Linux = "mdsbom/linux/latest/mdsbom.deb",
}

type Config = {
  mayhemToken: string;
  image: string;

  sarifOutput: string;

  command: string;
  failOnDefects: boolean;
  workspace: string;
};

function getConfig(): Config {

  return {
    mayhemToken: getInput("mayhem-token"),
    sarifOutput: getInput("sarif-output") || "",
    failOnDefects: getBooleanInput("fail-on-defects") || false,
    workspace: getInput("workspace").toLowerCase(),
    image: getInput("image") || "",
    command: getInput("command") || 'grype',
  };
}

/**
 * Downloads the mdsbom CLI from the given Mayhem cluster, marks it as executable, and returns the
 * path to the downloaded CLI.
 * @param url the base URL of the Mayhem cluster, such as "https://app.mayhem.security".
 * @param os the operating system to download the CLI for.
 * @return Path to the downloaded mdsbom CLI; resolves when the CLI download is complete.
 */
async function downloadCli(url: string, os: CliOsPath): Promise<string> {
  // Download the CLI and mark it as executable.
  const mdsbomPath = await downloadTool(`${url}/cli/${os}`);
  return mdsbomPath;
}

/** Mapping action arguments to CLI arguments and completing a run */
async function run(): Promise<void> {
  try {
    // Validate the action inputs and create a Config object from them.
    const config = getConfig();

    // Download the mdsbom deb for Linux.
    const deb = await downloadCli(mayhemUrl, CliOsPath.Linux);

    // const args: string[] = (getInput("args") || "").split(" ");

    // const argsString = args.join(" ");

    const script = `
    set -xe
    sudo dpkg -i ${deb}
    sudo usermod -aG mdsbom $USER

    echo '{
      "runtimes": {
        "mdsbom": {
          "path": "/usr/bin/mdsbom",
          "runtimeArgs": [
            "runc",
            "--",
            "runc"
          ]
        }
      },
      "default-runtime": "mdsbom"
    }' | sudo tee /etc/docker/daemon.json > /dev/null

    echo '[sync]
    api_token = "${config.mayhemToken}"
    upstream_url = "${mayhemUrl}"
    workspace = "${config.workspace}"
    ' | sudo tee -a /etc/mdsbom/config.toml

    curl -sSfL https://raw.githubusercontent.com/docker/scout-cli/main/install.sh | sh -s --

    sudo systemctl restart docker || sudo journalctl -xeu docker
    sudo systemctl restart mdsbom || sudo journalctl -xeu mdsbom

    mdsbom login ${mayhemUrl} ${config.mayhemToken}

    `

    // Start fuzzing
    const cliRunning = exec("bash", ["-c", script], {
      ignoreReturnCode: true,
    });
    const res = await cliRunning;
    if (res === 1) {
      throw new Error(`The Mayhem for Dynamic SBOM scan failed to run on your image.
      Check your configuration. For package visibility/permissions issues, see
      https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility
      on how to set your package to 'Public'.`);
    } else if (res === 2) {
      throw new Error(
        "The Mayhem for Dynamic SBOM scan detected the Mayhem run for your " +
          "target was unsuccessful.",
      );
    } else if (res === 3) {
      throw new Error("The Mayhem for Dynamic SBOM scan found defects in your target.");
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      info(`mdsbom action failed with: ${err.message}`);
      setFailed(err.message);
    }
  }
}

run();
