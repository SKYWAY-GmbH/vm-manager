import { describe, expect, it } from "vitest";
import { normalizeKubernetesErrorMessage } from "./errors";

describe("normalizeKubernetesErrorMessage", () => {
  it("extracts Kubernetes Status messages from client errors", () => {
    const message =
      'HTTP-Code: 400 Message: Unknown API Status Code! Body: "{\\"kind\\":\\"Status\\",\\"apiVersion\\":\\"v1\\",\\"metadata\\":{},\\"status\\":\\"Failure\\",\\"message\\":\\"admission webhook \\\\\\"virtualmachinesnapshot-validator.snapshot.kubevirt.io\\\\\\" denied the request: snapshot feature gate not enabled\\",\\"code\\":400}\\n" Headers: {"content-type":"application/json"}';

    expect(normalizeKubernetesErrorMessage(message)).toBe(
      "KubeVirt snapshot support is disabled in this cluster. Enable the Snapshot feature gate in the KubeVirt CR, then try again.",
    );
  });

  it("keeps regular messages unchanged", () => {
    expect(normalizeKubernetesErrorMessage("Virtual machine windows/vm-01 was not found.")).toBe(
      "Virtual machine windows/vm-01 was not found.",
    );
  });
});
