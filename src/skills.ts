import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import type { Skill } from "./types.js";

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns { frontmatter, content } where frontmatter is a Record and content is the markdown body.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, any>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const content = trimmed.slice(endIndex + 3).trim();

  // Simple YAML parser for flat key-value pairs (good enough for SKILL.md frontmatter)
  const frontmatter: Record<string, any> = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    // Parse booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;
    // Parse numbers
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);

    frontmatter[key] = value;
  }

  return { frontmatter, content };
}

/**
 * Load a single skill from a directory containing SKILL.md
 */
function loadSkillFromDir(dirPath: string): Skill | null {
  const skillFile = join(dirPath, "SKILL.md");
  if (!existsSync(skillFile)) return null;

  try {
    const raw = readFileSync(skillFile, "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);

    // Derive name from frontmatter or directory name
    const dirName = dirPath.split("/").pop() || "unknown";
    const name = frontmatter.name || dirName;

    // Description from frontmatter or first paragraph
    let description = frontmatter.description || "";
    if (!description) {
      const firstPara = content.split("\n\n")[0];
      description = firstPara?.replace(/^#+\s*/, "").slice(0, 200) || name;
    }

    // Parse allowed-tools (comma-separated string)
    let allowedTools: string[] | undefined;
    if (frontmatter["allowed-tools"]) {
      allowedTools = String(frontmatter["allowed-tools"])
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean);
    }

    return {
      name,
      description,
      content,
      disableModelInvocation: !!frontmatter["disable-model-invocation"],
      userInvocable: frontmatter["user-invocable"] !== false,
      allowedTools,
      filePath: skillFile,
      dirPath,
    };
  } catch (err) {
    console.error(`Failed to load skill from ${dirPath}:`, err);
    return null;
  }
}

/**
 * Discover and load all skills from a .claude/skills/ directory.
 * Each subdirectory that contains a SKILL.md becomes a skill.
 */
function loadSkillsFromSkillsDir(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];

  const skills: Skill[] = [];
  try {
    const entries = readdirSync(skillsDir);
    for (const entry of entries) {
      const dirPath = join(skillsDir, entry);
      try {
        if (statSync(dirPath).isDirectory()) {
          const skill = loadSkillFromDir(dirPath);
          if (skill) skills.push(skill);
        }
      } catch {
        // skip inaccessible entries
      }
    }
  } catch {
    // skip inaccessible dir
  }

  return skills;
}

/**
 * Also support legacy .claude/commands/ directory.
 * Each .md file in commands/ becomes a skill.
 */
function loadCommandsAsSkills(commandsDir: string): Skill[] {
  if (!existsSync(commandsDir)) return [];

  const skills: Skill[] = [];
  try {
    const entries = readdirSync(commandsDir).filter((e) => e.endsWith(".md"));
    for (const entry of entries) {
      const filePath = join(commandsDir, entry);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(raw);
        const name = frontmatter.name || entry.replace(/\.md$/, "");

        let description = frontmatter.description || "";
        if (!description) {
          const firstPara = content.split("\n\n")[0];
          description = firstPara?.replace(/^#+\s*/, "").slice(0, 200) || name;
        }

        skills.push({
          name,
          description,
          content,
          disableModelInvocation: !!frontmatter["disable-model-invocation"],
          userInvocable: frontmatter["user-invocable"] !== false,
          filePath,
          dirPath: commandsDir,
        });
      } catch {
        // skip bad file
      }
    }
  } catch {
    // skip inaccessible dir
  }

  return skills;
}

/**
 * Load all skills for a target directory.
 * Searches: <targetDir>/.claude/skills/ and <targetDir>/.claude/commands/
 * Skills with the same name: skills/ takes precedence over commands/
 */
export function loadSkills(targetDir: string): Skill[] {
  const skillsDir = join(targetDir, ".claude", "skills");
  const commandsDir = join(targetDir, ".claude", "commands");

  const skills = loadSkillsFromSkillsDir(skillsDir);
  const commands = loadCommandsAsSkills(commandsDir);

  // Deduplicate: skills take precedence over commands
  const skillNames = new Set(skills.map((s) => s.name));
  for (const cmd of commands) {
    if (!skillNames.has(cmd.name)) {
      skills.push(cmd);
    }
  }

  return skills;
}

/**
 * Build a summary of available skills for inclusion in system prompts.
 * Only includes skills that are NOT disabled for model invocation.
 */
export function buildSkillsSummary(skills: Skill[]): string {
  const modelSkills = skills.filter((s) => !s.disableModelInvocation);
  if (modelSkills.length === 0) return "";

  const lines: string[] = ["## Available Skills", ""];
  lines.push("The following skills are available. You can invoke them using the `skill` tool when they are relevant to your task.");
  lines.push("");

  for (const skill of modelSkills) {
    lines.push(`### ${skill.name}`);
    lines.push(skill.description);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get the full content of a skill by name.
 * Returns null if not found.
 */
export function getSkillContent(skills: Skill[], name: string): string | null {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  return skill.content;
}

/**
 * Build a brief description list for the planner.
 */
export function buildSkillsContextForPlanner(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "--- Available Skills (in .claude/skills/) ---",
    "The target project has the following Claude skills that workers can use:",
    "",
  ];

  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description}`);
  }

  lines.push("");
  lines.push("Workers will automatically have access to these skills and can invoke them when relevant.");

  return lines.join("\n");
}
