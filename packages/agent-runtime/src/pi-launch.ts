export interface PiLaunchCommand {
  command: string;
  argsPrefix: string[];
}

/**
 * Windows npm installs bin shims as .cmd files, which Node cannot spawn without
 * a shell. The Guest runtime therefore resolves the Pi CLI JavaScript entry and
 * runs it with the current Node executable. Linux keeps the normal `pi` shim.
 */
export function resolvePiLaunch(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): PiLaunchCommand {
  const configuredBinary = env.AGENT_IN_BOX_PI_BINARY?.trim();
  const configuredScript = env.AGENT_IN_BOX_PI_SCRIPT?.trim();
  if (configuredScript) {
    return {
      command: configuredBinary || execPath,
      argsPrefix: [configuredScript],
    };
  }
  return {
    command: configuredBinary || "pi",
    argsPrefix: [],
  };
}

export function assertPiLaunchSupported(launch: PiLaunchCommand): void {
  if (!launch.command.trim()) {
    throw new Error("Pi launch command is empty");
  }
  if (launch.argsPrefix.some((value) => !value.trim())) {
    throw new Error("Pi launch argument prefix contains an empty value");
  }
}
