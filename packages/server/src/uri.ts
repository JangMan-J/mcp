/** RFC 6570 subset matcher for resource reads: {var} and {+var} expressions. */
export function matchUriTemplate(template: string, uri: string): Record<string, string> | undefined {
	const vars: string[] = [];
	let pattern = "";
	for (let i = 0; i < template.length; i++) {
		const ch = template[i];
		if (ch === "{") {
			const end = template.indexOf("}", i);
			if (end < 0) return undefined;
			const expr = template.slice(i + 1, end);
			if (/^[+]?[A-Za-z_][A-Za-z0-9_]*$/u.test(expr) === false) return undefined;
			const plus = expr.startsWith("+");
			vars.push(plus ? expr.slice(1) : expr);
			pattern += plus ? "(.+)" : "([^/]+)";
			i = end;
		} else {
			pattern += (ch as string).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		}
	}
	const match = new RegExp(`^${pattern}$`, "u").exec(uri);
	if (!match) return undefined;
	return Object.fromEntries(vars.map((name, i) => [name, decodeURIComponent(match[i + 1] as string)]));
}
