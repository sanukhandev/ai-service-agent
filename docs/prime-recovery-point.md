# Prime Docker Compose recovery point

**Checkpoint:** prime — locally running, known-good Docker images for AI Service Agent.

**Git baseline:** the frozen *docker-compose.prime.base.yml* was copied from the repository's *docker-compose.yml* at commit **a9ed951bb07bb2947df291342a7fb19dcd9d7ca4**. This freezes Compose **configuration**, not the binaries or runtime database state. The real prime image versions are determined when you run the image-tagging script against the currently running containers.

## What is versioned in Git

- *docker-compose.prime.base.yml*: frozen Compose service/network/volume configuration. Do not update it as part of ordinary development.
- *docker-compose.prime.yml*: image override pointing to local ai-service-agent-(service):prime tags.
- *scripts/save-prime.ps1*: PowerShell command to tag image **IDs of running containers**, not newly built source images.
- This document: capture, recovery and limitations.

Docker images, .env, credentials, volume contents and database snapshots are **not** in Git. Git cannot restore those by itself.

## 1. Capture prime BEFORE the next deployment

Run from the repository root in PowerShell while the desired app is running:

~~~powershell
git switch main
git pull --ff-only origin main

docker compose ps
.\scripts\save-prime.ps1

docker image ls --filter "reference=*:prime"
~~~

The script requires one running api, web and nginx container under Compose project ai-service-agent; it tags other running Compose services (postgres, redis, n8n, gotenberg). Stopped optional services are skipped. It refuses to overwrite existing prime image tags if their image IDs differ; deliberate replacement requires the PowerShell flag -Force.

**Important:** Do not capture prime *after* deploying a broken image and assume it contains an earlier version. Prime is a checkpoint of what is running **when captured**. A Git commit or Compose YAML alone does not mean the image snapshot exists.

For recovery after Docker image deletion or moving to another machine, separately export the tagged images to a private/off-repository archive with docker image save and restore them with docker image load. Do not commit image archives: they are large and may contain sensitive layers.

## 2. Roll back the application services

Run from the repository root in PowerShell, keeping the existing private .env and Docker volumes:

~~~powershell
docker compose `
  -f docker-compose.prime.base.yml `
  -f docker-compose.prime.yml `
  up -d --no-build --no-deps --force-recreate api web nginx
~~~

The explicit --no-build uses already-tagged prime images and --no-deps avoids running migrate or recreating PostgreSQL, Redis, n8n or other dependencies. **This command does not roll back the database or provider actions.** It requires the tagged images to be available locally.

Check:

~~~powershell
docker compose -f docker-compose.prime.base.yml -f docker-compose.prime.yml ps
docker compose -f docker-compose.prime.base.yml -f docker-compose.prime.yml logs --tail=100 api web nginx
curl.exe -f http://localhost/api/health
~~~

If rollback is successful, do not run a normal docker compose up -d --build until you want to deploy the forward version again.

## 3. Data and compatibility warnings

- **PostgreSQL:** image rollback is not schema rollback. Take a separate, tested database backup **before** schema/migration changes; restore data only through an approved procedure. Never use docker compose down -v to roll back: it deletes named volumes.
- **n8n:** this application rollback does not restore workflows, credentials, encryption keys or n8n persistent data. Back them up separately when needed.
- **Redis / Azure CLI:** retained named volumes are unchanged by this command; their state and external authentication are not restored.
- **Secrets:** .env and provider credentials stay local/private. Keep a secure copy of the matching environment configuration; never commit secrets.
- **External side effects:** Salesforce leads, quotations, orders, payments and invoices are not undone by restoring Docker images. Never replay an uncertain operation solely because code was rolled back.
- **Image availability:** do not delete the prime images or their private backup archive. Verify tags before relying on this procedure.
- **Scope:** the rollback recreates api, web and nginx only. The underlying running database/services must remain compatible with the saved application code.

## 4. Return to the current development build

Only when ready to leave the recovery point:

~~~powershell
docker compose up -d --build api web nginx
docker compose ps
~~~

This returns the app containers to normal Compose development images; it does not reset volumes, migrate data backwards or undo external operations.
