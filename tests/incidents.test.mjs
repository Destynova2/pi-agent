import assert from "node:assert/strict";
import { test } from "node:test";
import { Incidents } from "../extensions/notes/incidents.ts";

const failure = (command = "podman ps --token=secret-input", text = "operation not permitted: secret-output") => ({ toolName: "bash", input: { command }, isError: true, content: [{ type: "text", text }] });

test("incident notes contain category/evidence/state, never raw inputs, errors or credentials", () => {
  const incidents = new Incidents(), event = failure();
  const opened = incidents.observe(event);
  assert.equal(opened.kind, "blocker"); assert.match(opened.body, /status=open category=permission/);
  assert.match(opened.body, /cause not yet verified/); assert.doesNotMatch(JSON.stringify(opened), /secret-|podman ps/);
  const repeated = incidents.observe(event);
  assert.equal(repeated.body, undefined); assert.match(repeated.hint, /Repeated incident/);
  assert.equal(incidents.observe({ ...failure("different command"), isError: false }), undefined);
  const recovered = incidents.observe({ ...event, isError: false, content: [{ type: "text", text: "secret-success" }] });
  assert.equal(recovered.kind, "done"); assert.match(recovered.body, /status=recovered/);
  assert.match(recovered.body, /application behavior still requires/); assert.doesNotMatch(JSON.stringify(recovered), /secret-/);
  assert.equal(incidents.observe({ ...event, isError: false }), undefined);
  assert.match(incidents.observe(event).body, /status=reopened/);
});

test("successful diagnostic text, ordinary application failures and Notes operations do not create incidents", () => {
  const incidents = new Incidents();
  assert.equal(incidents.observe({ ...failure(), isError: false }), undefined);
  assert.equal(incidents.observe(failure("tests", "assert expected 1, got 2")), undefined);
  for (const toolName of ["note_add", "note_list"]) assert.equal(incidents.observe({ ...failure(), toolName }), undefined);
});

test("permission guidance names the Podman bridge and identifies expired command approvals", () => {
  const incidents = new Incidents();
  assert.match(incidents.observe(failure()).hint, /request_podman_access for the local Podman engine/);
  for (const text of ["Command approval expired after five minutes", "Command approval is stale, expired or belongs to another workspace", "Podman approval expired"]) {
    const incident = incidents.observe(failure(text, text));
    assert.match(incident.body, /category=approval-state/);
    assert.match(incident.hint, /failed_call_id cannot be reused/);
  }
});

test("Metal unavailability does not suggest filesystem grants or an unrestricted retry", () => {
  const incident = new Incidents().observe(failure("metal-probe", "METAL_UNAVAILABLE: operation not permitted"));
  assert.match(incident.body, /category=gpu-unavailable/);
  assert.match(incident.hint, /Keep GPU acceptance open/);
  assert.match(incident.hint, /do not rerun outside confinement/);
  assert.match(incident.hint, /qualified backend is installed/);
  assert.match(incident.hint, /request_command_access with gpu=metal/);
  assert.doesNotMatch(incident.hint, /current Codex backend has no qualified GPU/);
});

test("KVM failures in English and French suggest the dedicated build capability", () => {
  for (const text of ["ls: cannot access '/dev/kvm': No such file or directory", "ls: impossible d'accéder à '/dev/kvm': Aucun fichier ou dossier de ce nom", "Could not access KVM kernel module: Permission denied", "KVM_UNAVAILABLE on host: EACCES"]) {
    const incident = new Incidents().observe(failure("kvm check", text));
    assert.match(incident.body, /category=kvm-unavailable/);
    assert.match(incident.hint, /request_build_access/);
    assert.match(incident.hint, /does not prove it is absent on the host/);
    assert.match(incident.hint, /never modify the live harness/);
  }
});

test("HTTP 403 is not automatically authentication; exact-read and proxy errors retain their scope", () => {
  const incidents = new Incidents();
  for (const text of ["curl: (22) The requested URL returned error: 403", "WEB_HTTP_FORBIDDEN: HTTP 403"]) {
    const observed = incidents.observe(failure("web_fetch", text));
    assert.match(observed.hint, /does not identify the cause/);
    assert.doesNotMatch(observed.hint, /Use the service's human authentication flow/);
  }
  for (const [text, category] of [["WEB_PROXY_DENIED: proxy 403", "network-policy"], ["WEB_NETWORK_DENIED: destination explicitly denied", "network-policy"], ["WEB_URL_NOT_AUTHORIZED", "web-url-scope"], ["401 Unauthorized", "authentication"]]) {
    assert.match(incidents.observe(failure(text, text)).body, new RegExp(`category=${category}`));
  }
});

test("storage failure, session reset and changed diagnostic remain retryable without granting permissions", () => {
  const incidents = new Incidents(), event = failure();
  const first = incidents.observe(event); incidents.forget(first.key);
  assert.equal(incidents.observe(event).kind, "blocker"); incidents.clear();
  assert.equal(incidents.observe({ ...event, isError: false }), undefined);
  for (const [text, category] of [["429 rate_limit_error secret", "provider-rate-limit"], ["authentication required secret", "authentication"], ["Lock file is already being held secret", "runtime-lock"], ["Unknown binary rust-analyzer", "missing-dependency"], ["deadline exceeded", "timeout"], ["ECONNREFUSED", "service-unavailable"]]) {
    assert.match(incidents.observe(failure("same", text)).body, new RegExp(`category=${category}`));
  }
  assert.doesNotMatch(incidents.observe(failure("auth", "401 invalid credentials")).hint, /disable authentication[^/]/);
});
