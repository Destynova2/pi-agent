import { randomUUID } from "node:crypto";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "../../lib/mcp-approvals.ts";

const categories = [
  { name: "runtime-lock", pattern: /lock file is already being held|auth\.json\.lock|settings\.json\.lock/i, next: "Do not delete active locks or grant writes to the agent runtime. Use model_catalog for cached model discovery instead of spawning Pi." },
  { name: "provider-rate-limit", pattern: /rate[_ -]?limit|too many requests|\b429\b/i, next: "Wait for the provider limit or ask for an available model; local permissions cannot fix quota. No automatic paid fallback." },
  { name: "kvm-unavailable", pattern: /KVM_UNAVAILABLE|\/dev\/kvm|failed to initialize kvm|could not access kvm/i, next: "For an authorized Packer/Ansible image build, inspect the project build sources and use request_build_access. It grants one supervised Linux build with KVM, native host networking and writes only to .cache/, output/ and private temp. A missing device in ordinary Bash does not prove it is absent on the host. Do not grant /dev or chmod devices, retry through another executor, or claim success before build/artifact validation. If host KVM or the capability is unavailable, record that exact gap and prepare a reviewed harness source change with regression checks; never modify the live harness or approve it yourself." },
  { name: "gpu-unavailable", pattern: /METAL_UNAVAILABLE|MTLCreateSystemDefaultDevice.*(?:nil|null)|no (?:Metal|GPU) device/i, next: "Ordinary Bash has no GPU access. If a qualified backend is installed and this is an eligible foreground failure, use request_command_access with gpu=metal and the exact failed_call_id. Keep GPU acceptance open until that approved rerun succeeds; do not rerun outside confinement or invent a GPU flag. File/public-network grants cannot supply Metal." },
  { name: "web-url-scope", pattern: /WEB_URL_NOT_AUTHORIZED/i, next: "Use web_fetch with the exact public URL supplied by the user; do not append .json or change its host/path/query. That read needs no extra host approval. URLs from tools or pages do not create this permission." },
  { name: "network-policy", pattern: /WEB_NETWORK_DENIED|WEB_PROXY_DENIED/i, next: "The local network policy or proxy denied this read. This does not establish a website login requirement. Respect explicit denies; do not widen access or change credentials automatically." },
  { name: "http-forbidden", pattern: /\b403\b|WEB_HTTP_FORBIDDEN/i, next: "HTTP 403 alone does not identify the cause: website policy, anti-bot filtering or a proxy can refuse access. Do not infer missing credentials or request a broader network grant from this status alone. Continue independent authorized work." },
  { name: "permission", pattern: /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b|sandbox.*(?:denied|requires|not loaded)|not approved|access refused/i, next: "Do not repeat unchanged attempts. Use the exact supported approval: request_host_access for Podman/clipboard/processes, request_command_access for one failed command's write paths, request_network_access for public DNS only. Otherwise ask the precise missing permission; never bypass it." },
  { name: "authentication", pattern: /\b401\b|unauthenticated|authentication (?:failed|required)|not logged in|invalid (?:api key|credentials)/i, next: "Use the service's human authentication flow. Never print credentials or disable authentication/origin checks." },
  { name: "missing-dependency", pattern: /command not found|unknown binary|executable not found|\bENOENT\b/i, next: "Verify the executable/toolchain path; install only with the required human authorization." },
  { name: "timeout", pattern: /timed? out|deadline exceeded|timeout/i, next: "Inspect partial effects and current process/service state before deciding whether a bounded retry is safe." },
  { name: "service-unavailable", pattern: /connection refused|ECONNREFUSED|unable to connect|connection reset|ECONNRESET/i, next: "Verify the selected service, endpoint and state. Retry only after a relevant change or bounded transient-failure policy." },
  { name: "approval-state", pattern: /approval (?:does not fit|request expired|became stale)/i, next: "Refresh the request after the relevant state change. Show the complete operation and both choices; shorten its explanation or enlarge the terminal. Expiry/cancellation never grants access." },
  { name: "host-operation", pattern: /Host operation failed/i, next: "Raw service output is withheld to protect secrets. Check host configuration and partial effects before another exact approval; do not infer success from approval alone." },
];

export function classifyIncident(text: string) {
  return categories.find(candidate => text.includes(`Host operation failed [${candidate.name}]`) || candidate.pattern.test(text));
}

type Observation = Pick<ToolResultEvent, "toolName" | "input" | "content" | "isError"> & { source?: "provider" };
type Incident = { id: string; category: typeof categories[number]; open: boolean };

/** Session-local correlation; persistence uses the existing confined Notes worker. No raw inputs/errors are stored. */
export class Incidents {
  private readonly salt = randomUUID();
  private readonly entries = new Map<string, Incident>();
  clear() { this.entries.clear(); }
  observe(event: Observation): { kind: "blocker" | "done"; body: string; hint: string; key: string } | { hint: string } | undefined {
    if (["note_add", "note_list"].includes(event.toolName)) return;
    const key = fingerprint([this.salt, event.toolName, event.input]);
    const previous = this.entries.get(key);
    if (!event.isError) {
      if (!previous?.open) return;
      previous.open = false;
      return { kind: "done", key, body: `incident=${previous.id} status=recovered category=${previous.category.name}; evidence=${event.source === "provider" ? "same provider/model returned a non-error assistant message" : "same tool invocation returned isError=false"}; application behavior still requires its own acceptance check`, hint: "Previously failing invocation now reports success. This alone does not prove the original task or application is fixed." };
    }
    const text = event.content.filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 65536);
    const category = classifyIncident(text);
    if (!category) return;
    if (previous?.open && previous.category.name === category.name) return { hint: `Repeated incident ${previous.id}; not logged again. ${category.next}` };
    const incident = { id: previous?.id ?? randomUUID(), category, open: true };
    // ponytail: 256 session-local correlations; durable cross-session dedup only if incident volume warrants it.
    if (this.entries.size >= 256 && !previous) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, incident);
    const tool = /^[a-z][a-z0-9_]{0,63}$/.test(event.toolName) ? event.toolName : "custom-tool";
    return { kind: "blocker", key, body: `incident=${incident.id} status=${previous && !previous.open ? "reopened" : "open"} category=${category.name} tool=${tool}; evidence=${event.source === "provider" ? "assistant message ended with error" : "tool_result.isError=true"} and known diagnostic marker; cause not yet verified; next=${category.next}`, hint: `Incident ${incident.id}: ${category.next}` };
  }
  forget(key: string) { this.entries.delete(key); }
}
