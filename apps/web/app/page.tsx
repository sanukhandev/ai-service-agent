import { CustomerChat } from "../components/customer-chat";

/** Public agent alias only; Node resolves the actual published agent and session. */
const agentKey = process.env.NEXT_PUBLIC_AGENT_KEY || "ancfz";

export default function HomePage() {
  return <CustomerChat agentKey={agentKey} />;
}
