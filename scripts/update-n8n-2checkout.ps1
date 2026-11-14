#requires -Version 5.1
<#
.SYNOPSIS
  Safely review, back up or update exactly the three existing ANCFZ billing
  workflows in the current local n8n owner workspace.
.EXAMPLE
  .\scripts\update-n8n-2checkout.ps1
  .\scripts\update-n8n-2checkout.ps1 -BackupOnly
  .\scripts\update-n8n-2checkout.ps1 -Apply
.NOTES
  This NEVER changes the n8n encryption key, owner, credentials or data volume.
  Both upgraded workflows remain INACTIVE. The new rotated merchant token is
  entered separately in n8n's credential editor.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$BackupOnly
)

$ErrorActionPreference = 'Stop'
if ($Apply -and $BackupOnly) {
    throw 'Choose either -Apply or -BackupOnly, not both.'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$secureKey = $null
$bstr = [IntPtr]::Zero

function Invoke-CheckedNode {
    param([string[]]$Arguments)
    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ("Node command failed: " + ($Arguments -join ' '))
    }
}

Push-Location $repo
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 is required.' }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Compose is required.' }

    # Validate tracked workflow files without using real secrets or the network.
    Invoke-CheckedNode -Arguments @('scripts/check-ancfz-workflows.mjs')
    Invoke-CheckedNode -Arguments @('scripts/check-2checkout-upgrade.mjs')
    Invoke-CheckedNode -Arguments @('scripts/upgrade-n8n-2checkout.mjs', '--dry-run')

    & docker compose --profile workflows config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration is invalid.' }

    $secureKey = Read-Host 'Existing n8n owner API key (not merchant token)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:N8N_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    Write-Host 'Inspecting three existing inactive invoice/payment workflows...'
    Invoke-CheckedNode -Arguments @('scripts/upgrade-n8n-2checkout.mjs', '--inspect')

    if ($Apply) {
        $confirmation = Read-Host 'Type UPDATE 2CHECKOUT to back up and replace only the three inactive invoice/payment workflows'
        if ($confirmation -cne 'UPDATE 2CHECKOUT') {
            throw 'Update cancelled. No workflows changed.'
        }
        # The Node upgrader always writes private local JSON backups before its
        # snapshot-guarded API mutations. It refuses drift and credential changes.
        Invoke-CheckedNode -Arguments @('scripts/upgrade-n8n-2checkout.mjs', '--apply')
        Write-Host 'Verifying updated workflows (still inactive)...'
        Invoke-CheckedNode -Arguments @('scripts/upgrade-n8n-2checkout.mjs', '--inspect')
        Write-Host 'Invoice and payment definitions updated. Configure the rotated X-Avangate-Authentication credential in n8n before activation.'
    }
    elseif ($BackupOnly) {
        Invoke-CheckedNode -Arguments @('scripts/upgrade-n8n-2checkout.mjs', '--backup')
        Write-Host 'Backups saved; no n8n definitions were changed.'
    }
    else {
        Write-Host 'Inspection complete; nothing changed. Use -Apply to back up and update.'
    }
}
finally {
    Remove-Item Env:N8N_API_KEY -ErrorAction SilentlyContinue
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Pop-Location
}
