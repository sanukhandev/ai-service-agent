"use client";

import { useEffect, useState } from "react";

/**
 * Cosmetic landing page for the gateway browser redirect only.
 * Query-string status, amount and reference are NOT payment evidence.
 * The original Sara chat independently verifies the existing gateway order.
 */
export function PaymentReturn() {
  const [closeAttempted, setCloseAttempted] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // Browsers may disallow closing manually opened tabs.
      }
      setCloseAttempted(true);
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-10">
      <section aria-labelledby="payment-return-title"
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div aria-hidden="true"
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-700">
          <svg width="26" height="26" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12h16m-6-6 6 6-6 6" />
          </svg>
        </div>
        <h1 id="payment-return-title" className="text-xl font-semibold text-zinc-900">
          Checkout window returned
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Please return to your Sara conversation. Your payment status is
          verified separately with the gateway; this return page does not
          confirm a successful payment.
        </p>
        {closeAttempted ? (
          <p role="status" className="mt-5 text-sm text-zinc-600">
            Your browser did not close this tab automatically.
            You can close it manually.
          </p>
        ) : (
          <p role="status" className="mt-5 text-sm font-medium text-zinc-700">
            This window will close automatically in 2 seconds…
          </p>
        )}
        <a href="/"
          className="mt-6 inline-flex rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900">
          Return to Sara
        </a>
      </section>
    </main>
  );
}
