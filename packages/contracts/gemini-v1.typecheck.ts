import {
  GEMINI_ALLOWED_BUILTIN_TOOLS, AI_SESSION_IDLE_SECONDS,
  STRICT_GEMINI_KNOWLEDGE_POLICY, assertAllowedGeminiBuiltinTool,
} from "./gemini-v1.js";
import type {
  GeminiBuiltinToolName, GeminiKnowledgePolicy, ModelFunctionCall,
  KnowledgeStoreBinding, GroundingStatus, AiSessionState,
} from "./gemini-v1.js";

const allowed: GeminiBuiltinToolName = "file_search";
void allowed;
// @ts-expect-error Google Search cannot be an allowed builtin
const deniedSearch: GeminiBuiltinToolName = "google_search";
void deniedSearch;
// @ts-expect-error URL Context cannot be an allowed builtin
const deniedUrl: GeminiBuiltinToolName = "url_context";
void deniedUrl;
// @ts-expect-error Foundry cannot be a Gemini knowledge provider
const badProvider: KnowledgeStoreBinding["provider"] = "foundry";
void badProvider;
// @ts-expect-error Model cannot invoke an arbitrary workflow URL
const badFunction: ModelFunctionCall["name"] = "execute_n8n";
void badFunction;
// @ts-expect-error External web search must always be false
const badPolicy: GeminiKnowledgePolicy = { ...STRICT_GEMINI_KNOWLEDGE_POLICY, externalWebSearch: true };
void badPolicy;
const expectedIdle: 3600 = AI_SESSION_IDLE_SECONDS;
const expectedTools: readonly ["file_search"] = GEMINI_ALLOWED_BUILTIN_TOOLS;
const status: GroundingStatus = "insufficient_evidence";
const session: AiSessionState["status"] = "expired";
void [expectedIdle, expectedTools, status, session, assertAllowedGeminiBuiltinTool];
