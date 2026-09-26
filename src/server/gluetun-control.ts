import { delay } from "../utilities";

/** Gluetun's HTTP control server listens here in every container. */
const CONTROL_PORT = 8000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Between stopping the tunnel and starting it again. */
const RESTART_PAUSE_MS = 3000;

/** A lane's control server: the host its proxy is on, gluetun's control port. */
export const gluetunControlURL = (proxy: string): string =>
  `http://${new URL(proxy).hostname}:${CONTROL_PORT}`;

const setVPNStatus = async (
  controlURL: string,
  apiKey: string,
  status: "stopped" | "running"
): Promise<void> => {
  const response = await fetch(`${controlURL}/v1/vpn/status`, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ status }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`gluetun answered ${response.status} to "${status}"`);
  }
};

/**
 * Reconnect a gluetun container's VPN. With `VPN_SERVICE_PROVIDER=protonvpn`
 * it picks a server at random among those its filters allow each time it
 * connects, so this moves the lane to another exit IP - with an allowance of
 * its own under LibGen's per-IP limit.
 */
export const restartGluetunVPN = async (controlURL: string, apiKey: string): Promise<void> => {
  await setVPNStatus(controlURL, apiKey, "stopped");
  await delay(RESTART_PAUSE_MS);
  await setVPNStatus(controlURL, apiKey, "running");
};
