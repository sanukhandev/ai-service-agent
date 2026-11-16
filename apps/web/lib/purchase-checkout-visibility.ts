/** Customer-visible checkout entry point; authorization remains enforced by Node. */
export function canStartSandboxCheckout(
  quoteVerified:boolean,
  purchaseSupported:boolean,
  sandboxEnabled:boolean,
):boolean {
  return quoteVerified && purchaseSupported && sandboxEnabled;
}
