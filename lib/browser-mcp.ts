import { randomUUID } from "node:crypto";
import { fingerprint } from "./mcp-approvals.ts";
import { localPodman } from "./podman-connection.ts";
import { runProcess } from "./process.ts";
import { RpcProcess } from "./rpc-process.ts";

export interface BrowserProfile { image: string; localhostPorts?: number[] }
interface BrowserServer { command: string; args: string[]; env?: Record<string, string>; network?: boolean; browser?: BrowserProfile }

export function validateBrowserServer(server: BrowserServer) {
  const profile = server.browser;
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some(key => !["image", "localhostPorts"].includes(key)) ||
      typeof profile.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(profile.image)) throw new Error("Browser MCP requires an exact local image ID: browser: { image: 'sha256:...' }");
  if (profile.localhostPorts !== undefined && (!Array.isArray(profile.localhostPorts) || profile.localhostPorts.length > 16 ||
      profile.localhostPorts.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) ||
      new Set(profile.localhostPorts).size !== profile.localhostPorts.length || profile.localhostPorts.length && server.network !== true)) {
    throw new Error("Browser localhostPorts requires network:true and at most 16 distinct ports from 1024 to 65535");
  }
  const expected = ["-y", "@playwright/mcp@0.0.83", "--isolated"];
  if (server.command !== "npx" || server.env && Object.keys(server.env).length ||
      JSON.stringify(server.args) !== JSON.stringify(expected) && JSON.stringify(server.args) !== JSON.stringify([...expected, "--headless"])) {
    throw new Error("Browser MCP supports only: npx -y @playwright/mcp@0.0.83 --isolated [--headless], without custom environment or launch flags");
  }
}

export function browserContainerArgs(image: string, name: string, network: boolean, localhostPorts: number[] = []) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^pi-mcp-browser-[a-f0-9-]{36}$/.test(name)) throw new Error("Invalid browser container identity");
  return ["create", "--interactive", "--init", "--pull=never", "--name", name, "--label", "io.pi-agent.browser-mcp=1",
    "--read-only", "--read-only-tmpfs=false", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
    "--shm-size=256m", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=512", "--memory=2g", "--cpus=2", `--network=${network ? "bridge" : "none"}`,
    "--http-proxy=false", "--unsetenv-all", "--env=HOME=/tmp", "--env=TMPDIR=/tmp",
    "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=LANG=C.UTF-8", "--env=PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "--workdir=/tmp", "--entrypoint=/usr/local/bin/node", image,
    "/opt/pi-browser/entrypoint.mjs", ...localhostPorts.map(String)];
}

class BrowserRpc extends RpcProcess {
  private readonly remove: () => Promise<void>;
  private closing?: Promise<void>;
  constructor(options: ConstructorParameters<typeof RpcProcess>[0], remove: () => Promise<void>) {
    super(options); this.remove = remove;
  }
  override shutdown(): Promise<void> {
    this.closing ??= this.closeBrowser();
    return this.closing;
  }
  private async closeBrowser() {
    try { await super.shutdown(); } finally { await this.remove(); }
  }
}

/** Host operations are limited to a fixed isolated container and its own cleanup. */
export async function prepareBrowserMcp(server: BrowserServer, cwd: string, agentDir: string, signal?: AbortSignal, execute = runProcess) {
  validateBrowserServer(server);
  if (process.env.PI_SUBAGENT_CHILD) throw new Error("Browser MCP requires the parent session; browser launch is not delegated");
  const image = server.browser!.image, network = server.network === true, ports = [...(server.browser!.localhostPorts ?? [])];
  const engine = await localPodman(cwd, agentDir, signal, execute);
  const options = { cwd, env: engine.env, timeoutMs: 15000, maxBytes: 65536 };
  const metadata = await execute(engine.executable.command, [...engine.prefix, "image", "inspect", "--format", '{{.Id}} {{index .Config.Labels "io.pi-agent.browser-mcp.version"}}', image], { ...options, signal });
  if (metadata.trim() !== `${image} 0.0.83` && metadata.trim() !== `${image.slice(7)} 0.0.83`) throw new Error("Browser image is missing or not the reviewed Playwright MCP 0.0.83 image; build containers/playwright/Containerfile first");
  return {
    identity: fingerprint([engine.identity, image, network, ports, "browser-container-v1"]),
    detail: `Playwright 0.0.83 / Chromium headless dans un conteneur Podman local jetable. Image ${image}. Aucun dossier, profil Chrome, secret ou socket hôte monté. Système en lecture seule, fichiers temporaires limités à 512 Mio. ${network ? "Réseau sortant complet du conteneur, y compris services locaux via host.containers.internal ; distinct de la liste réseau Codex." : "Réseau désactivé."} Relais localhost internes vers les ports hôte : ${ports.join(", ") || "aucun"}. Aucun port publié sur l'hôte. Les actions MCP gardent leurs propres autorisations. Arrêt et suppression du seul conteneur créé à la fermeture. Accord lié au projet, à l'image et à la connexion Podman ; révocation : /mcp permissions.`,
    verify: engine.verify,
    async start(authorized: () => void) {
      const name = `pi-mcp-browser-${randomUUID()}`;
      const remove = async () => {
        engine.verify();
        await execute(engine.executable.command, [...engine.prefix, "rm", "--force", "--ignore", name], options);
      };
      signal?.throwIfAborted(); authorized(); engine.verify();
      try {
        const id = (await execute(engine.executable.command, [...engine.prefix, ...browserContainerArgs(image, name, network, ports)], { ...options, signal })).trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid browser container ID");
        signal?.throwIfAborted(); authorized(); engine.verify();
        return new BrowserRpc({ command: engine.executable.command, args: [...engine.prefix, "start", "--attach", "--interactive", id], cwd, env: engine.env }, remove);
      } catch (error) { await remove(); throw error; }
    },
  };
}
