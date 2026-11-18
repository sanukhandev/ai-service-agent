# Saves a local, non-overwriting Docker image checkpoint named "prime".
# Run once BEFORE upgrading the images you might need to roll back.
# The Compose configuration is tracked in Git; the image blobs are NOT.
[CmdletBinding()]
param([switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $root
try {
    foreach ($file in @("docker-compose.prime.base.yml", "docker-compose.prime.yml")) {
        if (-not (Test-Path $file)) {
            throw "Missing $file. Pull the recovery-point commit first."
        }
    }

    $project = "ai-service-agent"
    $required = @("api", "web", "nginx")
    $services = @("api", "web", "nginx", "postgres", "redis", "n8n", "gotenberg")
    $images = @()

    # Inspect actual running containers, not current source/build tags.
    foreach ($service in $services) {
        $ids = @(& docker ps --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" | Where-Object { $_ -and $_.Trim() })
        if ($LASTEXITCODE -ne 0) { throw "docker ps failed" }
        if ($ids.Count -ne 1) {
            if ($required -contains $service) {
                throw "Expected exactly one running $service container; found $($ids.Count)"
            }
            Write-Host "Skipping optional, stopped or scaled service: $service"
            continue
        }

        $imageId = (& docker inspect --format '{{.Image}}' $ids[0] | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $imageId) {
            throw "Cannot inspect running $service image"
        }

        $tag = "ai-service-agent-$($service):prime"
        $existingId = (& docker image ls --no-trunc --quiet $tag | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect existing $tag" }
        if ($existingId -and $existingId -ne $imageId -and -not $Force) {
            throw "$tag already exists with a different image. Refusing to overwrite the recovery point. Use -Force only when intentionally replacing it."
        }

        $images += [pscustomobject]@{
            Service = $service
            ImageId = $imageId
            Tag = $tag
        }
    }

    # All required services and tag conflicts are checked before any mutation.
    foreach ($item in $images) {
        & docker image tag $item.ImageId $item.Tag
        if ($LASTEXITCODE -ne 0) { throw "Failed to tag $($item.Service)" }
        Write-Host "Pinned $($item.Service) -> $($item.Tag)"
    }

    & docker compose -f docker-compose.prime.base.yml -f docker-compose.prime.yml config --quiet
    if ($LASTEXITCODE -ne 0) { throw "Prime Compose configuration is invalid" }

    Write-Host "Prime image checkpoint saved locally. Keep the images and the matching private .env."
    Write-Host "Git tracks only the Compose files and this script, NOT the actual image contents."
}
finally {
    Pop-Location
}
