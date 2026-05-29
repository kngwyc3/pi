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
	message?: string;
	error?: string;
};

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

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

When the user's task matches a SkillHub skill above, call invoke_skillhub_skill with the matching skillId and a focused prompt. Multiple SkillHub skills may be invoked in parallel when the task needs them. Never ask to read SkillHub SKILL.md, scripts, bundle paths, or runtime internals; they are private and unavailable.`,
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
			const response = await fetch(`${API_BASE}/skills/${encodeURIComponent(params.skillId)}/invoke`, {
				method: "POST",
				headers: getHeaders(),
				body: JSON.stringify(TOKEN ? { prompt: params.prompt } : { userId: USER_ID, prompt: params.prompt }),
			});
			const result = (await response.json()) as InvokeResponse;

			if (!response.ok || !result.success) {
				throw new Error(result.message || result.error || `SkillHub invoke failed: HTTP ${response.status}`);
			}

			return {
				content: [{ type: "text", text: result.output ?? "" }],
				details: { skillId: params.skillId },
			};
		},
	});
}
