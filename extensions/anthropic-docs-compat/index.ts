import { getDocsPath, getExamplesPath, getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDocsCompat } from "./compat.ts";

/** Local workaround using Pi's public asset helpers and structured prompt API. */
export default function (pi: ExtensionAPI) {
  registerDocsCompat(pi, {
    readme: getReadmePath(),
    docs: getDocsPath(),
    examples: getExamplesPath(),
  });
}
