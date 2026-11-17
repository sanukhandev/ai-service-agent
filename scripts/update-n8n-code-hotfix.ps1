#requires -Version 5.1
<#
.SYNOPSIS
  Apply reviewed Salesforce FirstName/LastName and MockGateway n8n URL-node hotfix.
  No Salesforce or MockGateway POSTs; no credential, owner, encryption key or volume changes.
.EXAMPLE
  .\scripts\update-n8n-code-hotfix.ps1
  .\scripts\update-n8n-code-hotfix.ps1 -BackupOnly
  .\scripts\update-n8n-code-hotfix.ps1 -Apply
.NOTES
  Before -Apply, UNPUBLISH the two existing n8n workflows (Salesforce Lead and
  2Checkout Mock Order Create). Do not re-run old failed outbox operations.
  This writes timestamped private backups and only updates reviewed node parameters.
  Both workflows remain unpublished for manual credential checks before republish.
#>
[CmdletBinding()]
param([switch]$Apply,[switch]$BackupOnly)
$ErrorActionPreference = 'Stop'
if($Apply -and $BackupOnly){ throw 'Use -Apply OR -BackupOnly.' }
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$key=$null
$bstr=[IntPtr]::Zero
function Invoke-CheckedNode {
    param([string[]]$Arguments)
    & node @Arguments
    if($LASTEXITCODE -ne 0){ throw ('Node operation failed: '+($Arguments -join ' ')) }
}
Push-Location $repo
try {
    if(-not (Get-Command node -ErrorAction SilentlyContinue)){ throw 'Node.js 22 required.' }
    if(-not (Get-Command docker -ErrorAction SilentlyContinue)){ throw 'Docker Compose required.' }
    Invoke-CheckedNode -Arguments @('scripts/apply-n8n-code-hotfix.mjs','--dry-run')
    Invoke-CheckedNode -Arguments @('scripts/check-ancfz-salesforce.mjs')
    Invoke-CheckedNode -Arguments @('scripts/check-ancfz-billing-workflows.mjs')

    $key=Read-Host 'EXISTING n8n owner API key (not a Salesforce or merchant token)' -AsSecureString
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
    $env:N8N_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    Invoke-CheckedNode -Arguments @('scripts/apply-n8n-code-hotfix.mjs','--inspect')
    if($Apply){
        $confirmation=Read-Host 'Unpublish both ANCFZ Salesforce Lead and 2Checkout Order Create, then type APPLY ANCFZ HOTFIX'
        if($confirmation -cne 'APPLY ANCFZ HOTFIX'){
            throw 'Cancelled. No workflow changes made.'
        }
        Invoke-CheckedNode -Arguments @('scripts/apply-n8n-code-hotfix.mjs','--apply')
        Invoke-CheckedNode -Arguments @('scripts/apply-n8n-code-hotfix.mjs','--inspect')
        Write-Host 'Hotfix installed; both workflows must remain unpublished until credentials are checked and you deliberately republish.'
    } elseif($BackupOnly){
        Invoke-CheckedNode -Arguments @('scripts/apply-n8n-code-hotfix.mjs','--backup')
    } else {
        Write-Host 'Inspection only. No changes made; use -Apply to patch after unpublishing workflows.'
    }
} finally {
    Remove-Item Env:N8N_API_KEY -ErrorAction SilentlyContinue
    if($bstr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
    Pop-Location
}
