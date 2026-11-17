#requires -Version 5.1
<#
.SYNOPSIS
  Authenticated, read-only GET against an EXISTING MockGateway RefNo.
  This never creates a payment, verifies an OTP, or issues an invoice.
.EXAMPLE
  .\scripts\check-mockgateway-order-readonly.ps1 -OrderReference 'existing-provider-refno' -ExpectedExternalReference 'ANCFZ-...' -ExpectedAmount '20700.00'
.NOTES
  Rotate any previously disclosed merchant secret before using this script.
  Do not share the secret, raw headers, or a full HTTP response dump.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,120}$')]
    [string]$OrderReference,

    [Parameter(Mandatory=$true)]
    [ValidatePattern('^ANCFZ-[A-Za-z0-9_-]{8,160}$')]
    [string]$ExpectedExternalReference,

    [Parameter(Mandatory=$true)]
    [ValidatePattern('^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$')]
    [string]$ExpectedAmount
)
$ErrorActionPreference = 'Stop'
$credential=$null
$merchantKey=$null
$bstr=[IntPtr]::Zero
try {
    $credential=Read-Host 'Rotated MockGateway merchant secret (not n8n key)' -AsSecureString
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential)
    $merchantKey=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $url='https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/'+[uri]::EscapeDataString($OrderReference)+'/'
    $order=Invoke-RestMethod -Method GET -Uri $url -Headers @{
        'X-Avangate-Authentication'=$merchantKey
    } -ErrorAction Stop
    $reference=[string]$order.RefNo
    $external=[string]$order.ExternalReference
    $amount=[string]$order.GrossPrice
    $currency=[string]$order.Currency
    $status=[string]$order.Status
    $matched=($reference -ceq $OrderReference -and
        $external -ceq $ExpectedExternalReference -and
        $amount -ceq $ExpectedAmount -and $currency -ceq 'AED' -and
        $status -cin @('PENDING','COMPLETE','DECLINED','REFUNDED'))
    [PSCustomObject]@{
        OrderReferenceRequested=$OrderReference
        OrderReferenceReturned=$reference
        ExternalReferenceMatches=($external -ceq $ExpectedExternalReference)
        AmountMatches=($amount -ceq $ExpectedAmount)
        CurrencyMatches=($currency -ceq 'AED')
        ProviderStatus=$status
        VerifiedOrderIdentity=$matched
        PaymentCompletedByThisCheck=$false
    }
    if(-not $matched) {
        throw 'Provider GET returned mismatched order identity, amount, currency or status. No application payment was updated.'
    }
}
catch {
    $code=$null
    try { $code=[int]$_.Exception.Response.StatusCode } catch {}
    if($code -eq 401) { throw '401: MockGateway rejected the merchant credential. Update its authentication settings and the n8n Header Auth credential.' }
    if($code -eq 404) { throw '404: Gateway could not locate the EXISTING RefNo; never create a new order.' }
    throw
}
finally {
    if($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Remove-Variable merchantKey,credential,order -ErrorAction SilentlyContinue
}
