import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_SUBAGENT_LOG_DIR) {
  fs.mkdirSync(process.env.FAKE_SUBAGENT_LOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAKE_SUBAGENT_LOG_DIR, `${process.pid}.json`),
    JSON.stringify({ args, childArgs: process.env.AGENT_IN_BOX_SUBAGENT_CHILD_ARGS || "" }),
  );
}
const task = args.at(-1) || "";
if (task.includes("[hold]")) {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(
    `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `child result: ${task}` }],
        stopReason: "end",
      },
    })}\n`,
  );
}
