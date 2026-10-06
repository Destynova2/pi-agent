import { PermissionAudit } from "../../lib/permission-audit.ts";

const [agent, cwd] = process.argv.slice(2);
for (let index = 0; index < 12; index++) {
  const audit = new PermissionAudit(agent, { cwd, hasUI: true }, { resource: "fixture", operation: "concurrent" });
  audit.prompted();
  audit.answered("allow");
  audit.finish("granted", "human", "once");
}
