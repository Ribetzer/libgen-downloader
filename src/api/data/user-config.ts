import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface UserConfig {
  outputDirectory?: string;
}

export const getUserConfigPath = (): string => {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "libgen-downloader", "config.json");
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "libgen-downloader", "config.json");
};

/**
 * A missing or malformed config must never stop a download, so every failure
 * here degrades to "no saved settings".
 */
export const readUserConfig = async (): Promise<UserConfig> => {
  try {
    const contents = await fs.promises.readFile(getUserConfigPath(), "utf8");
    const parsed = JSON.parse(contents) as UserConfig;

    if (typeof parsed?.outputDirectory === "string" && parsed.outputDirectory.length > 0) {
      return { outputDirectory: parsed.outputDirectory };
    }

    return {};
  } catch {
    return {};
  }
};

export const writeUserConfig = async (config: UserConfig): Promise<string> => {
  const configPath = getUserConfigPath();

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`);

  return configPath;
};

/**
 * Flag beats saved default beats the current directory.
 */
export const resolveOutputDirectory = async (flagValue?: string): Promise<string> => {
  if (flagValue) {
    return path.resolve(flagValue);
  }

  const { outputDirectory } = await readUserConfig();
  if (outputDirectory) {
    return path.resolve(outputDirectory);
  }

  return process.cwd();
};

export const ensureOutputDirectory = async (directory: string): Promise<void> => {
  await fs.promises.mkdir(directory, { recursive: true });
};
