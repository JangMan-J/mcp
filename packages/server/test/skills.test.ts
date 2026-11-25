import { describe, expect, it } from "vitest";
import { McpClient } from "@mcp/core";
import { SkillsClient } from "@mcp/ext-skills";
import { InMemoryTransport } from "@mcp/testing";
import { McpServer } from "../src/server.js";

const SKILL_MD = `---
name: greeter
description: Greet people politely
allowed-tools: echo
---

Say hello warmly.
`;

function skillServer(): McpServer {
	const server = new McpServer({ serverInfo: { name: "skills", version: "1" } });
	server.registerSkill({
		uri: "mcp://skills/greeter",
		name: "greeter",
		description: "Greet people politely",
		allowedTools: ["echo"],
		files: [
			{ uri: "mcp://skills/greeter/SKILL.md", text: SKILL_MD, mimeType: "text/markdown" },
			{ uri: "mcp://skills/greeter/examples.txt", text: "hello world", mimeType: "text/plain" },
		],
	});
	return server;
}

describe("SkillsRegistry <-> SkillsClient", () => {
	it("lists, gets, and reads verified skill files", async () => {
		const server = skillServer();
		const client = new McpClient({
			transport: new InMemoryTransport((msg) => server.handleRequest(msg)),
			server: { key: "skills" },
		});
		const skills = new SkillsClient({
			client,
			capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
		});
		const listed = await skills.listAll();
		expect(listed.kind).toBe("ok");
		if (listed.kind === "ok") {
			expect(listed.value.skills.map((s) => s.name)).toEqual(["greeter"]);
			expect(listed.value.skills[0]?.files).toHaveLength(2);
		}
		const got = await skills.get("mcp://skills/greeter");
		expect(got.kind).toBe("ok");
		const md = await skills.readFile("mcp://skills/greeter", "mcp://skills/greeter/SKILL.md");
		expect(md.kind).toBe("ok");
		if (md.kind === "ok") expect(md.value.text).toContain("Say hello warmly.");
		const example = await skills.readFile("mcp://skills/greeter", "mcp://skills/greeter/examples.txt");
		expect(example.kind).toBe("ok");
		await client.close();
	});
});
