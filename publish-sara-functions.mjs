
import fs from "node:fs";
import { AIProjectClient } from "@azure/ai-projects";
import { AzureCliCredential } from "@azure/identity";

const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const name = process.env.FOUNDRY_AGENT_NAME;
const version = process.env.FOUNDRY_AGENT_VERSION;

if (!endpoint || !name || !version) {
  throw new Error("Missing Foundry configuration");
}

const project = new AIProjectClient(
  endpoint,
  new AzureCliCredential()
);

// Read the existing, working Sara version.
const current = await project.agents.getVersion(name, version);

if (current.definition?.kind !== "prompt") {
  throw new Error("Expected an existing prompt agent");
}

const existingTools = current.definition.tools ?? [];

if (!existingTools.some(t => t.type !== "function")) {
  throw new Error(
    "No existing knowledge tool found. Review IQ configuration first."
  );
}

const manifest = JSON.parse(
  fs.readFileSync("/tmp/sara-functions.json", "utf8")
    .replace(/^\uFEFF/, "")
);


const functionTools = manifest.functionTools.map(tool => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  strict: false
}));

if (functionTools.length !== 5) {
  throw new Error("Expected exactly five Node functions");
}

const names = new Set(functionTools.map(t => t.name));


// Preserve IQ and every other existing tool.
const tools = [
  ...existingTools.filter(
    t => t.type !== "function" ||
      !names.has(t.function?.name ?? t.name)
  ),
  ...functionTools
];

console.log("Source agent version:", version);
console.log("Existing tools:", existingTools.map(t => t.type));
console.log("New functions:", [...names]);

if (process.env.PUBLISH_TOOLS !== "yes") {
  console.log("Preview only. No agent version created.");
  process.exit(0);
}

// Create a new version. Never overwrite version 5.
const created = await project.agents.createVersion(name, {
  ...current.definition,
  tools
});

console.log("Created agent version:", created.version);
