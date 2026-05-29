import * as fs from "node:fs";
import * as path from "node:path";

type SkillHubSkill = {
	id: string;
	name: string;
	description?: string;
	capabilities?: string[];
	pricing?: string[];
	pricingLabel?: string;
	isInstalled?: boolean;
};

type InvokeResponse = {
	success?: boolean;
	output?: string;
	artifacts?: Array<{ name: string; type?: string; size?: number; url: string }>;
	message?: string;
	error?: string;
};

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

const textEncoder = new TextEncoder();

/** Read a single file or recursively collect all files under a directory (text only). */
function readLocalContext(filePaths: string[]): string {
	const MAX_BYTES = 80_000; // guard against huge payloads
	const parts: string[] = [];
	let totalBytes = 0;

	const addFile = (filePath: string) => {
		if (totalBytes >= MAX_BYTES) return;
		try {
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) {
				const entries = fs.readdirSync(filePath);
				for (const entry of entries) {
					if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
					addFile(path.join(filePath, entry));
				}
			} else if (stat.isFile()) {
				const content = fs.readFileSync(filePath, "utf8");
				const chunk = `\n<file path="${filePath}">\n${content}\n</file>`;
				parts.push(chunk);
				totalBytes += textEncoder.encode(chunk).byteLength;
			}
		} catch {
			parts.push(`\n<file path="${filePath}" error="unreadable" />`);
		}
	};

	for (const p of filePaths) addFile(p);

	if (totalBytes >= MAX_BYTES) {
		parts.push("\n<!-- [truncated: context size limit reached] -->");
	}

	return parts.join("");
}

type ExtensionAPI = {
	on(
		event: "before_agent_start",
		handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined,
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: Record<string, unknown>;
		execute: (toolCallId: string, params: Record<string, string>) => Promise<TextToolResult>;
	}): void;
};

const emptyParameters = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const invokeParameters = {
	type: "object",
	properties: {
		skillId: {
			type: "string",
			description: "Skill ID from list_skillhub_skills or skillhub_available_skills.",
		},
		prompt: {
			type: "string",
			description: "Task or question to send to the SkillHub skill.",
		},
		files: {
			type: "array",
			items: { type: "string" },
			description:
				"Optional list of absolute local file paths whose contents should be included as context. " +
				"Pi reads these files locally (before calling the cloud) and injects their contents into the prompt. " +
				"Use this whenever the skill needs to process local files — the cloud runtime cannot access your filesystem.",
		},
	},
	required: ["skillId", "prompt"],
	additionalProperties: false,
};

const API_BASE = (process.env.SKILLHUB_API_BASE ?? "http://localhost:3001/api").replace(/\/+$/, "");
const TOKEN = process.env.SKILLHUB_AGENT_TOKEN ?? "";
const USER_ID = process.env.SKILLHUB_USER_ID ?? "demo-user";

function getHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
	};
}

function userQuery(): string {
	if (TOKEN) return "";
	return USER_ID ? `?userId=${encodeURIComponent(USER_ID)}` : "";
}

function isAvailableSkill(skill: SkillHubSkill): boolean {
	return Boolean(skill.isInstalled || skill.pricing?.includes("free"));
}

function pickPublicSkill(skill: SkillHubSkill) {
	return {
		id: skill.id,
		name: skill.name,
		description: skill.description,
		capabilities: skill.capabilities ?? [],
		pricingLabel: skill.pricingLabel ?? "",
	};
}

async function fetchAvailableSkills(): Promise<SkillHubSkill[]> {
	const response = await fetch(`${API_BASE}/skills${userQuery()}`, { headers: getHeaders() });
	if (!response.ok) {
		throw new Error(`SkillHub list failed: HTTP ${response.status}`);
	}

	const skills = (await response.json()) as SkillHubSkill[];
	return skills.filter(isAvailableSkill);
}

function formatCatalog(skills: SkillHubSkill[]): string {
	return skills
		.map((skill) => {
			const publicSkill = pickPublicSkill(skill);
			const capabilityText = publicSkill.capabilities.length ? ` capabilities=${publicSkill.capabilities.join(", ")}` : "";
			const pricingText = publicSkill.pricingLabel ? ` pricing=${publicSkill.pricingLabel}` : "";
			return `- ${publicSkill.id}: ${publicSkill.name} - ${publicSkill.description ?? ""}${capabilityText}${pricingText}`;
		})
		.join("\n");
}

export default function skillhubExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		let skills: SkillHubSkill[] = [];
		try {
			skills = await fetchAvailableSkills();
		} catch {
			return;
		}

		if (skills.length === 0) return;

		const catalog = formatCatalog(skills);
		return {
			systemPrompt: `${event.systemPrompt}

<skillhub_available_skills>
${catalog}
</skillhub_available_skills>

When the user's task matches a SkillHub skill above, call invoke_skillhub_skill with the matching skillId and a focused prompt. Multiple SkillHub skills may be invoked in parallel when the task needs them. Never ask to read SkillHub SKILL.md, scripts, bundle paths, or runtime internals; they are private and unavailable. If a cloud invocation fails, report the SkillHub cloud error and stop; do not install dependencies locally or re-implement the closed-source Skill on the client machine.`,
		};
	});

	pi.registerTool({
		name: "list_skillhub_skills",
		label: "List SkillHub Skills",
		description:
			"List SkillHub skills available to the current user. Returns only public metadata: id, name, description, capabilities, and pricing label.",
		parameters: emptyParameters,
		execute: async () => {
			const skills = await fetchAvailableSkills();
			const publicSkills = skills.map(pickPublicSkill);
			return {
				content: [{ type: "text", text: JSON.stringify(publicSkills, null, 2) }],
				details: { count: publicSkills.length },
			};
		},
	});

	pi.registerTool({
		name: "invoke_skillhub_skill",
		label: "Invoke SkillHub Skill",
		description:
			"Invoke a SkillHub skill by ID with a prompt. The skill runs in SkillHub cloud runtime; source files and internals are never exposed. Each call may be billed by the platform.",
		parameters: invokeParameters,
		execute: async (_toolCallId, params) => {
			const paramsAny = params as Record<string, any>;
			// If local files were requested, read them here (pi runs locally and has fs access).
			// The cloud runtime is sandboxed and cannot read the user's filesystem.
			let fullPrompt = paramsAny.prompt;
			const filePaths = (paramsAny.files as string[] | undefined) ?? [];
			if (filePaths.length > 0) {
				const localContext = readLocalContext(filePaths);
				fullPrompt =
					`${paramsAny.prompt}\n\n` +
					`<local_context note="Files read by pi on the client before calling the cloud skill.">${localContext}\n</local_context>`;
			}

			const response = await fetch(`${API_BASE}/skills/${encodeURIComponent(params.skillId)}/invoke`, {
				method: "POST",
				headers: getHeaders(),
				body: JSON.stringify(
					TOKEN
						? { prompt: fullPrompt }
						: { userId: USER_ID, prompt: fullPrompt },
				),
			});
			const result = (await response.json()) as InvokeResponse;

			if (!response.ok || !result.success) {
				throw new Error(result.message || result.error || `SkillHub invoke failed: HTTP ${response.status}`);
			}

			const artifactText =
				result.artifacts && result.artifacts.length > 0
					? `\n\nArtifacts:\n${result.artifacts.map((artifact) => `- ${artifact.name}: ${artifact.url}`).join("\n")}`
					: "";

			return {
				content: [{ type: "text", text: `${result.output ?? ""}${artifactText}` }],
				details: { skillId: params.skillId, filesRead: filePaths.length, artifacts: result.artifacts ?? [] },
			};
		},
	});
}
