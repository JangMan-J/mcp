import { McpServer } from "../../../../dist/server/index.js";
import { StdioServerHost } from "../../../../dist/server-transport/index.js";

const server = new McpServer({ serverInfo: { name: "stdio-test", version: "1" } });
server.registerTool({
	name: "echo",
	inputSchema: { type: "object", properties: { message: { type: "string" } } },
	handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }),
});

await new StdioServerHost({ server }).listen();
