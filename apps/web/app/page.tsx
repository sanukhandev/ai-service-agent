import { CustomerChat } from "../components/customer-chat";
import { PaymentReturn } from "../components/payment-return";

/** Public agent alias only; Node resolves the published agent and session. */
const agentKey = process.env.NEXT_PUBLIC_AGENT_KEY || "ancfz";

type HomeSearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * MockGateway's configured return URL is the web root (/?refno=...&order_status=...).
 * Route this browser navigation to a lightweight close page, never to the
 * customer-chat bootstrap. The query string is untrusted and is not payment
 * verification, a callback API, or a trigger for state changes.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: HomeSearchParams;
}) {
  const params = await searchParams;
  const isGatewayReturn =
    typeof params.refno === "string" &&
    typeof params.order_status === "string";

  if (isGatewayReturn) return <PaymentReturn />;
  return <CustomerChat agentKey={agentKey} />;
}
